/**
 * 提权助手的生命周期：按需启动、等待就绪、连接、跨进程复用、回收。
 *
 * ## 三种启动方式
 *
 * 1. **不提权**（`elevate: false`）：直接 `spawn(node, helper.js)`。用途是自测 ——
 *    整条远程链路可以在没有 UAC 的情况下被完整验证（e2e 就是这么跑的）。
 * 2. **提权**（`elevate: true`）：用 Win32 的 **`ShellExecuteExW` + `runas` 谓词**
 *    触发 UAC（见 `lib/shell-exec.js`）。
 *    提权后**拿不到子进程的 stdout**，所以端口靠一个临时文件回传；
 *    但用 `SEE_MASK_NOCLOSEPROCESS` 可以拿到进程句柄，因此**能等到退出并取到退出码**。
 *
 *    ⚠️ 这里**曾经**用 `PowerShell Start-Process -Verb RunAs`，那条路在提权时**必然失败**：
 *    UAC 弹了、人同意了、PowerShell 退出码 0，但助手进程**从未执行**，
 *    调用方只看到"启动器退出码 0、没有启动助手"，极难定位。
 *    排查中依次排除了 `-WindowStyle Hidden`、参数引号、参数数量、
 *    内核路径、tmpdir、配置文件（每项都有实验证据），最终确认是那条链路本身的问题，
 *    于是整体换成 `ShellExecuteExW`。**不要改回 PowerShell。**
 * 3. **复用**：同一进程内已有一个健康助手就直接复用；跨进程还有"发现记录"可用
 *    （见下文），所以 DSH 重启后也常常不需要再弹 UAC。
 *
 * ## 安全取舍
 *
 * - token 与内核路径写进临时配置文件（助手读完即删），**不走命令行** ——
 *   Windows 下别的进程能通过 WMI 读到命令行，token 泄露等于把提权内存通道交出去。
 * - 助手只监听 `127.0.0.1`，首条消息必须带正确 token。
 * - 助手有空闲自退 + 客户端断连宽限退出，调用方崩了也不会留下常驻的管理员进程。
 *
 * @module dsh-get-admin/launch
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { RemoteMemoryBackend } from "./backend.js";
import { shellExecuteRunAs } from "./shell-exec.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER_PATH = path.join(HERE, "helper.js");

/** 已启动的助手（同一进程内复用）。 */
let current = null;

/** 简单的同步等待（启动探测是短轮询，没必要引入计时器抽象）。 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 生成一次性临时文件名。 */
function tempFile(prefix) {
	return path.join(os.tmpdir(), `${prefix}-${process.pid}-${crypto.randomBytes(6).toString("hex")}.json`);
}

/**
 * 启动（或复用）助手，并返回一个已认证的远程后端。
 *
 * @param {object} options 选项
 * @param {boolean} options.elevate 是否通过 UAC 提权启动
 * @param {string} [options.kernelPath] node-cheat-engine 目录（透传给助手）
 * @param {string} [options.extensions] 领域扩展模块路径（透传给助手，见 helper.js）
 * @param {number} [options.idleTimeoutMs] 助手空闲自退时间
 * @param {number} [options.timeoutMs] RPC 超时
 * @param {number} [options.launchTimeoutMs] 等待助手就绪的上限
 * @param {boolean} [options.discoverExisting] 是否允许复用跨进程发现的助手（默认允许）
 * @param {(message: string) => void} [options.log] 日志回调
 * @returns {Promise<RemoteMemoryBackend>}
 */
