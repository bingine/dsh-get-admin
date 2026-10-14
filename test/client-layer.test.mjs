/**
 * 右下角浮层（`lib/client.js`）的**真实 DOM 回归测试**。
 *
 * ## 这条测试的由来（用户实测的 bug）
 *
 * 浮层本该固定在整个界面**右下角**，实际却出现在**左下角**、而且按钮是
 * 浏览器原生的丑样式。用户从开发者工具复制出的 DOM 说明了原因：
 *
 *     <div id="get-admin-layer" style="visibility: visible;">…</div>
 *
 * 容器**在**，而 `<style id="get-admin-layer-style">` **不在文档里**。
 * 样式表一没，`position:fixed;right:16px;bottom:18px` 全部失效，容器退回
 * 普通流、落在 `<body>` 末尾 —— 在 column 布局下正好表现为左下角。
 *
 * 根因不是"谁把样式表删了"，而是**布局依赖了一个可能不存在的样式表**。
 * 修复办法是把关键布局用 CSSOM 内联写死（`styleLayer()`），
 * 于是这条测试的**核心断言**就是：
 *
 *   1. 定位内联在容器自己的 `style` 上（`fixed` + `right` + `bottom`）；
 *   2. 文档里**一个 `<style>` 都不需要** —— 全删掉，位置也不变；
 *   3. 卸载时不再去碰任何 `<style>`（历史上这里引用了已被删掉的变量）。
 *
 * ## 为什么必须用真实 DOM 桩，而不是再加一条静态检查
 *
 * 这个 bug 能溜进发布，正是因为此前只有"源码能否按脚本解析"这类**静态**检查
 * （见 `dsh-ce-tools` 的 `test/client-entry.test.mjs`）：它永远不执行
 * `useEffect`，也就永远看不到"样式表没插进去 / 被删掉了"。
 * 所以这里用最小 DOM + React 桩**真的把组件挂起来**，再去问 DOM 要答案。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const CLIENT = path.join(ROOT, "lib", "client.js");

//#region 最小 DOM 桩
/**
 * 只实现 `lib/client.js` 真正用到的那些 DOM 能力，但**语义要正确**：
 * `style` 是普通对象（`Object.assign(el.style, …)` 与 `el.style.x = y` 等价），
 * `remove()` 真的从父节点的 `children` 里摘掉，监听器可查可派发。
 */
