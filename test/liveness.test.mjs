/**
 * 目标存活判断（`isProcessAlive`）的助手侧契约。
 *
 * ## 为什么 get-admin 必须有这个方法
 *
 * 消费方（dsh-cheat-engine）的 `elevation-backend.js` **优先用本插件的助手**。
 * 而内核 `Process.isProcessAlive()` 在 `backend.isProcessAlive` 不是函数时
 * 如实返回 `undefined`，消费方的会话层把 `undefined` 当「未知」放行 ——
 * 于是目标一退出，远程后端下：
 *   · `ce_modules` / `ce_regions` → **静默返回 0 个**，不报错；
 *   · `ce_read` → 报「目标进程**仍在运行**」（与事实相反）；
 *   · `ce_write` → 被包装成误导性的「权限不足」。
 * 句柄由助手持有，所以只有助手能回答这个问题 —— 这正是本文件要钉住的契约。
 *
 * ## 三条分支都要有实测证据
 *
 * 1. 真链路（真内核 + 真夹具）：活着 → `true`；杀掉 → `false`；
 * 2. 后端**不支持**该方法 → 助手如实回 `undefined`（**不能猜**成 false/true）；
 * 3. 句柄**已失效** → 助手报「已失效」，后端据此回 `false`（这是"目标没了"的确证）。
 *
 * 第 2、3 条用一个**桩内核**来构造：往临时目录写一个只实现 `Process.open` 的模块，
 * 让助手加载它 —— 这样才能精确控制"后端具备/不具备 isProcessAlive"与
 * "句柄是否还有效"这两个变量。用真内核是构造不出这两种状态的。
 *
 * 运行：node --test test/liveness.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test, { after } from "node:test";

import { disposeHelper, startHelperBackend } from "../lib/launch.js";
import { findKernelDir, startFixture, stopFixture } from "./helpers/fixture.mjs";

const KERNEL_DIR = findKernelDir();

/**
 * 收尾：释放助手。
 *
 * ⚠️ 这里**不要**写 `process.exit()`。
 *
 * `integration.test.mjs` 里加 `process.exit()` 是为了对付"内核 worker 让事件循环不退出"，
 * 但实测在**本文件**（4 个用例）上它会**截断整个运行**：跑完第 3 个用例后钩子就触发了，
 * 第 4 个用例从未执行，`node --test` 报告的是 `1..3`（看起来"全绿"，实际少跑了一条）。
 * 这是测试基础设施的静默漏测，比偶发失败更危险。
 * 本文件不建内核 Process 之外的常驻线程，实测能自己退出，所以只做释放。
 */
after(() => {
	disposeHelper();
});

/** 写一个只实现 `Process.open` 的桩内核，用 pid 选择要构造的分支。 */
function makeStubKernel() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "get-admin-stub-kernel-"));
	fs.writeFileSync(
		path.join(dir, "index.js"),
		[
			"// 桩内核：只为构造 isProcessAlive 的三条分支，不实现任何内存操作。",
			"// pid 语义：",
			"//   1001 -> 后端**不支持** isProcessAlive（应回 undefined）",
			"//   1002 -> 后端支持且报 false（目标已退出）",
			"//   1003 -> 句柄**已失效**（isOpen=false，助手应报「已失效」）",
			"module.exports = {",
			"  Process: {",
			"    open(pid) {",
			"      const make = (backend, isOpen) => ({",
			"        pid, name: `stub-${pid}`, isOpen, backend, backendHandle: { id: 1 },",
			"        close() { this.isOpen = false; }",
			"      });",
			"      if (Number(pid) === 1001) return make({ name: 'stub-no-liveness' }, true);",
			"      if (Number(pid) === 1002) return make({ name: 'stub-dead', isProcessAlive: () => false }, true);",
			"      if (Number(pid) === 1003) return make({ name: 'stub-closed', isProcessAlive: () => true }, false);",
			"      return make({ name: 'stub-alive', isProcessAlive: () => true }, true);",
			"    }",
			"  }",
			"};",
			""
		].join("\n"),
		"utf8"
	);
	return dir;
}

