/**
 * `dsh-get-admin` 的**客户端(浏览器)部分**。
 *
 * 两件事：
 *   1. 整个对话界面**右下角**的管理员权限状态图标（图标下方显示"管理员权限"）；
 *   2. `+` 菜单里的「取消管理员权限」指令。
 *
 * ## 为什么界面挂在这个插件而不是消费方（例如 cheat-engine）
 *
 * 管理员权限是**跨插件共享**的资源：谁的界面都不该独占它。
 * 放在 get-admin 里，语义就是"这是权限本身的状态"，与哪个插件在用权限无关。
 *
 * ## 右下角为什么用**纯 DOM**而不是 React / 槽位 / Portal（踩过的坑）
 *
 * 早先把状态图标注册进 `conversation.input.dock` 槽位，结果**什么都没出现**：
 * 该槽位的渲染条件是 `zone !== undefined && renderSlot("conversation.input.dock", zone)`
 * —— 容器不给 `zone` 时整个槽位不渲染，组件根本不会挂载；即便挂上也可能被容器裁剪。
 *
 * 同 profile 的 `dsh-plugin-hyy-assistive-tool` 右下角浮层**确实能显示**，
 * 它的做法是：把 `<style>` 插进 `<head>`、把固定定位容器 `appendChild` 到 `document.body`，
 * **完全不经过任何槽位**。这里沿用"不进槽位、直接挂 body"的思路。
 *
 * ⚠️ 但**不沿用它的 `<style>` 做法**：本插件的样式表在真实环境里会消失 ——
 * 用户实测的 DOM 中，容器 `<div id="get-admin-layer" style="visibility: visible;">`
 * 在，而 `<style id="get-admin-layer-style">` **已不在文档里**。样式表一没，
 * `position:fixed;right:16px;bottom:18px` 全部失效，容器退回普通流、落在
 * `<body>` 末尾，在 column 布局下正好表现为**左下角**（用户报的现象）。
 *
 * ## 样式表是谁删的（已在宿主代码里取证，不是猜的）
 *
 * `@deepseek-ai/dsh-client-modules/lib/client.js` 里有一对函数：
 *
 *     removeOwnedStyles(id) {
 *       for (const el of document.querySelectorAll("style[data-plugin]"))
 *         if (el.getAttribute("data-plugin") === id) el.remove();
 *     }
 *     const claimStyles = (id) => {
 *       // "…any untagged tag is claimed for the materializing plugin (HMR bookkeeping)"
 *       for (const el of document.querySelectorAll("style:not([data-plugin])"))
 *         el.setAttribute("data-plugin", id);
 *       …
 *     };
 *
 * 也就是说：宿主在**物化某个插件**时，会把文档里**所有还没标记的 `<style>`
 * 全部认领给这个插件**；卸载该插件时再按 `data-plugin` **批量删除**。
 *
 * 证据（用户实测 DOM 里就能看见它标错）：`<style id="dsh-ce-progress-layer-style"
 * data-plugin="dsh-get-admin">` —— 这张表里装的是 **ce-tools 的进度浮层 CSS**，
 * 却被标成了 `dsh-get-admin`。而两个插件的源码都只设 `id`、**从不设
 * `data-plugin`**，所以这个标记只可能是宿主认领时打上去的，且认领错了对象。
 *
 * 后果链与现象完全对得上：
 *   · 我们的 `<style id="get-admin-layer-style">` 无标记 → 被某次物化认领；
 *   · 该插件卸载时 `removeOwnedStyles` 按 `data-plugin` **批量删表** → 我们那张被删；
 *   · 浮层容器是产品代码 `appendChild` 到 `body` 的 `<div>`，**不归宿主 HMR 管**，
 *     不会被一起删掉 → **容器在、样式表没了**。
 *
 * 注意这条链路**与具体时序无关**，也就意味着它无法靠"把自己的 `id` 写对"来规避：
 * 只要外观写在 `<style>` 里，这张表就不归我们掌控。
 * 所以关键布局一律走 CSSOM 内联，**不依赖样式表**。详见 `styleLayer()` 的注释。
 *
 * 旁注：这个机制是**跨插件**的 —— 上面那张 ce-tools 的样式表被标成了
 * `dsh-get-admin`，因此**本插件被热重载时会连带删掉 ce-tools 的进度浮层样式**。
 * 那个方向的问题不在本文件里，但根因相同。
 *
 * 代价是这一部分不走 React，需要自己管好 DOM 生命周期 —— 下面的 `useEffect`
 * 负责把建出来的东西（容器、定时器、监听器）在卸载时全部拆干净。
 */
