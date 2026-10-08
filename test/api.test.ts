import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, listenOnFreePort } from '../src/server';

async function setup() {
  const path = resolve(tmpdir(), `ids-api-${process.pid}-${Date.now()}.db`);
  const { server, store } = createApp({ dbPath: path, port: 0, host: '127.0.0.1' });
  const port = await listenOnFreePort(server, undefined, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    close: async () => {
      server.close();
      store.close();
      rmSync(path, { force: true });
    },
  };
}

test('HTTP 端到端：导入/解析/展开/计数/来源/冻结', async () => {
  const env = await setup();
  try {
    const res = await fetch(`${env.base}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definitions: [
          { key: '林', ids: '⿰木木' },
          { key: '森', ids: '⿱木林' },
        ],
      }),
    });
    assert.equal(res.status, 201);
    const { versionId } = (await res.json()) as { versionId: number };

    const parse = (await (
      await fetch(`${env.base}/ids/parse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: '⿲木木木' }),
      })
    ).json()) as any;
    assert.equal(parse.tree.children.length, 3);
    assert.equal(parse.reserialized, '⿲木木木');

    const expanded = (await (
      await fetch(`${env.base}/versions/${versionId}/expand`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '森' }),
      })
    ).json()) as any;
    assert.equal(expanded.atomLeafCount, 3);
    assert.equal(expanded.expandedIds, '⿱木⿰木木');

    const source = (await (
      await fetch(`${env.base}/versions/${versionId}/source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: '森', path: [1, 0] }),
      })
    ).json()) as any;
    assert.equal(source.node.char, '木');
    assert.deepEqual(source.occurrence.sourceChain, ['森', '林']);

    const results = (await (await fetch(`${env.base}/versions/${versionId}/results`)).json()) as any;
    assert.ok(results.frozen.length >= 1);
  } finally {
    await env.close();
  }
});

test('HTTP 错误码：未知操作符/环/未定义键/预算', async () => {
  const env = await setup();
  try {
    let r = await fetch(`${env.base}/ids/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: '⿾木' }),
    });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as any).error.code, 'UNKNOWN_OPERATOR');

    r = await fetch(`${env.base}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        definitions: [
          { key: 'A', ids: '⿰B木' },
          { key: 'B', ids: '⿱A日' },
        ],
      }),
    });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as any).error.code, 'CYCLE_DETECTED');

    r = await fetch(`${env.base}/versions/999/expand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'X' }),
    });
    assert.equal(r.status, 404);
    assert.equal(((await r.json()) as any).error.code, 'VERSION_NOT_FOUND');
  } finally {
    await env.close();
  }
});
