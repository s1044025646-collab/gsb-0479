// SQLite 存储层：定义版本、原始定义、语法树、引用图、冻结查询结果。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { IdsNode, parseIds, serializeIds } from "./ids.js";
import { findCycle } from "./expand.js";

export class StoreError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export interface DefinitionInput {
  key: string;
  ids: string;
}

export interface VersionInfo {
  id: number;
  createdAt: string;
  definitionCount: number;
}

const MAX_DEFINITIONS = 10000;

export class IdsStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS definitions (
        version_id INTEGER NOT NULL REFERENCES versions(id),
        key TEXT NOT NULL,
        ids TEXT NOT NULL,
        tree_json TEXT NOT NULL,
        PRIMARY KEY (version_id, key)
      );
      CREATE TABLE IF NOT EXISTS refs (
        version_id INTEGER NOT NULL,
        from_key TEXT NOT NULL,
        to_key TEXT NOT NULL,
        PRIMARY KEY (version_id, from_key, to_key)
      );
      CREATE TABLE IF NOT EXISTS queries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        request TEXT NOT NULL,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  currentVersion(): VersionInfo | null {
    const row = this.db
      .prepare(
        `SELECT v.id, v.created_at AS createdAt,
                (SELECT COUNT(*) FROM definitions d WHERE d.version_id = v.id) AS definitionCount
         FROM versions v ORDER BY v.id DESC LIMIT 1`
      )
      .get() as VersionInfo | undefined;
    return row ?? null;
  }

  listVersions(): VersionInfo[] {
    return this.db
      .prepare(
        `SELECT v.id, v.created_at AS createdAt,
                (SELECT COUNT(*) FROM definitions d WHERE d.version_id = v.id) AS definitionCount
         FROM versions v ORDER BY v.id`
      )
      .all() as unknown as VersionInfo[];
  }

  // 导入一批定义，生成新版本（继承上一版本定义并覆盖同键项）。
  importDefinitions(defs: DefinitionInput[]): VersionInfo {
    if (!Array.isArray(defs) || defs.length === 0) {
      throw new StoreError("EMPTY_IMPORT", "导入的定义列表为空");
    }
    const merged = new Map<string, IdsNode>();
    const rawIds = new Map<string, string>();
    const cur = this.currentVersion();
    if (cur) {
      for (const row of this.db
        .prepare(`SELECT key, ids, tree_json FROM definitions WHERE version_id = ?`)
        .all(cur.id) as unknown as { key: string; ids: string; tree_json: string }[]) {
        merged.set(row.key, JSON.parse(row.tree_json) as IdsNode);
        rawIds.set(row.key, row.ids);
      }
    }
    for (const def of defs) {
      this.validateKey(def.key);
      if (typeof def.ids !== "string" || def.ids.length === 0) {
        throw new StoreError("INVALID_IDS", `定义 ${def.key} 的 IDS 为空`);
      }
      const tree = parseIds(def.ids); // IdsError 直接上抛
      merged.set(def.key, tree);
      rawIds.set(def.key, def.ids);
    }
    if (merged.size > MAX_DEFINITIONS) {
      throw new StoreError(
        "TOO_MANY_DEFINITIONS",
        `定义数超过上限 ${MAX_DEFINITIONS}`
      );
    }
    const cycle = findCycle(merged);
    if (cycle) {
      throw new StoreError(
        "CYCLE_DETECTED",
        `引用存在循环，已拒绝整个版本: ${cycle.join(" -> ")}`
      );
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`INSERT INTO versions DEFAULT VALUES`).run();
      const versionId = Number(
        (this.db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id
      );
      const insDef = this.db.prepare(
        `INSERT INTO definitions (version_id, key, ids, tree_json) VALUES (?, ?, ?, ?)`
      );
      const insRef = this.db.prepare(
        `INSERT INTO refs (version_id, from_key, to_key) VALUES (?, ?, ?)`
      );
      for (const [key, tree] of merged) {
        const ids = rawIds.get(key)!;
        if (serializeIds(tree) !== ids) {
          throw new StoreError("SERIALIZE_MISMATCH", `定义 ${key} 序列化不一致`);
        }
        insDef.run(versionId, key, ids, JSON.stringify(tree));
        for (const ref of collectRefs(tree, merged)) {
          insRef.run(versionId, key, ref);
        }
      }
      this.db.exec("COMMIT");
      return this.currentVersion()!;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private validateKey(key: string): void {
    if (typeof key !== "string" || Array.from(key).length !== 1) {
      throw new StoreError("INVALID_KEY", "定义键必须是单个 Unicode 码点字符");
    }
    const cp = key.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff || /\s/u.test(key)) {
      throw new StoreError("INVALID_KEY", "定义键不能是空白或孤立代理项");
    }
  }

  getDefinition(key: string, versionId?: number): { ids: string; tree: IdsNode } | null {
    const vid = versionId ?? this.currentVersion()?.id;
    if (vid == null) return null;
    const row = this.db
      .prepare(`SELECT ids, tree_json FROM definitions WHERE version_id = ? AND key = ?`)
      .get(vid, key) as { ids: string; tree_json: string } | undefined;
    if (!row) return null;
    return { ids: row.ids, tree: JSON.parse(row.tree_json) as IdsNode };
  }

  listDefinitions(versionId?: number): { key: string; ids: string }[] {
    const vid = versionId ?? this.currentVersion()?.id;
    if (vid == null) return [];
    return this.db
      .prepare(`SELECT key, ids FROM definitions WHERE version_id = ? ORDER BY key`)
      .all(vid) as unknown as { key: string; ids: string }[];
  }

  allDefinitionTrees(versionId?: number): Map<string, IdsNode> {
    const vid = versionId ?? this.currentVersion()?.id;
    const map = new Map<string, IdsNode>();
    if (vid == null) return map;
    for (const row of this.db
      .prepare(`SELECT key, tree_json FROM definitions WHERE version_id = ?`)
      .all(vid) as unknown as { key: string; tree_json: string }[]) {
      map.set(row.key, JSON.parse(row.tree_json) as IdsNode);
    }
    return map;
  }

  freezeQuery(versionId: number, kind: string, request: unknown, response: unknown): void {
    this.db
      .prepare(`INSERT INTO queries (version_id, kind, request, response) VALUES (?, ?, ?, ?)`)
      .run(versionId, kind, JSON.stringify(request), JSON.stringify(response));
  }

  listQueries(versionId?: number): unknown[] {
    const vid = versionId ?? this.currentVersion()?.id;
    if (vid == null) return [];
    return this.db
      .prepare(`SELECT id, version_id AS versionId, kind, request, response, created_at AS createdAt FROM queries WHERE version_id = ? ORDER BY id`)
      .all(vid) as unknown as unknown[];
  }
}

function collectRefs(tree: IdsNode, defs: Map<string, IdsNode>): string[] {
  const out = new Set<string>();
  const walk = (n: IdsNode) => {
    if (n.kind === "leaf") {
      if (defs.has(n.char)) out.add(n.char);
    } else {
      n.children.forEach(walk);
    }
  };
  walk(tree);
  return [...out];
}
