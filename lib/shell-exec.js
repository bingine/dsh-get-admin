/**
 * 用 **`ShellExecuteExW` + `runas`** 提权启动进程（替代 PowerShell 的 `Start-Process`）。
 *
 * ## 为什么换掉 PowerShell
 *
 * 原来的做法是：
 *   `powershell -Command "Start-Process -FilePath <node> -ArgumentList @(...) -Verb RunAs -WindowStyle Hidden"`
 *
 * 实测在提权路径上**失败**，而失败方式极具误导性：UAC 弹了、人同意了、
 * PowerShell 退出码 0，但**助手进程从未执行**（连它在第一行写的诊断都没有），
 * 调用方只看到"启动器退出码 0、没有启动助手"。
 *
 * 排查中依次**排除**的原因（都有实验证据）：
 *   · `-WindowStyle Hidden` —— 最小实验证明带它也能起提权进程，不是它；
 *   · 参数引号 —— 改成显式包引号后仍失败；
 *   · 参数数量 —— 改成"生成临时 .ps1、提权只启动脚本、零复杂参数"后**仍失败**；
 *   · 内核路径/tmpdir/配置文件 —— 非提权路径完全正常。
 *
 * 剩下的就是 **`Start-Process -Verb RunAs` 这条链路本身**（可能涉及执行策略、
 * 或被安全软件拦截）。所以直接绕开它：用 Win32 原生的 `ShellExecuteExW`
 * 指定 `runas` 谓词启动，不再经过 PowerShell、不再有转义与执行策略问题。
 *
 * ## 依赖与代价（明确记录）
 *
 * 这需要原生绑定（`koffi`）。而 `dsh-get-admin` 原本**刻意不依赖任何原生模块**
 * （它是"通用提权插件"，不该绑死到某个具体内核）。这是为了修好提权而**有意接受的代价**：
 * `koffi` 通过 `node-cheat-engine`（内核已自带）解析，不额外引入新包。
 *
 * @module dsh-get-admin/shell-exec
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** 缓存 koffi 绑定，避免每次提权都重建结构体与函数签名。 */
let cached = null;

/**
 * 解析 `koffi`。
 *
 * `dsh-get-admin` 自己没有 `node_modules`，而 `node-cheat-engine`（内核）自带 koffi。
 * 按顺序尝试：直接解析 → 从内核目录解析。都不行时返回 null（调用方给出可读报错）。
 *
 * @returns {object|null} koffi 模块
 */
function loadKoffi() {
	try {
		return require("koffi");
	} catch {
		/* 继续尝试内核目录 */
	}
	// 常见布局：<插件根>/node_modules/node-cheat-engine/node_modules/koffi
	const candidates = [
		`${process.env.CE_KERNEL_PATH ?? ""}/node_modules/koffi`,
		// 与 dsh-get-admin 并排的 cheat-engine 仓库
		"../dsh-cheat-engine/node_modules/node-cheat-engine/node_modules/koffi",
		"../../dsh-cheat-engine/node_modules/node-cheat-engine/node_modules/koffi"
	];
	for (const candidate of candidates) {
		if (candidate.startsWith("/")) continue;
		try {
			return require(candidate);
		} catch {
			/* 试下一个 */
		}
	}
	return null;
}

/**
 * 建立 `SHELLEXECUTEINFOW` 结构体与 `ShellExecuteExW` 签名（只做一次）。
 *
 * ## 结构体布局必须精确
 *
 * `cbSize` 一定要等于**当前架构**下的真实大小，否则 `ShellExecuteExW` 会直接失败
 * （它用 cbSize 校验版本）。这里按字段自然对齐推算：
 *
 * 64 位（总 112 字节）：
 *   `cbSize` u32@0，填充@4，`fMask` u32@8，填充@12，`hwnd` ptr@16，
 *   `lpVerb`@24，`lpFile`@32，`lpParameters`@40，`lpDirectory`@48，
 *   `nShow` i32@56，填充@60，`hInstApp`@64，`lpIDList`@72，
 *   `lpClass`@80，`hkeyClass`@88，`dwHotKey` u32@96，填充@100，
 *   `hMonitor`@104（与 hIcon 共用），`hProcess`@112 → 总计 120？
 *
 * ⚠️ 与其手推，这里直接用 koffi 的 `sizeof` 校验：如果推算与 koffi 的对齐结果不符，
 * 就用 koffi 算出来的值 —— 它才是真正会传给 Win32 的那个大小。
 */
