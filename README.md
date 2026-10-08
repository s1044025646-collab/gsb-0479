# 汉字 IDS 部件树展开与引用来源核验后端

本地运行的**表意描述序列（IDS, Ideographic Description Sequence）符号结构分析服务**。
只做两件事：

1. 按码点解析人工提供的 IDS 前缀表达式，得到**带有序子节点的结构树**；
2. 在“定义库版本”上递归展开部件引用，统计**原子部件**并核验每个原子的**来源链与路径**。

只处理符号结构：**不生成字体、不识别图片、不推断笔顺、读音或真实字源，也不下载任何在线汉字数据库**。

- 语言/运行时：TypeScript + Node.js（需 Node ≥ 22.5，开发机为 Node 25）
- 存储：SQLite，使用 Node 内置 `node:sqlite`，**无需本机编译、无原生依赖**
- 形态：仅 HTTP API 与 CLI，无前端、无 Docker、无 WSL、无付费/在线服务

---

## 1. 支持的 IDS 子集与“原子”含义

### 操作符（按元数严格匹配）

| 元数 | 操作符 |
| --- | --- |
| 二元（后跟 2 个子表达式） | `⿰ ⿱ ⿴ ⿵ ⿶ ⿷ ⿸ ⿹ ⿺ ⿻` |
| 三元（后跟 3 个子表达式） | `⿲ ⿳` |

- 操作符按**前缀表达式**解析：操作符后紧跟其元数要求数量的子表达式。
- `U+2FF0–U+2FFF` 及 `U+31EF` 区段中**未在上表列出**的符号（如 `⿾ U+2FFE`、`⿿ U+2FFF`、`㇯ U+31EF`）一律以 `UNKNOWN_OPERATOR` **明确拒绝**，不会被当成叶子。
- **不会**把相邻叶子自动补成左右结构等任何“容错修复”；坏输入直接报错。

### 叶子

- 叶子是**一个 Unicode 标量字符**，可以是汉字（含补充平面，如 `𠔥 U+20525`）或教学用字母（如 `A`、`a`）。
- 不接受空白、孤立代理项、作为叶子的操作符。
- 除上述限制外，**不判断该叶子在真实汉字学里是否合格**。

### 码点边界（重要）

- 解析按 **Unicode 码点**切分，而不是 JavaScript 的 UTF-16 代码单元下标；补充平面字符只算 1 个码点。
- 诊断位置（`offset`）与每个节点的原文区间 `range` 使用**从零开始的码点偏移**。
- 整棵树必须**恰好消费整条输入**：
  - 操作数不足 → `MISSING_OPERAND`
  - 根表达式之后还有多余内容 → `UNEXPECTED_TRAILING`
  - 未知操作符 → `UNKNOWN_OPERATOR`
  - 空白/孤立代理叶子 → `UNSUPPORTED_LEAF`
  - 空输入 → `EMPTY_INPUT`；超过深度上限 → `DEPTH_LIMIT`
- 树可无损重序列化（`serialize`），恢复出的字符串与原 IDS 完全一致。

### 定义、引用与“原子”

- 定义库一条记录 = **单码点键 + 一棵合法 IDS 树**（如 `林 = ⿰木木`）。
- 完全展开时，树中的叶子若等于某条定义键，则用该定义树**替换**；
  **未定义的叶子即“原子”**（atom），例如库中不定义 `木`，则 `木` 是原子，**不会报“缺失字典”**。
- 原子计数只在**完全展开阶段**统计；原树里的复合部件名不会与其原子后代混在同一层计数。
- 同一原子在多个位置出现会**分别计数**；多个父节点可共享同一子定义，这是复用，不是循环。

---

## 2. 环检测与版本冻结

- 每个版本导入前先对完整引用图做 DFS 三色环检测，**包括自引用**。
- 发现环则**拒绝整个版本**（不写入任何版本号），并返回一条真实闭环引用链，
  例如 `A -> B -> A`。不会因为某条定义“暂时没被查询”而放行。
- 新增定义可能让原来的原子变成可展开部件（例如后来定义了 `木=⿰十八`），
  因此任何变更都生成**新版本**；查询结果在产生时**冻结**入库，新版本绝不回改旧结果。

## 3. 展开、路径、来源链与预算

- 展开保留操作符与子节点顺序，返回：
  - `atomLeafCount`：原子叶子总数
  - `expandedNodeCount`：展开后总节点数
  - `atomCounts`：按原子字符聚合的出现次数
  - `occurrences`：每个原子一次出现的 `{ atom, path, sourceChain }`
    - `path`：从展开树根开始的子节点**零基索引数组**
    - `sourceChain`：完整定义来源链（从查询键起，沿途经过的定义键）
- 每处引用都深拷贝为独立子树，不用“只展开一次”的缓存顶替，因此指数级复用会被如实计数。
- 限制（`src/definitions.ts` 的 `DEFAULT_LIMITS`，可改）：
  - 定义数上限 `5000`，解析深度 `64`，展开节点预算 `200000`。
  - 展开超过预算 → `BUDGET_EXCEEDED`（HTTP 422），结果**未完整展开**，且**不落冻结结果、不污染该版本**。

---

## 4. 目录结构

```
src/
  ids.ts          IDS 码点解析器（操作符元数、区间、序列化）
  definitions.ts  定义库、键校验、引用图环检测、递归展开与来源链
  db.ts           SQLite：版本/原始定义/语法树/引用图/冻结查询结果
  server.ts       HTTP API（默认监听空闲端口）
  cli.ts          命令行
test/             node:test 测试（解析/展开/存储/HTTP，24 个用例）
scripts/demo.ts   端到端演示
examples/         演示用定义 JSON
data/             项目内数据目录（SQLite 文件，生成物已 gitignore）
```

