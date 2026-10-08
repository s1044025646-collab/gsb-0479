// IDS 前缀表达式解析器：按 Unicode 码点解析，位置使用从零开始的码点偏移。

export const BINARY_OPS = new Set([
  "⿰", "⿱", "⿴", "⿵", "⿶", "⿷", "⿸", "⿹", "⿺", "⿻",
]);
export const TERNARY_OPS = new Set(["⿲", "⿳"]);

// U+2FF0–U+2FFF 以及 U+31EF 中未被支持的操作符。
export function isIdsOperatorChar(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (cp >= 0x2ff0 && cp <= 0x2fff) || cp === 0x31ef;
}

export function operatorArity(ch: string): number | null {
  if (BINARY_OPS.has(ch)) return 2;
  if (TERNARY_OPS.has(ch)) return 3;
  return null;
}

export type IdsNode =
  | {
      kind: "op";
      op: string;
      children: IdsNode[];
      start: number; // 码点偏移（含）
      end: number; // 码点偏移（不含）
    }
  | {
      kind: "leaf";
      char: string;
      start: number;
      end: number;
    };

export type IdsErrorCode =
  | "IDS_EMPTY"
  | "IDS_MISSING_OPERAND"
  | "IDS_TRAILING_CONTENT"
  | "IDS_UNKNOWN_OPERATOR"
  | "IDS_INVALID_LEAF"
  | "IDS_MAX_DEPTH";

export class IdsError extends Error {
  constructor(
    public code: IdsErrorCode,
    message: string,
    public position: number
  ) {
    super(message);
    this.name = "IdsError";
  }
}

export interface ParseOptions {
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 64;

export function parseIds(input: string, options: ParseOptions = {}): IdsNode {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (typeof input !== "string") {
    throw new IdsError("IDS_EMPTY", "输入必须是字符串", 0);
  }
  // Array.from 按码点切分，正确处理代理对（补充平面汉字）。
  const chars = Array.from(input);
  if (chars.length === 0) {
    throw new IdsError("IDS_EMPTY", "IDS 字符串为空", 0);
  }

  let pos = 0;

  function parseExpr(depth: number): IdsNode {
    if (depth > maxDepth) {
      throw new IdsError(
        "IDS_MAX_DEPTH",
        `超过最大嵌套深度 ${maxDepth}`,
        pos
      );
    }
    if (pos >= chars.length) {
      throw new IdsError("IDS_MISSING_OPERAND", "操作符缺少操作数", pos);
    }
    const start = pos;
    const ch = chars[pos];
    if (isIdsOperatorChar(ch)) {
      const arity = operatorArity(ch);
      if (arity === null) {
        throw new IdsError(
          "IDS_UNKNOWN_OPERATOR",
          `不支持的 IDS 操作符 U+${ch.codePointAt(0)!.toString(16).toUpperCase()}`,
          start
        );
      }
      pos++;
      const children: IdsNode[] = [];
      for (let i = 0; i < arity; i++) {
        children.push(parseExpr(depth + 1));
      }
      return { kind: "op", op: ch, children, start, end: pos };
    }
    if (/\s/u.test(ch)) {
      throw new IdsError("IDS_INVALID_LEAF", "叶子不能是空白字符", start);
    }
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw new IdsError("IDS_INVALID_LEAF", "叶子不能是孤立代理项", start);
    }
    pos++;
    return { kind: "leaf", char: ch, start, end: pos };
  }

  const root = parseExpr(1);
  if (pos !== chars.length) {
    throw new IdsError(
      "IDS_TRAILING_CONTENT",
      "根表达式之后存在多余内容",
      pos
    );
  }
  return root;
}

// 从保存的原文区间重序列化，必须恢复原 IDS 字符串。
export function serializeIds(node: IdsNode): string {
  if (node.kind === "leaf") return node.char;
  return node.op + node.children.map(serializeIds).join("");
}

export function countNodes(node: IdsNode): number {
  if (node.kind === "leaf") return 1;
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}
