#!/usr/bin/env node
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { Store } from './db';
import { parseIds, serialize, walk, IdsParseError } from './ids';
import { DefError, nodeAtPath, DEFAULT_LIMITS, DefinitionInput } from './definitions';

interface GlobalOpts {
  db: string;
}

function parseGlobal(argv: string[]): { opts: GlobalOpts; rest: string[] } {
  let db = resolve(process.env.DATA_DIR ?? 'data', 'ids.db');
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') db = argv[++i];
    else rest.push(argv[i]);
  }
  return { opts: { db }, rest };
}

function print(obj: unknown) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function fail(err: unknown): never {
  if (err instanceof IdsParseError) {
    print({ error: { code: err.code, message: err.message, offset: err.offset } });
  } else if (err instanceof DefError) {
    print({ error: { code: err.code, message: err.message, details: err.details } });
  } else {
    print({ error: { code: 'FAILED', message: (err as Error).message } });
  }
  process.exit(1);
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function readDefsArg(args: string[]): DefinitionInput[] {
  const file = flag(args, '--file');
  if (file) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(parsed.definitions) && !Array.isArray(parsed)) {
      throw new Error('--file 需要 JSON 数组或 {definitions:[...]}');
    }
    return Array.isArray(parsed) ? parsed : parsed.definitions;
  }
  const inline = flag(args, '--json');
  if (inline) return JSON.parse(inline);
  throw new Error('需要 --file <path> 或 --json \'[{"key":"林","ids":"⿰木木"}]\'');
}

function usage() {
  console.log(`ids — 汉字 IDS 部件树展开与引用来源核验 CLI

用法:
  ids parse --ids "⿲木木木"
  ids import --file defs.json [--note "v1"]
  ids import --json '[{"key":"林","ids":"⿰木木"}]'
  ids versions
  ids show <versionId>
  ids refs <versionId>
  ids expand <versionId> --key 森
  ids expand <versionId> --ids "⿰日月"
  ids counts <versionId> --key 森
  ids source <versionId> --key 森 --path "[1,0]"
  ids export <versionId> [--out tree.json]
  ids results <versionId>

全局选项: --db <path>   指定 SQLite 文件（默认 data/ids.db）
环境变量: DATA_DIR, PORT, HOST`);
}

function main() {
  const { opts, rest } = parseGlobal(process.argv.slice(2));
  const [cmd, ...args] = rest;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const store = new Store(opts.db, DEFAULT_LIMITS);

  try {
    switch (cmd) {
      case 'parse': {
        const ids = flag(args, '--ids');
        if (typeof ids !== 'string') throw new Error('需要 --ids');
        const tree = parseIds(ids, { maxDepth: DEFAULT_LIMITS.maxParseDepth });
        print({
          ids,
          tree,
          reserialized: serialize(tree),
          serializeOk: serialize(tree) === ids,
          spans: walk(tree).map((s) => ({
            path: s.path,
            kind: s.node.kind,
            char: s.node.char,
            range: s.node.range,
          })),
        });
        break;
      }
      case 'import': {
        const definitions = readDefsArg(args);
        const note = flag(args, '--note') ?? null;
        const { versionId } = store.importVersion(definitions, note);
        print({ versionId, definitionCount: definitions.length, refs: store.listRefs(versionId) });
        break;
      }
      case 'versions':
        print({ versions: store.listVersions() });
        break;
      case 'show': {
        const versionId = Number(args[0]);
        if (!store.getVersion(versionId)) throw new Error(`VERSION_NOT_FOUND:${versionId}`);
        print({
          version: store.getVersion(versionId),
          definitions: store
            .listDefinitions(versionId)
            .map((d) => ({ key: d.key, keyCp: d.key_cp, ids: d.ids, refs: JSON.parse(d.refs_json) })),
        });
        break;
      }
      case 'refs': {
        const versionId = Number(args[0]);
        print({ versionId, refs: store.listRefs(versionId) });
        break;
      }
      case 'expand': {
        const versionId = Number(args[0]);
        const key = flag(args, '--key');
        const ids = flag(args, '--ids');
        const { result, frozenId } = store.expandAtVersion(versionId, { key, ids });
        print({ versionId, frozenId, ...result });
        break;
      }
      case 'counts': {
        const versionId = Number(args[0]);
        const key = flag(args, '--key');
        const ids = flag(args, '--ids');
        const { result } = store.expandAtVersion(versionId, { key, ids });
        print({
          stage: 'expanded',
          atomLeafCount: result.atomLeafCount,
          expandedNodeCount: result.expandedNodeCount,
          atomCounts: result.atomCounts,
        });
        break;
      }
      case 'source': {
        const versionId = Number(args[0]);
        const key = flag(args, '--key');
        const ids = flag(args, '--ids');
        const path = JSON.parse(flag(args, '--path') ?? '[]') as number[];
        const { result } = store.expandAtVersion(versionId, { key, ids });
        const node = nodeAtPath(result.expanded, path);
        print({
          path,
          node,
          occurrence:
            result.occurrences.find(
              (o) => o.atom === node.char && JSON.stringify(o.path) === JSON.stringify(path),
            ) ?? null,
        });
        break;
      }
      case 'export': {
        const versionId = Number(args[0]);
        const key = flag(args, '--key');
        const ids = flag(args, '--ids');
        const { result } = store.expandAtVersion(versionId, { key, ids });
        const payload = {
          versionId,
          stage: 'expanded',
          rootKey: result.rootKey,
          expandedIds: result.expandedIds,
          tree: result.expanded,
          atomCounts: result.atomCounts,
          occurrences: result.occurrences,
        };
        const out = flag(args, '--out');
        if (out) {
          writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
          print({ exported: out, ...payload });
        } else {
          print(payload);
        }
        break;
      }
      case 'results': {
        const versionId = Number(args[0]);
        print({ frozen: store.listFrozen(versionId) });
        break;
      }
      default:
        usage();
        process.exit(2);
    }
  } catch (err) {
    fail(err);
  } finally {
    store.close();
  }
}

main();
