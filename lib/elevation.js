/**
 * 提权相关的判定、用户同意闸门与错误增强。
 *
 * ## 为什么需要这一层
 *
 * Windows 的权限是**进程级**的：要读写以更高权限运行的目标进程（多数游戏、反作弊、
 * 系统工具），**发起调用的那个进程本身**必须有管理员权限。因此「按需提权」不可能只针对
 * 单次操作 —— 只有三条路：
 *
 *   1. 让本进程以管理员身份重启（会中断当前 DSH 会话）；
 *   2. 起一个管理员权限的**助手进程**，把内存操作转发给它；
 *   3. 连一个以管理员身份运行的 `ceserver`，切到内核的 `native-ce` 后端。
 *
 * 本文件只负责**判定与征求同意**这两件与安全边界直接相关的事，并且刻意做成
 * 「先问、不自动提权」：提权会扩大插件的权限边界，必须由人来决定。
 *
 * ## 关于第 2 条路（助手进程）的实现约束（重要）
 *
 * 内核的 `ScanSession` / `PointerScanner` / `AutoAssembler` 内部调用的是 `Process` 的
 * **同步**方法（`src/scanner/scanner.ts` 里 `this.proc.readMemory(...)`），而
 * `Process` 的同步方法在**异步后端**上会直接抛错（`win/process.ts` 的 `syncResult`）。
 * 因此助手进程若只做成普通的异步 RPC，扫描/指针扫描/汇编**全部不可用**，
 * 只能读写与枚举 —— 这不是一个可交付的「提权后全功能」方案。
 * 要全功能，远程后端必须是**同步**的，也就是：worker 线程持有 socket 做异步 I/O，
 * 主线程用 `SharedArrayBuffer` + `Atomics.wait` 等结果。这条路可行但有两个代价：
 *   - 每次内存操作都会阻塞 DSH 宿主主线程（与现有 `SelfBackend` 的行为一致，扫描本来就会阻塞）；
 *   - 4MB 级别的扫描分块要在主线程与 worker 之间来回拷贝。
 *
 * 所以本文件**不**假装已经实现了提权转发；它把「权限不足的识别」与「征求同意的闸门」
 * 先做扎实，让后续接入任何一种方案时，安全边界都已经在位。
 *
 * @module dsh-cheat-engine/elevation
 */

import { spawnSync } from "node:child_process";

/** `net session` 的结果缓存（一次探测约 50–150ms，没必要反复探）。 */
let elevatedCache = null;

/**
 * 当前进程是否以管理员身份运行。
 *
 * 判定方式：`net session` 需要管理员权限才能成功；能成功即说明已提权。
 * 这是无副作用、不触发 UAC 的只读探测。
 *
 * @returns {boolean}
 */
export function isElevated() {
	if (elevatedCache !== null) return elevatedCache;
	try {
		const result = spawnSync("net", ["session"], {
			stdio: "ignore",
			windowsHide: true,
			timeout: 10_000
		});
		// status === 0 表示命令成功 → 有管理员权限
		elevatedCache = result.status === 0;
	} catch {
		// 探测本身失败时按「未提权」处理：宁可多说一句「可能权限不足」，也不要谎报已提权
		elevatedCache = false;
	}
	return elevatedCache;
}

/** 供测试注入：重置已提权探测的缓存。 */
export function resetElevationCache() {
	elevatedCache = null;
}

/**
 * 判断一个错误是不是「权限不足」。
 *
 * 覆盖几类实际会碰到的形态：
 *   - Win32 `ERROR_ACCESS_DENIED` = 5（`OpenProcess` / 读写被拒时内核会带上它）；
 *   - `0x80070005`（HRESULT 形式的 access denied）；
 *   - 文本里的「拒绝访问」/「Access is denied」；
 *   - Node 的 `EPERM` / `EACCES`（文件与管道场景）。
 *
 * @param {unknown} error 抛出的错误
 * @returns {boolean}
 */
export function isPermissionDenied(error) {
	const text = String((error && error.message) || error || "");
	if (text === "") return false;
	// 明确的 Win32 错误码 5（注意别把 50/500 之类误判）
	if (/\bWin32\s*错误\s*5\b/.test(text) || /\bWin32\s*(error\s*)?5\b/i.test(text)) return true;
	if (/0x0*80070005/i.test(text)) return true;
	if (/拒绝访问|access\s+is\s+denied/i.test(text)) return true;
	if (/\bEPERM\b|\bEACCES\b/.test(text)) return true;
	return false;
}

