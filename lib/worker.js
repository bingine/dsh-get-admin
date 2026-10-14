/**
 * 远程后端的 socket worker —— 「把异步通道伪装成同步调用」的关键一半。
 *
 * ## 为什么必须这么绕
 *
 * 内核的 `ScanSession` / `PointerScanner` / `AutoAssembler` 内部调用 `Process` 的**同步**方法，
 * 而 `Process` 的同步方法遇到返回 Promise 的后端会直接抛错（`win/process.ts` 的 `syncResult`）。
 * 所以远程后端**必须在 JS 侧同步返回**，否则扫描/汇编全部失效。
 *
 * 同一线程里同步等 socket 是做不到的（内核文档里那两份最小复现证明了：`Atomics.wait` 会把
 * 本线程的事件循环一起冻住，socket 回调永远不执行）。但把 socket 放到**独立 worker** 里就可以：
 *
 *   - 主线程：`postMessage` 发出请求 → `Atomics.wait` 阻塞自己等结果；
 *   - worker 线程：事件循环是活的，收到请求 → 异步 socket 往返 → 把结果写进
 *     `SharedArrayBuffer` → `Atomics.notify` 唤醒主线程。
 *
 * worker **自己从不阻塞**，这正是内核文档里两次失败尝试踩的坑（它们的 worker 也在
 * `Atomics.wait`，于是 worker 的 socket 回调同样被冻住）。
 *
 * 代价要讲清楚：主线程每次内存操作都会**真的阻塞**。这与现有 `SelfBackend` 的行为一致
 * （扫描本来就会阻塞宿主），但意味着走远程后端时 DSH 主循环在扫描期间是不响应的。
 *
 * @module dsh-cheat-engine/remote/worker
 */
import net from "node:net";
import { parentPort, workerData } from "node:worker_threads";

import { encodeRequest, FrameReader, toWire } from "./protocol.js";

const { control, data, host, port, connectTimeoutMs } = workerData;
const controlView = new Int32Array(control);
const dataView = new Uint8Array(data);

let socket = null;
let connected = false;
let reader = new FrameReader();
/** 当前在途请求（主线程一次只发一个）。 */
let inflight = null;
/** 连接建立前的待发帧。 */
const outbox = [];

/** 唤醒主线程：把结果写进共享区并置状态。 */
function wake(state, headerBytes, payloadBytes) {
	dataView.set(headerBytes, 0);
	Atomics.store(controlView, 1, headerBytes.length);
	Atomics.store(controlView, 2, payloadBytes.length);
	Atomics.store(controlView, 0, state);
	Atomics.notify(controlView, 0);
}

/** 以错误唤醒主线程。 */
function wakeWithError(id, message) {
	const header = Buffer.from(JSON.stringify({ id, ok: false, error: String(message) }), "utf8");
	wake(2, header, Buffer.alloc(0));
}

/** 建立连接；失败则把当前在途请求唤醒为错误。 */
function connect() {
	socket = net.connect({ host, port });
	socket.setNoDelay(true);
	socket.setTimeout(connectTimeoutMs);

	socket.on("connect", () => {
		connected = true;
		while (outbox.length > 0) socket.write(outbox.shift());
	});

	socket.on("data", (chunk) => {
		let frames;
		try {
			frames = reader.push(chunk);
		} catch (error) {
			// 协议不同步：这条连接已经不可信，报错并重建
			if (inflight !== null) {
				wakeWithError(inflight.id, `助手响应解析失败：${error.message}`);
				inflight = null;
			}
			socket.destroy();
			return;
		}
		for (const { header, payload } of frames) {
			// 每个帧单独兜底：任何异常都必须自己唤醒主线程，
			// 否则一次编码/尺寸问题就会变成一次 60 秒的干等
			let current = null;
			try {
				if (inflight === null || header.id !== inflight.id) continue;
				current = inflight;
				inflight = null;
				if (header.ok !== true) {
					wakeWithError(current.id, header.error ?? "助手返回了未知错误");
					continue;
				}
				const headerBytes = Buffer.from(
					// 必须用 toWire：响应里带 bigint（模块/区域的 baseAddress 等），
					// 裸 JSON.stringify 会直接抛 "Do not know how to serialize a BigInt"
					//
					// ⚠️ 这里**绝不能**写 `header.result ?? null`。
					//
					// 早先就是这个 `?? null` 把「助手如实回答 `undefined`（= 我判断不了）」
					// **改写成了 `null`**，于是下面这条语义在通道里被彻底抹掉：
					// 助手的 `isProcessAlive` 在后端不支持时返回 `undefined`（"未知"），
					// 消费方（内核 `Process.isProcessAlive` / 会话层 `isTargetAlive`）用
					// **严格比较**区分 `false`（已退出）与 `undefined`（未知）——
					// 拿到 `null` 时两个分支都不命中，于是退回旧行为，产物是**误导性结论**：
					// `ce_read` 报「…但目标进程**仍在运行**」（与事实相反）。
					// 缺键与显式 null 必须保持可区分：JSON 里省略 `result` 键即得到
					// `undefined`，这正是我们要的，`?? null` 是画蛇添足。
					JSON.stringify(toWire({ id: current.id, ok: true, result: header.result })),
					"utf8"
				);
				if (payload.length > dataView.length - headerBytes.length) {
					wakeWithError(current.id, `响应体过大：${payload.length} 字节（共享区 ${dataView.length}）`);
					continue;
				}
				const payloadBytes = Buffer.from(payload);
				// 顺序不能反：**先把 header 与 payload 全部写进共享区，再置状态、最后 notify**。
				// 先 notify 再写数据会让主线程读到半截内容（这是本文件里最容易写错的一处）。
				dataView.set(headerBytes, 0);
				dataView.set(payloadBytes, headerBytes.length);
				Atomics.store(controlView, 1, headerBytes.length);
				Atomics.store(controlView, 2, payloadBytes.length);
				Atomics.store(controlView, 0, 1);
				Atomics.notify(controlView, 0);
			} catch (error) {
				wakeWithError(
					current === null ? (header.id ?? 0) : current.id,
					`worker 处理响应失败：${error && error.message ? error.message : String(error)}`
				);
			}
		}
	});

	const onBroken = (reason) => {
		connected = false;
		reader = new FrameReader();
		if (inflight !== null) {
			wakeWithError(inflight.id, `与助手的连接中断：${reason}`);
			inflight = null;
		}
	};
	socket.on("error", (error) => onBroken(error.message));
	socket.on("timeout", () => {
		onBroken("socket 超时");
		socket.destroy();
	});
	socket.on("close", () => {
		connected = false;
	});
}

parentPort.on("message", (message) => {
	// 整个处理过程都必须自我兜底：主线程此刻（或马上）会阻塞在 Atomics.wait 上，
	// 它**收不到** Worker 的 'error' 事件，所以这里一旦漏抛，调用方只能干等到超时。
	try {
		const { seq, request, payload } = message;
		inflight = { id: seq };
		const frame = encodeRequest(request, payload === undefined ? Buffer.alloc(0) : Buffer.from(payload));
		if (connected && socket !== null && socket.writable) {
			socket.write(frame);
		} else {
			// 连接还没就绪（或刚断）：排队，连上后立刻发。
			// 主线程此刻正阻塞在 Atomics.wait 上，所以这里的顺序就是唯一顺序。
			outbox.push(frame);
			if (socket === null) connect();
		}
	} catch (error) {
		inflight = null;
		wakeWithError(message?.seq ?? 0, error && error.message ? error.message : String(error));
	}
});

connect();
