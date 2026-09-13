import {
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  FilePathTarget,
  Mp4OutputFormat,
  Output
} from "mediabunny";
import { unlink } from "node:fs/promises";
import { parseAacConfig, type AacConfig } from "../../shared/codecs";
import {
  ConfigPacketMerger,
  type MergedMediaPacket,
  type ScrcpyStreamEvent
} from "../scrcpy/protocol";

/** 实时预览所需的视频会话信息。 */
export interface LiveVideoSession {
  /** 画面宽度。 */
  width: number;
  /** 画面高度。 */
  height: number;
}

/** 实时监听使用的 AAC 编码包。 */
export interface LiveAudioPacket {
  /** 展示时间戳，单位微秒。 */
  ptsUs: number;
  /** 不带容器封装的 AAC 编码数据。 */
  data: Buffer;
}

/** MP4 封装过程回调。 */
export interface ScrcpyMp4MuxerCallbacks {
  /** 视频尺寸变化。 */
  onVideoSession?(session: LiveVideoSession): void;
  /** 收到新的 H.264 解码配置。 */
  onVideoConfig?(data: Buffer, codec: string): void;
  /** 收到可直接解码的 H.264 帧。 */
  onVideoPacket?(packet: MergedMediaPacket): void;
  /** 收到 AAC 解码配置。 */
  onAudioConfig?(data: Buffer, config: AacConfig): void;
  /** 收到 AAC 编码包。 */
  onAudioPacket?(packet: LiveAudioPacket): void;
  /** 设备端禁用音频。 */
  onAudioDisabled?(): void;
}

/** 等待写入的编码包。 */
interface PendingPacket {
  /** 媒体轨道。 */
  kind: "video" | "audio";
  /** 展示时间戳，单位微秒。 */
  ptsUs: number;
  /** 是否为关键帧。 */
  keyFrame: boolean;
  /** 原始编码数据。 */
  data: Buffer;
  /** 本包起效的视频解码配置。 */
  videoConfig?: Buffer;
  /** 本包对应的视频尺寸。 */
  videoSession?: LiveVideoSession;
}

/** 已建立时间基准的轨道包。 */
interface TimedPacket extends PendingPacket {
  /** 相对文件起点的时间戳，单位秒。 */
  timestamp: number;
}

/** 封装完成结果。 */
export interface MuxerResult {
  /** 最终是否写入音轨。 */
  hasAudio: boolean;
}

/** 等待设备首个音频包的最长时间。 */
const audioStartupTimeoutMilliseconds = 5_000;

/** 解析 Annex B H.264 配置中的 AVC Codec String。 */
export function parseAvcCodecString(data: Uint8Array): string {
  /** SPS NAL 单元。 */
  const sps = splitAnnexBNalus(data).find((nalu) => (nalu[0] & 0x1f) === 7);
  if (!sps || sps.length < 4) {
    throw new Error("H.264 配置中缺少有效 SPS");
  }

  /** profile、兼容标记和 level 的十六进制编码。 */
  const suffix = [sps[1], sps[2], sps[3]]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `avc1.${suffix}`;
}

export { parseAacConfig } from "../../shared/codecs";

/** 按起始码拆分 Annex B NAL 单元。 */
function splitAnnexBNalus(data: Uint8Array): Uint8Array[] {
  /** 所有起始码位置。 */
  const starts: Array<{ offset: number; size: number }> = [];
  for (let index = 0; index <= data.length - 3; index += 1) {
    if (data[index] !== 0 || data[index + 1] !== 0) {
      continue;
    }
    if (data[index + 2] === 1) {
      starts.push({ offset: index, size: 3 });
      index += 2;
    } else if (data[index + 2] === 0 && data[index + 3] === 1) {
      starts.push({ offset: index, size: 4 });
      index += 3;
    }
  }

  return starts.map((start, index) => {
    /** 当前 NAL 数据起点。 */
    const from = start.offset + start.size;
    /** 当前 NAL 数据终点。 */
    const to = starts[index + 1]?.offset ?? data.length;
    return data.subarray(from, to);
  });
}

