/**
 * `getAdmin` 服务 —— 供**其它 DSH 插件**注入使用的管理员权限门面。
 *
 * ## 为什么要有这一层
 *
 * "获取管理员权限"本质上是三件互相纠缠的事：UAC 启动、一个常驻提权进程的生命周期、
 * 以及把那个进程的能力暴露出去。任何需要管理员权限的插件如果各自实现一遍，
 * 就会各自弹 UAC、各自留常驻进程、各自维护一份帧协议 —— 而且**互相看不到对方已经拿到
 * 的权限**，于是同一个用户会被反复弹窗。
 *
 * 所以这里把它收敛成一个插件 + 一个服务：**谁先请求，谁就触发那一次 UAC；
 * 之后所有插件共用同一个提权助手**。
 *
 * ## 消费方怎么用
 *
 * ```js
 * export const inject = ["getAdmin"];
 *
 * export function apply(ctx) {
 *   ctx.inject(["getAdmin"], (child) => {
 *     child.effect(() => {
 *       const off = child.getAdmin.onChange((status) => { ... });   // 可选：订阅状态变化
 *       return off;
 *     });
 *   });
 * }
 *
 * // 需要管理员权限时（异步：可能弹 UAC）
 * const backend = await ctx.getAdmin.getRemoteBackend({ elevate: true, kernelPath });
 * // backend 是内核 MemoryBackend：listProcesses / openProcess / readProcessMemory / ...
 * ```
 *
 * ## 为什么把它注册成 cordis 服务而不是导出一个单例模块
 *
 * 单例模块在**同进程**里够用，但它绕过了 cordis 的依赖表达：消费方无法通过
 * `inject` 声明"我需要这个服务"，也就拿不到"服务不存在时别启动"的语义。
 * `ctx.provide(name, value)` 是 cordis 的公开 API，且**不需要 import 任何
 * `@deepseek-ai/*` 包** —— 这点很重要，本插件的卖点之一就是零外部依赖。
 *
 * @module dsh-get-admin/service
 */
import { discoveredHelperStatus, disposeHelper, helperStatus, startHelperBackend } from "./launch.js";
import { isElevated } from "./elevation.js";

/** 服务名。消费方用 `ctx.inject(["getAdmin"], ...)` 注入。 */
export const SERVICE_NAME = "getAdmin";

/**
 * 管理员权限服务。
 *
 * 状态与并发语义：
 *   - `backend` 是**进程内共享**的：第二个请求者不会触发第二次 UAC，而是拿到同一个后端；
 *   - `pending` 保证并发请求只启动一次助手（否则两个插件同时请求会弹两次 UAC）。
 */
export class GetAdminService {
	constructor() {
		/** 当前已连接的提权后端（`RemoteMemoryBackend`），没有则为 null。 */
		this.backend = null;
		/** 正在启动中的 Promise：并发请求共享它，避免弹两次 UAC。 */
		this.pending = null;
		/** 状态变化订阅者。 */
		this.listeners = new Set();
		/** 最近一次错误（诊断用）。 */
		this.lastError = null;
	}

	/**
	 * 当前状态快照（同步、只读、不触发任何提权）。
	 *
	 * ## 助手来源有两处，都要看
	 *
	 *  1. **本进程内**启动的助手（`helperStatus()`）—— 缓存的后端；
	 *  2. **跨进程发现记录**里的助手（`discoveredHelperStatus()`）——
	 *     由 CLI / 其它插件 / DSH 的另一次启动经 UAC 拉起。
	 *
	 * 只看第 1 处会漏掉第 2 处，表现为：明明已经通过 UAC 拿到提权助手，
	 * `/get-admin/status` 却仍报 `helperElevated: false`，
	 * 于是**界面右下角图标一直显示"未获得"、不会切换**（实测踩到）。
	 * 而"跨进程复用"正是这个插件的主要卖点，界面上却看不见，等于没实现。
	 *
	 * @returns {{ elevated: boolean, hasHelper: boolean, helperElevated: boolean, helperPid: number|null, helperPort: number|null, source: 'in-process'|'discovered'|null, busy: boolean, lastError: string|null, discovery: string }}
	 */
	status() {
		let helper = helperStatus();
		let source = helper === null ? null : "in-process";
		if (helper === null) {
			helper = discoveredHelperStatus();
			if (helper !== null) source = "discovered";
		}
		return {
			// 当前**本进程**是否已经是管理员（与是否有助手无关）
			elevated: isElevated(),
			hasHelper: helper !== null,
			helperElevated: helper !== null && helper.elevated === true,
			helperPid: helper?.pid ?? null,
			helperPort: helper?.port ?? null,
			// 助手从哪来 —— 便于排查"为什么界面看到了/没看到"，也便于告诉用户
			// "这是复用的既有助手，没有弹 UAC"。
			source,
			busy: this.pending !== null,
			lastError: this.lastError,
			discovery: "get-admin-helper-discovery.json"
		};
	}

