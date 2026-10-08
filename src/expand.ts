// 引用展开：把与定义键相同的叶子替换为对应定义树，记录来源链与路径。
import { IdsNode, countNodes } from "./ids.js";

export type DefLookup = (key: string) => IdsNode | null;

export interface ProvenanceEntry {
  key: string; // 被展开的定义键
  viaPath: number[]; // 在最终展开树中，该定义树根所在的路径
}

export interface ExpandedNode {
  kind: "op" | "leaf";
  op?: string;
  char?: string;
  children?: ExpandedNode[];
  // 该节点（作为叶子时）的来源链：从原始查询根到它的所有定义替换。
  provenance: ProvenanceEntry[];
}

export interface LeafOccurrence {
  char: string;
  path: number[];
  provenance: ProvenanceEntry[];
}

export interface ExpandResult {
  complete: boolean;
  reason?: string;
  tree: ExpandedNode;
  atomicCount: number;
  nodeCount: number;
  leaves: LeafOccurrence[];
}

export interface ExpandOptions {
  maxNodes?: number; // 展开节点预算
  maxDepth?: number;
}

const DEFAULT_MAX_NODES = 100000;
const DEFAULT_MAX_DEPTH = 256;

export function expandIds(
  root: IdsNode,
  lookup: DefLookup,
  options: ExpandOptions = {}
): ExpandResult {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  let used = 0;
  let truncated = false;
  let truncateReason = "";
  const leaves: LeafOccurrence[] = [];

  function expandNode(
    node: IdsNode,
    path: number[],
    provenance: ProvenanceEntry[],
    depth: number
  ): ExpandedNode {
    if (used >= maxNodes) {
      truncated = true;
      truncateReason = `超过展开节点预算 ${maxNodes}`;
      return { kind: "leaf", char: "�", provenance };
    }
    if (depth > maxDepth) {
      truncated = true;
      truncateReason = `超过展开深度 ${maxDepth}`;
      return { kind: "leaf", char: "�", provenance };
    }
    used++;
    if (node.kind === "op") {
      const children = node.children.map((c, i) =>
        expandNode(c, [...path, i], provenance, depth + 1)
      );
      return { kind: "op", op: node.op, children, provenance };
    }
    const def = lookup(node.char);
    if (def) {
      const entry: ProvenanceEntry = { key: node.char, viaPath: path };
      const sub = expandNode(def, path, [...provenance, entry], depth + 1);
      return sub;
    }
    leaves.push({ char: node.char, path, provenance });
    return { kind: "leaf", char: node.char, provenance };
  }

  const tree = expandNode(root, [], [], 1);
  return {
    complete: !truncated,
    reason: truncated ? truncateReason : undefined,
    tree,
    atomicCount: leaves.length,
    nodeCount: countExpanded(tree),
    leaves,
  };
}

export function countExpanded(node: ExpandedNode): number {
  if (node.kind === "leaf") return 1;
  return 1 + (node.children ?? []).reduce((s, c) => s + countExpanded(c), 0);
}

export function serializeExpanded(node: ExpandedNode): string {
  if (node.kind === "leaf") return node.char ?? "";
  return (node.op ?? "") + (node.children ?? []).map(serializeExpanded).join("");
}

// 独立遍历校验：重新统计原子叶与节点数，并核对每个来源路径可达。
export function verifyExpanded(result: ExpandResult): string[] {
  const problems: string[] = [];
  let leafCount = 0;
  let nodeCount = 0;
  function walk(node: ExpandedNode, path: number[]): void {
    nodeCount++;
    if (node.kind === "leaf") {
      leafCount++;
      return;
    }
    (node.children ?? []).forEach((c, i) => walk(c, [...path, i]));
  }
  walk(result.tree, []);
  if (leafCount !== result.atomicCount) {
    problems.push(`原子叶计数不一致: 遍历=${leafCount} 报告=${result.atomicCount}`);
  }
  if (nodeCount !== result.nodeCount) {
    problems.push(`节点计数不一致: 遍历=${nodeCount} 报告=${result.nodeCount}`);
  }
  for (const leaf of result.leaves) {
    let cur: ExpandedNode = result.tree;
    for (const idx of leaf.path) {
      const next = cur.children?.[idx];
      if (!next) {
        problems.push(`来源路径不可达: ${leaf.char} @ [${leaf.path}]`);
        break;
      }
      cur = next;
    }
    if (cur.kind !== "leaf" || cur.char !== leaf.char) {
      problems.push(`路径终点不匹配: ${leaf.char} @ [${leaf.path}]`);
    }
  }
  return problems;
}

// 引用图环检测，返回一条真实引用链（含自环）。
export function findCycle(
  defs: Map<string, IdsNode>
): string[] | null {
  const refsOf = (key: string): string[] => {
    const tree = defs.get(key);
    if (!tree) return [];
    const out: string[] = [];
    const walk = (n: IdsNode) => {
      if (n.kind === "leaf") {
        if (defs.has(n.char)) out.push(n.char);
      } else {
        n.children.forEach(walk);
      }
    };
    walk(tree);
    return out;
  };

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  function dfs(key: string): string[] | null {
    state.set(key, "visiting");
    stack.push(key);
    for (const ref of refsOf(key)) {
      const s = state.get(ref);
      if (s === "visiting") {
        const idx = stack.indexOf(ref);
        return [...stack.slice(idx), ref];
      }
      if (s !== "done") {
        const found = dfs(ref);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(key, "done");
    return null;
  }

  for (const key of defs.keys()) {
    if (!state.has(key)) {
      const found = dfs(key);
      if (found) return found;
    }
  }
  return null;
}
