/**
 * 工具定义适配层：产出 **DSH 工具注册表真正要求的形状**。
 *
 * ## 为什么需要它（这是个真踩过的坑）
 *
 * DSH 的 `tools.register()` 要求每个工具有：
 *   `name` / `description` / `parameters`（原始 JSON Schema）/
 *   **`output.schema` + `output.render`** / **`execute(args, exec)`**。
 *
 * 我第一版把执行入口写成了 `run`（跟着插件内部的 `spec.run` 命名走），
 * 并且没给 `output` —— 于是：
 *   - **测试全绿**（那些测试都是直接调 `spec.run` 的）；
 *   - 但在真实 DSH 里这个工具**一调用就崩**，因为注册表找的是 `execute`。
 *
 * 是"用真实 cordis 加载插件"的那条测试把这个错误假设抓出来的。
 * 所以本文件的存在理由就是：**让形状只在一处定义**，不再靠记忆去拼。
 *
 * ## 为什么不 import `@deepseek-ai/dsh-tools` 的 `defineTool`
 *
 * 桌面版把 DSH 依赖打进 asar，而 profile 的 `node_modules/@deepseek-ai/*` 联接
 * 指向 npm 全局那份，**两者版本可能不同**。只要 import 任何 `@deepseek-ai/*`，
 * 就可能把另一个版本的实现拉进来，注册表校验规则对不上时 `register()` 直接抛错、
 * 整个插件激活失败，而界面只显示 `failed`，极难定位。
 * 注册表要求的东西很少，自己产出即可，从而不引入任何模块解析风险。
 *
 * @module dsh-plugin-toolkit
 */

/**
 * 工具返回值的 schema。
 *
 * 用统一的信封（`summary` / `lines` / `data`）：
 *   - `summary` + `lines` 是给模型看的文本；
 *   - `data` 是结构化载荷，形状随工具而变，所以声明为「任意属性的对象」，
 *     而不是留空 schema（空 schema 是否被接受取决于实现细节）。
 */
export const ENVELOPE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		summary: { type: "string", required: true },
		lines: { type: "array", items: { type: "string" } },
		data: { type: "object", additionalProperties: true }
	}
};

/**
 * 把 `bigint` / `Buffer` / `Map` / `Set` / 函数等转成可安全 JSON 化的值。
 *
 * @param {unknown} value 任意值
 * @param {number} [depth] 递归深度（防环）
 * @returns {unknown}
 */
export function toJsonSafe(value, depth = 0) {
	if (value === null || value === undefined) return undefined;
	const type = typeof value;
	if (type === "bigint") return value.toString();
	if (type === "string" || type === "boolean") return value;
	if (type === "number") return Number.isFinite(value) ? value : String(value);
	if (type === "function") return undefined;
	if (Buffer.isBuffer(value)) return value.toString("hex");
	if (depth > 8) return "[…]";
	if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, depth + 1));
	if (value instanceof Map) return toJsonSafe(Object.fromEntries(value), depth + 1);
	if (value instanceof Set) return toJsonSafe([...value], depth + 1);
	if (type === "object") {
		const out = {};
		for (const [key, item] of Object.entries(value)) {
			const safe = toJsonSafe(item, depth + 1);
			if (safe !== undefined) out[key] = safe;
		}
		return out;
	}
	return undefined;
}

/**
 * 定义一个工具，产出注册表要求的形状。
 *
 * `spec.run(args, exec)` 返回 `{ summary, lines?, data? }`（信封）。
 *
 * @param {object} spec
 * @param {string} spec.name 工具名
 * @param {string} spec.description 给模型的说明
 * @param {object} spec.parameters 参数 schema（作者侧 DSL，见 {@link compileParameters}）
 * @param {(args: object, exec: object) => Promise<object>|object} spec.run 执行体
 * @param {() => boolean} [spec.isConcurrencySafe] 是否可并行（默认 true）
 * @param {number} [spec.timeoutMs] 超时
 * @returns {object} 可直接交给 `ctx.tools.register()` 的定义
 */
export function defineTool(spec) {
	if (typeof spec.name !== "string" || spec.name === "") {
		throw new Error("defineTool: name 不能为空");
	}
	if (typeof spec.description !== "string" || spec.description === "") {
		throw new Error(`defineTool(${spec.name}): description 不能为空`);
	}
	if (typeof spec.run !== "function") {
		throw new Error(`defineTool(${spec.name}): run 必须是函数`);
	}

	return {
		name: spec.name,
		description: spec.description,
		parameters: compileParameters(spec.parameters ?? { type: "object", additionalProperties: false, properties: {} }),
		output: {
			schema: ENVELOPE_SCHEMA,
			render: (_args, value) => {
				const body = Array.isArray(value?.lines) && value.lines.length > 0 ? value.lines.join("\n") : "";
				const summary = typeof value?.summary === "string" ? value.summary : "(无结果)";
				return [{ type: "text", text: body === "" ? summary : `${summary}\n${body}` }];
			}
		},
		...(typeof spec.isConcurrencySafe === "function" ? { isConcurrencySafe: spec.isConcurrencySafe } : {}),
		...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
		async execute(args, exec) {
			const result = await spec.run(args ?? {}, exec ?? {});
			const lines = Array.isArray(result?.lines) ? result.lines.map((line) => String(line)) : [];
			const data = result?.data === undefined ? undefined : toJsonSafe(result.data);
			return {
				summary: String(result?.summary ?? ""),
				lines,
				...(data === undefined ? {} : { data })
			};
		}
	};
}

/** 作者侧 DSL 类型 → JSON Schema 类型。 */
const TYPE_MAP = new Map([
	["string", "string"],
	["number", "number"],
	["integer", "integer"],
	["boolean", "boolean"],
	["null", "null"],
	["array", "array"],
	["object", "object"],
	["json", undefined]
]);

/**
 * 把作者侧参数 DSL 编译成原始 JSON Schema。
 *
 * 约定：`required: true` 写在属性上，编译时提到父级 `required` 数组；
 * `object` 应给出 `properties`；`array` 用 `items`；`enum` 只能落在标量上。
 *
 * @param {object} spec
 * @returns {object} JSON Schema
 */
export function compileParameters(spec) {
	const compile = (node, name) => {
		if (node === null || typeof node !== "object") {
			throw new Error(`defineTool 的 "${name}" 必须是对象形式的 schema 定义`);
		}
		const out = {};
		if (node.description !== undefined) out.description = String(node.description);
		if (node.enum !== undefined) out.enum = node.enum;
		if (node.const !== undefined) out.const = node.const;
		if (node.default !== undefined) out.default = node.default;

		const declared = node.type === undefined ? undefined : TYPE_MAP.get(node.type);
		if (node.type !== undefined && !TYPE_MAP.has(node.type)) {
			throw new Error(`defineTool 的 "${name}" 使用了不支持的 type：${node.type}`);
		}
		if (declared !== undefined) out.type = declared;

		if (node.type === "object" || node.properties !== undefined) {
			out.type = "object";
			out.additionalProperties = node.additionalProperties ?? false;
			out.properties = {};
			for (const [key, child] of Object.entries(node.properties ?? {})) {
				const compiled = compile(child, `${name}.${key}`);
				if (child.required === true) {
					out.required = out.required ?? [];
					out.required.push(key);
				}
				delete compiled.__required;
				out.properties[key] = compiled;
			}
		}
		if (node.type === "array" || node.items !== undefined) {
			out.type = "array";
			if (node.items !== undefined) out.items = compile(node.items, `${name}[]`);
		}
		return out;
	};
	return compile(spec, "parameters");
}
