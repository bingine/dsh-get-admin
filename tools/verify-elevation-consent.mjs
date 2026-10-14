/**
 * 验证 F2 修复：`askToElevate` 的批准判定必须基于**选项 id**，而不是文案。
 *
 * ## 缺陷原貌（安全事故级）
 *
 * 早先 `approved` 是 `chosen !== "不继续（推荐先用只读/换目标）"` —— 由**文案**推导。
 * 权威实现（get-admin）的选项 2 是「同意提权」，表达式成立；
 * 回退实现（cheat-engine/lib/elevation-impl.js）的选项 2 是「告诉我如何提权」
 * （描述明写"不自动执行"），同一个表达式就返回 **approved = true**。
 *
 * 也就是：用户只要求"讲解"，却真的去弹 UAC 提权 —— **同意闸门被绕过**。
 *
 * 修法：选项带稳定 `id`，用 id 判定；并且选项集由权威实现导出，
 * 让回退实现跟着同一份（从根上消除语义分叉）。
 *
 * 用法：node tools/verify-elevation-consent.mjs
 */
import { ELEVATION_OPTIONS, askToElevate } from "../lib/elevation.js";

/** 造一个按给定选择作答的 userQuestions 桩。 */
const stub = (selected) => ({ ask: async () => ({ answers: [{ selected: [selected] }] }) });
const exec = { agent: { session: { id: "probe" } }, signal: undefined };

let failures = 0;
const check = (label, actual, expected) => {
	const ok = actual === expected;
	if (!ok) failures += 1;
	console.log(`  ${ok ? "✅" : "❌"} ${label}：approved=${actual}（期望 ${expected}）`);
};

console.log("=== 导出的选项集（回退实现应当跟着用同一份）===");
for (const o of ELEVATION_OPTIONS) console.log(`  id=${o.id}  label=${o.label}`);
console.log("");

console.log("=== ① 用 id 作答（正确形状）===");
check("选 decline", (await askToElevate(stub("decline"), exec, {})).approved, false);
check("选 approve", (await askToElevate(stub("approve"), exec, {})).approved, true);

console.log("");
console.log("=== ② 用文案作答（兼容旧形状）===");
check("选「不继续…」文案", (await askToElevate(stub(ELEVATION_OPTIONS[0].label), exec, {})).approved, false);
check("选「同意提权…」文案", (await askToElevate(stub(ELEVATION_OPTIONS[1].label), exec, {})).approved, true);

console.log("");
console.log("=== ③ 关键回归：回退实现那句「告诉我如何提权」绝不能被当成同意 ===");
// 这正是缺陷的原始触发条件：一个"只讲解、不动手"的选项文案
for (const text of ["告诉我如何提权", "只告诉我做法", "先别动", "看看原因", ""]) {
	const r = await askToElevate(stub(text), exec, {});
	check(`选「${text || "(空)"}」`, r.approved, false);
}

console.log("");
console.log("=== ④ 没作答 / 形状异常时一律不批准 ===");
check("answers 缺失", (await askToElevate({ ask: async () => ({}) }, exec, {})).approved, false);
check("selected 为空数组", (await askToElevate({ ask: async () => ({ answers: [{ selected: [] }] }) }, exec, {})).approved, false);
check("selected 是对象且 id=decline", (await askToElevate(stub({ id: "decline", label: "x" }), exec, {})).approved, false);
check("selected 是对象且 id=approve", (await askToElevate(stub({ id: "approve", label: "y" }), exec, {})).approved, true);

console.log("");
console.log("=== ⑤ 拿不到交互能力时一律拒绝（绝不默默提权）===");
check("无 agent", (await askToElevate(stub("approve"), {}, {})).approved, false);
check("无 userQuestions", (await askToElevate(undefined, exec, {})).approved, false);
check("无 exec", (await askToElevate(undefined, undefined, {})).approved, false);

console.log("");
console.log(failures === 0 ? "✅ 全部通过" : `❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