function createDom() {
	/** 每个元素一张 type -> Set<fn>；用 WeakMap 避免给元素加可见属性。 */
	const listeners = new WeakMap();

	const listenersOf = (element, type) => {
		let byType = listeners.get(element);
		if (byType === undefined) {
			byType = new Map();
			listeners.set(element, byType);
		}
		let set = byType.get(type);
		if (set === undefined) {
			set = new Set();
			byType.set(type, set);
		}
		return set;
	};

	const makeElement = (tagName) => {
		const element = {
			tagName: String(tagName).toUpperCase(),
			id: "",
			className: "",
			type: "",
			style: {},
			dataset: {},
			attributes: {},
			children: [],
			parentNode: null,
			textContent: "",
			disabled: false,
			alt: "",
			src: "",
			title: "",
			appendChild(child) {
				if (child.parentNode !== null) child.remove();
				child.parentNode = element;
				element.children.push(child);
				return child;
			},
			append(...nodes) {
				for (const node of nodes) element.appendChild(node);
			},
			remove() {
				const parent = element.parentNode;
				if (parent === null) return;
				const index = parent.children.indexOf(element);
				if (index >= 0) parent.children.splice(index, 1);
				element.parentNode = null;
			},
			setAttribute(name, value) {
				element.attributes[name] = String(value);
			},
			getAttribute(name) {
				return name in element.attributes ? element.attributes[name] : null;
			},
			addEventListener(type, fn) {
				listenersOf(element, type).add(fn);
			},
			removeEventListener(type, fn) {
				listenersOf(element, type).delete(fn);
			},
			listenerCount(type) {
				const byType = listeners.get(element);
				return byType === undefined || !byType.has(type) ? 0 : byType.get(type).size;
			},
			/** 派发一次事件（同步），给测试驱动 click / visibilitychange 用。 */
			dispatch(type) {
				for (const fn of [...listenersOf(element, type)]) fn({ type });
			}
		};
		return element;
	};

	const head = makeElement("head");
	const body = makeElement("body");
	const documentListeners = new Map();

	/** 深度优先遍历（含自身）。 */
	const walk = (element, visit) => {
		visit(element);
		for (const child of [...element.children]) walk(child, visit);
	};

	const collect = (predicate) => {
		const found = [];
		for (const root of [head, body]) walk(root, (el) => predicate(el) && found.push(el));
		return found;
	};

	const document = {
		head,
		body,
		visibilityState: "visible",
		createElement: (tagName) => makeElement(tagName),
		getElementById(id) {
			const found = collect((el) => el.id === id);
			return found.length > 0 ? found[0] : null;
		},
		/** 只支持按标签名查（`querySelectorAll("style")`）——这是测试需要的全部。 */
		querySelectorAll(selector) {
			const tag = String(selector).toUpperCase();
			return collect((el) => el.tagName === tag);
		},
		addEventListener(type, fn) {
			let set = documentListeners.get(type);
			if (set === undefined) {
				set = new Set();
				documentListeners.set(type, set);
			}
			set.add(fn);
		},
		removeEventListener(type, fn) {
			const set = documentListeners.get(type);
			if (set !== undefined) set.delete(fn);
		},
		dispatch(type) {
			const set = documentListeners.get(type);
			if (set !== undefined) for (const fn of [...set]) fn({ type });
		},
		documentListenerCount(type) {
			const set = documentListeners.get(type);
			return set === undefined ? 0 : set.size;
		}
	};

	return { document, head, body, makeElement };
}
//#endregion

//#region 挂载脚手架
/**
 * 把 `lib/client.js` 真的跑起来：按**脚本**（非模块）在 vm 里加载，
 * 拿到它注册到 `__ModuleLoader__` 的 `apply`，再用桩 ctx 装配、
 * 从 `slots.register` 里取出组件、执行它的 `useEffect`。
 *
 * @param {object} [options]
 * @param {string} [options.admin] `/get-admin/status` 返回的 `admin.helperElevated` 取值。
 * @returns {Promise<object>} 挂载现场（元素句柄、cleanup、fetch 记录等）
 */
