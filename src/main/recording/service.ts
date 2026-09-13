import path from "node:path";
import { buildRecordingFileName } from "../../shared/formatters";
import type {
  DeviceInfo,
  MirrorState,
  RecordingArtifact,
  RecordingState
} from "../../shared/types";
import type { Mp4Metadata } from "../files/mp4";
import { FrameRateSampler } from "../media/frame-rate";
import type {
  MirrorRecordingContext,
  MirrorSessionEndEvent
} from "../mirroring/service";
import type { ScrcpyStreamEvent } from "../scrcpy/protocol";
import { ScrcpyProtocolError } from "../scrcpy/protocol";
import { resolveAudioPlan } from "./command";
import type {
  MuxerResult,
  ScrcpyMp4MuxerCallbacks
} from "./muxer";
import {
  createInitialRecordingState,
  transitionRecordingState
} from "./state";

/** 录制服务使用的 MP4 封装器。 */
export interface RecordingMuxer {
  /** 顺序处理视频协议事件。 */
  handleVideoEvent(event: ScrcpyStreamEvent): Promise<void>;
  /** 顺序处理音频协议事件。 */
  handleAudioEvent(event: ScrcpyStreamEvent): Promise<void>;
  /** 排空媒体包并完成 MP4。 */
  finalize(): Promise<MuxerResult>;
  /** 取消未完成输出。 */
  cancel(): Promise<void>;
}

/** 录制服务使用的统一镜像会话接口。 */
export interface RecordingMirrorSession {
  /** 获取当前可录制的镜像上下文。 */
  requireRecordingContext(): MirrorRecordingContext;
  /** 在下一关键帧挂载录制器。 */
  attachRecorder(muxer: RecordingMuxer): Promise<number>;
  /** 从持续媒体流中摘除录制器。 */
  detachRecorder(muxer: RecordingMuxer): void;
  /** 订阅镜像状态。 */
  onStateChanged(listener: (state: MirrorState) => void): () => void;
  /** 订阅媒体会话非预期结束。 */
  onSessionEnded(
    listener: (event: MirrorSessionEndEvent) => void
  ): () => void;
}

/** 录制服务外部依赖，便于平台适配与集成测试。 */
export interface RecordingServiceDependencies {
  /** 获取下一次录制使用的文件夹。 */
  getRecordingsDirectory(): string;
  /** 创建录制文件夹。 */
  ensureDirectory(directory: string): Promise<void>;
  /** 读取封装后的 MP4 信息。 */
  inspectFile(
    filePath: string
  ): Promise<Mp4Metadata & { sizeBytes: number }>;
  /** 注册完成文件并返回安全公开产物。 */
  registerArtifact(
    filePath: string,
    metadata: Mp4Metadata & { sizeBytes: number }
  ): Promise<RecordingArtifact>;
  /** 统一镜像、控制和媒体路由会话。 */
  mirroring: RecordingMirrorSession;
  /** 创建单文件无重编码封装器。 */
  createMuxer(
    filePath: string,
    audioExpected: boolean,
    callbacks: ScrcpyMp4MuxerCallbacks
  ): RecordingMuxer;
  /** 获取当前时间。 */
  now(): Date;
}

/** 当前活跃的 MP4 录制任务。 */
interface ActiveRecording {
  /** 目标设备。 */
  device: DeviceInfo;
  /** MP4 写入路径。 */
  filePath: string;
  /** H.264/AAC 直通封装器。 */
  muxer: RecordingMuxer;
  /** 是否已从关键帧正式挂载。 */
  attached: boolean;
  /** 实际录制帧率采样器。 */
  frameRate: FrameRateSampler;
  /** 媒体流异常。 */
  sessionError?: Error;
  /** 完成文件封装的共享任务。 */
  finalization?: Promise<RecordingState>;
}

/** 管理 MP4 录制器在持续镜像媒体流上的挂载生命周期。 */
export class RecordingService {
  /** 当前录制状态。 */
  private state = createInitialRecordingState();
  /** 当前活跃任务。 */
  private active?: ActiveRecording;
  /** 启动阶段是否已收到停止请求。 */
  private startCancellationRequested = false;
  /** 等待启动阶段完整收尾的任务。 */
  private startupCompletion?: Promise<void>;
  /** 最近一次完成产物。 */
  private artifact: RecordingArtifact | null = null;
  /** 状态订阅者。 */
  private readonly stateListeners = new Set<(state: RecordingState) => void>();
  /** 产物订阅者。 */
  private readonly artifactListeners = new Set<
    (artifact: RecordingArtifact | null) => void
  >();
  /** 录制计时器。 */
  private elapsedTimer?: NodeJS.Timeout;