export async function startHelperBackend(options) {
	const log = options.log ?? (() => {});
	if (current !== null && current.backend !== null) {
		// 复用前先做一次便宜的探活：助手可能已经空闲自退或被关掉了
		try {
			current.backend.listProcesses();
			log("复用已运行的提权助手");
			return current.backend;
		} catch {
			disposeHelper();
		}
	}

	// 进程内没有 → 试试**跨进程**复用：上一轮（或上一次 DSH 运行）留下的提权助手
	// 可能还在跑。能连上就完全不弹 UAC。
	if (options.discoverExisting !== false) {
		const discovered = connectToDiscoveredHelper();
		if (discovered !== null) {
			const info = helperStatusFrom(discovered);
			current = { backend: discovered, ...info };
			log(`发现并复用了**已在运行**的提权助手（pid ${info.pid}，端口 ${info.port}），不需要 UAC`);
			return discovered;
		}
	}

	const token = crypto.randomBytes(24).toString("hex");
		const portFile = tempFile("get-admin-port");
	const configFile = tempFile("get-admin-cfg");
	fs.writeFileSync(
		configFile,
		JSON.stringify({
			token,
			portFile,
			kernelPath: options.kernelPath ?? "",
			extensions: options.extensions ?? "",
			idleTimeoutMs: options.idleTimeoutMs ?? 1800000
		}),
		"utf8"
	);
	try {
		fs.unlinkSync(portFile);
	} catch {
		/* 不存在更好 */
	}

	const args = [HELPER_PATH, `--config=${configFile}`];
	/** 提权启动器进程（UAC 路径）；非提权路径为 null。 */
	let launcher = null;
	/** 启动器自身的错误（例如 powershell 找不到）。 */
	let launcherError = null;
	/** 启动器的退出码：UAC 被拒时 powershell 会以非零码退出。 */
	let launcherExitCode = null;
	if (options.elevate === true) {
		// ⚠️ **硬闸门**：`GET_ADMIN_NO_ELEVATE=1` 时拒绝提权，而不是弹 UAC。
		//
		// 用途：无人值守运行（CI、批量测试、让模型自己跑验证）时，绝不能出现
		// "UAC 自动/被批准确认 → 未经人确认就提权"。所以给一个能把提权彻底关掉的开关：
		// 触发时**明确报错**，而不是静默降级成不提权 —— 静默降级会让调用方以为拿到了
		// 管理员权限，后续操作以错误的权限假设继续，更难查。
		if (process.env.GET_ADMIN_NO_ELEVATE === "1") {
			// 临时文件已经建出来了，要收掉，否则每次被闸门拦下都会留垃圾
			for (const file of [configFile, portFile]) {
				try {
					fs.unlinkSync(file);
				} catch {
					/* 不存在更好 */
				}
			}
			throw new Error(
				"提权已被 GET_ADMIN_NO_ELEVATE=1 禁用（无人值守保护）。\n" +
					"这条闸门用于避免在无人看管时经 UAC 自动获得管理员权限。\n" +
					"要真正提权，请先清除该环境变量，并由人在 UAC 弹窗中确认。"
			);
		}
		// UAC：只传一个配置文件路径，避免引号与转义问题
		//
		// ⚠️ **每个参数必须显式带引号**，不能用 `-ArgumentList @('a','b')` 的数组形式。
		//
		// 这是实测定位到的真 bug，且极其隐蔽：
		// `Start-Process -ArgumentList` 传数组时，PowerShell 把元素**用空格拼成一个
		// 命令行**，**不会**为含空格的元素补引号。而本机 node 装在
		//   `C:\Program Files\nodejs\node.exe`
		// 于是提权后实际执行的命令行被空格切成了多个参数，node 拿到无效参数后
		// **静默退出**（`Start-Process` 不等子进程，所以调用方只看到"启动器退出码 0"）。
		//
		// 表现极具误导性：UAC 弹了、人同意了、却"没有启动助手"，
		// 而且助手的诊断日志**一个字都没有** —— 因为进程根本没跑起来。
		//
		// 我早先的"最小实验"之所以看起来成功，是因为**它用的脚本路径没有空格**，
		// 所以只证明了"提权能起进程"，没能复现这个问题。
		//
		// ── 用 ShellExecuteExW(runas) 提权启动 ──────────────────────────────
		//
		// 这里**取代了**原来的 PowerShell 方案：
		//   `powershell -Command "Start-Process -FilePath <node> -ArgumentList @(...) -Verb RunAs"`
		//
		// 原方案在提权路径上**必然失败**，而且失败方式极具误导性：UAC 弹了、人同意了、
		// PowerShell 退出码 0，但**助手进程从未执行**（连它第一行写的诊断都没有），
		// 调用方只看到"启动器退出码 0、没有启动助手"。
		//
		// 排查中依次**排除**（都有实验证据）：
		//   · `-WindowStyle Hidden` —— 最小实验证明带它也能起提权进程；
		//   · 参数引号 —— 改成显式包引号后仍失败；
		//   · 参数数量 —— 改成"生成临时 .ps1、只启动脚本、零复杂参数"后**仍失败**；
		//   · 内核路径 / tmpdir / 配置文件 —— 非提权路径完全正常。
		// 结论：问题就在 `Start-Process -Verb RunAs` 这条链路本身。
		//
		// 现在直接用 Win32 原生的 `ShellExecuteExW` + `runas` 谓词（见 lib/shell-exec.js），
		// 不经过 PowerShell：既没有转义问题、也没有执行策略问题。
		// 而且它用 `SEE_MASK_NOCLOSEPROCESS` 拿到进程句柄，可以**真的等到退出并取到退出码** ——
		// 这正是早先"退出码 0 却什么都没发生"无法分辨的地方。
		try {
			const run = shellExecuteRunAs({
				file: process.execPath,
				args: [HELPER_PATH, `--config=${configFile}`],
				verb: "runas",
				show: 0, // SW_HIDE
				timeoutMs: 60000
			});
			launcherExitCode = run.exitCode;
			log(`已请求 UAC 提权启动助手（启动器退出码 ${run.exitCode}）`);
		} catch (error) {
			// 提权被取消（用户在 UAC 点「否」）或绑定不可用 —— 都如实抛出去，
			// 由上层给出可读报错。**不再**把它伪装成"助手没就绪"。
			launcherError = error;
			throw error;
		}
	} else {
		// 助手进程默认 `stdio: "ignore"`：它的输出对使用者没有价值，留着只会污染终端。
		//
		// 但**启动失败时看不到原因**（只报"端口文件未生成"），排查很难。
		// 所以支持一个诊断开关：设了 `GET_ADMIN_HELPER_LOG=<文件>` 就把助手的
		// stdout/stderr 落到那个文件。默认行为不变。
		const helperLog = process.env.GET_ADMIN_HELPER_LOG;
		const child =
			typeof helperLog === "string" && helperLog !== ""
				? (() => {
						const fd = fs.openSync(helperLog, "a");
						const c = spawn(process.execPath, args, { windowsHide: true, stdio: ["ignore", fd, fd] });
						fs.closeSync(fd);
						return c;
					})()
				: spawn(process.execPath, args, { windowsHide: true, stdio: "ignore" });
		child.on("error", () => {
			/* 同上 */
		});
		child.unref?.();
		log("已启动助手（未提权）");
	}

	// 提权时还要等用户点 UAC，给足时间。
	//
	// 但**不能只等超时**：用户在 UAC 弹窗点「否」时，powershell 会立刻退出，
	// 而助手永远不会就绪。早先的实现会一直干等到 90 秒才报错 ——
	// 实测被感知为「一拒绝耗时就变长」，非常糟。
	// 所以这里同时盯着启动器进程：它一消失且没有端口文件，就立刻给出结论。
	const deadline = Date.now() + (options.launchTimeoutMs ?? (options.elevate === true ? 90_000 : 20_000));
	let info = null;
	let launcherGone = false;
	while (Date.now() < deadline) {
		if (fs.existsSync(portFile)) {
			try {
				info = JSON.parse(fs.readFileSync(portFile, "utf8"));
				if (typeof info.port === "number" && info.port > 0) break;
			} catch {
				/* 文件可能正写到一半，下一轮再读 */
			}
			info = null;
		}
		// 启动器退出且端口文件还没出现 → 提权未发生（UAC 被拒 / 被策略拦截）。
		// 再等下去没有意义，立刻失败。
		if (launcher !== null && launcherExitCode !== null && launcherError === null) {
			// 给助手一点点余量把端口文件写完（正常路径下它几乎同时出现）
			await sleep(300);
			if (!fs.existsSync(portFile)) {
				launcherGone = true;
				break;
			}
		}
		if (launcherError !== null) break;
		await sleep(150);
	}
	if (info === null) {
		// 助手启动失败时别留下半截临时文件
		for (const file of [configFile, portFile]) {
			try {
				fs.unlinkSync(file);
			} catch {
				/* 忽略 */
			}
		}
		if (launcherGone || launcherError !== null) {
			// ⚠️ **如实转述真实原因，不要套一句猜测的话。**
			//
			// 早先这里固定写"最常见的原因是**在 UAC 弹窗里点了「否」**"，
			// 结果是：无论真实原因是什么（执行策略、链路失效、绑定不可用……），
			// 用户看到的都是"你点了否" —— 一句**可能完全不实**的话，
			// 而且掩盖了 `launcherError` 里真正有价值的信息。实测被它误导过多次。
			//
			// 现在：有 `launcherError` 就以它为主（那是 `ShellExecuteExW` 或
			// 闸门给出的确切原因），没有才退回通用说明。
			const detail = launcherError !== null ? `${launcherError.message}` : "";
			throw new Error(
				"提权未能启动助手。\n" +
					(detail !== ""
						? `原因：${detail}`
						: `请求提权的进程已退出，但没有启动助手（启动器退出码 ${launcherExitCode ?? "-"}）。\n` +
							"常见原因：在 UAC 弹窗里点了「否」、弹窗被策略拦截、或被安全软件阻止。")
			);
		}
		throw new Error(
			options.elevate === true
				? "提权助手没有就绪：可能 UAC 被取消、被策略拦截，或助手启动失败。"
				: "助手没有就绪：启动失败或端口文件未生成。"
		);
	}

	const backend = new RemoteMemoryBackend({
		host: "127.0.0.1",
		port: info.port,
		token,
		timeoutMs: options.timeoutMs ?? 60_000
	});
	try {
		fs.unlinkSync(portFile);
	} catch {
		/* 忽略 */
	}
	current = { backend, pid: info.pid, elevated: info.elevated === true, port: info.port };
	// 只有**提权**助手才留"发现记录"：它的价值就是被复用，
	// 而未提权助手随时能便宜地重建，留记录反而增加攻击面。
	if (current.elevated) writeDiscovery({ port: info.port, pid: info.pid, token });
	else clearDiscovery();
	log(
		`助手就绪：pid ${info.pid}，端口 ${info.port}，` +
			`助手权限 ${backend.helperElevated ? "已提权" : "未提权"}`
	);
	return backend;
}

