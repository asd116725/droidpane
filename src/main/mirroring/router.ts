import { parseAacConfig } from "../../shared/codecs";
import type { MergedMediaPacket, ScrcpyStreamEvent } from "../scrcpy/protocol";
import type {
  LiveAudioPacket,
  LiveVideoSession
} from "../recording/muxer";
import { parseAvcCodecString } from "../recording/muxer";
import type { RecordingMuxer } from "../recording/service";

/** 镜像媒体路由所需的实时预览发布器。 */
export interface MirrorPreviewPublisher {
  /** 发布视频尺寸。 */
  publishSession(session: LiveVideoSession): void;
  /** 发布 H.264 配置。 */
  publishConfig(data: Buffer, codec: string): void;
  /** 发布实时视频包。 */
  publishPacket(packet: MergedMediaPacket): void;
  /** 发布 AAC 解码配置。 */
  publishAudioConfig(
    data: Buffer,
    config: ReturnType<typeof parseAacConfig>
  ): void;
  /** 发布 AAC 编码包。 */
  publishAudioPacket(packet: LiveAudioPacket): void;
}

/** 正在等待关键帧或已挂载的录制接收器。 */
interface AttachedRecorder {
  /** 本次 MP4 封装器。 */
  muxer: RecordingMuxer;
  /** 当前挂载阶段。 */
  phase: "waiting" | "priming" | "active";
  /** 首帧就绪回调。 */
  resolve(ptsUs: number): void;
  /** 会话提前结束回调。 */
  reject(error: Error): void;
}

/** 将单个 scrcpy 媒体会话分发给预览和可选录制器。 */
export class ScrcpyMediaRouter {
  /** 当前视频尺寸。 */
  private videoSession?: LiveVideoSession;
  /** 最近一组完整 H.264 配置。 */
  private videoConfig?: Buffer;
  /** 等待附加到下一视频帧的配置片段。 */
  private pendingVideoConfig?: Buffer;
  /** 最近一组 AAC 配置。 */
  private audioConfig?: Buffer;
  /** 设备端是否已关闭音频。 */
  private audioDisabled = false;
  /** 当前可选录制器。 */
  private recorder?: AttachedRecorder;

  /** 创建面向固定预览发布器的媒体路由。 */
  constructor(
    private readonly preview: MirrorPreviewPublisher,
    private readonly onAudioDisabled: () => void = () => undefined,
    private readonly onVideoPacket: () => void = () => undefined
  ) {}

  /** 当前是否已经挂载录制器。 */
  hasRecorder(): boolean {
    return Boolean(this.recorder);
  }

  /** 在下一关键帧挂载录制器并返回真实首帧 PTS。 */
  attachRecorder(muxer: RecordingMuxer): Promise<number> {
    if (this.recorder) {
      throw new Error("当前已有录制任务");
    }

    return new Promise((resolve, reject) => {
      this.recorder = {
        muxer,
        phase: "waiting",
        resolve,
        reject
      };
    });
  }

  /** 摘除指定录制器，后续媒体只继续用于镜像。 */
  detachRecorder(muxer: RecordingMuxer): void {
    if (this.recorder?.muxer === muxer) {
      if (this.recorder.phase !== "active") {
        this.recorder.reject(new Error("录制启动已取消"));
      }
      this.recorder = undefined;
    }
  }

  /** 顺序处理一条视频协议事件。 */
  async handleVideoEvent(event: ScrcpyStreamEvent): Promise<void> {
    if (event.type === "session") {
      this.videoSession = { width: event.width, height: event.height };
      this.preview.publishSession(this.videoSession);
      if (this.recorder?.phase === "active") {
        await this.recorder.muxer.handleVideoEvent(event);
      }
      return;
    }
    if (event.type !== "packet") {
      return;
    }
    if (event.config) {
      this.pendingVideoConfig = this.pendingVideoConfig
        ? Buffer.concat([this.pendingVideoConfig, event.data])
        : Buffer.from(event.data);
      if (this.recorder?.phase === "active") {
        await this.recorder.muxer.handleVideoEvent(event);
      }
      return;
    }

    this.onVideoPacket();

    if (this.pendingVideoConfig) {
      this.videoConfig = this.pendingVideoConfig;
      this.pendingVideoConfig = undefined;
      this.preview.publishConfig(
        this.videoConfig,
        parseAvcCodecString(this.videoConfig)
      );
    }
    this.preview.publishPacket({
      ptsUs: event.ptsUs,
      keyFrame: event.keyFrame,
      data: Buffer.from(event.data)
    });

    /** 当前等待或活跃的录制器。 */
    const recorder = this.recorder;
    if (!recorder) {
      return;
    }
    if (recorder.phase === "active") {
      await recorder.muxer.handleVideoEvent(event);
      return;
    }
    if (
      recorder.phase !== "waiting" ||
      !event.keyFrame ||
      !this.videoSession ||
      !this.videoConfig
    ) {
      return;
    }

    recorder.phase = "priming";
    await recorder.muxer.handleVideoEvent({
      type: "session",
      width: this.videoSession.width,
      height: this.videoSession.height,
      clientResized: false
    });
    await recorder.muxer.handleVideoEvent({
      type: "packet",
      ptsUs: 0,
      config: true,
      keyFrame: false,
      data: Buffer.from(this.videoConfig)
    });
    if (this.audioDisabled) {
      await recorder.muxer.handleAudioEvent({ type: "disabled" });
    } else if (this.audioConfig) {
      await recorder.muxer.handleAudioEvent({
        type: "packet",
        ptsUs: 0,
        config: true,
        keyFrame: false,
        data: Buffer.from(this.audioConfig)
      });
    }
    await recorder.muxer.handleVideoEvent(event);
    recorder.phase = "active";
    recorder.resolve(event.ptsUs);
  }

  /** 顺序处理一条音频协议事件。 */
  async handleAudioEvent(event: ScrcpyStreamEvent): Promise<void> {
    if (event.type === "disabled") {
      this.audioDisabled = true;
      this.onAudioDisabled();
    } else if (event.type === "packet" && event.config) {
      this.audioConfig = Buffer.from(event.data);
      try {
        this.preview.publishAudioConfig(
          this.audioConfig,
          parseAacConfig(this.audioConfig)
        );
      } catch {
        // 预览监听异常不影响镜像视频或后续录制降级。
      }
    } else if (event.type === "packet") {
      this.preview.publishAudioPacket({
        ptsUs: event.ptsUs,
        data: Buffer.from(event.data)
      });
    }

    if (this.recorder?.phase === "active") {
      await this.recorder.muxer.handleAudioEvent(event);
    }
  }

  /** 会话结束时拒绝尚未等到关键帧的录制请求。 */
  end(error?: Error): void {
    if (this.recorder?.phase !== "active") {
      this.recorder?.reject(error ?? new Error("镜像会话已结束"));
    }
    this.recorder = undefined;
  }
}
