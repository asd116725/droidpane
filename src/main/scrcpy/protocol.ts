/** scrcpy 媒体流类型。 */
export type ScrcpyStreamKind = "video" | "audio";

/** scrcpy 支持的录制 Codec。 */
export type ScrcpyCodec = "h264" | "aac";

/** scrcpy 4.1 数据违反固定协议。 */
export class ScrcpyProtocolError extends Error {
  /** 创建协议错误。 */
  constructor(message: string) {
    super(message);
    this.name = "ScrcpyProtocolError";
  }
}

/** scrcpy 媒体流在完整包之前结束。 */
export class ScrcpyStreamEndedError extends Error {
  /** 创建非完整媒体流错误。 */
  constructor(message: string) {
    super(message);
    this.name = "ScrcpyStreamEndedError";
  }
}

/** scrcpy 媒体数据包。 */
export interface ScrcpyMediaPacket {
  /** 事件类型。 */
  type: "packet";
  /** 展示时间戳，单位微秒；配置包固定为 0。 */
  ptsUs: number;
  /** 是否为 Codec 配置包。 */
  config: boolean;
  /** 是否为关键帧。 */
  keyFrame: boolean;
  /** Annex B H.264 或 AAC 原始数据。 */
  data: Buffer;
}

/** scrcpy 媒体流解析事件。 */
export type ScrcpyStreamEvent =
  | { type: "codec"; codec: ScrcpyCodec }
  | {
      type: "session";
      width: number;
      height: number;
      clientResized: boolean;
    }
  | ScrcpyMediaPacket
  | { type: "disabled" };

/** 合并配置后的可解码媒体包。 */
export interface MergedMediaPacket {
  /** 展示时间戳，单位微秒。 */
  ptsUs: number;
  /** 是否为关键帧。 */
  keyFrame: boolean;
  /** 包含最新 Codec 配置的媒体数据。 */
  data: Buffer;
}

/** scrcpy 帧头字节数。 */
const packetHeaderSize = 12;
/** 单个媒体包安全上限。 */
const maxPacketSize = 16 * 1024 * 1024;
/** 配置包标记。 */
const configFlag = 1n << 62n;
/** 关键帧标记。 */
const keyFrameFlag = 1n << 61n;
/** PTS 位掩码。 */
const ptsMask = keyFrameFlag - 1n;
/** Codec ID 对应表。 */
const codecMap = new Map<number, ScrcpyCodec>([
  [0x68323634, "h264"],
  [0x00616163, "aac"]
]);

/** 增量解析 scrcpy 4.1 媒体流。 */
export class ScrcpyPacketParser {
  /** 尚未解析的字节。 */
  private buffer = Buffer.alloc(0);
  /** 是否已经读取 Codec ID。 */
  private codecRead = false;
  /** 等待数据体的包信息。 */
  private pending?: Omit<ScrcpyMediaPacket, "data"> & { size: number };

  /** 创建指定媒体类型的解析器。 */
  constructor(private readonly kind: ScrcpyStreamKind) {}

  /** 追加字节并返回本次完整事件。 */
  push(chunk: Uint8Array): ScrcpyStreamEvent[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    /** 本次解析出的事件。 */
    const events: ScrcpyStreamEvent[] = [];

    while (this.parseNext(events)) {
      // 持续消费当前缓冲区中的完整数据。
    }

    return events;
  }

  /** 流结束时确认没有被截断的 Codec、帧头或包体。 */
  finish(): void {
    if (!this.codecRead || this.pending || this.buffer.length) {
      throw new ScrcpyStreamEndedError(
        `scrcpy ${this.kind} 媒体流在完整包之前结束`
      );
    }
  }

  /** 尝试解析一个 Codec、会话或媒体包。 */
  private parseNext(events: ScrcpyStreamEvent[]): boolean {
    if (!this.codecRead) {
      if (this.buffer.length < 4) {
        return false;
      }

      /** 服务端声明的 Codec ID。 */
      const codecId = this.buffer.readUInt32BE(0);
      this.consume(4);
      this.codecRead = true;

      if (codecId === 0) {
        events.push({ type: "disabled" });
        return this.buffer.length > 0;
      }

      /** 已知 Codec。 */
      const codec = codecMap.get(codecId);
      if (!codec || (this.kind === "video" ? codec !== "h264" : codec !== "aac")) {
        throw new ScrcpyProtocolError(
          `不支持的 scrcpy ${this.kind} Codec：0x${codecId.toString(16)}`
        );
      }

      events.push({ type: "codec", codec });
      return true;
    }

    if (this.pending) {
      if (this.buffer.length < this.pending.size) {
        return false;
      }

      /** 当前媒体包数据。 */
      const data = Buffer.from(this.buffer.subarray(0, this.pending.size));
      events.push({
        type: "packet",
        ptsUs: this.pending.ptsUs,
        config: this.pending.config,
        keyFrame: this.pending.keyFrame,
        data
      });
      this.consume(this.pending.size);
      this.pending = undefined;
      return true;
    }

    if (this.buffer.length < packetHeaderSize) {
      return false;
    }

    /** 当前 12 字节帧头。 */
    const header = this.buffer.subarray(0, packetHeaderSize);
    if (this.kind === "video" && (header[0] & 0x80) !== 0) {
      events.push({
        type: "session",
        width: header.readUInt32BE(4),
        height: header.readUInt32BE(8),
        clientResized: (header[3] & 1) === 1
      });
      this.consume(packetHeaderSize);
      return true;
    }

    /** 带标记的媒体 PTS。 */
    const ptsFlags = header.readBigUInt64BE(0);
    /** 媒体数据长度。 */
    const size = header.readUInt32BE(8);
    if (size > maxPacketSize) {
      throw new ScrcpyProtocolError(
        `scrcpy 媒体包超过 ${maxPacketSize} 字节`
      );
    }
    if (size === 0) {
      throw new ScrcpyProtocolError("scrcpy 媒体包长度不能为 0");
    }

    this.pending = {
      type: "packet",
      ptsUs: Number(ptsFlags & ptsMask),
      config: (ptsFlags & configFlag) !== 0n,
      keyFrame: (ptsFlags & keyFrameFlag) !== 0n,
      size
    };
    this.consume(packetHeaderSize);
    return true;
  }

  /** 移除已解析字节。 */
  private consume(length: number): void {
    this.buffer = this.buffer.subarray(length);
  }
}

/** 把 Codec 配置附加到下一帧，匹配 scrcpy 录制行为。 */
export class ConfigPacketMerger {
  /** 等待附加的配置数据。 */
  private config?: Buffer;

  /** 接收一个协议包并在媒体帧就绪时返回。 */
  push(packet: ScrcpyMediaPacket): MergedMediaPacket | undefined {
    if (packet.config) {
      this.config = this.config
        ? Buffer.concat([this.config, packet.data])
        : Buffer.from(packet.data);
      return undefined;
    }

    /** 合并后的媒体数据。 */
    const data = this.config
      ? Buffer.concat([this.config, packet.data])
      : Buffer.from(packet.data);
    this.config = undefined;
    return {
      ptsUs: packet.ptsUs,
      keyFrame: packet.keyFrame,
      data
    };
  }
}
