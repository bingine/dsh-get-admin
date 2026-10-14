/**
 * 验证 F5：`release()` 必须能处理**只存在于跨进程发现记录**里的助手。
 *
 * ## 缺陷原貌
 *
 * `disposeHelper()` 第一行曾是 `if (current === null) return;` —— 于是当助手是
 * 别的进程启动的（只在发现记录里）时，它直接返回，`clearDiscovery()` 永不执行。
 * 后果自相矛盾：`status()` 报"已获得管理员权限"，`release()` 却报"没有助手，无需释放"，
 * 界面右下角永远停在"已获得"、点了没反应。
 *
 * ## 为什么必须用**独立子进程**当靶子
 *
 * 第一版我用"当前进程"冒充助手，结果 `release()` 真的把它 kill 了 ——
 * 测试进程当场死掉（exit 1、无输出）。这恰好证明修复生效，
 * 但也说明靶子必须是与测试进程分离的。
 *
 * 用法：node tools/verify-release-discovered.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GetAdminService } from "../lib/service.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f5-release-"));
process.env.DSH_PROFILE_DIR = tmp;
const discoveryPath = path.join(tmp, "get-admin-helper-discovery.json");

/** 起一个长命子进程当"助手"靶子。 */
function spawnVictim() {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	return child;
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

let failures = 0;
const check = (ok, label) => {
	if (!ok) failures += 1;
	console.log(`  ${ok ? "✅" : "❌"} ${label}`);
};

console.log("=== ① 只有发现记录、没有进程内助手 ===");
const victim = spawnVictim();
await new Promise((r) => setTimeout(r, 300));
fs.writeFileSync(discoveryPath, JSON.stringify({ port: 1, pid: victim.pid, token: "t", at: Date.now() }), "utf8");
console.log(`  靶子进程 pid=${victim.pid} 存活=${alive(victim.pid)}`);

const service = new GetAdminService();
const before = service.status();
console.log(`  状态源: hasHelper=${before.hasHelper} helperElevated=${before.helperElevated} source=${before.source}`);
check(before.hasHelper === true && before.source === "discovered", "状态应当报告发现记录里的助手");

const result = service.release();
console.log(`  released=${result.released} killed=${result.killed} clearedDiscovery=${result.clearedDiscovery}`);
console.log(`  reason: ${result.reason}`);

check(result.released === true, "release 应当报告『确实做了事』（而不是『无需释放』）");
check(!fs.existsSync(discoveryPath), "发现记录必须被清掉（否则下个进程还会去连它）");
await new Promise((r) => setTimeout(r, 300));
check(!alive(victim.pid), "未提权的靶子应当被真正结束（本进程有权 kill）");

const after = service.status();
check(after.hasHelper === false, `释放后不应再报告有助手（实际 hasHelper=${after.hasHelper}）`);

console.log("");
console.log("=== ② 什么都没有时：幂等，且不谎报 ===");
const empty = service.release();
check(empty.released === false, "没有助手时 released 应为 false");
check(/没有提权助手|无需释放/.test(empty.reason), `理由应当说明没有助手：${empty.reason}`);

// 清理
try {
	victim.kill();
} catch {
	/* 已退出 */
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(failures === 0 ? "✅ 全部通过" : `❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
