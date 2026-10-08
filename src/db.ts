import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  buildVersion,
  Definition,
  DefinitionInput,
  expand,
  ExpandedNode,
  serializeExpanded,
  DEFAULT_LIMITS,
  Limits,
} from './definitions';
import { parseIds, serialize } from './ids';

export interface VersionRow {
  id: number;
  created_at: string;
  note: string | null;
  definition_count: number;
}

export interface StoredDefinition {
  version_id: number;
  key: string;
  key_cp: number;
  ids: string;
  tree_json: string;
  refs_json: string;
}

export interface FrozenResult {
  id: number;
  version_id: number;
  kind: string;
  request_json: string;
  result_json: string;
  complete: number;
  created_at: string;
}

export class Store {
  readonly db: DatabaseSync;
  readonly limits: Limits;

  constructor(dbPath: string, limits: Limits = DEFAULT_LIMITS) {
    const inMemory = dbPath === ':memory:';
    const abs = inMemory ? ':memory:' : resolve(dbPath);
    if (!inMemory) mkdirSync(dirname(abs), { recursive: true });
    this.db = new DatabaseSync(abs);
    this.limits = limits;
    if (!inMemory) this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        note TEXT,
        definition_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS definitions (
        version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        key_cp INTEGER NOT NULL,
        ids TEXT NOT NULL,
        tree_json TEXT NOT NULL,
        refs_json TEXT NOT NULL,
        PRIMARY KEY (version_id, key)
      );
      CREATE TABLE IF NOT EXISTS refs (
        version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
        src_key TEXT NOT NULL,
        dst_key TEXT NOT NULL,
        ord INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS frozen_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        request_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        complete INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS idx_defs_version ON definitions(version_id);
      CREATE INDEX IF NOT EXISTS idx_refs_version ON refs(version_id, src_key);
      CREATE INDEX IF NOT EXISTS idx_results_version ON frozen_results(version_id, kind);
    `);
  }

  listVersions(): VersionRow[] {
    return this.db
      .prepare('SELECT id, created_at, note, definition_count FROM versions ORDER BY id')
      .all() as unknown as VersionRow[];
  }

  latestVersionId(): number | null {
    const row = this.db
      .prepare('SELECT MAX(id) AS id FROM versions')
      .get() as { id: number | null };
    return row?.id ?? null;
  }

 getVersion(id: number): VersionRow | null {
    const row = this.db
      .prepare('SELECT id, created_at, note, definition_count FROM versions WHERE id = ?')
      .get(id) as VersionRow | undefined;
    return row ?? null;
  }

  /**
   * 导入一个新版本。
   * definitions 为完整快照；baseVersionId 仅用于“继承”语义，
   * 调用方需自己把旧版本定义与新增定义合并后传入。
   * 环检测在写入前完成，任何错误都不会产生新版本。
   */
  importVersion(
    definitions: DefinitionInput[],
    note: string | null = null,
  ): { versionId: number; definitions: ReturnType<typeof buildVersion> } {
    const defs = buildVersion(definitions, this.limits);
    const insertVersion = this.db.prepare(
      'INSERT INTO versions (note, definition_count) VALUES (?, ?)',
    );
    const insertDef = this.db.prepare(
      `INSERT INTO definitions (version_id, key, key_cp, ids, tree_json, refs_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertRef = this.db.prepare(
      'INSERT INTO refs (version_id, src_key, dst_key, ord) VALUES (?, ?, ?, ?)',
    );

    let versionId = -1;
    this.db.exec('BEGIN');
    try {
      const info = insertVersion.run(note, defs.size) as { lastInsertRowid: bigint };
      versionId = Number(info.lastInsertRowid);
      for (const def of defs.values()) {
        const cp = def.key.codePointAt(0)!;
        insertDef.run(
          versionId,
          def.key,
          cp,
          def.ids,
          JSON.stringify(def.tree),
          JSON.stringify(def.refs),
        );
        def.refs.forEach((dst, ord) => insertRef.run(versionId, def.key, dst, ord));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { versionId, definitions: defs };
  }

  /** 读取某版本的全部定义并重建成内存结构（供展开/环检测使用） */
  loadVersionDefs(versionId: number): Map<string, Definition> {
    const rows = this.db
      .prepare(
        `SELECT key, ids, tree_json, refs_json FROM definitions
         WHERE version_id = ? ORDER BY key`,
      )
      .all(versionId) as unknown as Array<{
      key: string;
      ids: string;
      tree_json: string;
      refs_json: string;
    }>;
    const defs = new Map<string, Definition>();
    for (const row of rows) {
      defs.set(row.key, {
        key: row.key,
        ids: row.ids,
        tree: JSON.parse(row.tree_json),
        refs: JSON.parse(row.refs_json),
      });
    }
    return defs;
  }

  listDefinitions(versionId: number): StoredDefinition[] {
    return this.db
      .prepare(
        `SELECT version_id, key, key_cp, ids, tree_json, refs_json
         FROM definitions WHERE version_id = ? ORDER BY key_cp`,
      )
      .all(versionId) as unknown as StoredDefinition[];
  }

  listRefs(versionId: number): Array<{ src_key: string; dst_key: string; ord: number }> {
    return this.db
      .prepare('SELECT src_key, dst_key, ord FROM refs WHERE version_id = ? ORDER BY src_key, ord')
      .all(versionId) as unknown as Array<{ src_key: string; dst_key: string; ord: number }>;
  }

  /**
   * 在指定版本上展开某个键（或直接展开一条 IDS 表达式）。
   * 成功结果写入 frozen_results 冻结保存；预算失败不落库，
   * 也绝不改变该版本已有的冻结结果。
   */
  expandAtVersion(
    versionId: number,
    request: { key?: string; ids?: string },
  ): { result: ReturnType<typeof expand>; frozenId: number } {
    if (!this.getVersion(versionId)) {
      throw new Error(`VERSION_NOT_FOUND:${versionId}`);
    }
    const defs = this.loadVersionDefs(versionId);
    let root;
    let rootKey: string | null = null;
    if (typeof request.key === 'string') {
      const def = defs.get(request.key);
      if (!def) {
        const err = new Error(`UNDEFINED_KEY:${request.key}`);
        (err as { code?: string }).code = 'UNDEFINED_KEY';
        throw err;
      }
      root = def.tree;
      rootKey = def.key;
    } else if (typeof request.ids === 'string') {
      root = parseIds(request.ids, { maxDepth: this.limits.maxParseDepth });
    } else {
      throw new Error('BAD_REQUEST: 需要 key 或 ids');
    }

    // 预算超限会在此抛出，freezeResult 不会执行，因此失败结果绝不落库
    const result = expand(root, defs, {
      rootKey,
      budget: this.limits.maxExpandedNodes,
    });
    const frozenId = this.freezeResult(versionId, 'expand', request, result, true);
    return { result, frozenId };
  }

  freezeResult(
    versionId: number,
    kind: string,
    request: unknown,
    result: unknown,
    complete: boolean,
  ): number {
    const info = this.db
      .prepare(
        `INSERT INTO frozen_results (version_id, kind, request_json, result_json, complete)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        kind,
        JSON.stringify(request),
        JSON.stringify(result),
        complete ? 1 : 0,
      ) as { lastInsertRowid: bigint };
    return Number(info.lastInsertRowid);
  }

  listFrozen(versionId: number): FrozenResult[] {
    return this.db
      .prepare(
        `SELECT id, version_id, kind, request_json, result_json, complete, created_at
         FROM frozen_results WHERE version_id = ? ORDER BY id`,
      )
      .all(versionId) as unknown as FrozenResult[];
  }

  close() {
    this.db.close();
  }
}

export function reparseStoredIds(ids: string, maxDepth: number) {
  const tree = parseIds(ids, { maxDepth });
  if (serialize(tree) !== ids) {
    throw new Error('SERIALIZE_MISMATCH');
  }
  return tree;
}

export { serializeExpanded, ExpandedNode };
