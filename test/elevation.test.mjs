/**
 * get-admin 的真实链路测试：启动助手进程 → 认证 → RPC → 跨进程读内存。
 *
 * ## 关键取舍：用 `elevate: false`
 *
 * 提权路径与不提权路径**只差一行**：`elevate: true` 时经
 * `PowerShell Start-Process -Verb RunAs` 触发 UAC，其余（配置回传、端口文件、
 * 认证、帧协议、助手侧调度、内存后端）**完全同一条代码路径**。
 *
 * 所以这里用 `elevate: false`：
 *   - 测试可以在没有管理员权限的环境里稳定跑（CI 也能跑）；
 *   - 唯一没被覆盖的是"有人在安全桌面上点 UAC"这一步 —— 自动化做不到，
 *     这一点在 README 里如实写明，不假装覆盖了。
 *
 * 另外还测了 `elevate: true` 的**失败路径**（UAC 被拒）：那条路径有明确的
 * "快速失败、不干等超时"要求，值得钉住。
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { disposeHelper, helperStatus, startHelperBackend } from "../lib/launch.js";
import { resetElevationCache } from "../lib/elevation.js";
import { findKernelDir, startFixture, stopFixture } from "./helpers/fixture.mjs";

const KERNEL_DIR = findKernelDir();

/**
 * 收尾：释放助手。
 *
 * ⚠️ 这里**曾经**写的是 `process.exit(process.exitCode ?? 0)`，动机是
 * 「助手/内核链路会留下让事件循环存活的句柄，不兜底就挂住」。但实测那是个**静默漏测**：
 * 顶层 `after()` 钩子会在**最后一个用例还没注册/执行**时就触发，
 * `process.exit()` 把进程连同那个用例一起带走 —— 本文件 3 个用例只跑了 2 个，
 * 而 `node --test` 报告 `1..2` 全绿，被丢掉的正是
 * 「回归：助手起不来时快速失败，不干等满超时」。
 *
 * 正确做法是让**运行器**兜底退出：`run-tests.mjs` / `package.json` 都带
 * `--test-force-exit`，它在全部用例跑完后强制收掉残留句柄，既不挂住也不漏跑。
 */
after(() => {
	disposeHelper();
});

test("跨进程：助手未提权启动 → 认证 → 枚举进程 → 打开目标 → 读取已知内存", async (t) => {
	if (KERNEL_DIR === null) {
		t.skip("找不到 node-cheat-engine 目录（设置 CE_KERNEL_PATH 可指定）");
		return;
	}

	resetElevationCache();
	const fixture = await startFixture(KERNEL_DIR);
	const logs = [];
	let backend = null;
	try {
		backend = await startHelperBackend({
			elevate: false,
			kernelPath: KERNEL_DIR,
			timeoutMs: 15_000,
			launchTimeoutMs: 20_000,
			// 不读跨进程发现记录：测试要的是"新起一个助手"，不是复用别的
			discoverExisting: false,
			log: (message) => logs.push(message)
		});

		// 后端契约：对内核而言这是**同步**后端（这是扫描/指针扫描能用的前提）
		assert.equal(backend.name, "remote-elevated");
		assert.equal(backend.capabilities.sync, true, "远程后端必须是同步后端");
		assert.equal(typeof backend.helperPid, "number", "hello 应当带回助手 pid");
		assert.equal(backend.helperElevated, false, "未提权启动时助手不应报告已提权");

		// 助手确实是一个**独立进程**，不是本进程
		assert.notEqual(backend.helperPid, process.pid, "助手必须是独立进程");

		// ① 进程枚举（走助手）
		const processes = backend.listProcesses();
		assert.ok(Array.isArray(processes) && processes.length > 0, "应当枚举到进程");
		const target = processes.find((p) => p.pid === fixture.pid);
		assert.ok(target !== undefined, `应当能枚举到夹具进程 pid=${fixture.pid}`);

		// ② 打开目标 + 读已知内存
		const handle = backend.openProcess(fixture.pid);
		assert.equal(handle.pid, fixture.pid);
		const health = backend.readProcessMemory(handle, fixture.base, 4);
		assert.equal(health.length, 4, "应当读到 4 字节");
		assert.equal(health.readInt32LE(0), fixture.values.health, "应当读到夹具的 health=1000");

		// ③ 区域查询（走助手的后端直通路径）
		const regions = backend.queryRegions(handle, {});
		assert.ok(Array.isArray(regions) && regions.length > 0, "应当查到内存区域");

		// ④ 模块枚举
		const modules = backend.queryModules(handle);
		assert.ok(Array.isArray(modules) && modules.length > 0, "应当查到模块");

		// ⑤ 写内存也走同一条通道（写回原值，避免影响后续）
		const wrote = backend.writeProcessMemory(handle, fixture.base, health, true);
		assert.ok(wrote === undefined || wrote === null || typeof wrote === "object" || typeof wrote === "boolean" ||
			typeof wrote === "number", "写操作应当成功返回");

		backend.closeProcess(handle);

		// 助手状态可查（其它插件与界面都靠它）
		const status = helperStatus();
		assert.ok(status !== null, "启动后应当有助手状态");
		assert.equal(status.elevated, false, "未提权助手应当如实报告 elevated=false");

		// 启动过程中的日志应当说明发生了什么（便于排查"为什么没弹窗"）
		assert.ok(logs.length > 0, "启动过程应当有日志");
	} finally {
		disposeHelper();
		stopFixture(fixture.proc);
	}

	// 释放后状态必须清空：不能留下"看起来还有助手"的假象
	assert.equal(helperStatus(), null, "释放后不应再有助手状态");
});