async function mount(options = {}) {
	const dom = createDom();
	const source = fs.readFileSync(CLIENT, "utf8");

	/** 被 `react.useEffect` 记录的副作用（测试手动执行，模拟提交阶段）。 */
	const effects = [];
	const react = {
		useEffect(cb) {
			effects.push(cb);
		},
		useState: (initial) => [initial, () => {}],
		useRef: (initial) => ({ current: initial }),
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
		useSyncExternalStore: (_subscribe, get) => get()
	};

	let moduleExports = null;
	const loader = {
		load(entry) {
			moduleExports = entry.factory((id) => {
				if (id === "react") return react;
				if (id === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null, Fragment: null };
				throw new Error(`测试桩没有提供模块：${id}`);
			});
		}
	};

	/** `/get-admin/status` 的可控返回；测试可以随时改。 */
	const fetchCalls = [];
	let statusAdmin = options.admin ?? null;
	/**
	 * `POST /get-admin/control`（释放）的响应。
	 *
	 * 默认是"释放成功、已无权限"。测试可以把它换成**挂起的 Promise** ——
	 * 否则 `await` 一下就过去了，根本观察不到 `busy === true` 的中间态。
	 */
	let releaseResponder = async () => ({ ok: true, admin: { helperElevated: false } });
	const sandbox = {
		window: { __ModuleLoader__: loader },
		document: dom.document,
		console,
		// 定时器桩：一个都不真的跑，测试想看第 N 次 tick 就自己去调度。
		setInterval: () => 0,
		clearInterval: () => {},
		fetch: async (url, init) => {
			fetchCalls.push({ url, init });
			const isRelease = String(url).includes("/control");
			const body = isRelease ? await releaseResponder() : { ok: true, admin: statusAdmin };
			return { ok: true, status: 200, json: async () => body };
		}
	};
	sandbox.globalThis = sandbox;
	vm.createContext(sandbox);
	new vm.Script(source, { filename: CLIENT }).runInContext(sandbox);

	assert.ok(moduleExports !== null, "lib/client.js 必须调用 window.__ModuleLoader__.load 注册模块");

	/** `slots.register` 的调用记录。 */
	const registrations = [];
	const ctx = {
		slots: {
			// 宿主在槽位可用时**订阅即回调**（产品代码依赖这个语义）。
			inject(_name, cb) {
				cb();
			},
			register(opts, component) {
				registrations.push({ opts, component });
				return () => {};
			}
		},
		// 本测试只关心浮层：不给 commandUi，验证"缺服务只是少做一件事"。
		inject(_names, _cb) {}
	};

	moduleExports.apply(ctx);
	assert.equal(registrations.length, 1, "应当恰好注册一个槽位条目（右下角浮层）");

	const { opts, component } = registrations[0];
	component(); // 组件本身不渲染任何东西
	assert.ok(effects.length >= 1, "组件应当通过 react.useEffect 建层");

	const cleanup = effects[0]();

	const root = dom.document.getElementById("get-admin-layer");
	assert.ok(root !== null, "挂载后 document 里应当有 #get-admin-layer");

	// ⚠️ 必须**同步**捕获这一瞬间的可见性：`mount()` 本身是 async，
	// 等到测试函数里再读，微任务队列可能已经让首次 tick 跑完了。
	const initialVisibility = root.style.visibility;

	const button = root.children[0];
	const img = button.children[0];
	const span = button.children[1];

	/** 让挂起的异步 tick（fetch → applyState）跑完。 */
	const drain = async () => {
		for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
	};

	return {
		dom,
		root,
		button,
		img,
		span,
		cleanup,
		drain,
		initialVisibility,
		slot: opts.name,
		fetchCalls,
		setStatus(next) {
			statusAdmin = next;
		},
		/** 换掉下一次 `POST /get-admin/control` 的响应；给函数就支持挂起。 */
		setRelease(next) {
			releaseResponder = typeof next === "function" ? next : async () => next;
		},
		/** 模拟"页面重新可见"→ 重新调度一轮 tick。 */
		async tickAgain() {
			dom.document.dispatch("visibilitychange");
			await drain();
		}
	};
}
//#endregion

/**
 * 卸载；**不让 teardown 的异常淹没真正的断言失败**。
 *
 * 这些用例都把 `cleanup()` 放在 `finally` 里 —— 一旦 teardown 自己抛错，
 * 会**所有用例一起变红**，掩盖掉真正失败的那一条。所以这里吞掉并单独打印；
 * "teardown 该不该抛错"由专门的"卸载"用例断言。
 */
function unmountQuietly(m) {
	try {
		m.cleanup();
	} catch (error) {
		console.error("[测试] 卸载时抛错（另有专门用例覆盖这一点）：", error);
	}
}

test("挂载后：右下角定位必须**内联**在容器上（不靠样式表）", async () => {
	const m = await mount();
	try {
		// 这几行就是用户报的那个 bug 的核心：丢了它们容器就掉到左下角。
		assert.equal(m.root.style.position, "fixed", "容器必须是固定定位");
		assert.equal(m.root.style.right, "16px", "必须贴右边（而非落到左下角的普通流）");
		assert.equal(m.root.style.bottom, "18px", "必须贴底部");
		// z-index 必须**足够高**才不会被宿主自己的浮层盖住。
		// （原来写的是 `Number(...) > 0`，实测把值改成 "1" 也照样 4/4 通过 —— 抓不住。）
		assert.equal(
			m.root.style.zIndex,
			"2147483000",
			`z-index 必须与设计值一致，实际：${m.root.style.zIndex}`
		);

		// 容器不吃点击、按钮吃点击 —— 否则要么挡住右下角的界面，要么按钮点不动。
		assert.equal(m.root.style.pointerEvents, "none", "容器本身不应拦截点击");
		assert.equal(m.button.style.pointerEvents, "auto", "按钮必须可点");
		assert.equal(m.button.style.cursor, "pointer", "按钮应显示可点光标");
	} finally {
		unmountQuietly(m);
	}
});