function buildBindings(koffi) {
	const SHELLEXECUTEINFOW = koffi.struct("DSH_SHELLEXECUTEINFOW", {
		cbSize: "uint32",
		fMask: "uint32",
		hwnd: "void *",
		lpVerb: "void *",
		lpFile: "void *",
		lpParameters: "void *",
		lpDirectory: "void *",
		nShow: "int32",
		hInstApp: "void *",
		lpIDList: "void *",
		lpClass: "void *",
		hkeyClass: "void *",
		dwHotKey: "uint32",
		hMonitor: "void *",
		hProcess: "void *"
	});

	const shell32 = koffi.load("shell32.dll");
	const kernel32 = koffi.load("kernel32.dll");

	return {
		koffi,
		SHELLEXECUTEINFOW,
		size: koffi.sizeof(SHELLEXECUTEINFOW),
		// ⚠️ 结构体指针作为**参数类型**时，koffi **不接受** `koffi.pointer(STRUCT)`
		// 放在参数位（实测抛 `Unexpected character '(' in type specifier`）。
		// 字符串形式 `void *` 可以，但那样 koffi 不知道要传结构体的**地址** ——
		// 早先所有调用都失败（`hInstApp=0`）很可能正是这个类型不匹配，
		// 而不是结构体布局错（实测 sizeof = 112，与 64 位预期一致）。
		//
		// 正确做法：让 koffi 知道参数是**指向该结构体的指针** —— 用类型注册后的
		// 名字加 `*`。这样传 `koffi.alloc(STRUCT, 1)` 得到的缓冲区时，
		// koffi 会正确取址而不是把内容当成指针值。
		ShellExecuteExW: shell32.func("bool ShellExecuteExW(DSH_SHELLEXECUTEINFOW *info)"),
		WaitForSingleObject: kernel32.func("uint32 WaitForSingleObject(void *handle, uint32 ms)"),
		GetExitCodeProcess: kernel32.func("bool GetExitCodeProcess(void *handle, uint32 *code)"),
		CloseHandle: kernel32.func("bool CloseHandle(void *handle)")
	};
}

/** 惰性建立绑定；失败返回 null。 */
function getBindings() {
	if (cached !== null) return cached.ok ? cached.value : null;
	const koffi = loadKoffi();
	if (koffi === null) {
		cached = { ok: false, reason: "解析不到 koffi（原生绑定），无法用 ShellExecuteExW 提权" };
		return null;
	}
	try {
		const value = buildBindings(koffi);
		cached = { ok: true, value };
		return value;
	} catch (error) {
		cached = { ok: false, reason: `初始化 ShellExecuteExW 绑定失败：${error && error.message ? error.message : String(error)}` };
		return null;
	}
}

/**
 * 取绑定不可用的原因（供调用方给出可读报错）。
 *
 * @returns {string|null}
 */
export function shellExecUnavailableReason() {
	getBindings();
	return cached !== null && cached.ok === false ? cached.reason : null;
}

