/**
 * 实测 get-admin 的整条链路，并打印每一步的实况。
 *
 * 与单测的区别：单测跑在 node:test 里追求断言；这个脚本是**给人/模型看的实测报告**，
 * 用真实的目标进程走一遍，把"到底拿到了什么"逐条打印出来，便于在没有管理员权限的
 * 环境里判断"是链路不通，还是只差一次 UAC 确认"。
 *
 * 用法：
 *   node tools/verify-elevation.mjs                     # 不提权跑通链路（不需要管理员）
 *   node tools/verify-elevation.mjs --elevate           # 真的走 UAC 提权（会弹窗，需人工确认）
 *   node tools/verify-elevation.mjs --kernel <目录>      # 显式指定 node-cheat-engine
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { disposeHelper, helperStatus, startHelperBackend } from "../lib/launch.js";
import { isElevated, resetElevationCache } from "../lib/elevation.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = path.dirname(HERE);

/** 读一个 `--name value` 或 `--name=value` 形式的参数。 */
function argValue(name, fallback = "") {
	const i = process.argv.indexOf(`--${name}`);
	if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
	const pref = `--${name}=`;
	const hit = process.argv.find((v) => v.startsWith(pref));
	return hit === undefined ? fallback : hit.slice(pref.length);
}

const WANT_ELEVATE = process.argv.includes("--elevate");
const KERNEL_ARG = argValue("kernel", "");

/** 找 node-cheat-engine 目录（不写死绝对路径）。 */
function findKernelDir() {
	const candidates = [];
	if (KERNEL_ARG !== "") candidates.push(KERNEL_ARG);
	if (process.env.CE_KERNEL_PATH) candidates.push(process.env.CE_KERNEL_PATH);
	// 与本插件并排的兄弟仓库，以及本插件自己的依赖目录
	candidates.push(path.join(path.dirname(PLUGIN_DIR), "dsh-cheat-engine", "node-cheat-engine"));
	candidates.push(path.join(PLUGIN_DIR, "node_modules", "node-cheat-engine"));
	for (const candidate of candidates) {
		try {
			if (fs.statSync(path.join(candidate, "package.json")).isFile()) return candidate;
		} catch {
			/* 继续找 */
		}
	}
	return null;
}

const line = (s) => process.stdout.write(`${s}\n`);

line("=== get-admin 链路实测 ===");
line(`插件目录    : ${PLUGIN_DIR}`);
line(`提权模式    : ${WANT_ELEVATE ? "经 UAC（会弹窗）" : "不提权（仅验链路）"}`);

resetElevationCache();
line(`当前进程提权: ${isElevated() ? "是（已是管理员）" : "否"}`);

const kernelDir = findKernelDir();
line(`内核目录    : ${kernelDir ?? "未找到（内存 RPC 会不可用）"}`);
if (kernelDir === null) {
	line("");
	line("找不到 node-cheat-engine：设置 CE_KERNEL_PATH 或用 --kernel <目录> 指定。");
}

/**
 * 起一个真实的目标进程，用来验证"跨进程读内存"确实发生。
 *
 * 注意：这里**不能**把 `new Promise` return 出去（会变成 Promise<Promise>），
 * 必须 `await` 它再返回，否则调用方拿到的 `proc` 是一个 Promise、`.stdout` 是 undefined。
 */
async function startTarget() {
	if (kernelDir === null) return null;
	const proc = spawn(process.execPath, [path.join(kernelDir, "test", "fixture-target.js")], {
		cwd: kernelDir,
		stdio: ["pipe", "ignore", "pipe"]
	});
	return await new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => reject(new Error("目标进程启动超时")), 20_000);
		proc.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		proc.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`目标进程在 ready 前退出：code=${code}`));
		});
		proc.stdout.on("data", (chunk) => {
			buf += chunk.toString();
			const nl = buf.indexOf("\n");
			if (nl === -1) return;
			clearTimeout(timer);
			const info = JSON.parse(buf.slice(0, nl));
			resolve({ proc, pid: info.pid, base: BigInt(info.base), values: info.values });
		});
	});
}

const target = kernelDir === null ? null : await startTarget();
let backend = null;
let exitCode = 0;
try {
	if (target !== null) line(`目标进程    : pid ${target.pid}（health=${target.values.health}）`);
	line("");
	line("--- 启动助手 ---");

	backend = await startHelperBackend({
		elevate: WANT_ELEVATE,
		kernelPath: kernelDir ?? "",
		timeoutMs: 30_000,
		launchTimeoutMs: WANT_ELEVATE ? 120_000 : 20_000,
		discoverExisting: true,
		log: (m) => line(`  · ${m}`)
	});

	line("");
	line("--- 助手状态 ---");
	line(`  后端名        : ${backend.name}`);
	line(`  同步后端      : ${backend.capabilities.sync ? "是（扫描/指针扫描可用）" : "否（只有读写可用）"}`);
	line(`  助手 pid      : ${backend.helperPid}（本进程 ${process.pid}）`);
	line(`  助手是否提权  : ${backend.helperElevated ? "是" : "否"}`);
	line(`  helperStatus(): ${JSON.stringify(helperStatus())}`);

	// 真实跨进程读内存
	const processes = backend.listProcesses();
	line(`  枚举进程数    : ${processes.length}`);

	if (target !== null) {
		const handle = backend.openProcess(target.pid);
		const buf = backend.readProcessMemory(handle, target.base, 4);
		const got = buf.readInt32LE(0);
		line("");
		line("--- 跨进程读内存（经助手）---");
		line(`  目标 pid ${handle.pid} 名 ${handle.name}`);
		line(`  读 0x${target.base.toString(16)} 4 字节 → ${got}`);
		line(`  期望值              → ${target.values.health}`);
		line(`  结果                : ${got === target.values.health ? "✅ 一致" : "❌ 不一致"}`);
		if (got !== target.values.health) exitCode = 1;
		backend.closeProcess(handle);

		// 内核的高层 Process：证明扫描那条**同步**路径也能用
		if (kernelDir !== null) {
			const require = createRequire(import.meta.url);
			const ce = require(path.join(kernelDir, "dist", "cjs", "index.js"));
			line("");
			line("--- 内核 Process 建在远程后端上（扫描路径的前提）---");
			try {
				const proc = ce.Process.open(target.pid, { backend });
				const read = proc.readMemory(target.base, 4).readInt32LE(0);
				const regions = proc.regions().length;
				line(`  同步 readMemory → ${read}（期望 ${target.values.health}）`);
				line(`  区域数 → ${regions}`);
				line(`  结果  : ${read === target.values.health && regions > 0 ? "✅ 提权后全功能可用" : "❌ 异常"}`);
				if (read !== target.values.health) exitCode = 1;
				proc.close();
			} catch (error) {
				line(`  ❌ 失败：${error.message}`);
				exitCode = 1;
			}
		}
	}

	line("");
	line("--- 释放 ---");
	disposeHelper();
	line(`  释放后 helperStatus(): ${JSON.stringify(helperStatus())}`);
	if (helperStatus() !== null) {
		line("  ❌ 释放后仍有助手");
		exitCode = 1;
	} else {
		line("  ✅ 已释放");
	}
} catch (error) {
	line("");
	line(`❌ 链路失败：${error && error.message ? error.message : String(error)}`);
	if (error && error.stack) line(error.stack);
	exitCode = 1;
} finally {
	disposeHelper();
	try {
		target?.proc?.kill();
	} catch {
		/* 已退出 */
	}
}

process.exit(exitCode);
