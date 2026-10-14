/**
 * 远程内存后端 —— 实现内核的 `MemoryBackend`，但所有 Win32 调用都在**提权助手进程**里发生。
 *
 * ## 关键点：它在 JS 侧是**同步**的
 *
 * `capabilities.sync = true`，每个方法都直接返回值（内部通过 `Atomics.wait` 阻塞等 socket 结果，
 * 见 `worker.js` 解释为什么只能这么做）。因此内核会把它当成和 `SelfBackend` 同类的同步后端，
 * 于是 `ScanSession` / `PointerScanner` / `AutoAssembler` / `.CT` / 地址表达式**全部无需改动即可用** ——
 * 这正是选择「实现后端」而不是「转发高层工具调用」的原因。
 *
 * ## 已知限制
 *
 * - **并行扫描必须关掉**：内核的扫描 worker（`win/scan-worker.ts`）自己 `import { Process }`，
 *   用的是它自己那份 koffi，走不到本后端。所以走远程时必须 `parallel: false`
 *   （由 `session.js` 强制），扫描退化到单线程路径 —— 慢但正确。
 * - 每次内存操作都会**阻塞宿主主线程**（与 `SelfBackend` 行为一致；扫描本来就会阻塞）。
 *
 * @module dsh-cheat-engine/remote/backend
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { fromWire } from "./protocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 共享区默认 16 MiB：扫描分块默认 4 MiB，留足余量。 */
const DEFAULT_BUFFER_BYTES = 16 * 1024 * 1024;

export class RemoteMemoryBackend {
	/** @type {Worker|null} */
	#worker = null;
	#controlView = null;
	#dataBuffer = null;
	#token = "";
	#seq = 0;
	#timeoutMs = 60_000;
	/** 一旦出现不可恢复的通道故障，后续调用直接快速失败，而不是傻等超时。 */
	#fatal = null;
	#disposed = false;

	/**
	 * 连接一个已经在跑的助手。构造函数会做一次 `hello`，因此**构造即验证连通与认证**。
	 *
	 * @param {{ host?: string, port: number, token: string, timeoutMs?: number, bufferBytes?: number }} options
	 */
	constructor(options) {
		const host = options.host ?? "127.0.0.1";
		const bufferBytes = options.bufferBytes ?? DEFAULT_BUFFER_BYTES;
		this.#token = options.token;
		this.#timeoutMs = options.timeoutMs ?? 60_000;

		const control = new SharedArrayBuffer(16);
		const data = new SharedArrayBuffer(bufferBytes);
		this.#controlView = new Int32Array(control);
		this.#dataBuffer = data;

		this.#worker = new Worker(path.join(HERE, "worker.js"), {
			workerData: {
				control,
				data,
				host,
				port: options.port,
				token: this.#token,
				connectTimeoutMs: Math.min(this.#timeoutMs, 15_000)
			}
		});
		this.#worker.on("error", (error) => {
			// worker 自己崩了：记下来，让阻塞中的等待尽快结束
			this.#fatal = `远程后端 worker 崩溃：${error && error.message ? error.message : String(error)}`;
			Atomics.store(this.#controlView, 0, 2);
			Atomics.notify(this.#controlView, 0);
		});
		this.#worker.unref?.();