  /** 创建录制服务并监听统一镜像会话。 */
  constructor(private readonly dependencies: RecordingServiceDependencies) {
    dependencies.mirroring.onStateChanged((state) =>
      this.syncAudioFallback(state)
    );
    dependencies.mirroring.onSessionEnded((event) =>
      this.handleMirrorSessionEnd(event)
    );
  }

  /** 获取不可变的当前状态快照。 */
  getState(): RecordingState {
    return { ...this.state };
  }

  /** 获取最近一次完成产物。 */
  getArtifact(): RecordingArtifact | null {
    return this.artifact ? { ...this.artifact } : null;
  }

  /** 订阅录制状态变化。 */
  onStateChanged(listener: (state: RecordingState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** 订阅录制产物变化。 */
  onArtifactChanged(
    listener: (artifact: RecordingArtifact | null) => void
  ): () => void {
    this.artifactListeners.add(listener);
    return () => this.artifactListeners.delete(listener);
  }

  /** 判断应用退出前是否需要结束录制。 */
  isBusy(): boolean {
    return ["starting", "recording", "stopping"].includes(this.state.status);
  }

  /** 开始当前镜像会话的单流 MP4 录制。 */
  async start(): Promise<RecordingState> {
    /** 当前显式镜像锁定的录制上下文。 */
    const context = this.dependencies.mirroring.requireRecordingContext();
    /** 当前镜像设备。 */
    const device = context.device;
    /** 当前镜像锁定预设。 */
    const preset = context.preset;

    this.startCancellationRequested = false;
    this.updateState({
      type: "START_REQUESTED",
      deviceSerial: device.serial
    });
    /** 标记本次启动流程完成。 */
    let completeStartup!: () => void;
    this.startupCompletion = new Promise((resolve) => {
      completeStartup = resolve;
    });
    this.clearArtifact();

    /** 本次已创建的封装器，启动失败时负责释放。 */
    let muxer: RecordingMuxer | undefined;
    /** 本次活跃任务。 */
    let active: ActiveRecording | undefined;

    try {
      /** 本次录制锁定使用的文件存储目录。 */
      const recordingsDirectory = this.dependencies.getRecordingsDirectory();
      await this.dependencies.ensureDirectory(recordingsDirectory);
      if (this.startCancellationRequested) {
        this.updateState({ type: "RESET" });
        return this.getState();
      }
      /** 输出文件路径。 */
      const filePath = path.join(
        recordingsDirectory,
        buildRecordingFileName(device.model, this.dependencies.now())
      );
      /** Android 版本对应的音频方案。 */
      const audioPlan = resolveAudioPlan(device, preset.audioMode);
      /** 最终是否期待录入设备音频。 */
      const audioExpected = audioPlan.enabled && !context.audioFallback;
      /** 当前音频降级原因。 */
      const fallbackReason =
        context.audioFallbackReason ?? audioPlan.fallbackReason;
      if (fallbackReason) {
        this.updateState({ type: "AUDIO_FALLBACK", reason: fallbackReason });
      }

      /** 实际录制帧率采样器。 */
      const frameRate = new FrameRateSampler(() =>
        this.dependencies.now().getTime()
      );
      muxer = this.dependencies.createMuxer(filePath, audioExpected, {
        onVideoPacket: () => frameRate.push()
      });
      active = {
        device,
        filePath,
        muxer,
        attached: false,
        frameRate
      };
      this.active = active;
      await this.dependencies.mirroring.attachRecorder(muxer);
      active.attached = true;
      active.frameRate.start();

      if (this.startCancellationRequested) {
        this.dependencies.mirroring.detachRecorder(muxer);
        return this.finalize(active);
      }

      this.updateState({
        type: "PROCESS_STARTED",
        startedAt: this.dependencies.now().getTime()
      });
      this.startElapsedTimer();
      return this.getState();
    } catch (error) {
      if (muxer) {
        this.dependencies.mirroring.detachRecorder(muxer);
        await muxer.cancel().catch(() => undefined);
      }
      if (this.active === active) {
        this.active = undefined;
      }
      if (this.startCancellationRequested) {
        this.updateState({ type: "RESET" });
        return this.getState();
      }

      /** 镜像或关键帧挂载失败说明。 */
      const sessionMessage = active?.sessionError?.message;
      /** 面向用户的启动错误。 */
      const message =
        sessionMessage ||
        (error instanceof Error ? error.message : "无法启动录制");
      this.fail(message);
      throw error;
    } finally {
      completeStartup();
      this.startupCompletion = undefined;
    }
  }

  /** 摘除录制器并完成 MP4，保持当前镜像继续运行。 */
  async stop(): Promise<RecordingState> {
    if (!this.active) {
      if (
        this.startupCompletion &&
        ["starting", "stopping"].includes(this.state.status)
      ) {
        this.startCancellationRequested = true;
        if (this.state.status === "starting") {
          this.updateState({ type: "STOP_REQUESTED" });
        }
        await this.startupCompletion;
      }
      return this.getState();
    }

    /** 当前活跃任务。 */
    const active = this.active;
    /** 停止请求是否发生在关键帧挂载前。 */
    const cancellingStartup = this.state.status === "starting";
    if (this.state.status !== "stopping") {
      this.updateState({ type: "STOP_REQUESTED" });
    }
    this.startCancellationRequested ||= cancellingStartup;
    this.dependencies.mirroring.detachRecorder(active.muxer);

    if (!active.attached && this.startupCompletion) {
      await this.startupCompletion;
      return this.getState();
    }

    return this.finalize(active);
  }

  /** 清空旧产物并同步渲染进程。 */
  private clearArtifact(): void {
    this.artifact = null;
    this.artifactListeners.forEach((listener) => listener(null));
  }

  /** 更新状态并通知渲染进程。 */
  private updateState(
    event: Parameters<typeof transitionRecordingState>[1]
  ): void {
    this.state = transitionRecordingState(this.state, event);
    this.stateListeners.forEach((listener) => listener(this.getState()));
  }

  /** 标记录制失败并停止计时。 */
  private fail(message: string): void {
    this.stopElapsedTimer();
    this.state = transitionRecordingState(this.state, {
      type: "FAILED",
      message
    });
    this.stateListeners.forEach((listener) => listener(this.getState()));
  }

  /** 镜像状态降级后同步录制音频提示。 */
  private syncAudioFallback(state: MirrorState): void {
    if (
      state.audioFallback &&
      !this.state.audioFallback &&
      ["starting", "recording"].includes(this.state.status)
    ) {
      this.updateState({
        type: "AUDIO_FALLBACK",
        reason: state.audioFallbackReason ?? "设备音频已自动降级为静音"
      });
    }
  }

  /** 媒体会话中断时尽力封装已经接收的媒体。 */
  private handleMirrorSessionEnd(event: MirrorSessionEndEvent): void {
    /** 对应当前录制的活跃任务。 */
    const active = this.active;
    if (
      !active ||
      active.device.serial !== event.deviceSerial ||
      !["starting", "recording"].includes(this.state.status)
    ) {
      return;
    }

    active.sessionError = event.error;
    if (!active.attached) {
      return;
    }
    this.updateState({ type: "STOP_REQUESTED" });
    void this.finalize(active);
  }

  /** 定时刷新录制时长。 */
  private startElapsedTimer(): void {
    this.stopElapsedTimer();
    this.elapsedTimer = setInterval(() => {
      /** 当前录制任务。 */
      const active = this.active;
      if (
        active &&
        this.state.startedAt &&
        this.state.status === "recording"
      ) {
        /** 本次采样时间。 */
        const now = this.dependencies.now().getTime();
        this.updateState({
          type: "TICK",
          elapsedMs: now - this.state.startedAt,
          fps: active.frameRate.sample()
        });
      }
    }, 500);
    this.elapsedTimer.unref();
  }

  /** 停止录制计时器。 */
  private stopElapsedTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = undefined;
    }
  }

