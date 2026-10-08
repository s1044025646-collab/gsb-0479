import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVersion,
  expand,
  DefError,
  serializeExpanded,
} from '../src/definitions';

function defErr(fn: () => unknown): DefError {
  try {
    fn();
  } catch (e) {
    return e as DefError;
  }
  throw new assert.AssertionError({ message: '预期抛出 DefError' });
}

test('林/森：未定义的木是原子，森展开后木出现 3 次', () => {
  const defs = buildVersion([
    { key: '林', ids: '⿰木木' },
    { key: '森', ids: '⿱木林' },
  ]);
  const r = expand(defs.get('森')!.tree, defs, { rootKey: '森' });
  assert.equal(r.expandedIds, '⿱木⿰木木');
  assert.equal(r.atomLeafCount, 3);
  assert.deepEqual(r.atomCounts, { 木: 3 });
  assert.deepEqual(
    r.occurrences.map((o) => o.path),
    [[0], [1, 0], [1, 1]],
  );
  assert.deepEqual(r.occurrences.map((o) => o.sourceChain), [
    ['森'],
    ['森', '林'],
    ['森', '林'],
  ]);
});

test('明=⿰日月：两个不同叶子各计一次', () => {
  const defs = buildVersion([{ key: '明', ids: '⿰日月' }]);
  const r = expand(defs.get('明')!.tree, defs, { rootKey: '明' });
  assert.equal(r.atomLeafCount, 2);
  assert.deepEqual(r.atomCounts, { 日: 1, 月: 1 });
});

test('自引用与互相引用都被拒绝，并给出真实链', () => {
  const self = defErr(() => buildVersion([{ key: 'A', ids: '⿰A木' }]));
  assert.equal(self.code, 'CYCLE_DETECTED');
  assert.deepEqual(self.details, { chain: ['A', 'A'] });

  const mutual = defErr(() =>
    buildVersion([
      { key: 'A', ids: '⿰B木' },
      { key: 'B', ids: '⿱A日' },
    ]),
  );
  assert.equal(mutual.code, 'CYCLE_DETECTED');
  const chain = (mutual.details as { chain: string[] }).chain;
  assert.equal(chain[0], chain[chain.length - 1]);
  assert.ok(chain.includes('A') && chain.includes('B'));
});

test('多个父节点共享同一子定义不是环，且每处引用分别计数', () => {
  const defs = buildVersion([
    { key: '林', ids: '⿰木木' },
    { key: 'X', ids: '⿱林日' },
    { key: 'Y', ids: '⿰月林' },
  ]);
  const rx = expand(defs.get('X')!.tree, defs, { rootKey: 'X' });
  const ry = expand(defs.get('Y')!.tree, defs, { rootKey: 'Y' });
  assert.equal(rx.atomCounts['木'], 2);
  assert.equal(ry.atomCounts['木'], 2);
  assert.equal(rx.occurrences.find((o) => o.path.join() === '0,0')?.sourceChain.join('>'), 'X>林');
});

test('多层相同叶子：路径与来源链逐级完整', () => {
  const defs = buildVersion([
    { key: 'a', ids: '⿰bb' },
    { key: 'b', ids: '⿱木c' },
    { key: 'c', ids: '木' },
  ]);
  const r = expand(defs.get('a')!.tree, defs, { rootKey: 'a' });
  // a -> b(2 份) -> 每份 ⿱ 下为 (木, c 展开成木)，各 2 个木，共 4 个
  assert.equal(r.atomLeafCount, 4);
  assert.equal(r.atomCounts['木'], 4);
  const paths = r.occurrences.map((o) => o.path.join('.')).sort();
  assert.deepEqual(paths, ['0.0', '0.1', '1.0', '1.1']);
  const viaC = r.occurrences.find((o) => o.path.join() === '0,1')!;
  assert.deepEqual(viaC.sourceChain, ['a', 'b', 'c']);
});

test('原始树计数与完全展开计数分阶段，不混层', () => {
  const defs = buildVersion([
    { key: '林', ids: '⿰木木' },
    { key: '森', ids: '⿱木林' },
  ]);
  const root = defs.get('森')!.tree;
  // 原树只有一个原子叶（木）与一个复合叶（林）
  const rawAtoms = walk_leaves(root).filter((l) => !defs.has(l.char));
  assert.equal(rawAtoms.length, 1);
  const expanded = expand(root, defs, { rootKey: '森' });
  assert.equal(expanded.atomLeafCount, 3);
});

test('指数级复制超过预算时报 BUDGET_EXCEEDED', () => {
  const defs = buildVersion(
    [
      { key: 'a', ids: '⿰bb' },
      { key: 'b', ids: '⿰木木' },
    ],
    { maxDefinitions: 100, maxParseDepth: 64, maxExpandedNodes: 4 },
  );
  // a 展开后共 9 个节点（⿰ + 2*(⿰+木+木)），预算 4 必超限
  const err = defErr(() => expand(defs.get('a')!.tree, defs, { rootKey: 'a', budget: 4 }));
  assert.equal(err.code, 'BUDGET_EXCEEDED');
});

test('独立遍历展开树重新计数与路径核对一致', () => {
  const defs = buildVersion([
    { key: '林', ids: '⿰木木' },
    { key: '森', ids: '⿱木林' },
  ]);
  const r = expand(defs.get('森')!.tree, defs, { rootKey: '森' });
  let atoms = 0;
  let nodes = 0;
  const recount = (n: ReturnType<typeof expand>['expanded'], depth = 0): void => {
    nodes += 1;
    if (n.kind === 'leaf') atoms += 1;
    n.children.forEach((c) => recount(c, depth + 1));
  };
  recount(r.expanded);
  assert.equal(atoms, r.atomLeafCount);
  assert.equal(nodes, r.expandedNodeCount);
  for (const occ of r.occurrences) {
    let cur = r.expanded;
    for (const i of occ.path) cur = cur.children[i];
    assert.equal(cur.kind, 'leaf');
    assert.equal(cur.char, occ.atom);
  }
  assert.equal(serializeExpanded(r.expanded), r.expandedIds);
});

function walk_leaves(n: { kind: string; char: string; children: any[] }) {
  const leaves: { char: string }[] = [];
  const go = (x: typeof n) => {
    if (x.kind === 'leaf') leaves.push({ char: x.char });
    else x.children.forEach(go);
  };
  go(n);
  return leaves;
}
