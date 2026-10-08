/**
 * 端到端演示（不启动 HTTP 服务，直接走存储层）：
 * 1. 林=⿰木木、森=⿱木林，不定义“木” -> 展开森，原子木出现 3 次
 * 2. 三元 ⿲木木木 恰有 3 个孩子；明=⿰日月 叶计数 2
 * 3. A/B 教学字符互相引用 -> 整个版本被拒绝并给出真实环链
 * 4. 新版本新增“木”的定义后，旧版本结果保持冻结、不被改写
 * 5. 补充平面汉字、缺操作数、多余尾字符、预算超限诊断
 */
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../src/db';
import { parseIds } from '../src/ids';
import { DefError, DEFAULT_LIMITS } from '../src/definitions';

const dbPath = resolve('data', 'demo.db');
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });

const line = (title: string) => console.log(`\n=== ${title} ===`);

const store = new Store(dbPath, DEFAULT_LIMITS);

line('1. 导入 v1：林=⿰木木，森=⿱木林（木未定义=原子）');
const v1 = store.importVersion(
  [
    { key: '林', ids: '⿰木木' },
    { key: '森', ids: '⿱木林' },
  ],
  'demo v1',
).versionId;
const sen = store.expandAtVersion(v1, { key: '森' }).result;
console.log('展开串:', sen.expandedIds);
console.log('原子叶计数:', sen.atomLeafCount, '（应为 3）');
console.log('展开后节点数:', sen.expandedNodeCount);
console.log('atomCounts:', sen.atomCounts);
console.log('三处木的路径与来源链:');
for (const occ of sen.occurrences) console.log(' ', occ);

line('2. 三元操作符 ⿲ 与 明=⿰日月');
const tri = parseIds('⿲木木木');
console.log('⿲ 孩子数:', tri.children.length, '（应为 3）');
const ming = store.expandAtVersion(v1, { ids: '⿰日月' }).result;
console.log('明 原子叶计数:', ming.atomLeafCount, '（应为 2）', ming.atomCounts);

line('3. 循环引用版本必须整体拒绝（A<->B）');
try {
  store.importVersion(
    [
      { key: 'A', ids: '⿰B木' },
      { key: 'B', ids: '⿱A日' },
    ],
    'cycle',
  );
  console.log('错误：环未被发现！');
} catch (e) {
  const err = e as DefError;
  console.log('拒绝:', err.code, err.message, err.details);
}

line('4. 共享子定义不是环：X、Y 都引用 林');
const v2 = store.importVersion(
  [
    { key: '林', ids: '⿰木木' },
    { key: 'X', ids: '⿱林日' },
    { key: 'Y', ids: '⿰月林' },
  ],
  'shared refs',
).versionId;
const x = store.expandAtVersion(v2, { key: 'X' }).result;
console.log('X 展开:', x.expandedIds, '木次数:', x.atomCounts['木']);

line('5. v3 新增“木”的定义：旧版本 v1 的冻结结果不变');
const v3 = store.importVersion(
  [
    { key: '木', ids: '⿰十八' },
    { key: '林', ids: '⿰木木' },
    { key: '森', ids: '⿱木林' },
  ],
  '木 被定义',
).versionId;
const senV3 = store.expandAtVersion(v3, { key: '森' }).result;
console.log('v3 森 原子:', senV3.atomCounts, '（十、八 各 3 次，无 木）');
const frozenV1 = store
  .listFrozen(v1)
  .map((r) => ({ id: r.id, kind: r.kind, complete: r.complete }));
console.log('v1 冻结查询数量:', frozenV1.length, '（新版本不影响旧结果）');

line('6. 边界：补充平面 / 缺操作数 / 多余尾字符');
const supp = parseIds('⿰𠔥木');
console.log('补充平面叶子 U+20525:', supp.children[0].char, supp.children[0].range);
for (const bad of ['⿰木', '⿰木木木', '木⿱']) {
  try {
    parseIds(bad);
    console.log(bad, '意外解析成功');
  } catch (e) {
    const err = e as { code: string; offset: number; message: string };
    console.log(`"${bad}" ->`, err.code, '@码点偏移', err.offset, err.message);
  }
}

line('7. 预算超限：指数级复制返回未完整展开，不落冻结结果');
{
  // 预算 50；a0->两个 a1->各两个 a2->... 指数复制，很快超限
  const tinyStore = new Store(':memory:', { ...DEFAULT_LIMITS, maxExpandedNodes: 50 });
  tinyStore.importVersion(
    [
      { key: 'a', ids: '⿰bb' },
      { key: 'b', ids: '⿰cc' },
      { key: 'c', ids: '⿰dd' },
      { key: 'd', ids: '⿰ee' },
      { key: 'e', ids: '⿰木木' },
    ],
    null,
  );
  const before = tinyStore.listFrozen(1).length;
  try {
    tinyStore.expandAtVersion(1, { key: 'a' });
  } catch (e) {
    const err = e as DefError;
    console.log('展开拒绝:', err.code, err.message);
  }
  const after = tinyStore.listFrozen(1).length;
  console.log('失败前后冻结结果数:', before, '->', after, '（不污染）');
}

store.close();
console.log('\n演示完成，数据库位于:', dbPath);
