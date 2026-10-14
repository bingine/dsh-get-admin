/**
 * 测试入口：**强制开启无人值守提权闸门**后运行测试。
 *
 * ## 为什么所有测试都必须经这里跑
 *
 * 无人值守时（CI、批量跑、让模型自己验证）UAC 可能被自动批准 ——
 * 那就等于**没经人确认就拿到了管理员权限**。
 * 所以测试**一律**带 `GET_ADMIN_NO_ELEVATE=1`：
 * 任何试图走 UAC 的代码都会**明确报错**而不是弹窗。
 *
 * 这不是"降低测试覆盖"：提权的失败路径本来就应该被测
 * （见 `test/no-elevate-guard.test.mjs`），而**成功**路径需要真人确认 UAC，
 * 本来就不该在自动化里跑。
 *
 * ## 为什么必须带 `--test-force-exit`
 *
 * 助手 / 内核链路会留下让事件循环保持存活的句柄（worker 等），
 * 不兜底的话"用例全过、`node --test` 却一直挂着"。
 *
 * ⚠️ 曾经的解法是在测试文件顶层钩子里 `process.exit()` —— 那是**错的**，
 * 会造成**静默漏测**：顶层 `after()` 会在最后一个用例还没执行时就触发，
 * `process.exit()` 把那个用例一起带走，而运行器照样报告全绿。
 * 实测 `elevation.test.mjs` 3 个用例只跑了 2 个、`integration.test.mjs`
 * 2 个只跑了 1 个（少的都是文件里最后一条）。
 * `--test-force-exit` 是运行器提供的正确机制：**全部用例跑完之后**才强制退出，
 * 既不挂住、也不会漏跑用例。
 *
 * 用法：
 *   node test/run-tests.mjs            # 跑全部
 *   node test/run-tests.mjs test/x.test.mjs   # 只跑指定文件
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

// 收集要跑的文件：优先用命令行给的，否则取 test 下的全部 *.test.mjs。
// 刻意**不用 shell 通配** —— 那样在 Windows 上行为不一致，且容易把
// 非测试文件（如 run-tests.mjs 自己、辅助模块）也塞进去。
const args = process.argv.slice(2);
const files =
	args.length > 0
		? args
		: fs
				.readdirSync(HERE)
				.filter((name) => name.endsWith(".test.mjs"))
				.sort()
				.map((name) => path.join(HERE, name));

if (files.length === 0) {
	process.stderr.write("没有找到任何 *.test.mjs\n");
	process.exit(1);
}

const child = spawn(process.execPath, ["--test", "--test-force-exit", ...files], {
	cwd: ROOT,
	stdio: "inherit",
	env: {
		...process.env,
		// ⚠️ 核心：无人值守保护
		GET_ADMIN_NO_ELEVATE: "1"
	}
});
child.on("exit", (code, signal) => {
	if (signal !== null) process.exit(1);
	process.exit(code ?? 1);
});