test("用户场景重演：文档里**一个 `<style>` 都没有**时，浮层依旧在右下角", async () => {
	const m = await mount();
	try {
		// ① 修复后压根不插入样式表 —— 外观随元素本身生灭。
		const styles = m.dom.document.querySelectorAll("style");
		assert.deepEqual(
			styles.map((el) => el.id),
			[],
			`修复后不应再往文档里插 <style>，实际有：${styles.map((el) => el.id).join(", ")}`
		);

		// ② 重演事故现场：把文档里所有 <style> 全删掉（用户实测的 DOM 就是没有样式表）。
		for (const style of styles) style.remove();
		for (const style of m.dom.document.querySelectorAll("style")) style.remove();
		assert.equal(m.dom.document.querySelectorAll("style").length, 0, "事故现场应当没有任何样式表");

		// ③ 定位与尺寸**不受影响** —— 这正是修复要保证的不变量。
		assert.equal(m.root.style.position, "fixed");
		assert.equal(m.root.style.right, "16px");
		assert.equal(m.root.style.bottom, "18px");
		assert.equal(m.root.style.display, "flex");
		assert.equal(m.img.style.width, "22px", "图标宽度也应内联（否则会撑成原始尺寸）");
		assert.equal(m.img.style.height, "22px");
	} finally {
		unmountQuietly(m);
	}
});

test("状态外观内联：有权限时橙色描边、无权限时灰度", async () => {
	const m = await mount({ admin: { helperElevated: false } });
	try {
		await m.drain();

		// 未提权：灰掉、无描边。
		assert.equal(m.button.dataset.admin, "false");
		// ⚠️ 必须是 `0.35` 而不是 `.35`：真实浏览器会把 `.35` 归一化成 `0.35`，
		// 断言 `.35` 只在 DOM 桩里成立（产品侧也已统一写成 0.35）。
		assert.equal(m.button.style.filter, "grayscale(0.35)", "未提权应灰度显示");
		assert.equal(m.button.style.borderColor, "transparent", "未提权不应有描边");
		assert.equal(m.root.style.visibility, "visible", "已查到状态后应当可见");
		assert.match(m.img.src, /no-admin$/, "未提权应显示 no-admin 图标");
		assert.equal(m.button.title, "未获得管理员权限");
		assert.equal(m.button.getAttribute("aria-label"), "管理员权限：未获得");

		// 切到已提权：出现橙色描边与底色、灰度解除。
		m.setStatus({ helperElevated: true });
		await m.tickAgain();
		assert.equal(m.button.dataset.admin, "true");
		assert.equal(m.button.style.filter, "none", "已提权不应再灰度");
		assert.notEqual(m.button.style.borderColor, "transparent", "已提权应有描边");
		assert.notEqual(m.button.style.background, "transparent", "已提权应有底色");
		assert.match(m.img.src, /admin$/, "已提权应显示 admin 图标");
		assert.equal(m.button.title, "已获得管理员权限 · 点击释放");
		assert.equal(m.button.getAttribute("aria-label"), "管理员权限：已获得");
	} finally {
		unmountQuietly(m);
	}
});

test("卸载：拆干净且不抛错（历史上这里引用了已被删掉的 style 变量）", async () => {
	const m = await mount();
	await m.drain();

	// 卸载前先确认现场是"活的"：有监听器、有定时器、节点在文档里。
	assert.equal(m.dom.document.getElementById("get-admin-layer"), m.root);
	assert.ok(m.button.listenerCount("click") > 0, "挂载期间应有 click 监听");
	assert.ok(m.dom.document.documentListenerCount("visibilitychange") > 0, "挂载期间应有可见性监听");

	// 卸载必须安全。**注意这条断言的局限**：它区分不了"改成内联样式"的前后 ——
	// 已发布的 1.0.2 里 teardown 本身也是好的（它只删自己建的东西）。
	// 它守的是"别再出现引用已删除变量"这类中途态；真正钉住本次修复的是前两条用例。
	assert.doesNotThrow(() => m.cleanup(), "卸载必须是安全的");

	assert.equal(m.dom.document.getElementById("get-admin-layer"), null, "卸载后容器必须被摘掉");
	assert.equal(m.root.parentNode, null, "卸载后容器不应再有父节点");
	assert.equal(m.button.listenerCount("click"), 0, "卸载后应摘掉 click 监听");
	assert.equal(
		m.dom.document.documentListenerCount("visibilitychange"),
		0,
		"卸载后应摘掉可见性监听"
	);
});

