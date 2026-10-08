// 演示脚本：导入定义 → 解析 → 展开 → 计数 → 来源 → 循环拒绝。
const path = require("node:path");
const { IdsStore } = require("../dist/src/store.js");
const { IdsService } = require("../dist/src/service.js");

const dbPath = path.join(__dirname, "..", "data", "demo.db");
const store = new IdsStore(dbPath);
const service = new IdsService(store);

console.log("== 导入定义版本 ==");
console.log(service.importVersion(require("../demo/definitions.json").definitions));

console.log("== 解析 IDS ==");
const parsed = service.parse("⿱木林");
console.log({ stage: parsed.stage, ids: parsed.ids, nodeCount: parsed.nodeCount });

console.log("== 展开 森 ==");
const expanded = service.expand("森");
console.log({
  stage: expanded.stage,
  serialized: expanded.serialized,
  atomicCount: expanded.atomicCount,
  nodeCount: expanded.nodeCount,
  complete: expanded.complete,
});

console.log("== 计数 森 ==");
console.log(service.counts("森").counts);

console.log("== 路径 [1,0] 的来源链 ==");
console.log(service.sourceAt("森", [1, 0]));

console.log("== 三元表达式孩子数 ==");
const ternary = service.exportTree("三");
console.log(ternary.raw.tree.children.length);

console.log("== 循环引用拒绝 ==");
try {
  service.importVersion([
    { key: "甲", ids: "⿰乙丙" },
    { key: "乙", ids: "⿱甲丁" },
  ]);
} catch (e) {
  console.log({ code: e.code, message: e.message });
}

store.close();
