import test from "node:test";
import assert from "node:assert/strict";
import { parseIds, serializeIds, IdsError, countNodes } from "../src/ids.js";
import { expandIds, verifyExpanded, findCycle, serializeExpanded } from "../src/expand.js";
import { IdsStore } from "../src/store.js";
import { IdsService } from "../src/service.js";

// ---------- 解析器 ----------

test("解析二元与三元操作符，序列化还原", () => {
  const ids = "⿱木⿰木木";
  const tree = parseIds(ids);
  assert.equal(tree.kind, "op");
  assert.equal(serializeIds(tree), ids);
  const ternary = parseIds("⿲木木木");
  assert.equal(ternary.kind, "op");
  if (ternary.kind === "op") assert.equal(ternary.children.length, 3);
  assert.equal(serializeIds(ternary), "⿲木木木");
});

test("支持全部十个二元操作符", () => {
  for (const op of ["⿰","⿱","⿴","⿵","⿶","⿷","⿸","⿹","⿺","⿻"]) {
    const tree = parseIds(`${op}日月`);
    assert.equal(serializeIds(tree), `${op}日月`);
  }
});

test("补充平面汉字叶子按码点处理", () => {
  const ids = "⿰𠀀𫝀"; // U+20000, U+2B740 均为代理对
  const tree = parseIds(ids);
  assert.equal(serializeIds(tree), ids);
  if (tree.kind === "op") {
    assert.equal(tree.children[0].start, 1);
    assert.equal(tree.children[0].end, 2); // 码点偏移而非 UTF-16 下标
    assert.equal(tree.children[1].start, 2);
  }
});

test("缺操作数、多余尾字符、未知操作符分别诊断", () => {
  assert.throws(() => parseIds("⿰木"), (e: IdsError) => e.code === "IDS_MISSING_OPERAND" && e.position === 2);
  assert.throws(() => parseIds("⿰木木木"), (e: IdsError) => e.code === "IDS_TRAILING_CONTENT" && e.position === 3);
  assert.throws(() => parseIds("⿾木木"), (e: IdsError) => e.code === "IDS_UNKNOWN_OPERATOR" && e.position === 0);
  assert.throws(() => parseIds("㇯木木"), (e: IdsError) => e.code === "IDS_UNKNOWN_OPERATOR"); // U+31EF
  assert.throws(() => parseIds(""), (e: IdsError) => e.code === "IDS_EMPTY");
  assert.throws(() => parseIds("⿰ 木"), (e: IdsError) => e.code === "IDS_INVALID_LEAF");
});

test("位置使用码点偏移（代理对之前的位置）", () => {
  try {
    parseIds("⿰𠀀"); // 𠀀 占两个 UTF-16 单元，但缺操作数位置应为码点 2
    assert.fail("应抛出");
  } catch (e) {
    assert.equal((e as IdsError).code, "IDS_MISSING_OPERAND");
    assert.equal((e as IdsError).position, 2);
  }
});

// ---------- 展开 ----------

function demoLookup(defs: Record<string, string>) {
  const map = new Map(Object.entries(defs).map(([k, v]) => [k, parseIds(v)]));
  return { map, lookup: (k: string) => map.get(k) ?? null };
}

test("演示: 林=⿰木木 森=⿱木林，木未定义，展开后木出现三次", () => {
  const { lookup } = demoLookup({ 林: "⿰木木", 森: "⿱木林" });
  const result = expandIds(parseIds("⿱木林"), lookup);
  assert.equal(result.complete, true);
  assert.equal(result.atomicCount, 3);
  assert.equal(serializeExpanded(result.tree), "⿱木⿰木木");
  assert.deepEqual(result.leaves.map((l) => l.char), ["木", "木", "木"]);
  assert.deepEqual(result.leaves[0].path, [0]);
  assert.deepEqual(result.leaves[1].path, [1, 0]);
  assert.deepEqual(result.leaves[2].path, [1, 1]);
  // 右侧两个木的来源链包含 林
  assert.equal(result.leaves[1].provenance.at(-1)?.key, "林");
  assert.equal(verifyExpanded(result).length, 0);
});

test("明=⿰日月 不同叶计数", () => {
  const { lookup } = demoLookup({ 明: "⿰日月" });
  const result = expandIds(parseIds("⿰日月"), lookup);
  assert.equal(result.atomicCount, 2);
  assert.deepEqual(result.leaves.map((l) => l.char), ["日", "月"]);
});

test("共享子定义不误判为循环，且每个出现都单独计数", () => {
  const { map, lookup } = demoLookup({ 林: "⿰木木", 森: "⿱木林", 焱x: "⿰林林" });
  const defs = new Map([...map].filter(([k]) => k !== "焱x"));
  defs.set("㯢", parseIds("⿰林林"));
  assert.equal(findCycle(defs), null);
  const result = expandIds(parseIds("⿰林林"), lookup);
  assert.equal(result.atomicCount, 4);
  assert.equal(verifyExpanded(result).length, 0);
});