  /** 复用同一个 MP4 最终封装任务。 */
  private finalize(active: ActiveRecording): Promise<RecordingState> {
    active.finalization ??= this.finalizeOnce(active);
    return active.finalization;
  }

  /** 排空编码包、写入 trailer 并发布安全产物。 */
  private async finalizeOnce(active: ActiveRecording): Promise<RecordingState> {
    this.stopElapsedTimer();

    try {
      if (active.sessionError instanceof ScrcpyProtocolError) {
        throw active.sessionError;
      }
      await active.muxer.finalize();
      /** MP4 元数据。 */
      const metadata = await this.dependencies.inspectFile(active.filePath);
      /** 公共产物信息。 */
      const artifact = await this.dependencies.registerArtifact(
        active.filePath,
        metadata
      );

      this.artifact = artifact;
      this.artifactListeners.forEach((listener) =>
        listener(this.getArtifact())
      );
      this.updateState({ type: "FINALIZED", artifactId: artifact.id });
      if (this.active === active) {
        this.active = undefined;
      }
      this.startCancellationRequested = false;
      return this.getState();
    } catch (error) {
      await active.muxer.cancel().catch(() => undefined);
      /** 媒体流或封装层的错误说明。 */
      const detail =
        active.sessionError?.message ||
        (error instanceof Error ? error.message : undefined);
      /** 面向用户的最终错误。 */
      const message = detail
        ? `录制文件封装失败：${detail}`
        : "录制文件封装失败，未生成可播放的 MP4";

      this.fail(message);
      if (this.active === active) {
        this.active = undefined;
      }
      this.startCancellationRequested = false;
      return this.getState();
    }
  }
}
