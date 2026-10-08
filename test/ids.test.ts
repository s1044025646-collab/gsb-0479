import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIds,
  serialize,
  walk,
  toCodePoints,
  sliceByRange,
  IdsParseError,
} from '../src/ids';

function parseErr(fn: () => unknown): IdsParseError {
  try {
    fn();
  } catch (e) {
    return e as IdsParseError;
  }
  throw new assert.AssertionError({ message: '预期抛出 IdsParseError' });
}

test('二元操作符有两个孩子，三元有三个孩子', () => {
  assert.equal(parseIds('⿰木木').children.length, 2);
  assert.equal(parseIds('⿲木木木').children.length, 3);
  assert.equal(parseIds('⿳日月木').children.length, 3);
  for (const op of ['⿰', '⿱', '⿴', '⿵', '⿶', '⿷', '⿸', '⿹', '⿺', '⿻']) {
    assert.equal(parseIds(`${op}甲乙`).children.length, 2, op);
  }
});

test('嵌套结构保留操作符与子节点顺序', () => {
  const tree = parseIds('⿱木⿰木木');
  assert.equal(tree.char, '⿱');
  assert.equal(tree.children[0].kind, 'leaf');
  assert.equal(tree.children[0].char, '木');
  assert.equal(tree.children[1].char, '⿰');
  assert.deepEqual(
    tree.children[1].children.map((c) => c.char),
    ['木', '木'],
  );
});

test('重序列化恢复原串，且每个节点区间切片一致', () => {
  for (const input of ['⿰木木', '⿱木林', '⿲木木木', '⿻⿰日月⿱山川']) {
    const tree = parseIds(input);
    assert.equal(serialize(tree), input);
    for (const span of walk(tree)) {
      assert.equal(sliceByRange(input, span.node), serialize(span.node));
      assert.equal(span.node.range.end - span.node.range.start, toCodePoints(serialize(span.node)).length);
    }
  }
});

test('错误位置使用码点偏移而非 UTF-16 下标', () => {
  // 𠔥 是补充平面字符（2 个 UTF-16 单元，1 个码点）
  const err = parseErr(() => parseIds('⿰𠔥'));
  assert.equal(err.code, 'MISSING_OPERAND');
  assert.equal(err.offset, 2, '操作符在 0，叶子在 1，缺第二操作数 -> 偏移 2');

  const trailing = parseErr(() => parseIds('⿰𠔥木木'));
  assert.equal(trailing.code, 'UNEXPECTED_TRAILING');
  assert.equal(trailing.offset, 3);
});

test('缺操作数 / 多余尾字符 / 空输入分别诊断', () => {
  assert.equal(parseErr(() => parseIds('⿰木')).code, 'MISSING_OPERAND');
  assert.equal(parseErr(() => parseIds('⿲木木')).code, 'MISSING_OPERAND');
  assert.equal(parseErr(() => parseIds('⿰木木木')).code, 'UNEXPECTED_TRAILING');
  assert.equal(parseErr(() => parseIds('木木')).code, 'UNEXPECTED_TRAILING');
  assert.equal(parseErr(() => parseIds('')).code, 'EMPTY_INPUT');
});

test('U+2FF0..U+2FFF 与 U+31EF 中未收录操作符被明确拒绝', () => {
  // ⿾(U+2FFE)、⿿(U+2FFF)、㇯(U+31EF) 均非本服务支持的操作符
  for (const bad of ['⿾木', '⿿木', '㇯木']) {
    const err = parseErr(() => parseIds(bad));
    assert.equal(err.code, 'UNKNOWN_OPERATOR', bad);
    assert.equal(err.offset, 0);
  }
});

test('空白与孤立代理项不能作为叶子，也不会自动补结构', () => {
  assert.equal(parseErr(() => parseIds('木 木')).code, 'UNEXPECTED_TRAILING');
  assert.equal(parseErr(() => parseIds('⿰木 木')).code, 'UNSUPPORTED_LEAF');
  const lone = String.fromCharCode(0xd800);
  assert.equal(parseErr(() => parseIds(lone)).code, 'UNSUPPORTED_LEAF');
});

test('教学字母与补充平面汉字可作为叶子，不判字源资格', () => {
  const t = parseIds('⿰Aa');
  assert.deepEqual(t.children.map((c) => c.char), ['A', 'a']);
  const sup = parseIds('𠔥');
  assert.equal(sup.char, '𠔥');
  assert.deepEqual(sup.range, { start: 0, end: 1 });
});
