/** @jest-environment node */

import {
  ConfigPacketMerger,
  ScrcpyPacketParser,
  type ScrcpyStreamEvent
} from "../../src/main/scrcpy/protocol";

/** 将无符号 64 位整数写为大端字节。 */
function uint64(value: bigint): Buffer {
  /** 编码后的 8 字节缓冲区。 */
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(value);
  return buffer;
}

/** 构造 scrcpy 媒体包。 */
function mediaPacket(
  ptsUs: bigint,
  data: number[],
  options: { config?: boolean; keyFrame?: boolean } = {}
): Buffer {
  /** PTS 与包标记。 */
  const ptsFlags =
    ptsUs |
    (options.config ? 1n << 62n : 0n) |
    (options.keyFrame ? 1n << 61n : 0n);
  /** 包长度。 */
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  return Buffer.concat([uint64(ptsFlags), size, Buffer.from(data)]);
}

/** 构造视频会话包。 */
function sessionPacket(width: number, height: number): Buffer {
  /** 会话包头。 */
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x80000000, 0);
  header.writeUInt32BE(width, 4);
  header.writeUInt32BE(height, 8);
  return header;
}

describe("scrcpy 4.1 媒体协议", () => {
  it("可从任意分片中解析 H.264、会话尺寸和关键帧", () => {
    /** H.264 Codec ID、会话包和视频帧。 */
    const stream = Buffer.concat([
      Buffer.from([0x68, 0x32, 0x36, 0x34]),
      sessionPacket(1080, 2400),
      mediaPacket(1_250_000n, [0, 0, 0, 1, 0x65], { keyFrame: true })
    ]);
    /** 视频流解析器。 */
    const parser = new ScrcpyPacketParser("video");
    /** 分片解析结果。 */
    const events: ScrcpyStreamEvent[] = [];

    [stream.subarray(0, 3), stream.subarray(3, 17), stream.subarray(17)].forEach(
      (chunk) => events.push(...parser.push(chunk))
    );

    expect(events).toEqual([
      { type: "codec", codec: "h264" },
      {
        type: "session",
        width: 1080,
        height: 2400,
        clientResized: false
      },
      {
        type: "packet",
        ptsUs: 1_250_000,
        config: false,
        keyFrame: true,
        data: Buffer.from([0, 0, 0, 1, 0x65])
      }
    ]);
  });

  it("把配置包拼接到下一媒体包并保留后续旋转配置", () => {
    /** 配置包合并器。 */
    const merger = new ConfigPacketMerger();

    expect(
      merger.push({
        type: "packet",
        ptsUs: 0,
        config: true,
        keyFrame: false,
        data: Buffer.from([0, 0, 0, 1, 0x67])
      })
    ).toBeUndefined();

    expect(
      merger.push({
        type: "packet",
        ptsUs: 2_000_000,
        config: false,
        keyFrame: true,
        data: Buffer.from([0, 0, 0, 1, 0x65])
      })
    ).toEqual({
      ptsUs: 2_000_000,
      keyFrame: true,
      data: Buffer.from([0, 0, 0, 1, 0x67, 0, 0, 0, 1, 0x65])
    });
  });

  it("识别设备显式禁用的音频流", () => {
    /** 音频流解析器。 */
    const parser = new ScrcpyPacketParser("audio");

    expect(parser.push(Buffer.alloc(4))).toEqual([{ type: "disabled" }]);
  });

  it("拒绝超过安全上限的媒体包", () => {
    /** H.264 Codec ID 与超长包头。 */
    const stream = Buffer.alloc(4 + 12 + 12);
    stream.writeUInt32BE(0x68323634, 0);
    stream.writeUInt32BE(0x80000000, 4);
    stream.writeUInt32BE(1080, 8);
    stream.writeUInt32BE(2400, 12);
    stream.writeUInt32BE(32 * 1024 * 1024, 24);

    expect(() => new ScrcpyPacketParser("video").push(stream)).toThrow(
      "scrcpy 媒体包超过 16777216 字节"
    );
  });

  it("流结束时拒绝未收完整的媒体包", () => {
    /** 仅包含 Codec 与半个帧头的流。 */
    const parser = new ScrcpyPacketParser("video");
    parser.push(
      Buffer.concat([
        Buffer.from([0x68, 0x32, 0x36, 0x34]),
        Buffer.alloc(6)
      ])
    );

    expect(() => parser.finish()).toThrow(
      "scrcpy video 媒体流在完整包之前结束"
    );
  });
});
