import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/db';
import { DefError, DEFAULT_LIMITS } from '../src/definitions';

function tmpDb(name: string) {
  return resolve(tmpdir(), `ids-test-${name}-${process.pid}-${Date.now()}.db`);
}

test('新版本新增定义不改变旧版本冻结结果', () => {
  const path = tmpDb('versions');
  const store = new Store(path);
  const v1 = store.importVersion(
    [
      { key: '林', ids: '⿰木木' },
      { key: '森', ids: '⿱木林' },
    ],
    'v1',
  ).versionId;
  const r1 = store.expandAtVersion(v1, { key: '森' }).result;
  assert.equal(r1.atomCounts['木'], 3);

  const v2 = store.importVersion(
    [
      { key: '木', ids: '⿰十八' },
      { key: '林', ids: '⿰木木' },
      { key: '森', ids: '⿱木林' },
    ],
    'v2 木被定义',
  ).versionId;
  const r2 = store.expandAtVersion(v2, { key: '森' }).result;
  assert.equal(r2.atomCounts['木'], undefined);
  assert.equal(r2.atomCounts['十'], 3);
  assert.equal(r2.atomCounts['八'], 3);

  const frozen = store.listFrozen(v1);
  const stored = JSON.parse(frozen[0].result_json) as typeof r1;
  assert.equal(stored.atomCounts['木'], 3, '旧版本冻结结果必须原样保留');
  store.close();
  rmSync(path, { force: true });
});

test('预算失败不写入冻结结果、不污染版本', () => {
  const path = tmpDb('budget');
  const store = new Store(path, { ...DEFAULT_LIMITS, maxExpandedNodes: 4 });
  const v = store.importVersion(
    [
      { key: 'a', ids: '⿰bb' },
      { key: 'b', ids: '⿰木木' },
    ],
    null,
  ).versionId;
  assert.throws(() => store.expandAtVersion(v, { key: 'a' }), DefError);
  assert.equal(store.listFrozen(v).length, 0);
  store.close();
  rmSync(path, { force: true });
});

test('有环版本整体拒绝，不产生版本号', () => {
  const path = tmpDb('cycle');
  const store = new Store(path);
  const before = store.listVersions().length;
  assert.throws(
    () =>
      store.importVersion(
        [
          { key: 'A', ids: '⿰B木' },
          { key: 'B', ids: '⿱A日' },
        ],
        null,
      ),
    DefError,
  );
  assert.equal(store.listVersions().length, before);
  store.close();
  rmSync(path, { force: true });
});

test('重启后可重新读取版本、定义、引用图与冻结结果', () => {
  const path = tmpDb('restart');
  let store = new Store(path);
  const v = store.importVersion(
    [
      { key: '林', ids: '⿰木木' },
      { key: '森', ids: '⿱木林' },
    ],
    null,
  ).versionId;
  store.expandAtVersion(v, { key: '森' });
  store.close();

  assert.ok(existsSync(path));
  store = new Store(path);
  assert.ok(store.getVersion(v));
  const defs = store.loadVersionDefs(v);
  assert.deepEqual(defs.get('林')?.refs, []);
  assert.deepEqual(defs.get('森')?.refs, ['林']);
  const again = store.expandAtVersion(v, { key: '森' }).result;
  assert.equal(again.atomLeafCount, 3);
  assert.equal(store.listFrozen(v).length, 2);
  store.close();
  rmSync(path, { force: true });
});

test('补充平面定义键与码点存储', () => {
  const path = tmpDb('supp');
  const store = new Store(path);
  const v = store.importVersion([{ key: '𠔥', ids: '⿰木木' }], null).versionId;
  const row = store.listDefinitions(v)[0];
  assert.equal(row.key_cp, 0x20525);
  const r = store.expandAtVersion(v, { key: '𠔥' }).result;
  assert.equal(r.atomCounts['木'], 2);
  store.close();
  rmSync(path, { force: true });
});

test('展开不存在的键返回 UNDEFINED_KEY；未定义叶子不是缺失字典', () => {
  const path = tmpDb('missing');
  const store = new Store(path);
  const v = store.importVersion([{ key: '林', ids: '⿰木木' }], null).versionId;
  assert.throws(() => store.expandAtVersion(v, { key: '无' }), /UNDEFINED_KEY/);
  const r = store.expandAtVersion(v, { key: '林' }).result;
  assert.equal(r.atomLeafCount, 2);
  store.close();
  rmSync(path, { force: true });
});
