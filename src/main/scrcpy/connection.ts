/** 支持精确读取的异步 Socket 字节游标。 */
export class SocketCursor {
  /** 底层异步迭代器。 */
  private readonly iterator: AsyncIterator<Uint8Array>;
  /** 尚未消费的字节。 */
  private buffer = Buffer.alloc(0);

  /** 创建异步字节游标。 */
  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  /** 精确读取指定字节数。 */
  async readExactly(length: number): Promise<Buffer> {
    while (this.buffer.length < length) {
      /** 底层流的下一块数据。 */
      const next = await this.iterator.next();
      if (next.done) {
        throw new Error("scrcpy 连接提前结束");
      }
      this.buffer = Buffer.concat([this.buffer, Buffer.from(next.value)]);
    }

    /** 本次读取结果。 */
    const result = Buffer.from(this.buffer.subarray(0, length));
    this.buffer = this.buffer.subarray(length);
    return result;
  }

  /** 按原始分片依次返回剩余字节。 */
  async *remaining(): AsyncGenerator<Buffer> {
    if (this.buffer.length) {
      yield Buffer.from(this.buffer);
      this.buffer = Buffer.alloc(0);
    }

    for (;;) {
      /** 底层流的下一块数据。 */
      const next = await this.iterator.next();
      if (next.done) {
        return;
      }
      yield Buffer.from(next.value);
    }
  }
}

/** 读取 forward 首连接的 dummy byte，确认设备 Socket 已就绪。 */
export async function readScrcpyDummyByte(cursor: SocketCursor): Promise<void> {
  /** 用于确认设备端服务已就绪的字节。 */
  const dummy = await cursor.readExactly(1);
  if (dummy[0] !== 0) {
    throw new Error("scrcpy 握手字节无效");
  }
}

/** 读取 scrcpy 固定长度设备名称。 */
export async function readScrcpyDeviceName(
  cursor: SocketCursor
): Promise<string> {
  /** 设备名称固定字段。 */
  const metadata = await cursor.readExactly(64);
  /** 字符串终止位置。 */
  const terminator = metadata.indexOf(0);
  return metadata
    .subarray(0, terminator >= 0 ? terminator : metadata.length)
    .toString("utf8");
}

/** 连续读取 dummy byte 与设备名称。 */
export async function readScrcpyHandshake(
  cursor: SocketCursor
): Promise<string> {
  await readScrcpyDummyByte(cursor);
  return readScrcpyDeviceName(cursor);
}
