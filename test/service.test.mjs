/**
 * get-admin 测试：提权探测、协议帧、服务契约。
 *
 * 这些是**不依赖 UAC** 的部分，所以能稳定跑在任何环境（包括没有管理员权限的 CI）。
 * 真实提权链路（UAC / 常驻助手 / 远程内存 RPC）在 `elevation.test.mjs` 里，
 * 它用"不提权助手"跑通同一条代码路径 —— 唯一没被覆盖的就是"有人在安全桌面上点 UAC"。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isElevated, isPermissionDenied, permissionDeniedAdvice, resetElevationCache } from "../lib/elevation.js";
import { decodeFrames, encodeFrames } from "./helpers/wire.mjs";
import { GetAdminService, SERVICE_NAME } from "../lib/service.js";

/* ─────────────────────────── 提权探测 ─────────────────────────── */

test("isElevated 返回布尔值，且缓存后可重置", () => {
	resetElevationCache();
	const first = isElevated();
	assert.equal(typeof first, "boolean", "应当返回布尔值");
	// 第二次必须命中缓存（同一结果）
	assert.equal(isElevated(), first, "缓存后结果应当一致");
	resetElevationCache();
	assert.equal(typeof isElevated(), "boolean", "重置后仍应返回布尔值");
});

test("isPermissionDenied 只把真正的权限失败认成权限问题", () => {
	// 应当命中
	assert.equal(isPermissionDenied(new Error("OpenProcess 失败：Win32 错误 5")), true, "Win32 5");
	assert.equal(isPermissionDenied(new Error("拒绝访问")), true, "中文拒绝访问");
	assert.equal(isPermissionDenied(new Error("Access is denied.")), true, "英文拒绝访问");
	assert.equal(isPermissionDenied(new Error("0x80070005")), true, "HRESULT");
	assert.equal(isPermissionDenied(Object.assign(new Error("x"), { code: "EPERM" })), false, "EPERM 在 message 里才认");
	assert.equal(isPermissionDenied(new Error("EPERM: operation not permitted")), true, "文本 EPERM");

	// 不该命中：避免把无关失败误报成权限问题
	assert.equal(isPermissionDenied(new Error("读取失败：部分数据无法读取")), false, "普通读取失败");
	assert.equal(isPermissionDenied(new Error("Win32 错误 299")), false, "299 不是权限错误");
	assert.equal(isPermissionDenied(new Error("找不到进程")), false, "找不到进程");
	assert.equal(isPermissionDenied(null), false, "null");
	assert.equal(isPermissionDenied(undefined), false, "undefined");
});

test("permissionDeniedAdvice 给出可执行的下一步", () => {
	const notElevated = permissionDeniedAdvice({ elevated: false, target: { pid: 123, name: "game.exe" } });
	const text = notElevated.join("\n");
	assert.match(text, /game\.exe/, "应当点名目标");
	assert.match(text, /123/, "应当带上 pid");
	assert.match(text, /未提权/, "应当说明当前未提权");
	assert.ok(notElevated.length >= 3, "应当给出多条建议");

	const already = permissionDeniedAdvice({ elevated: true });
	assert.match(already.join("\n"), /已提权|PPL|反作弊/, "已提权时应指向受保护进程这类原因");
});

/* ─────────────────────────── 协议帧 ─────────────────────────── */

test("协议：请求帧往返后字段与 payload 完整", () => {
	const payload = Buffer.from([1, 2, 3, 4, 5]);
	const frames = encodeFrames({ id: 7, method: "readProcessMemory", token: "t", params: { address: 0x1234n } }, payload);
	const decoded = decodeFrames(Buffer.concat(frames));
	assert.equal(decoded.length, 1, "应当解出 1 帧");
	assert.equal(decoded[0].header.id, 7);
	assert.equal(decoded[0].header.method, "readProcessMemory");
	assert.equal(decoded[0].header.token, "t");
	// bigint 必须经 wire 往返后仍是 bigint（否则地址会变成字符串/丢失精度）
	assert.equal(decoded[0].header.params.address, 0x1234n, "bigint 应当被还原");
	assert.deepEqual([...decoded[0].payload], [...payload], "payload 原样");
});

test("协议：分片到达也能正确解帧（TCP 是字节流）", () => {
	const frames = encodeFrames({ id: 1, method: "a" }, Buffer.alloc(0));
	const whole = Buffer.concat(frames);
	// 逐字节喂入
	const reader = new (class {
		constructor() {
			this.pending = [];
		}
		push(chunk) {
			this.pending.push(chunk);
			return decodeFrames(Buffer.concat(this.pending)).length;
		}
	})();
	let complete = 0;
	for (const byte of whole) complete = reader.push(Buffer.from([byte]));
	assert.equal(complete, 1, "逐字节喂入后应当恰好解出 1 帧");
});

/* ─────────────────────────── 服务契约 ─────────────────────────── */

test("服务名是 getAdmin（消费方靠这个字符串注入）", () => {
	assert.equal(SERVICE_NAME, "getAdmin");
});

test("未注册前 status 是只读的，且如实反映「没有助手」", () => {
	const service = new GetAdminService();
	const status = service.status();
	assert.equal(typeof status.elevated, "boolean");
	assert.equal(status.hasHelper, false, "刚构造时不应有助手");
	assert.equal(status.helperElevated, false);
	assert.equal(status.helperPid, null);
	assert.equal(status.busy, false);
	assert.equal(status.lastError, null);
	assert.equal(typeof status.discovery, "string");
});

test("onChange 订阅：release 会通知订阅者，取消订阅后不再收到", () => {
	const service = new GetAdminService();
	const seen = [];
	const off = service.onChange((status) => seen.push(status));

	service.release();
	assert.equal(seen.length, 1, "release 应当通知一次");
	assert.equal(seen[0].hasHelper, false);

	off();
	service.release();
	assert.equal(seen.length, 1, "取消订阅后不应再收到通知");
});

test("订阅者抛错不会拖垮服务，也不影响其它订阅者", () => {
	const service = new GetAdminService();
	let secondCalled = 0;
	service.onChange(() => {
		throw new Error("订阅者自己炸了");
	});
	service.onChange(() => {
		secondCalled += 1;
	});
	assert.doesNotThrow(() => service.release(), "订阅者抛错不应冒泡出来");
	assert.equal(secondCalled, 1, "另一个订阅者仍应被通知");
});

test("release 在没有任何助手时也幂等成功", () => {
	const service = new GetAdminService();
	const first = service.release();
	assert.equal(first.released, false, "没有助手时 released=false");
	assert.equal(first.status.hasHelper, false);
	assert.doesNotThrow(() => service.release(), "可以重复调用");
});