/**
 * 为「权限不足」生成可执行的下一步说明。
 *
 * ⚠️ 这里的建议必须与**代码里真实支持的提权通道**一致。
 * 早先这段文本只说"以管理员重启 DSH / 用 ceserver"，而那时插件其实已经有
 * 助手提权通道了 —— 用户照着做会白白重启一次会话，是**误导**。
 * 所以第 1 条现在就是本插件提供的助手提权（不用中断会话、不用重启）。
 *
 * @param {{ elevated?: boolean, target?: { pid?: number, name?: string }|null, action?: string }} [context]
 * @returns {string[]} 面向模型/用户的多行建议
 */
export function permissionDeniedAdvice(context = {}) {
	const elevated = context.elevated === undefined ? isElevated() : context.elevated;
	const target = context.target ?? null;
	const who = target === null
		? "目标进程"
		: `${target.name ?? "目标"}（pid ${target.pid ?? "?"}）`;
	const lines = [
		`权限不足：${who}以**更高的权限**运行，而当前 DSH 进程${elevated ? "已提权" : "**未提权**"}。`,
		"Windows 的权限是进程级的，无法只对单次操作提权。可选做法："
	];
	if (!elevated) {
		// ⚠️ 提权被 `GET_ADMIN_NO_ELEVATE=1` 禁用时，**不能**再推荐"会弹一次 UAC"的做法 ——
		// 那会让用户（和模型）以为还有路可走，实际上每一条都会被立刻拒绝、一次窗都不会弹。
		// 此时只给**不需要 UAC** 的做法，并说清助手这条路为什么走不通。
		if (process.env.GET_ADMIN_NO_ELEVATE === "1") {
			lines.push(
				"  ⚠️ 当前进程设置了 `GET_ADMIN_NO_ELEVATE=1`，**提权助手与 UAC 已被禁用**：",
				"     下面这些需要管理员身份的做法都不会成功（会被直接拒绝，不会弹窗）——",
				"       · `ce_elevation action=request` / `get_admin action=request`",
				"       · 把配置改为 `remoteElevate: true`（配合 `backend: 'remote'`）",
				"  不需要 UAC 的可行做法：",
				"  1. 以管理员身份重启 DSH（会中断当前会话）：",
				'     右键 DeepSeek Harness → 以管理员身份运行；',
				"     或在管理员 PowerShell 里启动它。",
				"  2. 用管理员权限运行官方 ceserver，然后把插件配置的 backend 设为 native-ce：",
				"     config: { backend: 'native-ce', ceserverHost: '127.0.0.1', ceserverPort: 52736 }",
				"     （这条需要一个**已经以管理员身份启动**的 ceserver，不是插件弹窗）"
			);
			lines.push("  只读分析时也可换一个不以管理员权限运行的目标进程。");
			return lines;
		}
		lines.push(
			"  1. **用提权助手**（本插件支持的通道，不需要重启或中断会话）：",
			"     经 `get-admin` 插件起一个管理员权限的助手进程，内存操作转发给它。",
			"     cheat-engine 侧：把配置改为 `remoteElevate: true`（配合 `backend: 'remote'`），",
			"     或直接调用 `get_admin` 工具的 action=request —— 会弹一次 UAC，确认后即可。",
			"     助手是常驻且可跨进程复用的，所以一次确认之后通常不用再弹。",
			"  2. 以管理员身份重启 DSH（会中断当前会话）：",
			'     右键 DeepSeek Harness → 以管理员身份运行；',
			"     或在管理员 PowerShell 里启动它。",
			"  3. 用管理员权限运行官方 ceserver，然后把插件配置的 backend 设为 native-ce：",
			"     config: { backend: 'native-ce', ceserverHost: '127.0.0.1', ceserverPort: 52736 }"
		);
	} else {
		lines.push(
			"  已提权却仍被拒 → 目标多半受 PPL/反作弊保护（普通用户态无解，需要内核驱动）。",
			"  可尝试：换用 native-ce 后端连接更高权限的 ceserver；或确认目标确实允许外部读取。"
		);
	}
	lines.push("  只读分析时也可换一个不以管理员权限运行的目标进程。");
	return lines;
}

