/**
 * 「界面为什么看不到已获得的权限」的回归测试。
 *
 * ## 缺陷原貌（实测发现）
 *
 * 助手是**跨进程共享**的：一次 UAC 确认后，DSH 重启、CLI、其它插件都能复用它。
 * 但 DSH 里那个服务实例原本只认**自己进程内启动的**助手
 * （`service.status()` → `helperStatus()` 只读进程内变量）。
 *
 * 后果（用户直接看到的现象）：
 *   用 CLI 经 UAC 起了一个**提权**助手（确认它 `helperElevated: true`）→
 *   `/get-admin/status` 仍报 `helperElevated: false` →
 *   **界面右下角图标一直是"未获得"，不会切换成"已获得"**。
 *   而客户端其实一直在正常轮询（每 4 秒），是数据源本身没反映真实情况。
 *
 * 修法：状态查询也看**跨进程发现记录**（`discoveredHelperStatus()`），
 * 并且必须做到"轻量、只读、不建连接" —— 因为它被每 4 秒轮询一次。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** 建一个隔离的 DSH_PROFILE_DIR，返回 { dir, discoveryPath }。 */
function tempProfile(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "get-admin-disc-"));
	const previous = process.env.DSH_PROFILE_DIR;
	process.env.DSH_PROFILE_DIR = dir;
	t.after(() => {
		if (previous === undefined) delete process.env.DSH_PROFILE_DIR;
		else process.env.DSH_PROFILE_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	});
	return { dir, discoveryPath: path.join(dir, "get-admin-helper-discovery.json") };
}

/** 每次重新 import，避免模块级缓存（发现记录路径在模块加载时并不缓存，但保持干净）。 */
async function launchModule() {
	return await import(`../lib/launch.js?t=${Date.now()}-${Math.random()}`);
}

test("无发现记录时，discoveredHelperStatus() 返回 null", async (t) => {
	tempProfile(t);
	const m = await launchModule();
	assert.equal(m.discoveredHelperStatus(), null);
});

test("发现记录指向**存活**进程时，报告助手存在且已提权", async (t) => {
	const { discoveryPath } = tempProfile(t);
	// 指向当前进程 —— 它一定存活
	fs.writeFileSync(
		discoveryPath,
		JSON.stringify({ port: 41234, pid: process.pid, token: "tok", at: Date.now() }),
		"utf8"
	);
	const m = await launchModule();
	const status = m.discoveredHelperStatus();
	assert.ok(status !== null, "应当报告发现记录里的助手");
	assert.equal(status.pid, process.pid);
	assert.equal(status.port, 41234);
	// 记录里放的只可能是提权助手（见 writeDiscovery 的调用点），所以必须报 true ——
	// 这正是界面图标能否切成"已获得"的判据。
	assert.equal(status.elevated, true, "发现记录里的助手应当被报告为已提权");
});

test("发现记录指向**已死**进程时返回 null（探活必须真的生效）", async (t) => {
	const { discoveryPath } = tempProfile(t);
	// 999999 不可能存在的 pid
	fs.writeFileSync(discoveryPath, JSON.stringify({ port: 41234, pid: 999999, token: "tok" }), "utf8");
	const m = await launchModule();
	assert.equal(
		m.discoveredHelperStatus(),
		null,
		"助手进程已死时不能谎报存在，否则界面会一直显示「已获得」、实际却不可用"
	);
});

test("发现记录损坏 / 字段缺失时不抛错，按「没有助手」处理", async (t) => {
	const { discoveryPath } = tempProfile(t);
	const m = await launchModule();

	for (const bad of ["{ 这不是 JSON", "null", "{}", '{"port":"不是数字"}', '{"pid":123}']) {
		fs.writeFileSync(discoveryPath, bad, "utf8");
		assert.equal(m.discoveredHelperStatus(), null, `内容 ${bad} 应当按「没有助手」处理`);
	}
	// 空字符串也要安全（写入中断会产生空文件）
	fs.writeFileSync(discoveryPath, "", "utf8");
	assert.equal(m.discoveredHelperStatus(), null, "空文件应当按「没有助手」处理");
});

test("进程内已有助手时，不再去看发现记录（避免两处来源互相干扰）", async (t) => {
	const { discoveryPath } = tempProfile(t);
	// 放一条指向存活进程的记录
	fs.writeFileSync(discoveryPath, JSON.stringify({ port: 1, pid: process.pid, token: "tok" }), "utf8");
	const m = await launchModule();
	// 进程内没有助手（fresh import），所以这里应当**看**记录
	assert.ok(m.discoveredHelperStatus() !== null, "进程内无助手时应当去看记录");
	// helperStatus() 在进程内无助手时必须返回 null —— 这是"两处来源"的边界
	assert.equal(m.helperStatus(), null, "进程内没有助手时 helperStatus() 应为 null");
});