/* ------------------------------------------------------------------ *
 * 跨进程复用：发现记录
 *
 * 为什么需要：`current` 是**进程内**状态。DSH 一重启（或换一个进程调用），
 * 即使提权助手还在跑，也看不到它、只能重新弹 UAC。
 * 记一条发现记录后，新进程可以先试着连上那个**已经在运行**的助手，
 * 连上就完全不需要 UAC。
 *
 * 安全取舍：记录里含 token，等于"复用一个已授权通道的能力"。
 * 但它只写在**当前用户**的 profile 目录（非世界可读），
 * 且助手自身 30 分钟空闲就自退 —— 与"保存管理员密码"是完全不同量级的事：
 * 这里保存的是一个迟早会消失的会话凭证，而不是长期凭据。
 * ------------------------------------------------------------------ */

/** 发现记录路径（按用户隔离）。 */
function discoveryPath() {
	const base =
		process.env.DSH_PROFILE_DIR ??
		process.env.LOCALAPPDATA ??
		os.homedir();
	return path.join(base, "get-admin-helper-discovery.json");
}

/** 写入发现记录（尽力而为，失败不影响主流程）。 */
function writeDiscovery(info) {
	try {
		fs.writeFileSync(discoveryPath(), JSON.stringify({ ...info, at: Date.now() }), {
			encoding: "utf8",
			mode: 0o600
		});
	} catch {
		/* 写不进去就只是失去"跨进程复用"这个优化 */
	}
}