	/**
	 * 订阅状态变化（返回取消订阅函数）。
	 *
	 * 服务状态会因为"助手空闲自退""另一个插件释放了权限"而变化，
	 * 界面与工具都靠它保持同步，而不是各自轮询。
	 *
	 * @param {(status: ReturnType<GetAdminService["status"]>) => void} listener
	 * @returns {() => void} 取消订阅
	 */
	onChange(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** 通知订阅者（订阅者抛错不影响其它订阅者，也不影响服务本身）。 */
	#notify() {
		const snapshot = this.status();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch {
				/* 订阅者自己的问题，不能拖垮服务 */
			}
		}
	}

	/**
	 * 取一个**提权后的内存后端**（首次调用可能触发 UAC）。
	 *
	 * @param {object} [options]
	 * @param {boolean} [options.elevate] 是否通过 UAC 提权（默认 true）
	 * @param {string} [options.kernelPath] node-cheat-engine 目录
	 * @param {string} [options.extensions] 领域扩展模块路径（见 helper.js）
	 * @param {number} [options.idleTimeoutMs] 助手空闲自退时间
	 * @param {number} [options.timeoutMs] RPC 超时
	 * @param {number} [options.launchTimeoutMs] 等待助手就绪上限
	 * @param {boolean} [options.discoverExisting] 是否允许跨进程复用（默认允许）
	 * @param {(message: string) => void} [options.log] 日志
	 * @returns {Promise<object>} 内核 MemoryBackend（同步）
	 */
	async getRemoteBackend(options = {}) {
		// 已有可用后端 → 直接复用（探活：助手可能已空闲自退）
		if (this.backend !== null) {
			try {
				this.backend.listProcesses();
				return this.backend;
			} catch {
				this.#dropBackend();
			}
		}
		// 已有启动中的请求 → 共享它，绝不并发弹第二次 UAC
		if (this.pending !== null) return this.pending;

		this.pending = (async () => {
			try {
				const backend = await startHelperBackend({
					elevate: options.elevate !== false,
					kernelPath: options.kernelPath,
					extensions: options.extensions,
					idleTimeoutMs: options.idleTimeoutMs,
					timeoutMs: options.timeoutMs,
					launchTimeoutMs: options.launchTimeoutMs,
					discoverExisting: options.discoverExisting,
					log: options.log
				});
				this.backend = backend;
				this.lastError = null;
				this.#notify();
				return backend;
			} catch (error) {
				this.lastError = error && error.message ? String(error.message) : String(error);
				this.#notify();
				throw error;
			} finally {
				this.pending = null;
			}
		})();
		return this.pending;
	}

	/**
	 * 释放管理员权限（结束提权助手进程 / 清掉跨进程复用记录）。
	 *
	 * ## 为什么不能只看"进程内有没有助手"（缺陷修复）
	 *
	 * 早先这里是 `const had = helperStatus() !== null;` —— 而 `helperStatus()` 只读
	 * **进程内**的助手。当助手是别的进程启动的（只在发现记录里）时：
	 *   `had` 为 false → 报"没有提权助手，无需释放"，
	 * 而 `status()` 同时又报 `helperElevated: true, source:'discovered'` —— **自相矛盾**，
	 * 界面右下角因此永远停在"已获得"、点了没反应。
	 *
	 * 现在直接采用 `disposeHelper()` 的回报（它已同时处理进程内与发现记录两处）：
	 *   - `killed`：真的结束了助手进程；
	 *   - `clearedDiscovery`：清掉了复用记录（提权助手本进程杀不掉时，这是唯一能做的，
	 *     它会在空闲超时后自行退出 —— 这一点会**如实写进 reason**，不假装杀掉了）。
	 *
	 * @returns {{ released: boolean, killed: boolean, clearedDiscovery: boolean, pid: number|null, reason: string, status: object }}
	 */
	release() {
		const outcome = disposeHelper();
		this.#dropBackend();
		this.lastError = null;
		this.#notify();

		const status = this.status();
		const didSomething = outcome.killed || outcome.clearedDiscovery;
		let reason;
		if (outcome.killed) {
			reason = `已结束提权助手进程（pid ${outcome.pid}）。`;
		} else if (outcome.clearedDiscovery) {
			reason =
				"已清除跨进程复用记录。那个助手是**其它进程**启动的（很可能是管理员权限），" +
				"本进程无权结束它 —— 它会在空闲超时后自行退出，之后不再被复用。";
		} else {
			reason = "当前没有提权助手，无需释放。";
		}
		return { released: didSomething, killed: outcome.killed, clearedDiscovery: outcome.clearedDiscovery, pid: outcome.pid, reason, status };
	}

	/** 丢掉进程内后端引用（不重复调用 dispose：`disposeHelper` 已经做过）。 */
	#dropBackend() {
		this.backend = null;
	}
}

/**
 * 把服务注册到 DSH 上下文。
 *
 * 用 `ctx.provide(name, value)`（cordis 公开 API，挂在 ctx 上），
 * 因此**不需要 import `@deepseek-ai/cordis`** —— 本插件保持零外部依赖。
 *
 * @param {object} ctx DSH 插件上下文
 * @returns {GetAdminService} 已注册的服务实例
 */
export function provideGetAdmin(ctx) {
	const service = new GetAdminService();
	if (typeof ctx.provide !== "function") {
		// 理论上不该发生（cordis 的 reflect 服务一定会挂上 provide），
		// 但真发生时宁可让调用方明确知道"服务没注册"，也不要静默地什么都不做。
		throw new Error(
			"get-admin: 当前上下文没有 ctx.provide()，无法把服务注册给其它插件。" +
				"（期望的 cordis 版本应提供 reflect 服务）"
		);
	}
	ctx.provide(SERVICE_NAME, service);
	return service;
}
