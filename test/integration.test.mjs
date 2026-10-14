/**
 * 集成测试：把 get-admin 的远程后端交给**内核**用，验证"提权后全功能可用"。
 *
 * ## 为什么这条最重要
 *
 * `lib/elevation.js` 顶部曾记过一条约束：内核的 `ScanSession` / `PointerScanner` /
 * `AutoAssembler` 内部调用 `Process` 的**同步**方法（`this.proc.readMemory(...)`），
 * 而 `Process` 的同步方法在**异步后端**上会直接抛错。
 *
 * 也就是说：如果提权助手只做成普通异步 RPC，那么"提权后"只有读写和枚举能用，
 * **扫描/指针扫描/汇编全部不可用** —— 那就不是一个可交付的提权方案。
 *
 * 我们通过 `capabilities.sync = true` + `Atomics.wait` 把远程后端做成同步的，
 * 从而让内核**无需任何改动**就能在提权链路上跑完整功能。这条测试就是钉住这一点。
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";

import { disposeHelper, startHelperBackend } from "../lib/launch.js";
import { findKernelDir, startFixture, stopFixture } from "./helpers/fixture.mjs";

const KERNEL_DIR = findKernelDir();

/**
 * 收尾：释放助手。
 *
 * ⚠️ 这里**曾经**写的是 `process.exit(process.exitCode ?? 0)`，动机是
 * 「内核 worker 会让事件循环保持存活，不加就挂住」。但实测那是个**静默漏测**：
 * 顶层 `after()` 钩子会在**最后一个用例还没注册/执行**时就触发，
 * `process.exit()` 于是把进程连同那个用例一起带走 ——
 * 本文件 2 个用例只跑了 1 个，`node --test` 却报告 `1..1` 全绿，
 * 被丢掉的正是「远程后端的地址表达式解引用」那条。
 *
 * 正确做法是让**运行器**去兜底退出：`test/run-tests.mjs` 与 `package.json`
 * 都带了 `--test-force-exit`，它会在全部用例跑完之后强制收掉残留句柄，
 * 既不挂住、也不会漏跑用例。
 */
after(() => {
	disposeHelper();
});

test("集成：内核 Process 能建在远程后端上，并同步读内存（扫描路径的前提）", async (t) => {
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

		// 内核的 Process.open 在**异步后端**上会直接抛错（syncResult），
		// 所以这一步能通过，就说明同步桥是有效的。
		const proc = ce.Process.open(fixture.pid, { backend });
		try {
			assert.equal(proc.pid, fixture.pid);
			// 同步读：内核扫描器内部正是这么调的
			const buf = proc.readMemory(fixture.base, 4);
			assert.equal(buf.readInt32LE(0), fixture.values.health, "同步读应当拿到夹具的 health");

			// 区域与模块（内核的高层封装，会做 BackendRegion → MemoryRegion 转换）
			const regions = proc.regions();
			assert.ok(regions.length > 0, "应当查到区域");
			assert.ok(
				regions.some((r) => fixture.base >= r.baseAddress && fixture.base < r.baseAddress + r.memorySize),
				"夹具基址应当落在某个区域里"
			);

			const modules = proc.modules();
			assert.ok(modules.length > 0, "应当查到模块");
		} finally {
			proc.close();
		}
	} finally {
		disposeHelper();
		stopFixture(fixture.proc);
	}
});

test("集成：远程后端的地址表达式解引用也走同步通道", async (t) => {
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
		const proc = ce.Process.open(fixture.pid, { backend });
		try {
			// 夹具在 pointerToTarget 处存了 targetValue 的地址；解引用应当拿回同一个地址。
			// 这条同时验证了「内核表达式求值 → 同步读内存」这条路在远程后端上通。
			const ctx = { process: proc };
			const slot = `0x${(fixture.base + BigInt(fixture.offsets.pointerToTarget)).toString(16)}`;
			const resolved = BigInt(ce.resolveAddress(`[${slot}]`, ctx));
			assert.equal(
				resolved,
				fixture.base + BigInt(fixture.offsets.targetValue),
				"解引用应当解析出夹具写入的 targetValue 地址"
			);
		} finally {
			proc.close();
		}
	} finally {
		disposeHelper();
		stopFixture(fixture.proc);
	}
});