test("真链路：真内核 + 真夹具，目标退出后助手如实报 false", async (t) => {
	if (KERNEL_DIR === null) {
		t.skip("找不到 node-cheat-engine 目录");
		return;
	}
	const require = createRequire(import.meta.url);
	const ce = require(path.join(KERNEL_DIR, "dist", "cjs", "index.js"));

	const fixture = await startFixture(KERNEL_DIR);
	let backend = null;
	try {
		backend = await startHelperBackend({
			elevate: false,
			kernelPath: KERNEL_DIR,
			timeoutMs: 15_000,
			launchTimeoutMs: 20_000,
			discoverExisting: false
		});

		assert.equal(
			typeof backend.isProcessAlive,
			"function",
			"RemoteMemoryBackend 必须实现 isProcessAlive（缺了它消费方的工具会静默返回错值）"
		);

		const proc = ce.Process.open(fixture.pid, { backend });
		try {
			assert.equal(proc.isProcessAlive(), true, "夹具还活着时必须报 true");

			stopFixture(fixture);
			const deadline = Date.now() + 15_000;
			let dead = undefined;
			for (;;) {
				dead = proc.isProcessAlive();
				if (dead === false || Date.now() > deadline) break;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			assert.equal(dead, false, `目标退出后必须报 false —— 实际 ${JSON.stringify(dead)}`);
		} finally {
			proc.close();
		}
	} finally {
		disposeHelper();
		stopFixture(fixture);
	}
});

test("分支：后端不支持 isProcessAlive 时如实回 undefined（不猜）", async () => {
	const stubDir = makeStubKernel();
	let backend = null;
	try {
		backend = await startHelperBackend({
			elevate: false,
			kernelPath: stubDir,
			timeoutMs: 15_000,
			launchTimeoutMs: 20_000,
			discoverExisting: false
		});
		const handle = backend.openProcess(1001);
		assert.equal(
			backend.isProcessAlive(handle),
			undefined,
			"后端无法判断时必须回 undefined（「未知」），绝不能猜成 false/true"
		);
	} finally {
		disposeHelper();
		fs.rmSync(stubDir, { recursive: true, force: true });
	}
});

test("分支：后端支持时，助手的答案被原样透传（false = 已退出）", async () => {
	const stubDir = makeStubKernel();
	let backend = null;
	try {
		backend = await startHelperBackend({
			elevate: false,
			kernelPath: stubDir,
			timeoutMs: 15_000,
			launchTimeoutMs: 20_000,
			discoverExisting: false
		});
		assert.equal(backend.isProcessAlive(backend.openProcess(1002)), false, "后端报 false 就回 false");
		assert.equal(backend.isProcessAlive(backend.openProcess(1004)), true, "后端报 true 就回 true");
	} finally {
		disposeHelper();
		fs.rmSync(stubDir, { recursive: true, force: true });
	}
});

test("分支：句柄已失效时助手明确报「已失效」，后端据此回 false", async () => {
	const stubDir = makeStubKernel();
	let backend = null;
	try {
		backend = await startHelperBackend({
			elevate: false,
			kernelPath: stubDir,
			timeoutMs: 15_000,
			launchTimeoutMs: 20_000,
			discoverExisting: false
		});
		// 桩内核让这个句柄的 isOpen=false；助手的 requireHandle 会抛「句柄 N 已失效」
		const handle = backend.openProcess(1003);
		assert.equal(
			backend.isProcessAlive(handle),
			false,
			"助手确认句柄已失效 = 目标没了，这正是我们要的「已退出」，不能吞成 undefined"
		);
	} finally {
		disposeHelper();
		fs.rmSync(stubDir, { recursive: true, force: true });
	}
});
