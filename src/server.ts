// HTTP API 服务：仅使用 node:http，无外部依赖。
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { IdsStore } from "./store.js";
import { IdsService } from "./service.js";
import { IdsError } from "./ids.js";

export interface ServerOptions {
  port?: number; // 0 或缺省表示自动选择空闲端口
  dbPath?: string;
  maxNodes?: number;
  maxDepth?: number;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function sendError(res: http.ServerResponse, e: unknown): void {
  const anyErr = e as { code?: string; message?: string; position?: number };
  const code = anyErr?.code ?? "INTERNAL_ERROR";
  const status =
    code === "KEY_NOT_DEFINED" || code === "PATH_NOT_FOUND" || code === "NO_VERSION"
      ? 404
      : code === "INTERNAL_ERROR"
        ? 500
        : 400;
  send(res, status, {
    error: { code, message: anyErr?.message ?? String(e), position: anyErr?.position },
  });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

export async function startServer(options: ServerOptions = {}) {
  const dbPath = options.dbPath ?? path.join(process.cwd(), "data", "ids.db");
  const store = new IdsStore(dbPath);
  const service = new IdsService(store, {
    maxNodes: options.maxNodes,
    maxDepth: options.maxDepth,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const route = `${req.method} ${url.pathname}`;
      const versionParam = url.searchParams.get("version");
      const versionId = versionParam ? Number(versionParam) : undefined;

      if (route === "GET /health") {
        return send(res, 200, { ok: true });
      }
      if (route === "POST /versions") {
        const body = (await readBody(req)) as { definitions?: { key: string; ids: string }[] };
        if (!Array.isArray(body.definitions)) {
          throw Object.assign(new Error("请求体需要 definitions 数组"), { code: "BAD_REQUEST" });
        }
        return send(res, 201, service.importVersion(body.definitions));
      }
      if (route === "GET /versions") {
        return send(res, 200, { versions: store.listVersions() });
      }
      if (route === "GET /definitions") {
        return send(res, 200, { definitions: store.listDefinitions(versionId) });
      }
      if (route === "POST /parse") {
        const body = (await readBody(req)) as { ids?: string };
        if (typeof body.ids !== "string") {
          throw Object.assign(new Error("请求体需要 ids 字符串"), { code: "BAD_REQUEST" });
        }
        return send(res, 200, service.parse(body.ids, versionId));
      }
      if (route === "GET /refs/check") {
        return send(res, 200, service.checkRefs(versionId));
      }
      const expandMatch = url.pathname.match(/^\/expand\/(.+)$/u);
      if (req.method === "GET" && expandMatch) {
        return send(res, 200, service.expand(decodeURIComponent(expandMatch[1]), versionId));
      }
      const countsMatch = url.pathname.match(/^\/counts\/(.+)$/u);
      if (req.method === "GET" && countsMatch) {
        return send(res, 200, service.counts(decodeURIComponent(countsMatch[1]), versionId));
      }
      const sourceMatch = url.pathname.match(/^\/source\/(.+)$/u);
      if (req.method === "GET" && sourceMatch) {
        const pathParam = url.searchParams.get("path");
        if (!pathParam) {
          throw Object.assign(new Error("需要 path 查询参数，如 ?path=1,0"), { code: "BAD_REQUEST" });
        }
        const p = pathParam.split(",").filter((s) => s !== "").map((s) => {
          const n = Number(s);
          if (!Number.isInteger(n) || n < 0) {
            throw Object.assign(new Error("path 必须是非负整数列表"), { code: "BAD_REQUEST" });
          }
          return n;
        });
        return send(res, 200, service.sourceAt(decodeURIComponent(sourceMatch[1]), p, versionId));
      }
      const exportMatch = url.pathname.match(/^\/export\/(.+)$/u);
      if (req.method === "GET" && exportMatch) {
        return send(res, 200, service.exportTree(decodeURIComponent(exportMatch[1]), versionId));
      }
      if (route === "GET /queries") {
        return send(res, 200, { queries: store.listQueries(versionId) });
      }
      return send(res, 404, { error: { code: "NOT_FOUND", message: "未知路由" } });
    } catch (e) {
      if (e instanceof SyntaxError) {
        return send(res, 400, { error: { code: "BAD_JSON", message: "请求体不是合法 JSON" } });
      }
      if (e instanceof IdsError) return sendError(res, e);
      return sendError(res, e);
    }
  });

  const port = options.port ?? (await findFreePort());
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address() as net.AddressInfo;
  return { server, port: addr.port, store, service, dbPath };
}
