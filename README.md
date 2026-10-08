# 汉字 IDS 部件树展开与引用来源核验后端

纯本地运行的表意描述序列（IDS）分析服务，只做 API 与 CLI。输入人工提供的字形部件定义，解析前缀结构、递归展开引用并统计原子部件。只处理符号结构：不生成字体、不识别图片、不推断笔顺、读音或真实字源，也不下载任何汉字数据库。

## 环境要求

- Windows 本地，Node.js 22 及以上（使用内置 node:sqlite，无需原生编译、Docker、WSL 或任何外部服务）
- 除 typescript 与 @types/node（开发依赖）外无运行时依赖

## 快速开始

```powershell
npm install
npm run build
npm test
npm run demo
npm start
```

- `npm run build`：编译 TypeScript 到 `dist/`
- `npm test`：构建并运行全部测试
- `npm run demo`：演示导入 林/森/明/三，展开、计数、来源、循环拒绝
- `npm start`：启动 HTTP API（缺省自动选择空闲端口并打印地址）

CLI 直接使用：

```powershell
node dist/src/cli.js serve --port 8080
node dist/src/cli.js import demo/definitions.json
node dist/src/cli.js parse "⿱木林"
node dist/src/cli.js expand 森
node dist/src/cli.js counts 森
node dist/src/cli.js source 森 1,0
node dist/src/cli.js export 森
node dist/src/cli.js check-refs
node dist/src/cli.js versions
```

通用参数：`--db <路径>`（默认 `data/ids.db`，项目内数据目录）、`--version <版本号>`、`--max-nodes <展开预算>`、`--port <端口>`（仅 serve）。

## IDS 子集说明

- 二元操作符：⿰ ⿱ ⿴ ⿵ ⿶ ⿷ ⿸ ⿹ ⿺ ⿻，各跟 2 个子表达式。
- 三元操作符：⿲ ⿳，各跟 3 个子表达式。
- U+2FF0–U+2FFF 与 U+31EF 中的其余操作符明确拒绝（错误码 `IDS_UNKNOWN_OPERATOR`）。
- 叶子为任意单个 Unicode 标量字符（汉字或教学用字母均可）；不接受空白、孤立代理项、操作符作叶子。不判断叶子在真实汉字学里是否合格。
- 解析按 Unicode 码点进行（代理对如 𠀀 算一个位置），错误位置是从零开始的码点偏移，不是 UTF-16 代码单元下标。
- 必须恰好消费整条输入：缺操作数（`IDS_MISSING_OPERAND`）、根表达式后多余内容（`IDS_TRAILING_CONTENT`）、未知操作符分别诊断；不会把相邻叶子自动补成左右结构来修复坏输入。
- 每个节点保存原文区间，重序列化严格恢复原字符串（导入时校验）。

## 原子与展开的含义

- 定义库每条记录 = 单码点键 + 一棵合法 IDS 树。树中叶子若等于某个定义键，展开时被该定义树替换；未定义的叶子即原子，不是缺失字典错误。
- 导入即生成新版本：先对整个引用图做环检测（含自环），有环返回一条真实引用链并拒绝整个版本；多个父节点共享同一子定义不算环。
- 展开结果包含：原子叶计数、展开后节点数、每个叶出现的路径（从根开始的子节点零基索引数组）与完整定义来源链。同一原子在多个位置分别统计。
- 查询结果区分阶段：`parsed`（原树，复合部件名在叶子层）与 `expanded`（完全展开树，只剩原子），两者不会混层计数。
- 新增定义可能使原来的原子变成可展开部件，因此生成新版本；旧版本的查询结果被冻结（存于 queries 表），不会自动改变。
- 预算限制：定义数上限 10000、解析深度 64、展开节点预算 100000（可配）。超过预算时返回 `complete: false` 与原因，截断树不会被当作完整结果，且失败导入不会污染旧版本（事务回滚）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/versions` | 导入定义版本，body 为 `{"definitions":[{"key":"林","ids":"⿰木木"}]}` |
| GET | `/versions` | 版本列表 |
| GET | `/definitions` | 当前（或 `?version=`）版本定义 |
| POST | `/parse` | 解析单条 IDS，body 为 `{"ids":"⿱木林"}` |
| GET | `/refs/check` | 引用环检查 |
| GET | `/expand/<key>` | 完全展开指定键 |
| GET | `/counts/<key>` | 原子部件计数 |
| GET | `/source/<key>?path=1,0` | 按路径查询来源链 |
| GET | `/export/<key>` | 导出原树与展开树 |
| GET | `/queries` | 冻结的查询结果 |

错误响应统一为 `{"error":{"code","message","position?"}}`，主要错误码：`IDS_*`（解析）、`CYCLE_DETECTED`、`KEY_NOT_DEFINED`、`PATH_NOT_FOUND`、`NO_VERSION`、`TOO_MANY_DEFINITIONS`、`INVALID_KEY`、`BAD_REQUEST`。

## 项目结构

- `src/ids.ts`：IDS 前缀解析器（码点级、带原文区间、可重序列化）
- `src/expand.ts`：引用展开、来源链、独立遍历校验、环检测
- `src/store.ts`：SQLite 存储（版本、定义、语法树、引用图、冻结查询）
- `src/service.ts`：API 与 CLI 共用业务逻辑
- `src/server.ts`：HTTP API（node:http，默认自动选空闲端口）
- `src/cli.ts`：命令行入口
- `test/ids.test.ts`：17 个测试（含补充平面、缺操作数、共享子定义、版本冻结、重启读取等）
- `demo/definitions.json`、`scripts/demo.js`：演示数据与脚本

## 已知限制

- node:sqlite 在 Node 25 仍标记为实验特性（启动时有 ExperimentalWarning，功能可用）。
- 展开预算截断时用占位叶 `�` 标记截断点并返回 `complete: false`，不做续展。
- 服务仅监听 127.0.0.1，无认证，面向本机使用。