/** 清除发现记录。 */
function clearDiscovery() {
	try {
		fs.unlinkSync(discoveryPath());
	} catch {
		/* 不存在更好 */
	}
}

/**
 * 尝试连上一个**已经在运行的提权助手**（来自发现记录）。
 *
 * @returns {RemoteMemoryBackend|null} 连上并认证成功则返回后端，否则 null
 */
function connectToDiscoveredHelper() {
	let info;
	try {
		info = JSON.parse(fs.readFileSync(discoveryPath(), "utf8"));
	} catch {
		return null;
	}
	if (info === null || typeof info.port !== "number" || typeof info.token !== "string" || info.token === "") {
		clearDiscovery();
		return null;
	}
	try {
		// 构造即验证：RemoteMemoryBackend 的构造函数会做一次 hello + token 认证
		const backend = new RemoteMemoryBackend({
			host: "127.0.0.1",
			port: info.port,
			token: info.token,
			timeoutMs: 15_000
		});
		if (backend.helperElevated !== true) {
			// 记录里本应只有提权助手；不是就当作过期记录清掉
			backend.dispose();
			clearDiscovery();
			return null;
		}
		return backend;
	} catch {
		// 助手已经自退 / 端口不通 —— 记录过期
		clearDiscovery();
		return null;
	}
}

