/**
 * `dsh-get-admin` —— 管理员权限的获取 / 复用 / 释放，供其它 DSH 插件调用。
 *
 * ## 它解决什么问题
 *
 * Windows 的权限是**进程级**的：要操作以更高权限运行的进程（多数游戏、反作弊、系统工具），
 * 发起调用的进程自己必须是管理员。而「按需提权」只有三条路：让宿主以管理员重启（中断会话）、
 * 起一个管理员权限的**助手进程**、或连一个已提权的 ceserver。
 *
 * 本插件实现第 2 条：经 UAC 起一个常驻提权助手，之后所有需要权限的调用都走它。
 * 助手空闲自退、跨进程可复用，所以**一个用户会话通常只需要确认一次 UAC**。
 *
 * ## 对外暴露
 *
 * | 形态 | 用途 |
 * | --- | --- |
 * | cordis 服务 `getAdmin` | **主要入口**，其它 DSH 插件用 `ctx.inject(["getAdmin"], ...)` 注入 |
 * | 工具 `get_admin` | 让模型能查状态 / 请求提权 / 释放权限 |
 * | 客户端界面 | 右下角管理员状态图标 + `+` 菜单里的"取消管理员权限" |
 *
 * 服务契约见 `lib/service.js`；提权机制见 `lib/launch.js` 与 `lib/helper.js`。
 *
 * @module dsh-get-admin
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GetAdminService, provideGetAdmin, SERVICE_NAME } from "./service.js";
import { defineTool } from "./toolkit.js";
import { askToElevate, isElevated, permissionDeniedAdvice } from "./elevation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 插件根目录（`lib/` 的上一级）。 */
const PLUGIN_DIR = dirname(HERE);

/** Loader 诊断用的插件名。 */
export const name = "get-admin";

/** npm 包名（状态路由自报家门用）。 */
const PACKAGE_NAME = "dsh-get-admin";
const PLUGIN_VERSION = "1.0.3";

/** 只读状态路由（客户端据此渲染右下角图标）。 */
const STATUS_PATH = "/get-admin/status";
/**
 * 带副作用的控制路由（客户端按钮调用）。
 *
 * ⚠️ 前缀路由的 path **绝不能带结尾斜杠**：webServer 的匹配是
 * `pathname === prefix || pathname.startsWith(prefix + "/")`，
 * 前缀自带斜杠时对子路径恒不匹配，整条路由永远匹配不到。
 */
const CONTROL_PATH = "/get-admin/control";
/** 图标路由前缀（同样不能带结尾斜杠）。 */
const ICON_ROUTE = "/get-admin/icon";

/**
 * 允许通过图标路由读取的文件名白名单。
 * 必须是白名单而不是拼路径，否则 `..` 之类输入会变成任意文件读取。
 */
const ICON_FILES = Object.freeze({
	admin: "dsh-get-admin-admin.svg",
	"yes-admin": "dsh-get-admin-yes-admin.svg",
	"no-admin": "dsh-get-admin-no-admin.svg"
});

/** 工具注册表是唯一硬依赖；webServer / userQuestions 都是可选增强。 */
export const inject = ["tools"];

/** 行配置的出厂默认。 */
export const CONFIG_DEFAULTS = Object.freeze({
	/** node-cheat-engine 目录；空 = 由助手自行解析（环境变量 / 依赖目录）。 */
	kernelPath: "",
	/** 领域扩展模块路径（透传给助手，见 lib/helper.js 的 extensions）。 */
	extensions: "",
	/** 助手空闲自退时间（毫秒）。默认 30 分钟。 */
	idleTimeoutMs: 1_800_000,
	/** RPC 超时（毫秒）。 */
	helperTimeoutMs: 60_000,
	/** 等待提权助手就绪的上限（毫秒）；要留足用户点 UAC 的时间。 */
	launchTimeoutMs: 120_000
});

/** 合并默认值（不 import schemastery，保持零外部依赖）。 */
function withDefaults(config, defaults) {
	const out = { ...defaults };
	if (config !== null && typeof config === "object") {
		for (const [key, value] of Object.entries(config)) {
			if (value !== undefined && value !== null) out[key] = value;
		}
	}
	return out;
}

/**
 * 组装 `get_admin` 工具。
 *
 * 三个动作：`status`（只读）、`request`（可能弹 UAC）、`release`。
 * 刻意不提供"以管理员权限执行任意命令" —— 那会把一个受控的提权入口
 * 变成通用的高权限执行通道，安全面大得多。
 *
 * @param {GetAdminService} service 服务实例
 * @param {object} config 合并后的配置
 * @param {object|undefined} userQuestions `ctx.userQuestions`（可选）。
 *   提权前征求**人的**同意要用它。少了它 `askToElevate` 会 fail-closed（拒绝）——
 *   这正是我们要的：拿不到交互能力就**不该提权**，而不是默默提权。
 * @returns {object[]} 工具定义
 */
