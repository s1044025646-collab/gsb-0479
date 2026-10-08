import {
  IdsNode,
  parseIds,
  serialize,
  nodeCount,
  toCodePoints,
  isOperatorRange,
  isWhitespace,
  treeDepth,
} from './ids';

export interface DefinitionInput {
  key: string;
  ids: string;
}

export interface Definition {
  key: string;
  ids: string;
  tree: IdsNode;
  /** 该定义树中引用到的其它（或自身）定义键，按出现次序去重 */
  refs: string[];
}

export type DefErrorCode =
  | 'INVALID_KEY'
  | 'DUPLICATE_KEY'
  | 'IDS_PARSE_ERROR'
  | 'TOO_MANY_DEFINITIONS'
  | 'CYCLE_DETECTED'
  | 'UNDEFINED_KEY'
  | 'BUDGET_EXCEEDED'
  | 'DEPTH_LIMIT';

export class DefError extends Error {
  code: DefErrorCode;
  details?: unknown;
  constructor(code: DefErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'DefError';
    this.code = code;
    this.details = details;
  }
}

export interface Limits {
  maxDefinitions: number;
  maxParseDepth: number;
  maxExpandedNodes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxDefinitions: 5000,
  maxParseDepth: 64,
  maxExpandedNodes: 200_000,
};

/** 定义键必须是“单个 Unicode 标量字符”，且不能是操作符/空白/代理项 */
export function validateKey(key: unknown): string {
  if (typeof key !== 'string') {
    throw new DefError('INVALID_KEY', '定义键必须是字符串');
  }
  const cps = toCodePoints(key);
  if (cps.length !== 1) {
    throw new DefError('INVALID_KEY', `定义键必须是单个码点，收到 ${cps.length} 个`, { key });
  }
  const cp = cps[0];
  if (cp >= 0xd800 && cp <= 0xdfff) {
    throw new DefError('INVALID_KEY', '定义键不能是代理项', { key });
  }
  if (isWhitespace(cp)) {
    throw new DefError('INVALID_KEY', '定义键不能是空白', { key });
  }
  if (isOperatorRange(cp)) {
    throw new DefError('INVALID_KEY', `定义键不能是操作符 U+${cp.toString(16)}`, { key });
  }
  return key;
}

function collectRefLeaves(node: IdsNode, keySet: Set<string>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const visit = (n: IdsNode) => {
    if (n.kind === 'leaf') {
      if (keySet.has(n.char) && !seen.has(n.char)) {
        seen.add(n.char);
        ordered.push(n.char);
      }
      return;
    }
    n.children.forEach(visit);
  };
  visit(node);
  return ordered;
}

/**
 * 构造一个版本的全部定义（完整快照），并检查引用图环。
 * 有环（含自引用）时拒绝整个版本，并返回一条真实引用链。
 */
export function buildVersion(
  inputs: DefinitionInput[],
  limits: Limits = DEFAULT_LIMITS,
): Map<string, Definition> {
  if (!Array.isArray(inputs)) {
    throw new DefError('INVALID_KEY', '定义列表必须是数组');
  }
  if (inputs.length > limits.maxDefinitions) {
    throw new DefError(
      'TOO_MANY_DEFINITIONS',
      `定义数量 ${inputs.length} 超过上限 ${limits.maxDefinitions}`,
    );
  }

  const defs = new Map<string, Definition>();
  for (const item of inputs) {
    const key = validateKey(item?.key);
    if (defs.has(key)) {
      throw new DefError('DUPLICATE_KEY', `定义键重复：${key}`, { key });
    }
    if (typeof item?.ids !== 'string') {
      throw new DefError('IDS_PARSE_ERROR', `定义 ${key} 的 IDS 必须是字符串`, { key });
    }
    let tree: IdsNode;
    try {
      tree = parseIds(item.ids, { maxDepth: limits.maxParseDepth });
    } catch (e) {
      const err = e as { code?: string; message?: string; offset?: number };
      throw new DefError(
        'IDS_PARSE_ERROR',
        `定义 ${key} 的 IDS 解析失败：${err.message ?? ''}`,
        { key, code: err.code, offset: err.offset },
      );
    }
    if (treeDepth(tree) > limits.maxParseDepth) {
      throw new DefError('DEPTH_LIMIT', `定义 ${key} 超过最大解析深度`, { key });
    }
    defs.set(key, { key, ids: item.ids, tree, refs: [] });
  }

  // 填充引用边
  for (const def of defs.values()) {
    def.refs = collectRefLeaves(def.tree, new Set(defs.keys()));
  }

  const cycle = findCycle(defs);
  if (cycle) {
    throw new DefError(
      'CYCLE_DETECTED',
      `引用图存在环：${cycle.join(' -> ')}`,
      { chain: cycle },
    );
  }
  return defs;
}

/**
 * DFS 三色环检测。返回一条真实引用链（首尾同键即闭环，如 A->B->A）。
 * 多个父节点共享同一子定义不会被误判为环。
 */
