/**
 * 提权助手 ↔ 远程后端 的帧协议。
 *
 * 帧格式（两个方向一致）：
 *
 * ```
 * [4 字节 totalLen (LE)][4 字节 headerLen (LE)][header JSON (UTF-8)][payload 原始字节]
 * totalLen = 4 + headerLen + payload.length
 * ```
 *
 * - `header` 是 JSON，带 `id` / `method` / `params` 或 `ok` / `error`；
 * - 大体积数据（读到的内存）走 `payload` 原始字节，**不做 base64**，避免 33% 膨胀与额外拷贝；
 * - `bigint` 不能进 JSON，统一经 `toWire`/`fromWire` 转成 `{"$bigint":"..."}`。
 *
 * 为什么不用现成的 RPC 库：这条通道只在「同机、单向、单请求/响应、需要把大块内存搬回来」
 * 的场景下用，自己写 30 行帧处理比引入依赖更可控，也更容易在出问题时看清字节。
 *
 * @module dsh-cheat-engine/remote/protocol
 */

/** 单帧上限：扫描分块默认 4MB，留足余量后仍然拒绝异常大的帧。 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const BIGINT_TAG = "$bigint";

/**
 * 把值转成可 JSON 化的形式（bigint → 带标记的字符串）。
 * @param {unknown} value 任意值
 * @returns {unknown} 可 JSON 化的值
 */
export function toWire(value) {
	if (typeof value === "bigint") return { [BIGINT_TAG]: value.toString() };
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map((item) => toWire(item));
	if (Buffer.isBuffer(value)) return { $buffer: value.toString("base64") };
	if (typeof value === "object") {
		const out = {};
		for (const [key, item] of Object.entries(value)) out[key] = toWire(item);
		return out;
	}
	return value;
}

/**
 * 把 JSON 化后的值还原（bigint 复原）。
 * @param {unknown} value 来自 JSON 的值
 * @returns {unknown} 还原后的值
 */
export function fromWire(value) {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) return value.map((item) => fromWire(item));
	if (typeof value === "object") {
		if (typeof value[BIGINT_TAG] === "string") return BigInt(value[BIGINT_TAG]);
		if (typeof value.$buffer === "string") return Buffer.from(value.$buffer, "base64");
		const out = {};
		for (const [key, item] of Object.entries(value)) out[key] = fromWire(item);
		return out;
	}
	return value;
}

/**
 * 编码一个请求帧（与响应帧同布局，便于复用同一个解帧器）。
 * @param {{ id: number, method: string, params?: object, token?: string }} request 请求头
 * @param {Buffer} [payload] 原始字节（写内存时携带数据）
 * @returns {Buffer} 帧
 */
export function encodeRequest(request, payload = Buffer.alloc(0)) {
	const headerBytes = Buffer.from(JSON.stringify(toWire(request)), "utf8");
	const total = 4 + headerBytes.length + payload.length;
	if (total > MAX_FRAME_BYTES) throw new Error(`请求帧过大：${total} 字节`);
	const frame = Buffer.allocUnsafe(8 + headerBytes.length + payload.length);
	frame.writeUInt32LE(total, 0);
	frame.writeUInt32LE(headerBytes.length, 4);
	headerBytes.copy(frame, 8);
	payload.copy(frame, 8 + headerBytes.length);
	return frame;
}

/**
 * 编码一个响应帧。
 * @param {object} header 响应头（`{ id, ok: true, result }` 或 `{ id, ok: false, error }`）
 * @param {Buffer} [payload] 原始字节
 * @returns {Buffer} 帧
 */
export function encodeResponse(header, payload = Buffer.alloc(0)) {
	const headerBytes = Buffer.from(JSON.stringify(toWire(header)), "utf8");
	const total = 4 + headerBytes.length + payload.length;
	if (total > MAX_FRAME_BYTES) throw new Error(`响应帧过大：${total} 字节`);
	const frame = Buffer.allocUnsafe(8 + headerBytes.length + payload.length);
	frame.writeUInt32LE(total, 0);
	frame.writeUInt32LE(headerBytes.length, 4);
	headerBytes.copy(frame, 8);
	payload.copy(frame, 8 + headerBytes.length);
	return frame;
}

/**
 * 增量解帧器：TCP 是字节流，一帧可能跨多个 chunk。
 */
export class FrameReader {
	constructor() {
		this.buffer = Buffer.alloc(0);
	}

	/**
	 * 喂入数据，返回本次能解析出的完整帧。
	 * @param {Buffer} chunk 新到的字节
	 * @returns {Array<{ header: object, payload: Buffer }>} 解析出的帧
	 */
	push(chunk) {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		const frames = [];
		for (;;) {
			if (this.buffer.length < 8) break;
			const total = this.buffer.readUInt32LE(0);
			if (total < 4 || total > MAX_FRAME_BYTES) {
				throw new Error(`帧长度非法：${total}（协议不同步或对端不是本插件的助手）`);
			}
			const frameLength = 4 + total; // totalLen 本身那 4 字节不算在 total 里
			if (this.buffer.length < frameLength) break;
			const headerLength = this.buffer.readUInt32LE(4);
			const headerStart = 8;
			const headerEnd = headerStart + headerLength;
			if (headerLength > total || headerEnd > frameLength) {
				throw new Error(`帧头长度非法：${headerLength}（total=${total}）`);
			}
			const header = JSON.parse(this.buffer.toString("utf8", headerStart, headerEnd));
			const payload = this.buffer.subarray(headerEnd, frameLength);
			frames.push({ header: fromWire(header), payload: Buffer.from(payload) });
			this.buffer = this.buffer.subarray(frameLength);
		}
		return frames;
	}
}