/** 将 scrcpy 编码包直接封装为 H.264/AAC MP4。 */
export class ScrcpyMp4Muxer {
  /** 视频配置合并器。 */
  private readonly videoMerger = new ConfigPacketMerger();
  /** 顺序执行所有封装操作。 */
  private task = Promise.resolve();
  /** 尚未启动输出时暂存的媒体包。 */
  private readonly pendingPackets: PendingPacket[] = [];
  /** 当前视频尺寸。 */
  private videoSession?: LiveVideoSession;
  /** H.264 Codec 配置。 */
  private videoConfig?: Buffer;
  /** 等待附加到下一帧的 H.264 配置。 */
  private pendingVideoConfig?: Buffer;
  /** AAC AudioSpecificConfig。 */
  private audioConfig?: Buffer;
  /** 音频是否已被设备端关闭。 */
  private audioDisabled: boolean;
  /** Mediabunny 输出。 */
  private output?: Output<Mp4OutputFormat, FilePathTarget>;
  /** 视频编码包输入源。 */
  private videoSource?: EncodedVideoPacketSource;
  /** 音频编码包输入源。 */
  private audioSource?: EncodedAudioPacketSource;
  /** 文件时间戳起点。 */
  private ptsOriginUs?: number;
  /** 等待下一帧确定时长的视频包。 */
  private previousVideo?: TimedPacket;
  /** 等待下一帧确定时长的音频包。 */
  private previousAudio?: TimedPacket;
  /** 视频包序号。 */
  private videoSequence = 0;
  /** 音频包序号。 */
  private audioSequence = 0;
  /** 已写入的视频包数量。 */
  private videoPacketsWritten = 0;
  /** 已写入的音频包数量。 */
  private audioPacketsWritten = 0;
  /** 音频首包等待计时器。 */
  private audioStartupTimer?: NodeJS.Timeout;
  /** 首个封装错误，阻止后续媒体写入。 */
  private failure?: Error;

  /** 创建单文件 MP4 封装器。 */
  constructor(
    private readonly filePath: string,
    audioExpected: boolean,
    private readonly callbacks: ScrcpyMp4MuxerCallbacks = {}
  ) {
    this.audioDisabled = !audioExpected;
  }

  /** 顺序处理一条视频协议事件。 */
  handleVideoEvent(event: ScrcpyStreamEvent): Promise<void> {
    return this.enqueue(async () => {
      if (event.type === "session") {
        this.videoSession = { width: event.width, height: event.height };
        this.callbacks.onVideoSession?.(this.videoSession);
        return;
      }
      if (event.type !== "packet") {
        return;
      }
      if (event.config) {
        this.pendingVideoConfig = this.pendingVideoConfig
          ? Buffer.concat([this.pendingVideoConfig, event.data])
          : Buffer.from(event.data);
      }

      /** 附带最新 SPS/PPS 的视频帧。 */
      const packet = this.videoMerger.push(event);
      if (!packet) {
        return;
      }

      /** 本帧开始生效的 H.264 配置。 */
      const currentConfig = this.pendingVideoConfig;
      if (currentConfig) {
        this.videoConfig = currentConfig;
        this.pendingVideoConfig = undefined;
        this.callbacks.onVideoConfig?.(
          Buffer.from(currentConfig),
          parseAvcCodecString(currentConfig)
        );
      }

      this.callbacks.onVideoPacket?.({
        ptsUs: event.ptsUs,
        keyFrame: event.keyFrame,
        data: Buffer.from(event.data)
      });
      this.pendingPackets.push({
        kind: "video",
        ptsUs: packet.ptsUs,
        keyFrame: packet.keyFrame,
        data: packet.data,
        videoConfig: currentConfig,
        videoSession: this.videoSession
      });
      this.startAudioFallbackTimer();
      await this.tryStart(false);
      await this.drainPackets();
    });
  }

  /** 顺序处理一条音频协议事件。 */
  handleAudioEvent(event: ScrcpyStreamEvent): Promise<void> {
    return this.enqueue(async () => {
      if (event.type === "disabled") {
        this.disableAudio();
        await this.tryStart(false);
        await this.drainPackets();
        return;
      }
      if (event.type !== "packet") {
        return;
      }
      if (event.config) {
        this.audioConfig = Buffer.from(event.data);
        try {
          this.callbacks.onAudioConfig?.(
            Buffer.from(event.data),
            parseAacConfig(event.data)
          );
        } catch {
          // 监听异常不得影响录制封装。
        }
        return;
      }

      try {
        this.callbacks.onAudioPacket?.({
          ptsUs: event.ptsUs,
          data: Buffer.from(event.data)
        });
      } catch {
        // 监听异常不得影响录制封装。
      }

      this.pendingPackets.push({
        kind: "audio",
        ptsUs: event.ptsUs,
        keyFrame: true,
        data: Buffer.from(event.data)
      });
      this.clearAudioFallbackTimer();
      await this.tryStart(false);
      await this.drainPackets();
    });
  }

