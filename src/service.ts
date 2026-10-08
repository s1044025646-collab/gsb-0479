// 服务层：API 与 CLI 共用的业务逻辑。
import { parseIds, serializeIds, countNodes, IdsNode } from "./ids.js";
import {
  expandIds,
  verifyExpanded,
  findCycle,
  serializeExpanded,
  ExpandResult,
} from "./expand.js";
import { IdsStore, DefinitionInput } from "./store.js";

export interface ServiceOptions {
  maxNodes?: number;
  maxDepth?: number;
}

export class IdsService {
  constructor(private store: IdsStore, private options: ServiceOptions = {}) {}

  importVersion(defs: DefinitionInput[]) {
    const version = this.store.importDefinitions(defs);
    return { version };
  }

  parse(ids: string, versionId?: number) {
    const tree = parseIds(ids);
    const vid = versionId ?? this.store.currentVersion()?.id ?? null;
    const result = {
      stage: "parsed" as const,
      ids: serializeIds(tree),
      nodeCount: countNodes(tree),
      tree,
      versionId: vid,
    };
    if (vid != null) this.store.freezeQuery(vid, "parse", { ids }, result);
    return result;
  }

  checkRefs(versionId?: number) {
    const defs = this.store.allDefinitionTrees(versionId);
    const cycle = findCycle(defs);
    return {
      ok: cycle === null,
      cycle,
      definitionCount: defs.size,
    };
  }

  private expandTree(root: IdsNode, vid: number): ExpandResult {
    const lookup = (k: string) => this.store.getDefinition(k, vid)?.tree ?? null;
    return expandIds(root, lookup, this.options);
  }

  expand(key: string, versionId?: number) {
    const vid = versionId ?? this.store.currentVersion()?.id;
    if (vid == null) throw err("NO_VERSION", "尚未导入任何定义版本");
    const def = this.store.getDefinition(key, vid);
    if (!def) throw err("KEY_NOT_DEFINED", `键 ${key} 在当前版本中没有定义`);
    const result = this.expandTree(def.tree, vid);
    const problems = verifyExpanded(result);
    const response = {
      stage: "expanded" as const,
      key,
      versionId: vid,
      complete: result.complete,
      reason: result.reason,
      atomicCount: result.atomicCount,
      nodeCount: result.nodeCount,
      serialized: serializeExpanded(result.tree),
      leaves: result.leaves,
      verifyProblems: problems,
    };
    this.store.freezeQuery(vid, "expand", { key }, response);
    return response;
  }

  counts(key: string, versionId?: number) {
    const expanded = this.expand(key, versionId);
    const byChar = new Map<string, number>();
    for (const leaf of expanded.leaves) {
      byChar.set(leaf.char, (byChar.get(leaf.char) ?? 0) + 1);
    }
    return {
      stage: "expanded" as const,
      key,
      versionId: expanded.versionId,
      complete: expanded.complete,
      atomicCount: expanded.atomicCount,
      counts: Object.fromEntries([...byChar.entries()].sort()),
    };
  }

  sourceAt(key: string, path: number[], versionId?: number) {
    const expanded = this.expand(key, versionId);
    const match = expanded.leaves.find(
      (l) => l.path.length === path.length && l.path.every((v, i) => v === path[i])
    );
    if (!match)
      throw err("PATH_NOT_FOUND", `路径 [${path.join(",")}] 不存在于展开树中`);
    return {
      stage: "expanded" as const,
      key,
      path,
      char: match.char,
      provenance: match.provenance,
    };
  }

  exportTree(key: string, versionId?: number) {
    const vid = versionId ?? this.store.currentVersion()?.id;
    if (vid == null) throw err("NO_VERSION", "尚未导入任何定义版本");
    const def = this.store.getDefinition(key, vid);
    if (!def) throw err("KEY_NOT_DEFINED", `键 ${key} 在当前版本中没有定义`);
    const result = this.expandTree(def.tree, vid);
    return {
      versionId: vid,
      key,
      raw: { stage: "parsed" as const, ids: def.ids, tree: def.tree },
      expanded: {
        stage: "expanded" as const,
        complete: result.complete,
        reason: result.reason,
        tree: result.tree,
      },
    };
  }
}

export function err(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}
