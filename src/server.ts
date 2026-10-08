import { createServer, Server, IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import { Store } from './db';
import { parseIds, serialize, walk, IdsParseError, sliceByRange } from './ids';
import {
  DefError,
  expand,
  nodeAtPath,
  DefinitionInput,
  DEFAULT_LIMITS,
} from './definitions';

export interface AppConfig {
  dbPath: string;
  port: number;
  host: string;
}

interface JsonError {
  error: { code: string; message: string; details?: unknown };
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function mapError(err: unknown): { status: number; body: JsonError } {
  if (err instanceof IdsParseError) {
    return {
      status: 400,
      body: { error: { code: err.code, message: err.message, details: { offset: err.offset } } },
    };
  }
  if (err instanceof DefError) {
    const status =
      err.code === 'BUDGET_EXCEEDED'
        ? 422
        : err.code === 'UNDEFINED_KEY'
          ? 404
          : 400;
    return {
      status,
      body: { error: { code: err.code, message: err.message, details: err.details } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message.startsWith('UNDEFINED_KEY:')) {
    return { status: 404, body: { error: { code: 'UNDEFINED_KEY', message } } };
  }
  if (message.startsWith('VERSION_NOT_FOUND:')) {
    return { status: 404, body: { error: { code: 'VERSION_NOT_FOUND', message } } };
  }
  if (message.startsWith('BAD_REQUEST')) {
    return { status: 400, body: { error: { code: 'BAD_REQUEST', message } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message } } };
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > 8 * 1024 * 1024) {
      const err = new Error('BAD_REQUEST: 请求体超过 8 MiB');
      throw err;
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('BAD_REQUEST: JSON 解析失败');
  }
}

export function createApp(config: AppConfig): { server: Server; store: Store } {
  const store = new Store(config.dbPath, DEFAULT_LIMITS);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/health') {
        send(res, 200, { ok: true, service: 'ids-tree-backend' });
        return;
      }

      if (method === 'GET' && path === '/versions') {
        send(res, 200, { versions: store.listVersions() });
        return;
      }

      if (method === 'POST' && path === '/versions') {
        const body = await readJson(req);
        const definitions: DefinitionInput[] = body.definitions;
        if (!Array.isArray(definitions)) {
          throw new Error('BAD_REQUEST: definitions 必须是 [{key, ids}] 数组');
        }
        const note = typeof body.note === 'string' ? body.note : null;
        const { versionId } = store.importVersion(definitions, note);
        send(res, 201, {
          versionId,
          definitionCount: definitions.length,
          refs: store.listRefs(versionId),
        });
        return;
      }

      const versionMatch = path.match(/^\/versions\/(\d+)(\/.*)?$/);
      if (method === 'GET' && versionMatch && (!versionMatch[2] || versionMatch[2] === '/')) {
        const versionId = Number(versionMatch[1]);
        const version = store.getVersion(versionId);
        if (!version) throw new Error(`VERSION_NOT_FOUND:${versionId}`);
        send(res, 200, {
          version,
          definitions: store.listDefinitions(versionId).map((d) => ({
            key: d.key,
            keyCp: d.key_cp,
            ids: d.ids,
            tree: JSON.parse(d.tree_json),
            refs: JSON.parse(d.refs_json),
          })),
          refs: store.listRefs(versionId),
        });
        return;
      }

      // POST /ids/parse 不依赖版本
      if (method === 'POST' && path === '/ids/parse') {
        const body = await readJson(req);
        if (typeof body.ids !== 'string') throw new Error('BAD_REQUEST: 需要字符串字段 ids');
        const tree = parseIds(body.ids, { maxDepth: DEFAULT_LIMITS.maxParseDepth });
        const resp = serialize(tree);
        if (resp !== body.ids) {
          throw new Error('SERIALIZE_MISMATCH: 重序列化与输入不一致');
        }
        send(res, 200, {
          ids: body.ids,
          tree,
          reserialized: resp,
          nodeCount: walk(tree).length,
        });
        return;
      }

      if (method === 'POST' && versionMatch && versionMatch[2] === '/expand') {
        const versionId = Number(versionMatch[1]);
        const body = await readJson(req);
        const { result, frozenId } = store.expandAtVersion(versionId, {
          key: body.key,
          ids: body.ids,
        });
        send(res, 200, { versionId, frozenId, ...result });
        return;
      }

      if (method === 'GET' && versionMatch && versionMatch[2] === '/results') {
        const versionId = Number(versionMatch[1]);
        if (!store.getVersion(versionId)) throw new Error(`VERSION_NOT_FOUND:${versionId}`);
        send(res, 200, { frozen: store.listFrozen(versionId) });
        return;
      }

      if (method === 'POST' && versionMatch && versionMatch[2] === '/source') {
        const versionId = Number(versionMatch[1]);
        const body = await readJson(req);
        const { result } = store.expandAtVersion(versionId, { key: body.key, ids: body.ids });
        const pathArr: number[] = Array.isArray(body.path) ? body.path : [];
        if (!pathArr.every((n) => Number.isInteger(n) && n >= 0)) {
          throw new Error('BAD_REQUEST: path 必须是非负整数数组');
        }
        const node = nodeAtPath(result.expanded, pathArr);
        const occ = result.occurrences.find(
          (o) => o.atom === node.char && JSON.stringify(o.path) === JSON.stringify(pathArr),
        );
        send(res, 200, {
          path: pathArr,
          node,
          occurrence: occ ?? null,
          note: '中间节点（操作符）没有原子来源；occurrence 仅对原子叶子存在',
        });
        return;
      }

      send(res, 404, { error: { code: 'NOT_FOUND', message: `无此路由：${method} ${path}` } });
    } catch (err) {
      const { status, body } = mapError(err);
      send(res, status, body);
    }
  });

  return { server, store };
}

/** 请求一个空闲端口：先监听 0，再取实际端口 */
export function listenOnFreePort(
  server: Server,
  preferredPort: number | undefined,
  host: string,
): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.once('error', reject);
    if (preferredPort && preferredPort > 0) {
      server.listen(preferredPort, host, () => {
        resolvePort((server.address() as { port: number }).port);
      });
    } else {
      server.listen(0, host, () => {
        resolvePort((server.address() as { port: number }).port);
      });
    }
  });
}

function pickPortFromArg(): number | undefined {
  const idx = process.argv.indexOf('--port');
  if (idx >= 0 && process.argv[idx + 1]) return Number(process.argv[idx + 1]);
  const envPort = Number(process.env.PORT);
  return Number.isFinite(envPort) && envPort > 0 ? envPort : undefined;
}

async function main() {
  const host = process.env.HOST ?? '127.0.0.1';
  const dbPath = resolve(process.env.DATA_DIR ?? 'data', 'ids.db');
  const { server } = createApp({ dbPath, port: 0, host });
  const port = await listenOnFreePort(server, pickPortFromArg(), host);
  console.log(`IDS 后端已启动: http://${host}:${port}`);
  console.log(`数据目录数据库: ${dbPath}`);
  console.log('按 Ctrl+C 退出');
  void networkInterfaces;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