  /** 写完最后两个轨道包并生成可播放 MP4。 */
  finalize(): Promise<MuxerResult> {
    this.clearAudioFallbackTimer();
    return this.enqueue(async () => {
      await this.tryStart(true);
      await this.drainPackets();

      if (!this.output || !this.videoSource || !this.previousVideo) {
        throw new Error("录制未收到可封装的视频帧");
      }

      await this.writeVideo(this.previousVideo, 0.1);
      this.previousVideo = undefined;
      if (this.previousAudio && this.audioSource && this.audioConfig) {
        /** AAC 单包默认持续时间。 */
        const { sampleRate } = parseAacConfig(this.audioConfig);
        await this.writeAudio(this.previousAudio, 1024 / sampleRate);
        this.previousAudio = undefined;
      }

      this.videoSource.close();
      this.audioSource?.close();
      await this.output.finalize();
      return { hasAudio: this.audioPacketsWritten > 0 };
    });
  }

  /** 取消输出并释放文件句柄。 */
  cancel(): Promise<void> {
    this.clearAudioFallbackTimer();
    return this.enqueue(async () => {
      if (this.output) {
        try {
          if (this.output.state !== "finalized") {
            await this.output.cancel();
          }
        } finally {
          await unlink(this.filePath).catch(() => undefined);
        }
      }
    }, true);
  }