/**
 * 把「权限不足」的错误增强成带可执行建议的错误。
 *
 * 非权限错误原样返回，避免把无关失败也说成权限问题。
 *
 * @param {unknown} error 原错误
 * @param {{ target?: object|null, action?: string }} [context]
 * @returns {Error} 原始错误或增强后的错误
 */
export function enrichPermissionError(error, context = {}) {
	if (!isPermissionDenied(error)) return error;
	const advice = permissionDeniedAdvice(context);
	const original = (error && error.message) || String(error);
	const enriched = new Error(
		`${context.action ? `[${context.action}] ` : ""}${advice.join("\n")}\n\n原始错误：${original}`
	);
	enriched.cause = error;
	enriched.permissionDenied = true;
	return enriched;
}

/**
 * 提权询问的选项定义。
 *
 * ## 为什么把 id 与文案抽成常量（这是一个真实缺陷的修复）
 *
 * 早先 `approved` 是**由选项文案推导**的：
 *   `const approved = chosen !== "不继续（推荐先用只读/换目标）"`
 *
 * 这个写法把「同意」隐式绑在了"文案不等于某个字符串"上。于是当另一份实现
 * （`cheat-engine/lib/elevation-impl.js`）用了**同一套推导但不同的选项文案**时：
 *   - 权威实现：选项 2 = 「同意提权」→ 表达式成立，行为正确；
 *   - 回退实现：选项 2 = 「告诉我如何提权」（描述明写"不自动执行"）→
 *     同一个表达式返回 **approved = true**。
 *
 * 也就是**同意闸门被绕过**：用户只是要求"讲解一下"，却真的去弹 UAC 提权。
 *
 * 修法有两层：
 *   1. 判定改用**稳定的选项 id**，不再看文案 —— 文案改了也不会改变语义；
 *   2. 选项集与文案由本文件导出（`ELEVATION_OPTIONS`），让回退实现**跟着用同一份**，
 *      从根上消除"两份实现语义不同"的可能。
 */
export const ELEVATION_OPTIONS = Object.freeze([
	Object.freeze({
		id: "decline",
		label: "不继续（推荐先用只读/换目标）",
		description: "放弃对高权限目标的操作，不做任何提权。"
	}),
	Object.freeze({
		id: "approve",
		label: "同意提权（弹 UAC 确认）",
		description: "起一个管理员权限的助手进程，之后内存操作转发给它；助手常驻可复用。"
	})
]);

/** 默认选择（用户没作答时）：**一律按不同意处理**，绝不默认批准。 */
const DEFAULT_OPTION_ID = "decline";

/**
 * 从用户作答里解出"选了哪个选项"。
 *
 * 作答形状可能是：`"approve"`（选中的是 id）、`"同意提权（弹 UAC 确认）"`（选中的是文案）、
 * 或 `{ id, label }`。所以这里把 raw 值**同时**拿去和 id、label 比 ——
 * 不要假设"非对象就是文案"（我第一版就是这么写的，结果把 id `"approve"` 当文案，
 * 于是"同意"被判成不同意）。
 *
 * 匹配不上时一律返回**不同意** —— 宁可把该批准的拒掉，
 * 也绝不能把"没表达同意"当成同意。
 *
 * @param {object} answer `userQuestions.ask` 的返回
 * @returns {{ id: string, label: string }}
 */
function resolveChoice(answer) {
	const selected = answer?.answers?.[0]?.selected?.[0];
	// 取出用于比对的原始值：对象取 id 优先、其次 label；标量直接用
	const rawId = typeof selected === "object" && selected !== null ? selected.id : selected;
	const rawLabel = typeof selected === "object" && selected !== null ? selected.label : selected;

	for (const option of ELEVATION_OPTIONS) {
		if (rawId !== undefined && rawId !== null && String(rawId) === option.id) return { id: option.id, label: option.label };
	}
	for (const option of ELEVATION_OPTIONS) {
		if (rawLabel !== undefined && rawLabel !== null && String(rawLabel) === option.label) {
			return { id: option.id, label: option.label };
		}
	}
	return { id: DEFAULT_OPTION_ID, label: ELEVATION_OPTIONS[0].label };
}