/** 当前助手的描述（没有则为 null）。 */
export function helperStatus() {
	if (current === null) return null;
	return { pid: current.pid, port: current.port, elevated: current.elevated };
}

/**
 * 读发现记录里的助手**是否还活着**（轻量、只读、不建连接）。
 *
 * ## 为什么需要它（这是实测发现的真实缺陷）
 *
 * 助手是**跨进程共享**的：一次 UAC 确认之后，DSH 重启、CLI、其它插件都能复用它。
 * 但 DSH 里那个服务实例原本只认**自己进程内启动的**助手
 * （`helperStatus()` 只读进程内变量 `current`），于是出现一个很迷惑的现象：
 *
 *   用 CLI 经 UAC 起了一个提权助手（`helperElevated: true`）→
 *   `/get-admin/status` 仍报 `helperElevated: false` →
 *   **界面右下角的图标一直显示"未获得"，不会切换成已获得**。
 *
 * 也就是说"跨进程复用"在**界面**上是不可见的，用户看不出已经拿到权限了。
 * 所以状态查询必须也看发现记录。
 *
 * ## 为什么不能直接调 `connectToDiscoveredHelper()`
 *
 * 那个函数会**真连一次**并做 token 握手（构造 `RemoteMemoryBackend`），
 * 而状态端点被客户端**每 4 秒轮询一次** —— 为了一次显示而反复建连接不可接受。
 * 这里只做两件廉价的事：读一个小 JSON、`kill(pid, 0)` 探活。
 *
 * @returns {{ pid: number, port: number, elevated: boolean }|null}
 */
export function discoveredHelperStatus() {
	if (current !== null) return null; // 进程内已有助手时无需看记录
	let info;
	try {
		info = JSON.parse(fs.readFileSync(discoveryPath(), "utf8"));
	} catch {
		return null; // 没有记录 / 读不动 → 就是没有
	}
	if (info === null || typeof info.pid !== "number" || typeof info.port !== "number") return null;

	// 探活：信号 0 不真的发信号，只做权限与存在性检查。
	// 进程不存在会抛 ESRCH；其它错误（如 EPERM）说明进程存在但我们无权发信号，
	// 那也算"活着"。
	try {
		process.kill(info.pid, 0);
	} catch (error) {
		if (error === null || error === undefined || error.code === "ESRCH") return null;
	}
	// 记录里放的**只可能是提权助手**（见 writeDiscovery 的调用点），所以这里为 true。
	return { pid: info.pid, port: info.port, elevated: true };
}