window.__ModuleLoader__.load({
	id: "dsh-get-admin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const { jsx } = jsxRuntime;

		//#region 常量
		/** 状态路由（只读）。与 lib/index.js 的 STATUS_PATH 成对维护。 */
		const STATUS_API = "/get-admin/status";
		/** 控制路由（GET 查状态 / POST 释放）。与 lib/index.js 的 CONTROL_PATH 成对维护。 */
		const CONTROL_API = "/get-admin/control";
		/** 图标路由前缀。与 lib/index.js 的 ICON_ROUTE 成对维护。 */
		const ICON_API = "/get-admin/icon/";
		/** 轮询间隔（仅页面可见时）。 */
		const POLL_MS = 4000;

		/**
		 * 三个界面图标（由宿主从 `icons/*.svg` 读出来提供）。
		 *
		 * 客户端插件没有静态资源通道，所以只能走宿主路由 ——
		 * 好处是**真正使用磁盘上的 SVG 文件**，改文件重启即生效。
		 */
		const ICONS = {
			/** `+` 菜单里的"取消管理员权限"用 */
			admin: `${ICON_API}admin`,
			/** 已获得管理员权限 → 右下角用这个 */
			yesAdmin: `${ICON_API}yes-admin`,
			/** 未获得管理员权限 → 右下角用这个 */
			noAdmin: `${ICON_API}no-admin`
		};

		/** 图标下方的固定字样（用户明确要求显示"管理员权限"）。 */
		const ADMIN_LABEL = "管理员权限";
		//#endregion

		//#region 宿主状态
		/**
		 * 读宿主的管理员状态。
		 *
		 * 失败一律返回 `null`：界面据此隐藏，而不是显示一个点了没反应的假按钮。
		 */
		async function fetchStatus(signal) {
			try {
				const res = await fetch(STATUS_API, { method: "GET", signal, headers: { accept: "application/json" } });
				if (!res.ok) return null;
				const body = await res.json();
				return body?.admin ?? null;
			} catch {
				return null;
			}
		}

		/**
		 * 请求释放管理员权限。
		 *
		 * @returns {Promise<{ admin?: object, error?: string }>}
		 */
		async function releaseAdmin() {
			try {
				const res = await fetch(CONTROL_API, { method: "POST", headers: { accept: "application/json" } });
				const body = await res.json().catch(() => null);
				if (!res.ok || body?.ok !== true) return { error: body?.error ?? `HTTP ${res.status}` };
				return { admin: body.admin ?? null };
			} catch (error) {
				return { error: error?.message ?? String(error) };
			}
		}
		//#endregion

		//#region 右下角浮层（纯 DOM）
		/** 浮层容器在 DOM 里的 id（幂等挂载用）。 */
		const LAYER_ID = "get-admin-layer";

		/**
		 * 关键布局与外观**用 CSSOM 内联写死**，不依赖任何样式表。
		 *
		 * ## 为什么不用 `<style>` 元素（真实踩过的坑）
		 *
		 * 早先的写法是把 `LAYER_CSS` 插进 `<head>`、卸载时 `style.remove()` ——
		 * 于是**布局依赖了一个自己完全掌控不了的样式表**。
		 *
		 * 两个删除者，任一个都能让布局塌掉：
		 *   1. **宿主 HMR**：会把文档里所有无标记的 `<style>` 认领给正在物化的插件、
		 *      再在卸载时按 `data-plugin` 批量删除。取证与完整链路见文件头注释 ——
		 *      用户 DOM 里 `<style id="dsh-ce-progress-layer-style"
		 *      data-plugin="dsh-get-admin">` 就是它**认领错**的直接证据。
		 *   2. **本文件自己**：卸载时 `style.remove()`。而浮层容器是直接挂在
		 *      `document.body` 上的 `<div>`，**不归宿主 HMR 管、也不会被 React 收走** ——
		 *      于是只要出现一次「挂载 → 卸载 → 根节点又被重建」的错配，
		 *      样式表就被永久删掉、而容器还在（用户实测的 DOM 正是如此）。
		 *
		 * 样式表一没，`position:fixed;right:16px;bottom:18px` 全部失效，
		 * 容器退回普通流、落在 `<body>` 末尾 → **左下角**，且按钮是原生丑样式。
		 *
		 * ## 为什么内联是可靠的
		 *
		 *   · `el.style.x = y`（CSSOM）**不受 CSP `style-src` 限制** ——
		 *     比 `<style>` 元素和 `style="…"` 属性都更不容易被打掉；
		 *   · 不存在"这个元素被谁移除了"这一层不确定性：外观随元素本身生灭；
		 *   · 没有 id 撞车 / 重复插入 / 清理顺序的问题。
		 *
		 * 代价：状态相关外观（提权描边、灰度、disabled）不能用
		 * `[data-admin="true"]` 这类选择器，得在 `applyState` 里显式设置。
		 * 这里选择显式设置 —— 顺带消掉了"同一套外观写在 CSS 与 JS 两处"的分叉。
		 */
		function styleLayer(root, button, img, text) {
			// 容器：固定定位到**右下角**。这是本次修复的核心，必须内联 ——
			// 丢了这几行浮层就掉到左下角。
			Object.assign(root.style, {
				position: "fixed",
				right: "16px",
				bottom: "18px",
				zIndex: "2147483000",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: "10px",
				// 容器本身不吃点击（否则会挡住右下角底下的 UI），只有按钮吃
				pointerEvents: "none",
				fontFamily: "inherit",
				boxSizing: "border-box"
			});
			Object.assign(button.style, {
				pointerEvents: "auto",
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: "3px",
				padding: "7px 9px",
				border: "1px solid transparent",
				borderRadius: "10px",
				background: "transparent",
				color: "inherit",
				fontSize: "11px",
				lineHeight: "1",
				whiteSpace: "nowrap",
				cursor: "pointer",
				fontFamily: "inherit",
				boxSizing: "border-box"
			});
			Object.assign(img.style, {
				display: "block",
				width: "22px",
				height: "22px",
				objectFit: "contain",
				boxSizing: "border-box"
			});
			Object.assign(text.style, { opacity: "0.85", boxSizing: "border-box" });
		}

		/**
		 * 右下角管理员权限状态浮层。
		 *
		 * 本组件**不渲染任何内容**：只在挂载时建层、卸载时拆层，
		 * 图标与文字由定时轮询到的状态直接更新 DOM。
		 */
		function AdminStatusLayer() {
			react.useEffect(() => {
				if (typeof document === "undefined" || document.body === null) return undefined;

				// 幂等：同名容器先移除，避免重复挂载叠出多个
				const stale = document.getElementById(LAYER_ID);
				if (stale !== null) stale.remove();

				const root = document.createElement("div");
				root.id = LAYER_ID;
				document.body.appendChild(root);

				const button = document.createElement("button");
				button.type = "button";
				button.className = "ga-admin";
				button.dataset.admin = "false";
				const img = document.createElement("img");
				img.alt = "";
				img.src = ICONS.noAdmin;
				const text = document.createElement("span");
				text.textContent = ADMIN_LABEL;
				button.append(img, text);
				root.appendChild(button);

				// 外观随元素内联写死：不走 `<style>`，因此不存在
				// "样式表被谁删掉了" 这种会导致浮层掉到左下角的失败模式。
				styleLayer(root, button, img, text);

				let disposed = false;
				let timer = null;
				let busy = false;
				/** 最近一次状态；null/undefined 表示还没查到。 */
				let state;

				const applyState = () => {
					if (disposed) return;
					const known = state !== undefined && state !== null;
					// 没查到状态时先隐藏，避免闪一下"未提权"这种误导
					root.style.visibility = known ? "visible" : "hidden";
					if (!known) return;
					const hasAdmin = state.helperElevated === true;
					button.dataset.admin = hasAdmin ? "true" : "false";
					// 状态相关外观：原先由 CSS 的 `[data-admin="true"]` / `:disabled`
					// 选择器负责，现在样式表不存在了，必须在这里显式写内联。
					button.style.borderColor = hasAdmin ? "rgba(255,160,64,.55)" : "transparent";
					button.style.background = hasAdmin ? "rgba(255,160,64,.12)" : "transparent";
					button.style.filter = hasAdmin ? "none" : "grayscale(.35)";
					button.style.opacity = busy ? "0.6" : "1";
					button.style.cursor = busy ? "default" : "pointer";
					img.src = hasAdmin ? ICONS.yesAdmin : ICONS.noAdmin;
					img.alt = hasAdmin ? "已获得管理员权限" : "未获得管理员权限";
					button.title = hasAdmin ? "已获得管理员权限 · 点击释放" : "未获得管理员权限";
					button.setAttribute("aria-label", `${ADMIN_LABEL}：${hasAdmin ? "已获得" : "未获得"}`);
					button.disabled = busy;
				};

				const tick = async () => {
					state = await fetchStatus();
					applyState();
				};

				const onClick = async () => {
					// 只有确实持有权限时才释放；没有权限时这里不主动弹 UAC
					// （提权必须由人在 UAC 弹窗里确认，不该被一次点击绕过）
					if (busy || state === undefined || state === null || state.helperElevated !== true) return;
					busy = true;
					applyState();
					const result = await releaseAdmin();
					busy = false;
					state = result.error === undefined ? result.admin : state;
					applyState();
				};
				button.addEventListener("click", onClick);

				// 页面不可见时不轮询（后台标签页只是白耗电）
				const schedule = () => {
					if (timer !== null) clearInterval(timer);
					if (document.visibilityState === "visible") {
						void tick();
						timer = setInterval(tick, POLL_MS);
					}
				};
				schedule();
				document.addEventListener("visibilitychange", schedule);

				// 卸载：把**自己**建的东西全部拆干净
				return () => {
					disposed = true;
					if (timer !== null) clearInterval(timer);
					document.removeEventListener("visibilitychange", schedule);
					button.removeEventListener("click", onClick);
					// 只拆根节点：外观是内联在节点上的，**没有** `<style>` 需要清理
					// （这正是本次修复要消掉的东西 —— 清理顺序一旦错位，
					//  样式表先没、容器还在，浮层就掉到左下角且变成原生丑样式）。
					root.remove();
				};
			}, []);

			return null;
		}
		//#endregion

		//#region 插件装配
		/**
		 * 需要的宿主服务：
		 *   - `slots`     —— 提供挂载点（用于触发浮层挂载）；
		 *   - `commandUi` —— 往 `+` 菜单注册"取消管理员权限"。
		 *
		 * 二者都只在对应服务可用时才触发回调，所以某个服务缺失时只是"少做一件事"。
		 */
		const inject = ["slots", "commandUi"];

		/**
		 * 挂载点槽位。
		 *
		 * ⚠️ **绝不能**用 `conversation.input.permission`。
		 *
		 * 该槽位在 DSH 里声明为 `{ kind: "single", scope: "session" }` —— **单占位**，
		 * 只允许一个占用者；而 DSH 自带的
		 * `@deepseek-ai/dsh-client-ui-permission-presets` 正是它的占用者
		 * （注册 `PermissionSelect`，且不传 `id`）。
		 *
		 * 踩过的完整后果链（代价很大，务必别重犯）：
		 *   往该槽位注册一个带 `id` 的按钮 → 抢掉唯一占位 →
		 *   `PermissionSelect` 注册失败 → 该插件报 `failed` →
		 *   **整个 web boot 失败、应用打不开** →
		 *   并连带触发 DSH 把 `cordis.patch.yml` 截断成几百字节
		 *   （**所有插件与模型配置丢失**）。
		 *
		 * 正确做法是用 `{ kind: "list", scope: "session" }` 的槽位
		 * （如本处用的 `conversation.input.dock`）—— 它本来就为多占用者设计，
		 * 追加条目不会挤掉任何内置 UI。
		 */
		const SLOT = "conversation.input.dock";

		/** 统一记录并吞掉装配期异常：客户端插件抛错会让整个界面白屏。 */
		const guard = (what, run) => {
			try {
				return run();
			} catch (error) {
				try {
					console.error(`[get-admin] ${what}失败（已忽略）`, error);
				} catch {
					/* 控制台不可用 */
				}
				return () => {};
			}
		};

		function apply(ctx) {
			// ① 右下角状态浮层
			//
			// `ctx.slots.inject()` 在**订阅时**不执行回调，所以 try/catch 必须放进
			// 回调**内部** —— 否则注册期抛出的异常捕获不到，会让客户端装配失败。
			ctx.slots.inject(SLOT, () =>
				guard("注册管理员状态浮层", () =>
					ctx.slots.register({ name: SLOT, id: "get-admin-status", order: 60 }, AdminStatusLayer)
				)
			);

			// ② `+` 菜单里的"取消管理员权限"
			//
			// 写法与官方内置 "file" 指令一致：
			//   scope.get("commandUi") + scope.effect(() => commands.register({...}), label)
			// 注意 `commands.register` **不返回 disposer**，所以 effect 的回调不能返回它。
			ctx.inject(["commandUi"], (scope) => {
				scope.effect(() => {
					const commands = scope.get("commandUi");
					try {
						commands.register({
							name: "get-admin-revoke",
							label: () => "取消管理员权限",
							// 右侧说明：`description` 与 `label` 一样是**返回字符串的函数**
							// （见官方 CommandUiRuntime.candidates 的行构造），漏传就会右侧留空。
							description: () => "结束提权助手进程，收回管理员权限",
							// 图标是**组件**（官方传的是 IconPaperclipOutlineRegular 这种组件）
							icon: () =>
								jsx("img", {
									src: ICONS.admin,
									alt: "",
									width: 16,
									height: 16,
									style: { display: "block", width: "16px", height: "16px", objectFit: "contain" }
								}),
							available: () => true,
							ui: {
								kind: "action",
								run: () => {
									void releaseAdmin();
								}
							}
						});
					} catch (error) {
						try {
							console.error("[get-admin] 注册 + 菜单指令失败（已忽略）", error);
						} catch {
							/* 控制台不可用 */
						}
					}
				}, "get-admin: revoke action");
			});
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