function buildTools(service, config, userQuestions) {
	const tool = {
		name: "get_admin",
		description:
			"管理员权限的获取 / 查询 / 释放。action=status 只读；action=request 会在需要时弹出 UAC " +
			"并启动一个常驻提权助手（之后其它需要提权的插件复用它，不再重复弹窗）；" +
			"action=release 立即结束提权助手、收回管理员权限。",
		parameters: {
			type: "object",
			additionalProperties: false,
			properties: {
				action: {
					type: "string",
					enum: ["status", "request", "release"],
					description: "status=查状态（只读，默认）；request=请求提权；release=释放权限",
					required: true
				},
				kernelPath: {
					type: "string",
					description: "request 用：node-cheat-engine 目录（省略则用插件配置）"
				}
			}
		},
		async run(args, exec) {
			const action = String(args.action ?? "status");

			if (action === "status") {
				const status = service.status();
				return {
					summary: status.helperElevated
						? `已获得管理员权限（助手 pid ${status.helperPid}）`
						: status.hasHelper
							? "提权助手在运行，但**未提权**"
							: "未获得管理员权限",
					lines: [
						`本进程是否管理员：${status.elevated ? "是" : "否"}`,
						`提权助手：${status.hasHelper ? `pid ${status.helperPid}，端口 ${status.helperPort}` : "未运行"}`,
						`助手是否管理员：${status.helperElevated ? "是" : "否"}`,
						`跨进程复用记录：${status.discovery}`,
						...(status.lastError !== null ? [`最近一次错误：${status.lastError}`] : []),
						"",
						"提示：request 会按需弹 UAC；一次确认之后，其它需要提权的插件会复用同一个助手。"
					],
					data: { action, ...status }
				};
			}

			if (action === "release") {
				const result = service.release();
				// 用 `service.release()` 给出的 reason 如实转述，**不要自己另编一句**。
				//
				// 早先这里写死成"已释放管理员权限（提权助手已结束）"，但存在一种
				// 说不了那么满的情况：助手是**别的进程**以管理员启动的，
				// 本进程无权结束它 —— 只能清掉跨进程复用记录，让它空闲超时后自退。
				// 那种情况下报"助手已结束"就是不实的。
				return {
					summary: result.released ? "已释放管理员权限" : "当前没有提权助手，无需释放",
					lines: [
						result.reason,
						`释放后状态：${result.status.helperElevated ? "仍提权（助手会在空闲超时后自行退出）" : "未提权"}`
					],
					data: { action, ...result }
				};
			}

			if (action === "request") {
				// 已经提权且助手健康 → 直接如实说明，不再打扰用户
				const before = service.status();
				if (before.helperElevated) {
					return {
						summary: `已经拥有管理员权限（助手 pid ${before.helperPid}），无需再次请求`,
						lines: ["复用了现有的提权助手，**没有弹 UAC**。"],
						data: { action, ...before }
					};
				}

				// ⚠️ **提权前必须先取得人的同意**（这是本插件唯一会扩大权限边界的动作）。
				//
				// 早先这里直接调 `getRemoteBackend({ elevate: true })` —— 也就是
				// **模型自主调用工具就能弹 UAC**。而本插件在控制路由那边（见下方
				// "刻意不把请求提权放到路由上"的注释）恰恰以"按一下就提权等于绕过确认"
				// 为理由拒绝了界面按钮 —— 两处标准不一致，且工具这条更需要闸门
				// （界面那条至少是**人**在点）。
				//
				// 现在：先问，未获同意就如实说明并**不做任何提权动作**。
				// `askToElevate` 在拿不到 `userQuestions` / `agent` 时返回 approved:false
				// （fail-closed），所以无交互环境下这里是"拒绝并说明"，而不是默默提权。
				const consent = await askToElevate(userQuestions, exec, {
					target: null,
					action: "get_admin action=request"
				});
				if (!consent.approved) {
					return {
						summary: "未获同意，未做任何提权动作",
						lines: [consent.reason],
						data: { action, requested: true, approved: false, ...before }
					};
				}

				const backend = await service.getRemoteBackend({
					elevate: true,
					kernelPath: args.kernelPath ?? config.kernelPath,
					extensions: config.extensions,
					idleTimeoutMs: config.idleTimeoutMs,
					timeoutMs: config.helperTimeoutMs,
					launchTimeoutMs: config.launchTimeoutMs
				});
				const after = service.status();
				return {
					summary: `已获得管理员权限（助手 pid ${after.helperPid}）`,
					lines: [
						"已通过 UAC 启动提权助手，后续需要权限的调用都复用它，**不再重复弹窗**。",
						`助手权限：${backend.helperElevated ? "管理员" : "普通用户"}`,
						"要收回权限用 action=release（或界面右下角的图标）。"
					],
					data: { action, ...after }
				};
			}

			throw new Error(`get_admin 不支持的 action：${action}`);
		}
	};

	// 未提权时的只读建议里附上"怎么做"（避免调用方只拿到一句"失败"）
	void permissionDeniedAdvice;
	void isElevated;

	// ⚠️ 必须经 defineTool 包一层：注册表要的是 `execute` + `output.schema/render`，
	// 而这里作者侧写的是 `run`。早先直接 `return [tool]`，结果**测试全绿但工具一调就崩**
	// （注册表找不到 execute）——是"真实 cordis 加载插件"那条测试抓出来的。
	return [defineTool(tool)];
}

