/**
 * 提权助手进程 —— **通用**的「以管理员权限执行跨进程内存操作」RPC 服务。
 *
 * ## 它是什么
 *
 * 一个独立的 Node 进程，由 `launch.js` 启动（可选经 UAC 提权）。启动后：
 *
 *   1. 监听 `127.0.0.1` 上一个临时端口（只本机可达）；
 *   2. 把端口 / pid / 是否已提权写进**临时文件**回传（提权启动时拿不到子进程 stdout）；
 *   3. 按 `protocol.js` 的帧协议接受请求，把内存操作转成 node-cheat-engine 的调用；
 *   4. 空闲超时或客户端全部断连后**自己退出** ——
 *      这是必须的：管理员进程**无法被普通权限的父进程杀死**，
 *      「DSH 退出后不留常驻管理员进程」只能由助手自己决定。
 *
 * ## 为什么是通用插件（而不是 cheat-engine 的一部分）
 *
 * 内存后端（`MemoryBackend`）的形状是稳定的：进程枚举、打开/关闭、读/写、区域、模块、
 * 线程、分配、保护。任何需要「以管理员权限访问别的进程内存」的插件都能用它，
 * 而不是各自重写一遍 UAC 启动 + 帧协议 + 同步等待。
 *
 * 领域相关的方法（例如某个插件自己的驱动控制）通过 **`--extensions=<模块路径>`**
 * 挂进来：那个模块导出 `create()`，返回 `{ methods: { 名字: (params, payload) => ... } }`。
 * 这样本文件不需要知道任何具体插件的存在。
 *
 * ## 安全边界
 *
 * - token 只走临时配置文件，**不放命令行**（Windows 下别的进程能通过 WMI 读到命令行）；
 * - 首条消息必须是带正确 token 的 `hello`，否则直接断开；
 * - 只监听 `127.0.0.1`。
 *
 * @module dsh-get-admin/helper
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";

import { encodeResponse, FrameReader } from "./protocol.js";
import { isElevated } from "./elevation.js";

const require = createRequire(import.meta.url);

/**
 * 助手启动的**最早**诊断记录。
 *
 * ## 为什么必须在最前面
 *
 * 实测问题：提权启动助手时，`GET_ADMIN_HELPER_LOG` 指向的日志文件**根本没被创建**，
 * 而调用方只看到"启动器退出码 0、没有启动助手"，完全看不出原因。
 *
 * 关键点：日志初始化在 `readConfig()` **之后**，而 `readConfig()` 里的
 * `readFileSync` 一旦抛错（配置不存在/读不到），进程会在**写任何东西之前**就死掉，
 * 于是日志文件永远不出现 —— **诊断手段本身先死了**，这正是排查卡住的原因。
 *
 * 所以这里在**任何可能抛错的操作之前**先落盘一行"进程起来了"。
 * 无论后面死在哪一步，这一行都会留下 —— 至少能区分
 * 「进程从未启动」与「启动了但随后失败」。
 *
 * 只在设了 `GET_ADMIN_HELPER_LOG` 时写；默认不产生任何 I/O。
 */
function bootTrace(message) {
	const file = process.env.GET_ADMIN_HELPER_LOG;
	if (file === undefined || file === "") return;
	try {
		fs.appendFileSync(
			file,
			`${new Date().toISOString()} pid=${process.pid} argv=${JSON.stringify(process.argv.slice(2))} ${message}\n`,
			"utf8"
		);
	} catch {
		/* 诊断失败绝不影响助手 */
	}
}

bootTrace("助手进程已启动（在解析配置之前）");

/** 命令行参数读取（助手由 launch.js 以 `--key=value` 形式启动）。 */
function argOf(name, fallback) {
	const prefix = `--${name}=`;
	const hit = process.argv.find((value) => value.startsWith(prefix));
	return hit === undefined ? fallback : hit.slice(prefix.length);
}

/**
 * 读配置。
 *
 * 刻意**不**把 token 放在命令行上 —— 见文件顶部「安全边界」。
 * 配置文件读完立刻删除，减少残留。
 */