  /** 把工作追加到唯一异步队列。 */
  private enqueue<T>(
    work: () => Promise<T>,
    allowAfterFailure = false
  ): Promise<T> {
    /** 本次顺序任务。 */
    const next = this.task.then(async () => {
      if (this.failure && !allowAfterFailure) {
        throw this.failure;
      }

      try {
        return await work();
      } catch (error) {
        this.failure ??=
          error instanceof Error ? error : new Error("MP4 封装失败");
        throw error;
      }
    });
    this.task = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /** 在媒体元数据与首包齐全后启动 MP4 输出。 */
  private async tryStart(forceSilent: boolean): Promise<void> {
    if (this.output || !this.videoSession || !this.videoConfig) {
      return;
    }

    /** 是否已经收到视频首帧。 */
    const hasVideo = this.pendingPackets.some(
      (packet) => packet.kind === "video"
    );
    /** 是否已经收到音频首包。 */
    const hasAudio = this.pendingPackets.some(
      (packet) => packet.kind === "audio"
    );
    if (!hasVideo) {
      return;
    }
    if (!this.audioDisabled && (!this.audioConfig || !hasAudio)) {
      if (!forceSilent) {
        return;
      }
      this.disableAudio();
    }

    /** MP4 视频包输入源。 */
    this.videoSource = new EncodedVideoPacketSource("avc");
    /** 是否创建 AAC 音轨。 */
    const includeAudio = !this.audioDisabled && Boolean(this.audioConfig);
    this.audioSource = includeAudio
      ? new EncodedAudioPacketSource("aac")
      : undefined;
    /** 直接写入最终文件的 MP4 输出。 */
    this.output = new Output({
      format: new Mp4OutputFormat({ fastStart: false }),
      target: new FilePathTarget(this.filePath)
    });
    this.output.addVideoTrack(this.videoSource);
    if (this.audioSource) {
      this.output.addAudioTrack(this.audioSource);
    }
    await this.output.start();

    /** 第一个视频 PTS。 */
    const firstVideoPts = this.pendingPackets.find(
      (packet) => packet.kind === "video"
    )?.ptsUs;
    /** 第一个音频 PTS。 */
    const firstAudioPts = this.pendingPackets.find(
      (packet) => packet.kind === "audio"
    )?.ptsUs;
    this.ptsOriginUs = this.audioSource
      ? Math.min(firstVideoPts as number, firstAudioPts as number)
      : (firstVideoPts as number);
  }

  /** 把已建立时间基准的暂存包写入对应轨道。 */
  private async drainPackets(): Promise<void> {
    if (!this.output || this.ptsOriginUs === undefined) {
      return;
    }

    while (this.pendingPackets.length) {
      /** 下一个媒体包。 */
      const packet = this.pendingPackets.shift() as PendingPacket;
      if (packet.kind === "audio" && !this.audioSource) {
        continue;
      }
      /** 归一化后的轨道包。 */
      const timed: TimedPacket = {
        ...packet,
        timestamp: Math.max(0, (packet.ptsUs - this.ptsOriginUs) / 1_000_000)
      };
      if (packet.kind === "video") {
        if (this.previousVideo) {
          await this.writeVideo(
            this.previousVideo,
            Math.max(0.000001, timed.timestamp - this.previousVideo.timestamp)
          );
        }
        this.previousVideo = timed;
      } else {
        if (this.previousAudio) {
          await this.writeAudio(
            this.previousAudio,
            Math.max(0.000001, timed.timestamp - this.previousAudio.timestamp)
          );
        }
        this.previousAudio = timed;
      }
    }
  }

  /** 写入一个已知时长的视频包。 */
  private async writeVideo(
    packet: TimedPacket,
    duration: number
  ): Promise<void> {
    if (!this.videoSource || !this.videoSession || !this.videoConfig) {
      return;
    }

    /** 首包所需解码配置。 */
    const config = packet.videoConfig ?? this.videoConfig;
    const session = packet.videoSession ?? this.videoSession;
    const metadata: EncodedVideoChunkMetadata | undefined =
      this.videoPacketsWritten === 0 || packet.videoConfig
        ? {
            decoderConfig: {
              codec: parseAvcCodecString(config),
              codedWidth: session.width,
              codedHeight: session.height
            }
          }
        : undefined;
    await this.videoSource.add(
      new EncodedPacket(
        packet.data,
        packet.keyFrame ? "key" : "delta",
        packet.timestamp,
        duration,
        this.videoSequence
      ),
      metadata
    );
    this.videoSequence += 1;
    this.videoPacketsWritten += 1;
  }

  /** 写入一个已知时长的 AAC 包。 */
  private async writeAudio(
    packet: TimedPacket,
    duration: number
  ): Promise<void> {
    if (!this.audioSource || !this.audioConfig) {
      return;
    }

    /** AAC 解码配置。 */
    const config = parseAacConfig(this.audioConfig);
    /** 首包所需解码配置。 */
    const metadata: EncodedAudioChunkMetadata | undefined =
      this.audioPacketsWritten === 0
        ? {
            decoderConfig: {
              codec: config.codec,
              numberOfChannels: config.numberOfChannels,
              sampleRate: config.sampleRate,
              description: this.audioConfig
            }
          }
        : undefined;
    await this.audioSource.add(
      new EncodedPacket(
        packet.data,
        "key",
        packet.timestamp,
        duration,
        this.audioSequence
      ),
      metadata
    );
    this.audioSequence += 1;
    this.audioPacketsWritten += 1;
  }

  /** 等待一秒仍无首个音频包时自动降级。 */
  private startAudioFallbackTimer(): void {
    if (
      this.audioDisabled ||
      this.audioStartupTimer ||
      this.pendingPackets.some((packet) => packet.kind === "audio")
    ) {
      return;
    }

    this.audioStartupTimer = setTimeout(() => {
      void this.enqueue(async () => {
        this.disableAudio();
        await this.tryStart(false);
        await this.drainPackets();
      }).catch(() => undefined);
    }, audioStartupTimeoutMilliseconds);
    this.audioStartupTimer.unref();
  }

  /** 清除音频首包等待计时器。 */
  private clearAudioFallbackTimer(): void {
    if (this.audioStartupTimer) {
      clearTimeout(this.audioStartupTimer);
      this.audioStartupTimer = undefined;
    }
  }

  /** 关闭本次音轨并通知录制状态。 */
  private disableAudio(): void {
    if (!this.audioDisabled) {
      this.audioDisabled = true;
      this.clearAudioFallbackTimer();
      this.callbacks.onAudioDisabled?.();
    }
  }
}
