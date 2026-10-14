/**
 * **行为验证**：`ctx.provide(name, value)` 注册的服务，能否被另一个插件用
 * `ctx.inject([name], scope => scope.get(name))` 取到？
 *
 * 为什么必须实测而不是读源码：整个 get-admin 方案都建立在这条机制上 ——
 * cheat-engine 要通过注入 `getAdmin` 服务来拿到提权后端。
 * 如果这个版本的 cordis 不支持，方案就得整体换掉（例如改用文件发现 + 直接 import）。
 *
 * 这个脚本用真实的 cordis 包跑一遍，把每一步的实际结果打出来。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** 找 cordis（DSH 安装目录里的那一份）。 */
function findCordis() {
	const roots = [
		"C:\\Users\\36376\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules",
		"C:\\Users\\36376\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules",
		"C:\\Users\\36376\\.dsh\\profiles\\desktop\\node_modules"
	];
	for (const root of roots) {
		for (const candidate of [
			path.join(root, "@deepseek-ai", "cordis"),
			path.join(root, "cordis"),
			path.join(root, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "cordis")
		]) {
			try {
				if (fs.statSync(path.join(candidate, "package.json")).isFile()) return candidate;
			} catch {
				/* 继续找 */
			}
		}
	}
	return null;
}

const cordisDir = findCordis();
console.log("cordis 目录:", cordisDir ?? "❌ 未找到");
if (cordisDir === null) {
	// 退一步：把候选根列出来，便于人工定位
	for (const root of [
		"C:\\Users\\36376\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai",
		"C:\\Users\\36376\\.dsh\\profiles\\desktop\\node_modules"
	]) {
		try {
			const names = fs.readdirSync(root).filter((n) => /cordis/i.test(n));
			console.log(`  ${root} 里含 cordis 的项: ${names.join(", ") || "（无）"}`);
		} catch (error) {
			console.log(`  ${root} 读不到: ${error.message}`);
		}
	}
	process.exit(1);
}

const require = createRequire(import.meta.url);
const cordis = require(cordisDir);
console.log("导出:", Object.keys(cordis).slice(0, 20).join(", "));

const { Context } = cordis;
if (Context === undefined) {
	console.log("❌ 没有导出 Context，无法继续");
	process.exit(1);
}

// ---- 建根上下文 ----
const root = new Context();
console.log("\n=== 根上下文 ===");
console.log("  ctx.provide 是函数:", typeof root.provide === "function");
console.log("  ctx.inject  是函数:", typeof root.inject === "function");
console.log("  ctx.get     是函数:", typeof root.get === "function");
console.log("  ctx.set     是函数:", typeof root.set === "function");
console.log("  ctx.effect  是函数:", typeof root.effect === "function");

const SERVICE = "getAdmin";
const VALUE = { hello: "我是 get-admin 服务", marker: 42 };

// ---- ① 提供者：注册服务 ----
let provided = false;
let provideError = null;
root.plugin({
	name: "provider",
	apply(ctx) {
		try {
			const disposer = ctx.provide(SERVICE, VALUE);
			provided = true;
			console.log(`\n=== ① 注册服务 ===\n  ctx.provide 返回: ${typeof disposer}（期望 function=可释放）`);
		} catch (error) {
			provideError = error;
			console.log(`\n=== ① 注册服务 ===\n  ❌ 抛错: ${error.message}`);
		}
	}
});

console.log("  注册是否成功:", provided ? "✅" : `❌ ${provideError?.message ?? "未执行"}`);

// ---- ② 消费者：注入并取值 ----
let got = undefined;
let injectError = null;
let injectCallbackRan = false;
root.plugin({
	name: "consumer",
	inject: [SERVICE],
	apply(ctx) {
		// 写法 A：声明式 inject（cordis 会在服务就绪后调用 apply）
		try {
			got = ctx.get(SERVICE);
			console.log(`\n=== ② 消费者（声明式 inject）===\n  回调已执行: ✅\n  ctx.get("${SERVICE}") = ${got === undefined ? "undefined" : JSON.stringify(got)}`);
		} catch (error) {
			injectError = error;
			console.log(`\n=== ② 消费者（声明式 inject）===\n  ❌ ctx.get 抛错: ${error.message}`);
		}
	}
});

// ---- ③ 命令式 ctx.inject(["name"], scope => ...) ----
let scoped = undefined;
let scopeCallbackRan = false;
root.plugin({
	name: "consumer2",
	apply(ctx) {
		try {
			const r = ctx.inject([SERVICE], (scope) => {
				scopeCallbackRan = true;
				scoped = scope.get(SERVICE);
				console.log(`\n=== ③ 消费者（命令式 ctx.inject）===\n  作用域回调已执行: ✅\n  scope.get("${SERVICE}") = ${scoped === undefined ? "undefined" : JSON.stringify(scoped)}`);
				return () => {};
			});
			console.log(`  ctx.inject 返回: ${typeof r}`);
		} catch (error) {
			console.log(`\n=== ③ 消费者（命令式 ctx.inject）===\n  ❌ 抛错: ${error.message}`);
		}
	}
});

// ---- ④ 未注册的服务：注入应当拿不到（负向对照）----
let missing = "（回调没跑）";
root.plugin({
	name: "consumer3",
	apply(ctx) {
		try {
			const r = ctx.inject(["根本不存在的服务"], () => {
				missing = "❌ 回调竟然跑了（不该）";
			});
			missing = `回调未执行（符合预期），inject 返回 ${typeof r}`;
		} catch (error) {
			missing = `抛错：${error.message}`;
		}
	}
});

// 等一拍让异步回调有机会跑
await new Promise((r) => setTimeout(r, 300));

console.log("\n=== ④ 负向对照（未注册的服务）===");
console.log("  " + missing);

// ---- 结论 ----
console.log("\n=== 结论 ===");
const ok1 = provided;
const ok2 = got !== undefined && got?.marker === 42;
const ok3 = scopeCallbackRan && scoped !== undefined;
console.log(`  ctx.provide 可用            : ${ok1 ? "✅" : "❌"}`);
console.log(`  声明式 inject 能取到         : ${ok2 ? "✅" : "❌"}`);
console.log(`  命令式 ctx.inject 能取到     : ${ok3 ? "✅" : "❌"}`);
console.log(`  整体结论                     : ${ok1 && (ok2 || ok3) ? "✅ 跨插件服务机制可用，get-admin 方案成立" : "❌ 机制不成立，方案需要改"}`);
process.exit(ok1 && (ok2 || ok3) ? 0 : 1);