function readConfig() {
	const configPath = argOf("config", "");
	if (configPath !== "") {
		// 在读之前先记录**配置是否存在** —— 这是"提权后读不到配置"最直接的证据。
		// 注意：提权进程可能看到不同的 %TEMP%，所以这里如实打印它**实际**看到的路径与存在性。
		bootTrace(`准备读配置 path=${configPath} exists=${fs.existsSync(configPath)}`);
		let raw;
		try {
			raw = fs.readFileSync(configPath, "utf8");
		} catch (error) {
			bootTrace(`读配置失败：${error && error.message ? error.message : String(error)}`);
			throw error;
		}
		bootTrace(`配置已读到（${raw.length} 字节），即将删除`);
		try {
			fs.unlinkSync(configPath);
		} catch {
			/* 删不掉不影响功能 */
		}
		return JSON.parse(raw);
	}
	// 兼容直接传参（测试与手工调试用）
	return {
		token: argOf("token", ""),
		portFile: argOf("port-file", ""),
		kernelPath: argOf("kernel", ""),
		extensions: argOf("extensions", ""),
		idleTimeoutMs: Number(argOf("idle-timeout-ms", "1800000"))
	};
}

const CONFIG = readConfig();
const TOKEN = CONFIG.token ?? "";
const PORT_FILE = CONFIG.portFile ?? "";
const KERNEL_PATH = CONFIG.kernelPath ?? "";
const EXTENSIONS_PATH = CONFIG.extensions ?? "";
const IDLE_TIMEOUT_MS = Number(CONFIG.idleTimeoutMs ?? 1800000);

if (TOKEN === "" || PORT_FILE === "") {
	process.stderr.write("helper: 缺少 token 或 portFile（见 lib/helper.js 顶部说明）\n");
	process.exit(2);
}

/**
 * 解析内核（node-cheat-engine）目录。
 *
 * 顺序：显式 `kernelPath` → 环境变量 → 本进程可解析到的依赖目录。
 * 刻意**不含硬编码绝对路径**：换机器/换目录布局都还能找到。
 *
 * @returns {object} 内核模块
 */
