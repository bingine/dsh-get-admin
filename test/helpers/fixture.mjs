/**
 * 启动 node-cheat-engine 自带的测试夹具目标进程。
 *
 * 夹具首行输出 JSON：
 *   {"ready":true,"pid":..,"base":"0x..","values":{..},"offsets":{..}}
 *
 * ## 为什么这里用 stdout 管道
 *
 * 早先 DSH 跑在受限沙箱（read-only / workspace-write）时，程序**不能打开命名管道**，
 * `spawn` 用默认 `stdio: 'pipe'` 会让 `stdout` 变成 `null`。当时的绕法是把子进程输出
 * 重定向到临时文件。但那个绕法在 `node --test` 下会踩到另一个坑：
 * **测试运行器替换过 `child_process`**，把文件路径当 stdio 传会报
 * `ERR_INVALID_SYNC_FORK_INPUT`。
 *
 * 现在沙箱为 `danger-full-access`，管道可用，所以回到最直接、最可靠的做法：
 * `stdio: 'pipe'` 读首行。若将来又要跑在受限沙箱里，需要重新引入文件重定向绕法
 * （并且要绕开测试运行器的 child_process 替换，例如经一个中间进程启动夹具）。
 *
 * @module dsh-get-admin/test/helpers/fixture
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * 找出 node-cheat-engine 目录。
 *
 * 顺序：环境变量 → 与本插件**并排**的兄弟仓库 → 本插件依赖目录。
 * 刻意不写死绝对路径。
 *
 * @param {string} [fromDir] 从哪里开始向上找（默认本文件所在目录）
 * @returns {string|null}
 */
export function findKernelDir(fromDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
	/** 判断某个目录是不是可用内核（有夹具脚本即可判定）。 */
	const isKernel = (dir) => {
		try {
			return fs.statSync(path.join(dir, "test", "fixture-target.js")).isFile();
		} catch {
			return false;
		}
	};

	const candidates = [];
	if (process.env.CE_KERNEL_PATH) candidates.push(process.env.CE_KERNEL_PATH);

	let dir = fromDir;
	for (;;) {
		candidates.push(path.join(dir, "node_modules", "node-cheat-engine"));
		candidates.push(path.join(path.dirname(dir), "node-cheat-engine"));

		// 兄弟目录按特征搜索（**不写死目录名**）。
		// 写死名字的代价实测过：仓库目录一改名（例如去掉名字里的 "plugin"），
		// 这里就静默失效 —— 表现为相关测试**全部被 skip** 而不是报错，很容易漏看。
		const parent = path.dirname(dir);
		try {
			for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
				if (!entry.isDirectory() || !/cheat-engine/i.test(entry.name)) continue;
				candidates.push(path.join(parent, entry.name, "node-cheat-engine"));
				candidates.push(path.join(parent, entry.name));
			}
		} catch {
			/* 父目录不可读就跳过这一层 */
		}

		const up = path.dirname(dir);
		if (up === dir) break;
		dir = up;
	}

	for (const candidate of candidates) {
		if (isKernel(candidate)) return candidate;
	}
	return null;
}

/**
 * 启动夹具目标进程并等它报告 ready。
 *
 * @param {string} kernelDir 内核目录
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ proc: import("node:child_process").ChildProcess, pid: number, base: bigint, offsets: object, values: object }>}
 */
export function startFixture(kernelDir, options = {}) {
	const proc = spawn(process.execPath, [path.join(kernelDir, "test", "fixture-target.js")], {
		cwd: kernelDir,
		// stdin 保持管道：夹具用 readline 挂在 stdin 上，stdin 一 EOF 它就会自己退出
		// （曾经用 'ignore' 导致"ready 写出来了，但进程已经没了"）。
		stdio: ["pipe", "pipe", "pipe"]
	});

	let stderr = "";
	proc.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	const timeoutMs = options.timeoutMs ?? 20_000;
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(`夹具启动超时（${timeoutMs}ms）。stderr=${stderr || "(空)"}`));
		}, timeoutMs);
		const settle = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			fn(value);
		};

		proc.on("error", (error) => settle(reject, error));
		proc.on("exit", (code, signal) =>
			settle(reject, new Error(`夹具在报告 ready 前退出：code=${code} signal=${signal}。stderr=${stderr || "(空)"}`))
		);

		let buffer = "";
		proc.stdout.on("data", (chunk) => {
			buffer += chunk.toString();
			const nl = buffer.indexOf("\n");
			if (nl === -1) return;
			try {
				const info = JSON.parse(buffer.slice(0, nl));
				settle(resolve, {
					proc,
					pid: info.pid,
					base: BigInt(info.base),
					offsets: info.offsets,
					values: info.values
				});
			} catch (error) {
				settle(reject, error);
			}
		});
	});
}

/** 关掉夹具进程（不抛错）。 */
export function stopFixture(fixture) {
	try {
		fixture?.proc?.kill();
	} catch {
		/* 已退出 */
	}
}