/** 按 Windows 命令行规则给参数加引号（只在必要时）。 */
function quoteArgument(value) {
	const text = String(value);
	if (text !== "" && !/[\s"]/.test(text)) return text;
	// 转义规则：内部引号前加反斜杠；结尾若有反斜杠要加倍，否则会吃掉收尾引号
	let out = '"';
	let backslashes = 0;
	for (const ch of text) {
		if (ch === "\\") {
			backslashes += 1;
			out += ch;
			continue;
		}
		if (ch === '"') {
			out += "\\".repeat(backslashes) + '\\"';
			backslashes = 0;
			continue;
		}
		backslashes = 0;
		out += ch;
	}
	out += "\\".repeat(backslashes) + '"';
	return out;
}

/**
 * 以管理员身份启动一个进程，并**等它结束**。
 *
 * 与 `Start-Process` 不同，这里用 `SEE_MASK_NOCLOSEPROCESS` 拿到进程句柄，
 * 因此可以**真的等到退出并取到退出码** —— 这正是早先"退出码 0 却什么都没发生"
 * 无法分辨的地方。
 *
 * @param {{ file: string, args?: string[], verb?: string, show?: number, timeoutMs?: number }} options
 * @returns {{ pid: number|null, exitCode: number, timedOut: boolean }} 进程结果
 * @throws {Error} 提权被取消（用户在 UAC 点「否」）或启动失败
 */
export function shellExecuteRunAs(options) {
	const bindings = getBindings();
	if (bindings === null) {
		throw new Error(shellExecUnavailableReason() ?? "ShellExecuteExW 绑定不可用");
	}
	const { koffi, SHELLEXECUTEINFOW, size, ShellExecuteExW, WaitForSingleObject, GetExitCodeProcess, CloseHandle } = bindings;

	/** 持有字符串缓冲区的引用，保证它们在 Win32 读之前不被 GC 回收。 */
	const keepAlive = [];

	// 命令行：可执行文件 + 已加引号的参数
	const commandLine = [quoteArgument(options.file), ...(options.args ?? []).map(quoteArgument)].join(" ");
	// lpFile 传可执行文件路径、lpParameters 传参数（比整条命令行更不容易出错）
	const verb = options.verb ?? "runas";
	const show = options.show ?? 0; // SW_HIDE

	// ⚠️ **字符串字段必须显式分配 UTF-16 缓冲区**，不能直接赋 JS 字符串。
	//
	// 这是实测踩出来的：结构体里 `lpVerb`/`lpFile`/`lpParameters` 声明为 `void *`，
	// 我一开始直接赋 JS 字符串，koffi 把它当**指针值**处理，Win32 于是读到垃圾内存 ——
	// 表现为弹窗
	//   `Windows 找不到文件 '揲停稍牧浄极汩瀲渼拏楽凞潮数据敷'`
	// （乱码文件名就是那段垃圾内存）。所以这里逐个分配 NUL 结尾的 UTF-16 缓冲。
	const utf16 = (text) => {
		const buf = Buffer.from(`${text}\0`, "utf16le");
		// 必须持有引用，否则可能在 Win32 读之前被 GC 回收
		keepAlive.push(buf);
		return buf;
	};

	const lpVerb = utf16(verb);
	const lpFile = utf16(options.file);
	const lpParameters = utf16((options.args ?? []).map(quoteArgument).join(" "));
	const lpDirectory = options.directory === undefined ? null : utf16(options.directory);

	const info = koffi.alloc(SHELLEXECUTEINFOW, 1);
	// 清零：未用字段保持 0，避免把垃圾当指针传进 Win32
	koffi.encode(info, SHELLEXECUTEINFOW, {
		cbSize: size,
		// 只用 `SEE_MASK_NOCLOSEPROCESS(0x40)`：它让 ShellExecuteExW 把新进程的句柄
		// 放进 `hProcess`，我们据此等待并取退出码。
		//
		// ⚠️ 早先还加了 `SEE_MASK_NOASYNC(0x100)`，结果**连非提权调用都直接失败**
		// （`hInstApp=0`）。原因是 NOASYNC 要求调用线程有消息泵、并且
		// `CoInitialize` 过 —— 而 Node 主线程两样都没有。实测排除。
		fMask: 0x40,
		hwnd: null,
		lpVerb,
		lpFile,
		lpParameters,
		lpDirectory: null,
		nShow: show,
		hInstApp: null,
		lpIDList: null,
		lpClass: null,
		hkeyClass: null,
		dwHotKey: 0,
		hMonitor: null,
		hProcess: null
	});

	const ok = ShellExecuteExW(info);
	if (ok !== true) {
		// 读回 hInstApp：Win32 用它表示失败原因（<= 32 都是错误码）
		let hInstApp = 0;
		try {
			hInstApp = Number(koffi.decode(info, SHELLEXECUTEINFOW).hInstApp ?? 0);
		} catch {
			/* 读不到就用通用报错 */
		}
		if (hInstApp === 5) throw new Error("提权被取消：你在 UAC 弹窗里点了「否」（或没有权限）。");
		throw new Error(`ShellExecuteExW 启动失败（hInstApp=${hInstApp}）。常见原因：UAC 被拒绝、被安全软件拦截。`);
	}

	const decoded = koffi.decode(info, SHELLEXECUTEINFOW);
	const handle = decoded.hProcess;
	if (handle === null || handle === undefined) {
		throw new Error("ShellExecuteExW 成功但没有返回进程句柄（缺少 SEE_MASK_NOCLOSEPROCESS？）");
	}

	const timeoutMs = options.timeoutMs ?? 30000;
	const waitResult = WaitForSingleObject(handle, timeoutMs);
	// `GetExitCodeProcess` 的第二个参数是**输出**指针。不同 koffi 版本对
	// "用数组接收 out 参数"的支持不一致（早先传 `[0]` 拿到的一直是 0），
	// 所以这里显式分配一块 uint32 缓冲区再读回，行为确定。
	const codeBuf = koffi.alloc("uint32", 1);
	koffi.encode(codeBuf, "uint32", 0);
	const gotCode = GetExitCodeProcess(handle, codeBuf);
	const code = gotCode === true ? Number(koffi.decode(codeBuf, "uint32")) : 0;
	CloseHandle(handle);

	return { pid: null, exitCode: code, timedOut: waitResult === 0x102 /* WAIT_TIMEOUT */ };
}
