/**
 * 协议测试用的小包装。
 *
 * 刻意**直接复用生产代码**的 `encodeRequest` / `FrameReader`，
 * 而不是在测试里另写一份帧处理 —— 那样测的是复制品，协议改了测试也不会发现。
 */
import { encodeRequest, FrameReader } from "../../lib/protocol.js";

/** 把一次请求编成若干帧（数组里通常只有一帧，保留数组便于将来测粘包）。 */
export function encodeFrames(request, payload = Buffer.alloc(0)) {
	return [encodeRequest(request, payload)];
}

/** 把一段字节喂进解帧器，返回本次解出的所有帧。 */
export function decodeFrames(chunk) {
	const reader = new FrameReader();
	return reader.push(chunk);
}