test("首次 tick 之前必须已经隐藏（否则会闪一下「未提权」）", async () => {
	const m = await mount({ admin: { helperElevated: true } });
	try {
		// 同步捕获的那一瞬间：`tick()` 还卡在 await fetch，`state` 仍是 undefined。
		// 后台标签页里 `schedule()` 根本不 tick，这个窗口会一直持续到用户切回来。
		assert.equal(
			m.initialVisibility,
			"hidden",
			"挂载到首次 tick 之间是异步窗口，容器必须已经隐藏 —— 否则会先闪一个「未提权」图标，而真实状态可能是已提权"
		);
		await m.drain();
		assert.equal(m.root.style.visibility, "visible", "查到状态之后才放出来");
	} finally {
		unmountQuietly(m);
	}
});

test("点击释放：忙碌期间按钮禁用并降透明，完成后恢复", async () => {
	const m = await mount({ admin: { helperElevated: true } });
	try {
		await m.drain();
		assert.equal(m.button.dataset.admin, "true");
		assert.equal(m.button.disabled, false, "空闲时应可点");
		assert.equal(m.button.style.cursor, "pointer");
		assert.equal(m.button.style.opacity, "1");

		// 把释放请求**挂起**，否则 await 一下就过去了、根本观察不到忙碌中间态
		let finishRelease = () => {};
		m.setRelease(
			() =>
				new Promise((resolve) => {
					finishRelease = resolve;
				})
		);
		m.button.dispatch("click");
		await m.drain();

		assert.equal(m.button.disabled, true, "忙碌期间必须禁用（否则用户能连点）");
		assert.equal(m.button.style.cursor, "default", "忙碌期间光标不该还是可点手型");
		assert.equal(m.button.style.opacity, "0.6", "忙碌期间应降透明");

		finishRelease({ ok: true, admin: { helperElevated: false } });
		await m.drain();

		assert.equal(m.button.disabled, false, "释放完成后必须恢复可点");
		assert.equal(m.button.style.cursor, "pointer");
		assert.equal(m.button.style.opacity, "1");
		assert.equal(m.button.dataset.admin, "false", "释放后应变成未提权");
		assert.equal(m.button.style.filter, "grayscale(0.35)");
	} finally {
		unmountQuietly(m);
	}
});

test("释放返回 null（状态未知）时，按钮不会卡在 disabled / 半透明", async () => {
	// 这是**实测过的真实路径**：`releaseAdmin()` 回 `{ admin: null }` 时，
	// 产品把 `state` 置成 null → `applyState()` 走 `!known` 早退。
	// 若 busy 相关外观写在早退之后，按钮就永远停在 disabled / 0.6 / default 上
	// （容器同时被隐藏所以用户看不见，但要等下一次成功 tick 才自愈）。
	const m = await mount({ admin: { helperElevated: true } });
	try {
		await m.drain();
		m.setRelease({ ok: true, admin: null });
		m.button.dispatch("click");
		await m.drain();

		assert.equal(m.button.disabled, false, "busy 已结束，必须恢复可点");
		assert.equal(m.button.style.opacity, "1", "busy 已结束，不该还是半透明");
		assert.equal(m.button.style.cursor, "pointer", "busy 已结束，光标应恢复");
		assert.equal(m.root.style.visibility, "hidden", "状态未知应把容器藏起来");
	} finally {
		unmountQuietly(m);
	}
});
