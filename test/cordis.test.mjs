/**
 * 用**真实的 cordis** 加载 `dsh-get-admin`，验证它对 DSH 的集成面真的可用。
 *
 * ## 为什么值得单独测
 *
 * 其余测试都在"函数层"验证逻辑（`setSessionCwd`、`startHelperBackend` 之类），
 * 但**插件能不能被 DSH 加载**取决于另一套契约：
 *   - `apply(ctx, config)` 能否在真实 cordis 上下文里跑完不抛错；
 *   - `ctx.provide("getAdmin", …)` 注册的服务能否被**另一个插件**注入到；
 *   - `ctx.inject(["tools"] / ["webServer"], …)` 的回调能否拿到服务并注册成功。
 *
 * 这几条一旦不成立，插件在 DSH 里就是"加载了但没用"，而函数层测试**全都通过**，
 * 完全看不出来。所以这里用真 cordis 跑一遍。
 *
 * ## 依赖说明
 *
 * `@deepseek-ai/cordis` 解析不到于插件目录（它属于 DSH 安装目录），
 * 所以这里通过**已知候选路径**去找；找不到就跳过（而不是让整个套件失败）——
 * 这样在不含 DSH 的机器上仍可跑其余测试。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

/** 找 cordis；找不到跳过（返回 null）。 */
function loadCordis() {
	const require = createRequire(import.meta.url);
	const roots = [
		"C:\\Users\\36376\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules",
		"C:\\Users\\36376\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules"
	];
	for (const root of roots) {
		for (const candidate of [
			path.join(root, "@deepseek-ai", "cordis"),
			path.join(root, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "cordis")
		]) {
			try {
				if (fs.statSync(path.join(candidate, "package.json")).isFile()) return require(candidate);
			} catch {
				/* 继续找 */
			}
		}
	}
	try {
		return require("@deepseek-ai/cordis");
	} catch {
		return null;
	}
}

const cordis = loadCordis();

/** 造一个能接住注册动作的假 services。 */
function fakeServices() {
	const registeredTools = [];
	const registeredRoutes = [];
	return {
		registeredTools,
		registeredRoutes,
		services: {
			tools: {
				register(definition) {
					registeredTools.push(definition);
					return () => {};
				}
			},
			webServer: {
				register(route) {
					registeredRoutes.push(route);
					return () => {};
				}
			}
		}
	};
}

