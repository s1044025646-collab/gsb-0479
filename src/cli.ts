// CLI 入口：node dist/src/cli.js <command> [...args]
import path from "node:path";
import { readFileSync } from "node:fs";
import { IdsStore } from "./store.js";
import { IdsService } from "./service.js";
import { startServer } from "./server.js";

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function print(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const dbPath = argValue(args, "db") ?? path.join(process.cwd(), "data", "ids.db");
  const versionArg = argValue(args, "version");
  const versionId = versionArg ? Number(versionArg) : undefined;
  const maxNodesArg = argValue(args, "max-nodes");
  const maxNodes = maxNodesArg ? Number(maxNodesArg) : undefined;

  if (cmd === "serve") {
    const portArg = argValue(args, "port");
    const started = await startServer({
      port: portArg ? Number(portArg) : undefined,
      dbPath,
      maxNodes,
    });
    console.log(`IDS 服务已启动: http://127.0.0.1:${started.port} (数据库: ${dbPath})`);
    return;
  }

  const store = new IdsStore(dbPath);
  const service = new IdsService(store, { maxNodes });
  try {
    switch (cmd) {
      case "import": {
        const file = args[1];
        if (!file) throw new Error("用法: import <definitions.json> [--db path]");
        const defs = JSON.parse(readFileSync(file, "utf8"));
        print(service.importVersion(Array.isArray(defs) ? defs : defs.definitions));
        break;
      }
      case "parse": {
        print(service.parse(args[1], versionId));
        break;
      }
      case "check-refs": {
        print(service.checkRefs(versionId));
        break;
      }
      case "expand": {
        print(service.expand(args[1], versionId));
        break;
      }
      case "counts": {
        print(service.counts(args[1], versionId));
        break;
      }
      case "source": {
        const p = args[2].split(",").filter(Boolean).map(Number);
        print(service.sourceAt(args[1], p, versionId));
        break;
      }
      case "export": {
        print(service.exportTree(args[1], versionId));
        break;
      }
      case "versions": {
        print(store.listVersions());
        break;
      }
      case "definitions": {
        print(store.listDefinitions(versionId));
        break;
      }
      default:
        console.error("未知命令: " + (cmd ?? "(空)"));
        console.error("可用命令: serve | import <file> | parse <ids> | check-refs | expand <key> | counts <key> | source <key> <path> | export <key> | versions | definitions");
        console.error("通用参数: --db <路径> --version <版本号> --max-nodes <预算> --port <端口>");
        process.exitCode = 1;
    }
  } catch (e) {
    const anyErr = e as { code?: string; message?: string; position?: number };
    console.error(
      JSON.stringify({
        error: { code: anyErr.code ?? "ERROR", message: anyErr.message, position: anyErr.position },
      })
    );
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main();