SQLite 表：`versions`、`definitions`（原始 IDS + 有序语法树 JSON + 引用列表）、
`refs`（引用图边）、`frozen_results`（冻结查询结果）。

---

## 5. 安装与常用命令（Windows PowerShell）

```powershell
npm install
npm run build      # 类型检查并编译到 dist/
npm test           # 编译 test 配置并运行 node:test
npm run demo       # 端到端演示（生成 data/demo.db）
npm start          # 启动 HTTP 服务（默认选空闲端口）
```

开发时可不编译直接跑：

```powershell
npm run dev                         # tsx 直启服务
npm run cli -- parse --ids "⿲木木木"
npx tsx scripts/demo.ts
```

### 端口与数据目录

- 不传端口时，服务监听 `0` 由系统分配**空闲端口**，启动日志打印实际地址。
- 指定端口：`npm start -- --port 8080`，或环境变量 `PORT=8080`。
- 监听地址：`HOST`（默认 `127.0.0.1`）；数据库：`DATA_DIR`（默认项目内 `data/ids.db`）。

---

## 6. CLI 用法

```powershell
node dist/cli.js parse --ids "⿲木木木"
node dist/cli.js import --file examples/demo-v1.json --note "v1"
node dist/cli.js import --json '[{"key":"林","ids":"⿰木木"}]'
node dist/cli.js versions
node dist/cli.js show 1
node dist/cli.js refs 1
node dist/cli.js expand 1 --key 森
node dist/cli.js expand 1 --ids "⿰日月"
node dist/cli.js counts 1 --key 森
node dist/cli.js source 1 --key 森 --path "[1,0]"
node dist/cli.js export 1 --key 森 --out data/tree.json
node dist/cli.js results 1
```

全局选项 `--db <path>` 可指定别的 SQLite 文件。

---

## 7. HTTP API

所有请求/响应均为 JSON；错误体形如 `{"error":{"code","message","details"}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/ids/parse` | 解析单条 IDS，返回树、重序列化、节点数 |
| GET | `/versions` | 列出所有版本 |
| POST | `/versions` | 导入一个新版本，体：`{"definitions":[{"key","ids"}],"note"?}` |
| GET | `/versions/{id}` | 版本详情：定义、有序树、引用图 |
| POST | `/versions/{id}/expand` | 展开，体：`{"key":"森"}` 或 `{"ids":"⿰日月"}` |
| POST | `/versions/{id}/source` | 按路径查来源，体：`{"key":"森","path":[1,0]}` |
| GET | `/versions/{id}/results` | 查看该版本冻结查询结果 |

示例：

```powershell
$b = 'http://127.0.0.1:<端口>'
Invoke-RestMethod "$b/versions" -Method Post -ContentType 'application/json; charset=utf-8' `
  -Body '{"definitions":[{"key":"林","ids":"⿰木木"},{"key":"森","ids":"⿱木林"}]}'
Invoke-RestMethod "$b/versions/1/expand" -Method Post -ContentType 'application/json; charset=utf-8' `
  -Body '{"key":"森"}'
```

### 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `EMPTY_INPUT / UNKNOWN_OPERATOR / MISSING_OPERAND / UNEXPECTED_TRAILING / UNSUPPORTED_LEAF / DEPTH_LIMIT` | IDS 解析问题（`details.offset` 为码点偏移） |
| 400 | `INVALID_KEY / DUPLICATE_KEY / IDS_PARSE_ERROR / TOO_MANY_DEFINITIONS / CYCLE_DETECTED` | 定义/版本问题；环错误附 `details.chain` |
| 404 | `UNDEFINED_KEY / VERSION_NOT_FOUND` | 展开未知键 / 版本不存在 |
| 422 | `BUDGET_EXCEEDED` | 展开超过节点预算，未完整展开 |
| 400 | `BAD_REQUEST` | 请求体/参数非法 |

> 注意：**未定义叶子是原子，不是 `UNDEFINED_KEY`**；该错误仅在“按定义键展开一个库里不存在的键”时返回。

---

## 8. 演示场景（`npm run demo`）

1. `林=⿰木木`、`森=⿱木林`，不定义 `木`：展开森 = `⿱木⿰木木`，原子 `木` 出现 **3** 次，路径 `[0] / [1,0] / [1,1]`。
2. `⿲木木木` 恰有 **3** 个孩子；`明=⿰日月` 叶计数为 **2**。
3. 教学字符 `A=⿰B木`、`B=⿱A日` 互相引用 → 整个版本被拒绝，链 `A -> B -> A`。
4. 多个父节点共享 `林` 不判环，且每处引用分别计数。
5. 新版本新增 `木=⿰十八` 后，新结果原子为 `十/八`，旧版本冻结结果保持 `木×3` 不变。
6. 补充平面叶子、缺操作数、多余尾字符的码点偏移诊断。
7. 指数级复制超过预算时返回 `BUDGET_EXCEEDED`，冻结结果数 `0 -> 0`。

---

## 9. 明确的范围与限制

- 只校验**符号结构与引用关系**，不判断部件真实字源、是否规范汉字。
- 操作符仅支持上表 12 个；区段内其它操作符一律拒绝（不做语义模拟）。
- 定义键限单个码点；一条 IDS 的长度/深度/展开规模受预算约束。
- 冻结结果针对成功展开保存；预算失败不产生“正式完整结果”。
- 并发：SQLite 以 WAL 打开文件库；导入使用事务，环检测失败会回滚，不留半成品版本。