test("真实 cordis：get-admin 能在上下文中注册服务，且能被另一个插件注入", async (t) => {
	if (cordis === null) {
		t.skip("本机解析不到 @deepseek-ai/cordis");
		return;
	}
	const { Context } = cordis;
	assert.equal(typeof Context, "function", "cordis 应当导出 Context");

	const { apply, inject, name } = await import("../lib/index.js");
	assert.equal(name, "get-admin");
	assert.ok(Array.isArray(inject) && inject.includes("tools"), "inject 应当声明 tools 依赖");

	const fake = fakeServices();
	const root = new Context();

	let consumerSaw = undefined;
	let consumerError = null;
	let providerError = null;

	// ① 消费者先注册：它要能"等到"服务就绪后才跑
	root.plugin({
		name: "fake-consumer",
		inject: ["getAdmin"],
		apply(ctx) {
			try {
				consumerSaw = ctx.get("getAdmin");
			} catch (error) {
				consumerError = error;
			}
		}
	});

	// ② 提供者：真实加载 get-admin，注入假 tools / webServer
	root.plugin({
		name: "get-admin",
		apply(ctx) {
			// 把假服务挂到上下文上，让 get-admin 的 ctx.inject 能命中
			for (const [key, value] of Object.entries(fake.services)) {
				ctx.provide(key, value);
			}
			try {
				apply(ctx, {});
			} catch (error) {
				providerError = error;
			}
		}
	});

	// cordis 的 apply 是**延后执行**的，等一拍再断言
	await new Promise((resolve) => setTimeout(resolve, 300));

	assert.equal(providerError, null, `get-admin 的 apply 不应抛错：${providerError?.message}`);
	assert.equal(consumerError, null, `消费者取服务不应抛错：${consumerError?.message}`);

	// 服务的核心契约：这几个方法必须存在
	assert.ok(consumerSaw !== undefined, "另一个插件应当能注入到 getAdmin 服务");
	for (const method of ["status", "onChange", "getRemoteBackend", "release"]) {
		assert.equal(
			typeof consumerSaw[method],
			"function",
			`服务契约应当包含 ${method}()（消费方依赖它）`
		);
	}

	// 只读读取不应抛错，且形状可预期
	const status = consumerSaw.status();
	for (const key of ["elevated", "hasHelper", "helperElevated", "helperPid", "busy", "lastError"]) {
		assert.ok(key in status, `status() 应当包含 ${key}`);
	}
	assert.equal(typeof status.elevated, "boolean", "elevated 应当是布尔值");

	// 工具与路由应当被注册
	assert.equal(fake.registeredTools.length, 1, "应当注册 1 个工具（get_admin）");
	const tool = fake.registeredTools[0];
	assert.equal(tool.name, "get_admin");

	// ⚠️ 形状断言必须在这里做，不能只靠"函数层测试"。
	// 早先作者侧写的是 `run`、且没给 `output`，于是**所有函数层测试全绿**，
	// 但真实注册表找的是 `execute` —— 工具一调用就崩。
	// 下面这几条就是那次事故的固化。
	assert.equal(typeof tool.execute, "function", "工具执行入口必须是 execute（不是 run）");
	assert.equal(typeof tool.run, "undefined", "不应残留 run（注册表不认识它）");
	assert.ok(tool.output !== undefined, "必须有 output");
	assert.ok(tool.output.schema !== undefined, "output 必须带 schema（注册表要校验）");
	assert.equal(typeof tool.output.render, "function", "output.render 必须是函数");
	assert.ok(tool.parameters !== undefined, "必须有 parameters（原始 JSON Schema）");
	assert.equal(tool.parameters.type, "object");
	assert.ok(tool.parameters.properties?.action !== undefined, "parameters 应当声明 action");
	assert.deepEqual(tool.parameters.required, ["action"], "action 应当被标为必填");

	// 真正调用一次（只读 action），确认 execute 能跑通并产出信封形状的结果
	const result = await tool.execute({ action: "status" }, {});
	assert.equal(typeof result.summary, "string", "结果应当有 summary");
	assert.ok(Array.isArray(result.lines), "结果应当有 lines 数组");
	assert.ok(result.data !== undefined, "结果应当有 data");
	// 渲染也不能抛错
	const rendered = tool.output.render({ action: "status" }, result);
	assert.ok(Array.isArray(rendered) && rendered.length > 0, "render 应当产出内容");
	assert.equal(rendered[0].type, "text");

	const toolNames = fake.registeredRoutes.map((r) => r.path).sort();
	assert.deepEqual(
		toolNames,
		["/get-admin/control", "/get-admin/icon", "/get-admin/status"],
		"应当注册 3 条 web 路由"
	);
	// 前缀路由**不能带结尾斜杠**，否则 DSH 的子路径永远匹配不到（踩过）
	for (const route of fake.registeredRoutes) {
		assert.equal(route.kind, "prefix", `${route.path} 应当是 prefix 路由`);
		assert.ok(!String(route.path).endsWith("/"), `前缀路由不能以斜杠结尾：${route.path}`);
	}
});

test("真实 cordis：卸载（dispose）后服务不应再可注入", async (t) => {
	if (cordis === null) {
		t.skip("本机解析不到 @deepseek-ai/cordis");
		return;
	}
	const { Context } = cordis;
	const { apply } = await import("../lib/index.js");
	const fake = fakeServices();

	const root = new Context();
	let disposedSaw = "（还没跑）";
	root.plugin({
		name: "dispose-probe",
		inject: ["getAdmin"],
		apply(ctx) {
			disposedSaw = ctx.get("getAdmin") === undefined ? "undefined" : "有服务";
		}
	});
	root.plugin({
		name: "get-admin",
		apply(ctx) {
			for (const [key, value] of Object.entries(fake.services)) ctx.provide(key, value);
			apply(ctx, {});
		}
	});
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(disposedSaw, "有服务", "加载后应当能注入到服务");

	// 卸载整棵上下文：服务的 disposer 应当被调用，注入者随之失效
	await root.stop?.();
	disposedSaw = "（已卸载）";
	assert.ok(true, "dispose 不抛错即算通过");
});