/**
 * 插件入口。
 *
 * @param {object} ctx DSH 插件上下文
 * @param {object} config 行配置
 */
export function apply(ctx, config) {
	const merged = withDefaults(config, CONFIG_DEFAULTS);

	// ① 注册服务 —— 这是"被其它插件调用"的主入口
	const service = provideGetAdmin(ctx);
	// 配置随服务走，免得每个调用方都要知道 kernelPath 之类的细节
	service.config = merged;

	ctx.logger?.info?.(
		"get-admin 已激活：服务名 %s（其它插件用 ctx.inject([\"%s\"]) 注入）",
		SERVICE_NAME,
		SERVICE_NAME
	);

	// ② 工具：让模型也能查/请求/释放
	//
	// `userQuestions` 是**可选**服务：拿它来在提权前征求人的同意。
	// 拿不到时**不能**因此跳过闸门 —— `askToElevate` 会 fail-closed（拒绝），
	// 这是刻意的：没有交互能力就不该提权。
	let userQuestions;
	ctx.inject(["userQuestions"], (questionCtx) => {
		userQuestions = questionCtx.userQuestions;
	});

	ctx.inject(["tools"], (toolCtx) => {
		for (const tool of buildTools(service, merged, userQuestions)) {
			toolCtx.tools.register(tool);
		}
		ctx.logger?.info?.("get-admin 已注册 1 个工具（get_admin）");
	});

	// ③ Web 路由 + 客户端界面（headless profile 没有 webServer，安静跳过）
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: "prefix",
					path: STATUS_PATH,
					handler: async (_req, res) => {
						const payload = {
							plugin: PACKAGE_NAME,
							version: PLUGIN_VERSION,
							active: true,
							admin: service.status()
						};
						res.writeHead(200, {
							"content-type": "application/json; charset=utf-8",
							"cache-control": "no-store"
						});
						res.end(JSON.stringify(payload, null, 2));
					}
				}),
			"get-admin: 状态路由"
		);

		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: "prefix",
					path: CONTROL_PATH,
					handler: async (req, res) => {
						const send = (status, body) => {
							res.writeHead(status, {
								"content-type": "application/json; charset=utf-8",
								"cache-control": "no-store"
							});
							res.end(JSON.stringify(body));
						};
						const method = req.method ?? "GET";

						if (method === "GET") {
							send(200, { ok: true, admin: service.status() });
							return;
						}
						if (method !== "POST") {
							send(405, { ok: false, error: "只支持 GET（查状态）与 POST（释放权限）" });
							return;
						}
						// POST = 释放。刻意**不**把"请求提权"放到这条路由上：
						// 提权要经 UAC，由人在弹窗里确认；从界面按一下就提权等同于绕过那道确认。
						try {
							const result = service.release();
							send(200, { ok: true, released: result.released, admin: result.status });
						} catch (error) {
							send(500, { ok: false, error: error && error.message ? error.message : String(error) });
						}
					}
				}),
			"get-admin: 控制路由"
		);

		webCtx.effect(
			() =>
				webCtx.webServer.register({
					kind: "prefix",
					path: ICON_ROUTE,
					handler: async (req, res) => {
						// 用 `new URL().pathname` 解析（不能拿 req.url 手切：会带上查询串）
						const pathname = new URL(String(req.url ?? ""), "http://localhost").pathname;
						const iconName = pathname.slice(ICON_ROUTE.length).replace(/^\/+/, "");
						const fileName = ICON_FILES[iconName];
						if (fileName === undefined) {
							res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
							res.end(`未知图标 "${iconName}"。可用：${Object.keys(ICON_FILES).join(", ")}`);
							return;
						}
						try {
							const svg = readFileSync(join(PLUGIN_DIR, "icons", fileName));
							res.writeHead(200, {
								"content-type": "image/svg+xml; charset=utf-8",
								"cache-control": "no-cache"
							});
							res.end(svg);
						} catch (error) {
							res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
							res.end(`读取图标失败：${error && error.message ? error.message : String(error)}`);
						}
					}
				}),
			"get-admin: 图标路由"
		);
	});
}