		const hello = this.#call("hello", {}).result;
		/** 助手进程 pid（诊断用）。 */
		this.helperPid = hello.pid;
		/** 助手是否真的拿到了管理员权限（提权的核心证据）。 */
		this.helperElevated = hello.elevation === true;
	}

	get name() {
		return "remote-elevated";
	}

	get capabilities() {
		return {
			// 关键：对内核而言这是同步后端
			sync: true,
			enumerateProcesses: true,
			queryRegions: true,
			queryModules: true,
			queryThreads: true,
			suspendThreads: false,
			allocateMemory: true,
			changeProtection: true,
			local: false,
			requiresServer: true
		};
	}

	/**
	 * 通过同步桥发一次**任意方法**并等结果。
	 *
	 * 公开出来是为了让内核驱动动作（install/load/unload）也能走这条**已经提权**的通道 ——
	 * 那样一次 UAC 之后，后续动作都复用同一个提权进程，不再反复弹窗。
	 *
	 * 之所以只能同步：`Atomics.wait` 会阻塞调用线程的事件循环（见文件顶部说明），
	 * 但对内核驱动动作来说这正好合适（`sc.exe` 本来就是阻塞调用）。
	 *
	 * @param {string} method 助手支持的方法名
	 * @param {object} [params] 参数
	 * @returns {unknown} 助手返回的 result
	 */
	kernelRpc(method, params = {}) {
		return this.#call(method, params).result;
	}

	/**
	 * 通过同步桥发一次请求并等结果。
	 *
	 * 顺序严格是：置状态为「等待」→ postMessage → `Atomics.wait` 阻塞 → 读状态与数据。
	 * worker 侧保证「先写数据、再置状态、最后 notify」，两侧合起来才不会读到半截内容。
	 */
	#call(method, params, payload) {
		if (this.#disposed) throw new Error("远程后端已释放");
		if (this.#fatal !== null) throw new Error(this.#fatal);
		const seq = ++this.#seq;
		Atomics.store(this.#controlView, 0, 0);
		Atomics.store(this.#controlView, 3, seq);
		this.#worker.postMessage({ seq, request: { id: seq, method, params, token: this.#token }, payload });

		const outcome = Atomics.wait(this.#controlView, 0, 0, this.#timeoutMs);
		if (outcome === "timed-out") {
			this.#fatal = `助手在 ${this.#timeoutMs}ms 内没有响应（方法 ${method}）`;
			throw new Error(this.#fatal);
		}
		const state = Atomics.load(this.#controlView, 0);
		const headerLength = Atomics.load(this.#controlView, 1);
		const payloadLength = Atomics.load(this.#controlView, 2);
		const bytes = new Uint8Array(this.#dataBuffer);
		// fromWire：把 `{"$bigint":"…"}` 还原成真 bigint，否则整个内核拿到的是字符串
		const header = fromWire(JSON.parse(Buffer.from(bytes.subarray(0, headerLength)).toString("utf8")));
		if (state !== 1 || header.ok !== true) {
			const message = header.error ?? "助手返回了失败响应";
			if (state === 2 && /崩溃|中断|超时|解析失败/.test(String(message))) this.#fatal = message;
			throw new Error(String(message));
		}
		return {
			result: header.result,
			payload: payloadLength > 0
				? Buffer.from(bytes.subarray(headerLength, headerLength + payloadLength))
				: undefined
		};
	}

	/* ── MemoryBackend 接口（全部同步返回） ── */

	listProcesses() {
		return this.#call("listProcesses", {}).result;
	}

	openProcess(pid) {
		const result = this.#call("openProcess", { pid }).result;
		return { id: result.id, pid: result.pid };
	}

	closeProcess(handle) {
		this.#call("closeProcess", { id: handle.id });
	}

	queryRegions(handle, filter) {
		return this.#call("queryRegions", { id: handle.id, filter: filter ?? {} }).result;
	}

	readProcessMemory(handle, address, size) {
		const { payload } = this.#call("readProcessMemory", { id: handle.id, address, size });
		return payload ?? Buffer.alloc(0);
	}

	writeProcessMemory(handle, address, data, fixProtection) {
		return this.#call("writeProcessMemory", { id: handle.id, address, fixProtection }, data).result;
	}

	queryModules(handle) {
		return this.#call("queryModules", { id: handle.id }).result;
	}

	queryThreads(handle) {
		return this.#call("queryThreads", { id: handle.id }).result;
	}

	allocate(handle, size, protect, preferred) {
		return this.#call("allocate", { id: handle.id, size, protect, preferred }).result;
	}

	free(handle, address) {
		this.#call("free", { id: handle.id, address });
	}

	changeProtection(handle, address, size, newProtect) {
		return this.#call("changeProtection", { id: handle.id, address, size, newProtect }).result;
	}

	isWow64(handle) {
		return this.#call("isWow64", { id: handle.id }).result;
	}

	/**
	 * 目标进程是否仍然存活。
	 *
	 * ⚠️ 这个方法**不能省**。内核 `Process.isProcessAlive()` 在
	 * `backend.isProcessAlive` 不是函数时返回 `undefined`，会话层把 undefined
	 * 当「未知」放行，于是目标一退出，远程后端就退回旧行为：
	 *   - `ce_modules` / `ce_regions` → **静默返回 0 个**，不报错；
	 *   - `ce_read` → 报「目标进程**仍在运行**」，与事实相反；
	 *   - `ce_write` → 被包装成误导性的「权限不足」。
	 * 而本地（self）后端在同样场景下会明确报「目标进程已退出」。
	 * 句柄在助手进程里（Windows 上进程退出后句柄仍有效），真相只能问助手，
	 * 所以必须经由 helper.js 的 `isProcessAlive` 分支。
	 *
	 * @param {{id: number}} handle 远程句柄
	 * @returns {boolean|undefined} true=存活；false=已退出；undefined=无法判断
	 */
	isProcessAlive(handle) {
		try {
			return this.#call("isProcessAlive", { id: handle.id }).result;
		} catch (error) {
			// 助手报「句柄已失效」= 它确认目标没了，这正是我们要的"已退出"。
			// 其余失败（通道故障、助手重启、旧版助手没有这个方法）才如实报"未知"，
			// 由上层按旧行为继续 —— 不能一律吞成 undefined，
			// 否则又把「目标已退出」这条唯一可靠的信息丢掉了。
			if (/已失效/.test(String(error && error.message))) return false;
			return undefined;
		}
	}

	dispose() {
		if (this.#disposed) return;
		this.#disposed = true;
		try {
			this.#worker?.terminate();
		} catch { /* worker 可能已经退出 */ }
		this.#worker = null;
	}
}
