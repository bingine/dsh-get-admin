/**
 * 无人值守保护闸门的测试：`GET_ADMIN_NO_ELEVATE=1` 必须让**所有**提权路径拒绝执行。
 *
 * ## 为什么这条测试很重要
 *
 * 无人值守运行时 UAC 可能被自动批准 —— 那就等于**没经人确认就拿到了管理员权限**。
 * 所以必须有办法把提权彻底关掉，而且关掉后：
 *   a) **不弹 UAC**（不 spawn powershell -Verb RunAs）；
 *   b) **明确报错**，而不是静默降级成"不提权也继续" ——
 *      静默降级会让调用方以为自己有管理员权限，后续以错误的权限假设继续跑，更难查；
 *   c) 不留临时文件垃圾。
 *
 * 这里覆盖**三条**提权路径：
 *   1. `dsh-get-admin/lib/launch.js`（共享助手，主路径）
 *   2. `dsh-cheat-engine/lib/remote/launch.js`（回退助手）
 *   3. `dsh-cheat-engine/lib/remote/kernel-elevate.js`（内核驱动动作）
 * 只关一条而漏掉其它，闸门就是摆设。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** 找两个仓库的路径（兄弟目录布局）。 */
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const GET_ADMIN = path.dirname(HERE);
const CHEAT_ENGINE = path.join(path.dirname(GET_ADMIN), "dsh-cheat-engine");

/** 在设了闸门的环境变量下跑一段逻辑，返回其抛出的错误。 */
async function withGuard(fn) {
	const previous = process.env.GET_ADMIN_NO_ELEVATE;
	process.env.GET_ADMIN_NO_ELEVATE = "1";
	try {
		await fn();
		return null;
	} catch (error) {
		return error;
	} finally {
		if (previous === undefined) delete process.env.GET_ADMIN_NO_ELEVATE;
		else process.env.GET_ADMIN_NO_ELEVATE = previous;
	}
}

test("闸门：get-admin 的提权启动被拒绝，且明确说明原因", async () => {
	const { startHelperBackend } = await import("../lib/launch.js");
	const before = fs.readdirSync(os.tmpdir()).length;
	const error = await withGuard(() =>
		startHelperBackend({
			elevate: true,
			kernelPath: path.join(CHEAT_ENGINE, "node-cheat-engine"),
			timeoutMs: 5_000,
			launchTimeoutMs: 5_000,
			discoverExisting: false
		})
	);
	assert.ok(error !== null, "设了闸门时提权必须失败，而不是静默继续");
	assert.match(error.message, /GET_ADMIN_NO_ELEVATE/, "错误信息应当点明是哪个开关拦下的");
	assert.match(error.message, /无人值守/, "错误信息应当说明这是无人值守保护");
	// 必须"明确报错"，不能假装成功
	assert.ok(!/已就绪|成功/.test(error.message), "不能给出像是成功的措辞");

	// 不该留下临时文件垃圾（允许少量波动，但不应大量增长）
	const after = fs.readdirSync(os.tmpdir()).length;
	assert.ok(after - before <= 2, `被闸门拦下时不应留下大量临时文件（${before} → ${after}）`);
});

test("闸门：cheat-engine 的回退提权启动同样被拒绝（两条助手路径都要关）", async (t) => {
	if (!fs.existsSync(path.join(CHEAT_ENGINE, "lib", "remote", "launch.js"))) {
		t.skip("找不到 dsh-cheat-engine 仓库");
		return;
	}
	const { startHelperBackend } = await import(`file://${path.join(CHEAT_ENGINE, "lib", "remote", "launch.js").replace(/\\/g, "/")}`);
	const error = await withGuard(() =>
		startHelperBackend({ elevate: true, timeoutMs: 5_000, launchTimeoutMs: 5_000, discoverExisting: false })
	);
	assert.ok(error !== null, "回退路径也必须被闸门拦住 —— 否则只关一条等于没关");
	assert.match(error.message, /GET_ADMIN_NO_ELEVATE/);
});

test("闸门：内核驱动动作的提权被拒绝（第三条路径）", async (t) => {
	const elevatePath = path.join(CHEAT_ENGINE, "lib", "remote", "kernel-elevate.js");
	if (!fs.existsSync(elevatePath)) {
		t.skip("找不到 dsh-cheat-engine 仓库");
		return;
	}
	const mod = await import(`file://${elevatePath.replace(/\\/g, "/")}`);
	assert.equal(typeof mod.runElevatedKernelAction, "function", "应当导出 runElevatedKernelAction");

	// preferPersistentHelper: false 会走"一次性提权执行器"那条分支，
	// 也就是第三条提权路径。
	const error = await withGuard(() =>
		mod.runElevatedKernelAction({
			action: "load",
			preferPersistentHelper: false,
			timeoutMs: 5_000
		})
	);
	assert.ok(error !== null, "内核驱动动作的提权也必须被闸门拦住");
	assert.match(error.message, /GET_ADMIN_NO_ELEVATE/, "错误信息应当点明开关");
	assert.match(error.message, /load/, "错误信息应当点明是哪个动作被拦下");
});

test("闸门不设时不影响不提权的正常路径", async () => {
	const { startHelperBackend } = await import("../lib/launch.js");

	// ⚠️ 不能假设"本进程没有设这个变量"：测试入口 `test/run-tests.mjs`
	// **总是**注入 GET_ADMIN_NO_ELEVATE=1（无人值守保护）。
	// 所以这里显式把闸门拿掉，才能验证"没有闸门时"的行为。
	const previous = process.env.GET_ADMIN_NO_ELEVATE;
	delete process.env.GET_ADMIN_NO_ELEVATE;
	try {
		// 不提权 + 内核目录不存在 → 会失败，但我们只验证失败原因**不是**闸门造成的
		let error = null;
		try {
			await startHelperBackend({
				elevate: false,
				kernelPath: path.join(os.tmpdir(), "get-admin-不存在"),
				timeoutMs: 3_000,
				launchTimeoutMs: 4_000,
				discoverExisting: false
			});
		} catch (e) {
			error = e;
		}
		if (error !== null) {
			assert.ok(
				!/GET_ADMIN_NO_ELEVATE/.test(error.message),
				`未设闸门时不应出现闸门相关错误：${error.message}`
			);
		}
	} finally {
		if (previous === undefined) delete process.env.GET_ADMIN_NO_ELEVATE;
		else process.env.GET_ADMIN_NO_ELEVATE = previous;
	}
});

test("测试入口确实注入了无人值守闸门（否则上面几条测试就没有意义）", () => {
	// 这条是"守卫的守卫"：如果哪天有人把 run-tests.mjs 里的注入删了，
	// 上面那些依赖闸门的测试会静默变成"其实没测到闸门"，这条能立刻发现。
	assert.equal(
		process.env.GET_ADMIN_NO_ELEVATE,
		"1",
		"测试必须经 test/run-tests.mjs 运行（它会注入无人值守闸门）；直接 node --test 会缺这道保护"
	);
});
