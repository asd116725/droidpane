/** @jest-environment node */

import { Readable } from "node:stream";
import {
  SocketCursor,
  readScrcpyHandshake
} from "../../src/main/scrcpy/connection";

describe("scrcpy Socket 连接", () => {
  it("跨分片读取 dummy byte、设备名并保留后续媒体字节", async () => {
    /** 固定长度设备信息。 */
    const metadata = Buffer.alloc(64);
    metadata.write("Android Device", "utf8");
    /** 紧随握手数据后的 H.264 Codec ID。 */
    const codec = Buffer.from([0x68, 0x32, 0x36, 0x34]);
    /** 模拟任意网络分片。 */
    const stream = Readable.from([
      Buffer.concat([Buffer.from([0]), metadata.subarray(0, 5)]),
      metadata.subarray(5, 43),
      Buffer.concat([metadata.subarray(43), codec])
    ]);
    /** 流式字节读取器。 */
    const cursor = new SocketCursor(stream);

    await expect(readScrcpyHandshake(cursor)).resolves.toBe("Android Device");

    /** 握手后的剩余字节。 */
    const remaining: Buffer[] = [];
    for await (const chunk of cursor.remaining()) {
      remaining.push(chunk);
    }
    expect(Buffer.concat(remaining)).toEqual(codec);
  });

  it("连接提前结束时返回明确错误", async () => {
    /** 只有 dummy byte 的不完整连接。 */
    const cursor = new SocketCursor(Readable.from([Buffer.from([0])]));

    await expect(readScrcpyHandshake(cursor)).rejects.toThrow(
      "scrcpy 连接提前结束"
    );
  });
});