function resolveKernel() {
	const candidates = [];
	if (KERNEL_PATH !== "") candidates.push(KERNEL_PATH);
	if (process.env.CE_KERNEL_PATH !== undefined && process.env.CE_KERNEL_PATH !== "") {
		candidates.push(process.env.CE_KERNEL_PATH);
	}
	// 助手所在目录（<插件>/lib/）以及其上层，逐级找 node_modules/node-cheat-engine
	let dir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
	for (;;) {
		candidates.push(path.join(dir, "node_modules", "node-cheat-engine"));
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	const failures = [];
	for (const candidate of candidates) {
		try {
			return require(path.resolve(candidate));
		} catch (error) {
			failures.push(`${candidate}: ${error && error.message ? error.message : String(error)}`);
		}
	}
	try {
		return require("node-cheat-engine");
	} catch (error) {
		failures.push(`node-cheat-engine: ${error && error.message ? error.message : String(error)}`);
	}
	throw new Error(`helper 无法加载内核（node-cheat-engine）：\n  ${failures.join("\n  ")}`);
}

const ce = resolveKernel();

/**
 * 挂载调用方提供的扩展方法。
 *
 * 取不到（路径空/模块加载失败/没有 `create`）时**不致命** ——
 * 助手仍然提供完整的内存 RPC，只是少了那些领域方法。
 * 失败原因会记在 `extensionsError` 里，随 `hello` 回传，便于调用方定位。
 */
let extensions = null;
let extensionsError = null;
if (EXTENSIONS_PATH !== "") {
	try {
		const mod = require(path.resolve(EXTENSIONS_PATH));
		extensions = typeof mod?.create === "function" ? mod.create({ ce, require, kernelPath: KERNEL_PATH }) : null;
		if (extensions === null) extensionsError = "扩展模块没有导出 create()";
	} catch (error) {
		extensionsError = error && error.message ? String(error.message) : String(error);
	}
}

/** 句柄表：id → 内核 Process。 */
const handles = new Map();
let nextHandleId = 1;
let lastActivity = Date.now();
/** 客户端断开后的宽限退出计时器。 */
let shutdownTimer = null;
/** 当前连接数。 */
let openConnections = 0;

/**
 * 客户端断开后等多久就自退。
 *
 * 提权启动的助手**父进程无权杀死它**，所以「不留常驻管理员进程」只能自己收尾。
 * 宽限期是为了扛住"调用方刚好在重连"的瞬间。
 */
const CLIENT_GONE_GRACE_MS = Number(argOf("grace-ms", "8000"));

/** 取句柄，失效时给出明确错误。 */
function requireHandle(id) {
	const proc = handles.get(id);
	if (proc === undefined) throw new Error(`句柄 ${id} 不存在（可能已关闭，或助手重启过）`);
	if (!proc.isOpen) throw new Error(`句柄 ${id} 已失效（目标进程可能已退出）`);
	return proc;
}

/**
 * 执行一条 RPC。
 *
 * 内存类调用一律**直通内核后端**（`proc.backend` + `proc.backendHandle`），
 * 而不是走 `Process` 的高层方法：高层方法会把 `BackendRegion` 转成 `MemoryRegion`
 * （`regionSize`/`state` → `memorySize`/`committed`），再转回来会丢信息。
 * 直通后端接口意味着这条通道两端严格同一种语义。
 *
 * @param {string} method 方法名
 * @param {object} params 参数
 * @param {Buffer} payload 原始字节（写内存用）
 * @returns {{ result?: unknown, payload?: Buffer }}
 */
function dispatch(method, params, payload) {
	/** 取句柄所在的内核后端与后端句柄，然后调用。 */
	const viaBackend = (id, name, ...args) => {
		const proc = requireHandle(id);
		const backend = proc.backend;
		const handle = proc.backendHandle;
		if (typeof backend[name] !== "function") {
			throw new Error(`内核后端 ${backend.name} 不支持 ${name}()`);
		}
		return backend[name](handle, ...args);
	};

	switch (method) {
		case "hello":
			return {
				result: {
					ok: true,
					pid: process.pid,
					elevation: isElevated(),
					platform: process.platform,
					// 让调用方能分辨"扩展没挂上"和"扩展方法不存在"
					extensions: extensions !== null,
					extensionsError
				}
			};
		case "listProcesses":
			return { result: ce.listProcesses() };
		case "openProcess": {
			// 句柄由助手持有：权限不足的失败就发生在这里，也正是需要提权的原因
			const proc = ce.Process.open(params.pid);
			const id = nextHandleId++;
			handles.set(id, proc);
			return { result: { id, pid: proc.pid, name: proc.name } };
		}
		case "closeProcess": {
			const proc = handles.get(params.id);
			handles.delete(params.id);
			if (proc !== undefined) proc.close();
			return { result: null };
		}
		case "queryRegions":
			return { result: viaBackend(params.id, "queryRegions", params.filter ?? {}) };
		case "readProcessMemory": {
			const buffer = viaBackend(params.id, "readProcessMemory", BigInt(params.address), params.size);
			return { result: { length: buffer.length }, payload: buffer };
		}
		case "writeProcessMemory":
			return {
				result: viaBackend(
					params.id,
					"writeProcessMemory",
					BigInt(params.address),
					payload,
					params.fixProtection !== false
				)
			};
		case "queryModules":
			return { result: viaBackend(params.id, "queryModules") };
		case "queryThreads":
			return { result: viaBackend(params.id, "queryThreads") };
		case "allocate":
			return {
				result: viaBackend(
					params.id,
					"allocate",
					params.size,
					params.protect,
					params.preferred === undefined ? undefined : BigInt(params.preferred)
				)
			};
		case "free":
			viaBackend(params.id, "free", BigInt(params.address));
			return { result: null };
		case "changeProtection":
			return {
				result: viaBackend(params.id, "changeProtection", BigInt(params.address), params.size, params.newProtect)
			};
		case "isWow64":
			return { result: viaBackend(params.id, "isWow64") };
		// 目标存活判断。
		//
		// ⚠️ 这个方法**必须**存在，否则「目标已退出」这条信息在远程后端下整个丢失：
		// 内核 `Process.isProcessAlive()`（win/process.ts）在 `backend.isProcessAlive`
		// 不是函数时如实返回 `undefined`，而会话层把 undefined 当成「未知」放行 ——
		// 于是所有工具退回旧行为，产物是**静默错值**：
		//   `ce_modules` 返回 0 个模块、`ce_regions` 返回 0 个区域、
		//   `ce_read` 报「…但目标进程**仍在运行**」（与事实相反）、
		//   `ce_write` 甚至被包装成误导性的「权限不足」。
		// 句柄由助手持有（Windows 上进程退出后句柄依然有效），
		// 所以只有助手能问出真相，这里必须桥一次。
		case "isProcessAlive": {
			const proc = requireHandle(params.id);
			const backend = proc.backend;
			if (typeof backend.isProcessAlive !== "function") {
				// 后端自己无法判断（例如 ceserver）—— 如实报"未知"，而不是猜
				return { result: undefined };
			}
			return { result: backend.isProcessAlive(proc.backendHandle) };
		}
		case "shutdown":
			// 调用方主动要求收尾（例如"释放管理员权限"）：退出前尽量关掉句柄
			setImmediate(() => shutdown());
			return { result: { ok: true } };
		default: {
			// 领域方法交给扩展；没有扩展就如实报错（而不是静默返回 undefined）
			const handler = extensions?.methods?.[method];
			if (typeof handler === "function") {
				return handler(params, payload) ?? { result: null };
			}
			throw new Error(`helper 不支持的方法：${method}`);
		}
	}
}

const server = net.createServer((socket) => {
	socket.setNoDelay(true);
	const reader = new FrameReader();
	// 认证状态是**每连接**的：不能因为上一条连接认证过就信任新连接
	let authenticated = false;
	openConnections += 1;
	if (shutdownTimer !== null) {
		clearTimeout(shutdownTimer);
		shutdownTimer = null;
	}

	socket.on("data", (chunk) => {
		lastActivity = Date.now();
		let frames;
		try {
			frames = reader.push(chunk);
		} catch {
			socket.destroy();
			return;
		}
		for (const { header, payload } of frames) {
			// 认证：每条连接的第一条消息都必须是带正确 token 的 hello
			if (!authenticated) {
				if (header.method !== "hello" || header.token !== TOKEN) {
					socket.destroy();
					return;
				}
				authenticated = true;
			}
			lastActivity = Date.now();
			try {
				const { result, payload: outPayload } = dispatch(header.method, header.params ?? {}, payload);
				socket.write(encodeResponse({ id: header.id, ok: true, result }, outPayload ?? Buffer.alloc(0)));
			} catch (error) {
				socket.write(
					encodeResponse({
						id: header.id,
						ok: false,
						error: error && error.message ? String(error.message) : String(error)
					})
				);
			}
		}
	});
	socket.on("error", () => socket.destroy());
	socket.on("close", () => {
		openConnections -= 1;
		// 最后一条连接断了 → 宽限期后自退（提权进程无法被父进程杀掉，只能自己收尾）
		if (openConnections <= 0 && shutdownTimer === null) {
			shutdownTimer = setTimeout(() => shutdown(), CLIENT_GONE_GRACE_MS);
			shutdownTimer.unref?.();
		}
	});
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	// 端口写进文件：提权启动时拿不到子进程的 stdout，只能靠文件回传
	fs.writeFileSync(
		PORT_FILE,
		JSON.stringify({
			port: address.port,
			pid: process.pid,
			elevated: isElevated(),
			at: Date.now(),
			extensions: extensions !== null
		}),
		"utf8"
	);
});

// 空闲自退：调用方崩了也不会留下一个常驻的管理员进程
setInterval(() => {
	if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
		shutdown();
	}
}, 30_000).unref();

/** 被信号终止或客户端消失后收尾：尽量把句柄关掉再退出。 */
function shutdown() {
	for (const proc of handles.values()) {
		try {
			proc.close();
		} catch {
			/* 忽略 */
		}
	}
	handles.clear();
	process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