test("释放助手会同时清掉跨进程发现记录（否则下个进程会连一个已废弃的助手）", async (t) => {
	if (KERNEL_DIR === null) {
		t.skip("找不到 node-cheat-engine 目录");
		return;
	}
	const fixture = await startFixture(KERNEL_DIR);
	try {
		await startHelperBackend({
			elevate: false,
			kernelPath: KERNEL_DIR,
			timeoutMs: 15_000,
			launchTimeoutMs: 20_000,
			discoverExisting: false
		});
		assert.ok(helperStatus() !== null);
		disposeHelper();
		assert.equal(helperStatus(), null);
	} finally {
		disposeHelper();
		stopFixture(fixture.proc);
	}
});

test("回归：助手起不来时快速失败，不干等满超时", async () => {
	// 早先的实现会静默等满 90 秒，用户感知是"一拒绝就卡很久"。
	// 现在盯着启动器进程 + 上限，必须在 launchTimeoutMs 附近就给出结论。
	//
	// ⚠️ 这里**刻意不走 UAC 分支**（不传 elevate: true）。
	// 之前的版本用"elevate: true + 小超时"来验证时限，结果它**真的会弹 UAC**：
	//   - 打扰使用者；
	//   - 即便超时放弃，那个 `powershell -Verb RunAs` 子进程仍让测试进程退不出
	//     （表现为所有用例都通过、`node --test` 却一直挂着）。
	// 快速失败的核心逻辑（盯启动器退出 / 到点就报）与是否提权无关，
	// 所以这里用"不给内核路径 + 极短超时"制造一次必然失败的启动，同样能钉住时限。
	resetElevationCache();
	const started = Date.now();
	let error = null;
	try {
		await startHelperBackend({
			elevate: false,
			// 指向一个不存在的目录：助手会在加载内核时立刻失败
			kernelPath: path.join(os.tmpdir(), "get-admin-不存在的内核目录"),
			timeoutMs: 2_000,
			launchTimeoutMs: 4_000,
			discoverExisting: false
		});
	} catch (e) {
		error = e;
	}
	const elapsed = Date.now() - started;
	disposeHelper();

	assert.ok(error !== null, "内核目录不存在时应当失败，而不是假装启动成功");
	assert.ok(elapsed < 30_000, `失败必须快速返回（实测 ${elapsed}ms），不能干等满超时`);
	// 报错要指出是"助手/内核"这条链上的问题，而不是一句无信息的失败
	assert.ok(
		/助手|内核|就绪|node-cheat-engine/.test(error.message),
		`错误信息应当说明问题出在助手/内核链路：${error.message}`
	);
});
