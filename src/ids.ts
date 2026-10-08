/**
 * IDS（Ideographic Description Sequence，表意描述序列）子集解析器。
 *
 * 只处理符号结构：按 Unicode 标量值（码点）解析前缀表达式，
 * 得到带有序子节点的树。不涉及字体、图片、笔顺、读音或字源。
 */

export type NodeKind = 'op' | 'leaf';

export interface IdsNode {
  kind: NodeKind;
  /** 操作符字符或叶子字符（长度可能为 2 个 UTF-16 代码单元） */
  char: string;
  /** 有序子节点；叶子为空数组 */
  children: IdsNode[];
  /** 原文区间，单位为“从零开始的码点偏移” */
  range: { start: number; end: number };
}

export type IdsErrorCode =
  | 'EMPTY_INPUT'
  | 'UNKNOWN_OPERATOR'
  | 'MISSING_OPERAND'
  | 'UNEXPECTED_TRAILING'
  | 'UNSUPPORTED_LEAF'
  | 'DEPTH_LIMIT';

export class IdsParseError extends Error {
  code: IdsErrorCode;
  /** 出错位置（从零开始的码点偏移） */
  offset: number;
  constructor(code: IdsErrorCode, message: string, offset: number) {
    super(message);
    this.name = 'IdsParseError';
    this.code = code;
    this.offset = offset;
  }
}

/** 本服务支持的操作符 -> 元数 */
export const OPERATORS: Readonly<Record<string, number>> = Object.freeze({
  '⿰': 2, '⿱': 2, '⿴': 2, '⿵': 2, '⿶': 2,
  '⿷': 2, '⿸': 2, '⿹': 2, '⿺': 2, '⿻': 2,
  '⿲': 3, '⿳': 3,
});

export function isSupportedOperator(cp: number): boolean {
  return Object.prototype.hasOwnProperty.call(OPERATORS, String.fromCodePoint(cp));
}

/**
 * U+2FF0..U+2FFF 为 IDS 操作符区段；U+31EF 也被规范指定为操作符。
 * 这些区段里“未被支持集合收录”的操作符必须明确拒绝，
 * 而不是当作叶子字符。
 */
export function isOperatorRange(cp: number): boolean {
  return (cp >= 0x2ff0 && cp <= 0x2fff) || cp === 0x31ef;
}

/**
 * 把字符串切成 Unicode 码点数组。
 * 使用迭代器而非 str.length / 下标，避免代理对被拆成两个 UTF-16 单元。
 */
export function toCodePoints(input: string): number[] {
  const cps: number[] = [];
  for (const ch of input) cps.push(ch.codePointAt(0)!);
  return cps;
}

/** 判断码点是否为空白（含 ASCII 与常见 CJK 全角空格） */
export function isWhitespace(cp: number): boolean {
  return (
    (cp >= 0x09 && cp <= 0x0d) ||
    cp === 0x20 ||
    cp === 0x85 ||
    cp === 0xa0 ||
    cp === 0x3000 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f
  );
}

export interface ParseOptions {
  /** 解析深度上限（根深度为 1） */
  maxDepth?: number;
}

/** 解析单条 IDS，必须恰好消费整条输入 */
export function parseIds(input: string, opts: ParseOptions = {}): IdsNode {
  const maxDepth = opts.maxDepth ?? 100;
  if (typeof input !== 'string') {
    throw new IdsParseError('EMPTY_INPUT', '输入必须是字符串', 0);
  }
  const cps = toCodePoints(input);
  if (cps.length === 0) {
    throw new IdsParseError('EMPTY_INPUT', '输入为空', 0);
  }

  let pos = 0;

  const parseExpr = (depth: number): IdsNode => {
    if (depth > maxDepth) {
      throw new IdsParseError('DEPTH_LIMIT', `超过最大解析深度 ${maxDepth}`, pos);
    }
    if (pos >= cps.length) {
      throw new IdsParseError('MISSING_OPERAND', '缺少操作数', pos);
    }
    const start = pos;
    const cp = cps[pos];
    const ch = String.fromCodePoint(cp);
    pos += 1;

    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new IdsParseError('UNSUPPORTED_LEAF', '不接受孤立代理项作为叶子', start);
    }
    if (isWhitespace(cp)) {
      throw new IdsParseError('UNSUPPORTED_LEAF', '不接受空白作为叶子', start);
    }

    if (Object.prototype.hasOwnProperty.call(OPERATORS, ch)) {
      const arity = OPERATORS[ch];
      const children: IdsNode[] = [];
      for (let i = 0; i < arity; i++) {
        if (pos >= cps.length) {
          throw new IdsParseError(
            'MISSING_OPERAND',
            `操作符 ${ch} 需要 ${arity} 个操作数，第 ${i + 1} 个缺失`,
            pos,
          );
        }
        children.push(parseExpr(depth + 1));
      }
      return { kind: 'op', char: ch, children, range: { start, end: pos } };
    }

    if (isOperatorRange(cp)) {
      throw new IdsParseError(
        'UNKNOWN_OPERATOR',
        `不支持的操作符 U+${cp.toString(16).toUpperCase().padStart(4, '0')}`,
        start,
      );
    }

    // 其余任意 Unicode 标量字符均为合法叶子（汉字或教学用字母均可）
    return { kind: 'leaf', char: ch, children: [], range: { start, end: pos } };
  };

  const root = parseExpr(1);
  if (pos !== cps.length) {
    throw new IdsParseError(
      'UNEXPECTED_TRAILING',
      '根表达式之后仍有多余内容',
      pos,
    );
  }
  return root;
}

/** 重序列化：树必须恢复成原 IDS 字符串 */
export function serialize(node: IdsNode): string {
  if (node.kind === 'leaf') return node.char;
  let out = node.char;
  for (const child of node.children) out += serialize(child);
  return out;
}

export function nodeCount(node: IdsNode): number {
  let n = 1;
  for (const child of node.children) n += nodeCount(child);
  return n;
}

export function treeDepth(node: IdsNode): number {
  if (node.kind === 'leaf') return 1;
  return 1 + Math.max(...node.children.map(treeDepth));
}

/** 独立遍历：以“码点偏移区间”为依据重新核对每个节点的原文切片 */
export interface Span {
  node: IdsNode;
  /** 父节点 -> 该子节点在父中的零基索引；根为 [] */
  path: number[];
}

export function walk(node: IdsNode, path: number[] = []): Span[] {
  const spans: Span[] = [{ node, path: [...path] }];
  node.children.forEach((child, i) => {
    spans.push(...walk(child, [...path, i]));
  });
  return spans;
}

/** 用区间从原始输入中切回子串，校验序列化一致性 */
export function sliceByRange(input: string, node: IdsNode): string {
  const cps = toCodePoints(input);
  return cps
    .slice(node.range.start, node.range.end)
    .map((cp) => String.fromCodePoint(cp))
    .join('');
}