/**
 * 提权**之前**征求用户同意。
 *
 * 提权是本插件唯一会扩大权限边界的动作，所以一律**先问、不自动提权**。
 *
 * ## 为什么这个闸门放在 get-admin，而不是各消费方各写一份
 *
 * 提权是**跨插件共享**的资源：谁调用都会起同一个助手、弹同一次 UAC。
 * 如果每个消费方各写一份"要不要提权"的询问，措辞和选项就会漂移
 * （实测 cheat-engine 与 get-admin 各有一份，文案已经开始不一致，
 *  而且回退那份的 `approved` 推导把"只讲解"当成了"同意"）。
 * 所以闸门由拥有提权能力的这一方提供，消费方只负责把
 * `userQuestions` 与 `exec` 传进来。
 *
 * ## 拿不到交互能力时一律**拒绝**
 *
 * 子代理调用、没有 `user-questions` 服务的 profile、缺 agent 会话 —— 这些情况下
 * 都无法真正征得同意。此时必须按"未获同意"处理，**绝不能**默默提权。
 *
 * @param {object} userQuestions `ctx.userQuestions`
 * @param {object} exec 工具执行上下文（需要 `exec.agent`，建议带 `exec.signal`）
 * @param {{ target?: object|null, action?: string }} [context]
 * @returns {Promise<{ approved: boolean, reason: string }>}
 */
export async function askToElevate(userQuestions, exec, context = {}) {
	const advice = permissionDeniedAdvice(context);
	if (exec === undefined || exec.agent === undefined) {
		return {
			approved: false,
			reason:
				"当前调用没有可用的 agent 会话，无法向你确认是否提权，因此**不做任何提权动作**。\n" +
				advice.join("\n")
		};
	}
	if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
		return {
			approved: false,
			reason: "当前 profile 没有 user-questions 服务，无法征求同意，因此不做任何提权动作。\n" + advice.join("\n")
		};
	}
	const target = context.target ?? null;
	const who = target === null ? "目标进程" : `${target.name ?? "目标"}（pid ${target.pid ?? "?"}）`;
	// ⚠️ **`ask` 必须包在 try/catch 里**（fail-closed）。
	//
	// 用户不介入是**常态**而不是异常：关掉弹窗、点了取消、会话超时、
	// profile 没装 user-questions 的可交互前端、`signal` 提前 abort ……
	// 这些都会让 `ask` 以异常收场。
	//
	// 早先这里是裸 `await`，于是任何一种"用户没回应"都会把异常**穿透**到调用方
	// —— 工具层直接失败，模型看到的是一堆与"权限不足"无关的栈信息，
	// 而真正的原因（没拿到同意）被吞掉了。安全上更糟的是：闸门本该
	// fail-closed（拿不到同意 = 不提权），却变成了"抛错"这种不确定状态，
	// 上层完全可能误以为是别的问题而重试。
	//
	// 正确做法：**任何异常一律视为"没拿到同意"**，并把原因如实说出来。
	let answer;
	try {
		answer = await userQuestions.ask({
			questions: [
				{
					id: "elevate",
					header: "需要管理员权限",
					question:
						`${who}以更高权限运行，当前 DSH 未提权，读写被拒绝。\n` +
						"提权会扩大插件的权限边界（会弹一次 UAC），需要你确认。是否继续？",
					options: ELEVATION_OPTIONS.map((o) => ({ id: o.id, label: o.label, description: o.description }))
				}
			],
			agent: exec.agent,
			signal: exec.signal
		});
	} catch (error) {
		// 取消 / 超时 / 无可交互前端 / signal 中断 —— 都不能当成"同意"
		const why = error && error.message ? String(error.message) : String(error);
		return {
			approved: false,
			reason:
				"未能就提权征求到你的确认（提问被取消、超时或不可用），因此**不做任何提权动作**。\n" +
				`（原因：${why}）\n` +
				advice.join("\n")
		};
	}
	// 用 id 判定，不看文案 —— 见 ELEVATION_OPTIONS 的说明
	const choice = resolveChoice(answer);
	const approved = choice.id === "approve";
	return {
		approved,
		reason: approved
			? [`已获同意（你选择了「${choice.label}」）。具体做法：`, ...advice].join("\n")
			: [`未获同意（你选择了「${choice.label}」），未做任何提权动作。`, ...advice].join("\n")
	};
}