/**
 * 从一个已连接的后端取助手描述。
 *
 * `RemoteMemoryBackend` 自己知道助手 pid（`hello` 时拿到的）与是否提权，
 * 所以不需要额外的握手。
 */
function helperStatusFrom(backend) {
	const elevated = backend.helperElevated === true;
	// worker 与助手之间是本地 socket，对端端口可从后端记录里取；
	// 这里的 port 只用于诊断展示，取不到就给 0。
	return {
		pid: typeof backend.helperPid === "number" ? backend.helperPid : 0,
		port: typeof backend.helperPort === "number" ? backend.helperPort : 0,
		elevated
	};
}

/**
 * 释放当前助手。
 *
 * 两步都要做：
 *   1. 关掉 RPC 通道（worker 里的 socket）；
 *   2. **主动结束助手进程** —— 否则会在用户机器上留下一个常驻的、可能带管理员权限的进程。
 *      未提权时 `process.kill` 直接有效；提权时父进程无权杀它，改由助手自己察觉到
 *      「客户端断了」后退出（见 helper.js 的 socket close 宽限退出）。
 *
 * ## 为什么要**同时**处理跨进程发现记录（这是一个真实缺陷的修复）
 *
 * 早先本函数第一行是 `if (current === null) return;` —— 于是当助手是**别的进程**
 * 启动的（只存在于发现记录里、进程内 `current` 为 null）时，它会**直接返回**，
 * 后面的 `clearDiscovery()` 永不执行。后果是一组自相矛盾的行为：
 *
 *   - `status()` 报 `helperElevated: true, source: 'discovered'`（状态源修好了，看得见）；
 *   - `release()` 却报"当前没有提权助手，无需释放"（动作没跟上）；
 *   - 界面右下角因此**永远停在"已获得"**，点多少次都没反应；
 *   - 发现记录也一直在，下个进程还会去连它。
 *
 * 现在：无论助手来自进程内还是发现记录，都尽力处理，并**如实回报做了什么**。
 * 提权助手本进程无权杀（它是管理员进程），这时不能假装杀掉了 ——
 * 而是清掉复用记录、并说明"它会在空闲超时后自行退出"。
 *
 * @returns {{ killed: boolean, clearedDiscovery: boolean, pid: number|null }}
 */
export function disposeHelper() {
	let killed = false;
	let pid = null;

	if (current !== null) {
		pid = typeof current.pid === "number" ? current.pid : null;
		try {
			current.backend.dispose();
		} catch {
			/* 忽略 */
		}
		try {
			if (pid !== null && pid > 0) {
				process.kill(pid);
				killed = true;
			}
		} catch {
			/* 提权/已退出时会失败，交给助手的宽限退出 */
		}
		current = null;
	}

	// 跨进程发现记录里的助手：进程内可能根本没有它。
	// 尽力杀（未提权时能成功；提权时本进程无权，会抛错），
	// **但记录一定要清掉** —— 否则下个进程还会去连一个我们已放弃的助手。
	let discoveredPid = null;
	try {
		const info = JSON.parse(fs.readFileSync(discoveryPath(), "utf8"));
		if (info !== null && typeof info.pid === "number") discoveredPid = info.pid;
	} catch {
		/* 没有记录 */
	}
	const hadDiscovery = discoveredPid !== null;
	if (discoveredPid !== null) {
		try {
			process.kill(discoveredPid);
			if (pid === null) {
				killed = true;
				pid = discoveredPid;
			}
		} catch {
			/* 提权助手本进程杀不掉，正常 */
		}
	}
	clearDiscovery();

	return { killed, clearedDiscovery: hadDiscovery, pid };
}