test("多层相同叶分别统计", () => {
  const { lookup } = demoLookup({ 林: "⿰木木", 森: "⿱木林", 磨: "⿸麻森" });
  const defs = new Map([...demoLookup({ 林: "⿰木木", 森: "⿱木林" }).map]);
  defs.set("磨", parseIds("⿸麻森"));
  const lookup2 = (k: string) => defs.get(k) ?? null;
  const result = expandIds(defs.get("磨")!, lookup2);
  assert.equal(result.atomicCount, 4); // 麻 + 木*3
  assert.equal(result.leaves.filter((l) => l.char === "木").length, 3);
  assert.equal(verifyExpanded(result).length, 0);
});

test("自环与互环均被检测并给出引用链", () => {
  const self = new Map([["甲", parseIds("⿰甲乙")]]);
  const cycle1 = findCycle(self);
  assert.ok(cycle1 && cycle1.includes("甲"));
  const mutual = new Map([
    ["甲", parseIds("⿰乙丙")],
    ["乙", parseIds("⿱甲丁")],
  ]);
  const cycle2 = findCycle(mutual);
  assert.ok(cycle2 && cycle2.includes("甲") && cycle2.includes("乙"));
});

test("展开预算不足时报告未完整展开", () => {
  const { lookup } = demoLookup({ 林: "⿰木木", 森: "⿱木林" });
  const result = expandIds(parseIds("⿱木林"), lookup, { maxNodes: 3 });
  assert.equal(result.complete, false);
  assert.ok(result.reason);
});

// ---------- 存储与版本 ----------

test("导入版本、环拒绝、旧版本结果冻结", () => {
  const store = new IdsStore(":memory:");
  const service = new IdsService(store);
  const v1 = service.importVersion([
    { key: "林", ids: "⿰木木" },
    { key: "森", ids: "⿱木林" },
  ]).version;
  assert.equal(v1.id, 1);
  const before = service.expand("森");
  assert.equal(before.atomicCount, 3);

  // 新增定义使原子变成可展开部件 → 新版本
  const v2 = service.importVersion([{ key: "木", ids: "⿰丿丶" }]).version;
  assert.equal(v2.id, 2);
  const after = service.expand("森");
  assert.equal(after.atomicCount, 6);
  // 旧版本查询结果不变
  const frozen = service.expand("森", v1.id);
  assert.equal(frozen.atomicCount, 3);

  // 循环版本被拒绝且不污染现有版本
  assert.throws(
    () => service.importVersion([{ key: "回", ids: "⿴回口" }]),
    (e: { code: string }) => e.code === "CYCLE_DETECTED"
  );
  assert.equal(store.currentVersion()!.id, 2);
  store.close();
});

test("互相引用的教学字符被拒绝", () => {
  const store = new IdsStore(":memory:");
  const service = new IdsService(store);
  assert.throws(
    () =>
      service.importVersion([
        { key: "甲", ids: "⿰乙丙" },
        { key: "乙", ids: "⿱甲丁" },
      ]),
    (e: { code: string; message: string }) =>
      e.code === "CYCLE_DETECTED" && e.message.includes("甲")
  );
  store.close();
});

test("重启读取：关闭后重开数据库内容仍在", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ids-")), "t.db");
  const s1 = new IdsStore(tmp);
  new IdsService(s1).importVersion([{ key: "林", ids: "⿰木木" }]);
  s1.close();
  const s2 = new IdsStore(tmp);
  const svc2 = new IdsService(s2);
  assert.equal(svc2.expand("林").atomicCount, 2);
  assert.equal(svc2.counts("林").counts["木"], 2);
  s2.close();
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
});

test("按路径查询来源链", () => {
  const store = new IdsStore(":memory:");
  const service = new IdsService(store);
  service.importVersion([
    { key: "林", ids: "⿰木木" },
    { key: "森", ids: "⿱木林" },
  ]);
  const src = service.sourceAt("森", [1, 0]);
  assert.equal(src.char, "木");
  assert.deepEqual(src.provenance.map((p) => p.key), ["林"]);
  assert.throws(() => service.sourceAt("森", [9, 9]), (e: { code: string }) => e.code === "PATH_NOT_FOUND");
  store.close();
});

test("导出树区分 parsed 与 expanded 阶段", () => {
  const store = new IdsStore(":memory:");
  const service = new IdsService(store);
  service.importVersion([
    { key: "林", ids: "⿰木木" },
    { key: "森", ids: "⿱木林" },
  ]);
  const out = service.exportTree("森");
  assert.equal(out.raw.stage, "parsed");
  assert.equal(out.raw.ids, "⿱木林");
  assert.equal(out.expanded.stage, "expanded");
  assert.equal(out.expanded.complete, true);
  store.close();
});

test("countNodes 与解析树一致", () => {
  const tree = parseIds("⿲木木木");
  assert.equal(countNodes(tree), 4);
});