export function findCycle(defs: Map<string, Definition>): string[] | null {
  const color = new Map<string, 0 | 1 | 2>(); // 0 灰 1? 用 0=未访问 1=在栈上 2=完成
  for (const key of defs.keys()) color.set(key, 0);
  const stack: string[] = [];

  const dfs = (key: string): string[] | null => {
    color.set(key, 1);
    stack.push(key);
    const def = defs.get(key);
    for (const ref of def?.refs ?? []) {
      const c = color.get(ref) ?? 2;
      if (c === 1) {
        const idx = stack.indexOf(ref);
        return [...stack.slice(idx), ref];
      }
      if (c === 0) {
        const found = dfs(ref);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(key, 2);
    return null;
  };

  for (const key of defs.keys()) {
    if (color.get(key) === 0) {
      const found = dfs(key);
      if (found) return found;
    }
  }
  return null;
}

export interface Occurrence {
  /** 原子叶子字符 */
  atom: string;
  /** 在完全展开树中，从根开始的子节点零基索引数组 */
  path: number[];
  /** 完整定义来源链：从被查询键开始，沿途经过的定义键 */
  sourceChain: string[];
}

export interface ExpandedNode {
  kind: 'op' | 'leaf';
  char: string;
  children: ExpandedNode[];
  /** 该节点来自哪条定义（查询根树里的节点来源标记为 root） */
  sourceKey: string;
}

export interface ExpandResult {
  complete: true;
  rootKey: string | null;
  expanded: ExpandedNode;
  expandedIds: string;
  atomLeafCount: number;
  expandedNodeCount: number;
  /** 按原子字符聚合的出现次数（同一原子多个位置分别计数） */
  atomCounts: Record<string, number>;
  occurrences: Occurrence[];
}

interface ExpandState {
  budgetLeft: number;
  occurrences: Occurrence[];
}

/**
 * 完全展开。defs 已保证无环。
 * 每处引用都深拷贝为独立子树——即使多个父节点共享同一定义，
 * 也按实际出现次数计数，不用“只展开一次”的缓存顶替。
 */
export function expand(
  root: IdsNode,
  defs: Map<string, Definition>,
  options: { rootKey?: string | null; budget?: number } = {},
): ExpandResult {
  const budget = options.budget ?? DEFAULT_LIMITS.maxExpandedNodes;
  const state: ExpandState = { budgetLeft: budget, occurrences: [] };
  const rootKey = options.rootKey ?? null;

  const build = (
    node: IdsNode,
    sourceKey: string,
    chain: string[],
  ): ExpandedNode => {
    if (state.budgetLeft <= 0) {
      throw new DefError(
        'BUDGET_EXCEEDED',
        `展开节点数超过预算 ${budget}，结果未完整展开`,
        { budget },
      );
    }
    state.budgetLeft -= 1;

    if (node.kind === 'leaf') {
      const def = defs.get(node.char);
      if (def) {
        // 复合部件：替换为定义树；来源链追加该键
        return build(def.tree, def.key, [...chain, def.key]);
      }
      // 原子叶子：未定义即原子，不报缺失
      return { kind: 'leaf', char: node.char, children: [], sourceKey };
    }
    const children = node.children.map((child) => build(child, sourceKey, chain));
    return { kind: 'op', char: node.char, children, sourceKey };
  };

  const expanded = build(root, rootKey ?? '__raw__', rootKey ? [rootKey] : []);

  // 独立遍历展开树：重新计数并登记每个原子的路径与来源链
  const atomCounts: Record<string, number> = {};
  let atomLeafCount = 0;
  let expandedNodeCount = 0;
  const occurrences: Occurrence[] = [];

  // 为还原来源链，需要在遍历时携带“该节点所属定义链”。
  // build 阶段无法记录每片叶子的 chain，故在叶子节点上直接记录。
  // 重新走一遍带 chain 的树：
  const recount = (n: ExpandedNode, path: number[], chain: string[]) => {
    expandedNodeCount += 1;
    if (n.kind === 'leaf') {
      // 展开树里叶子必然是原子
      atomLeafCount += 1;
      atomCounts[n.char] = (atomCounts[n.char] ?? 0) + 1;
      occurrences.push({ atom: n.char, path: [...path], sourceChain: [...chain] });
      return;
    }
    n.children.forEach((child, i) => {
      const childChain =
        child.sourceKey !== n.sourceKey && child.sourceKey !== '__raw__'
          ? [...chain, child.sourceKey]
          : chain;
      recount(child, [...path, i], childChain);
    });
  };
  recount(expanded, [], rootKey ? [rootKey] : []);

  return {
    complete: true,
    rootKey,
    expanded,
    expandedIds: serializeExpanded(expanded),
    atomLeafCount,
    expandedNodeCount,
    atomCounts,
    occurrences,
  };
}

export function serializeExpanded(node: ExpandedNode): string {
  if (node.kind === 'leaf') return node.char;
  return node.char + node.children.map(serializeExpanded).join('');
}

/** 按展开树路径取节点 */
export function nodeAtPath(root: ExpandedNode, path: number[]): ExpandedNode {
  let cur = root;
  for (const index of path) {
    if (!Number.isInteger(index) || index < 0 || index >= cur.children.length) {
      throw new DefError('UNDEFINED_KEY', `路径越界：${JSON.stringify(path)}`, { path });
    }
    cur = cur.children[index];
  }
  return cur;
}

export { nodeCount, serialize };
