import { stripVTControlCharacters } from "node:util";
import type {
  DeviceControlCommand,
  DeviceInfo,
  LivePreviewStatus,
  MirrorState,
  RecordingPreset
} from "../../shared/types";
import { FrameRateSampler } from "../media/frame-rate";
import type { LivePreviewPublisher } from "../preview/hub";
import { resolveAudioPlan } from "../recording/command";
import type { RecordingMuxer } from "../recording/service";
import type {
  ScrcpySessionFactory,
  ScrcpySessionHandle
} from "../scrcpy/session";
import { ScrcpyMediaRouter } from "./router";

/** 镜像会话服务外部依赖。 */
export interface MirroringServiceDependencies {
  /** 建立配套 scrcpy-server 媒体与控制会话。 */
  sessionFactory: Pick<ScrcpySessionFactory, "start">;
  /** 实时预览发布器。 */
  preview: LivePreviewPublisher;
  /** 按本次 SCID 精确查询设备端服务 PID。 */
  findServerPid(serial: string, scid: number): Promise<number | undefined>;
  /** 向设备端服务进程发送中断信号。 */
  interruptServer(serial: string, pid: number): Promise<void>;
  /** 强制结束未响应的设备端服务进程。 */
  forceStopServer(serial: string, pid: number): Promise<void>;
  /** 可替换的短暂等待函数。 */
  wait?(milliseconds: number): Promise<void>;
  /** 可替换的当前毫秒时间。 */
  now?(): number;
}

/** 当前镜像提供给录制服务的只读上下文。 */
export interface MirrorRecordingContext {
  /** 镜像设备。 */
  device: DeviceInfo;
  /** 镜像会话锁定的录制预设。 */
  preset: RecordingPreset;
  /** 是否发生音频自动降级。 */
  audioFallback: boolean;
  /** 音频降级说明。 */
  audioFallbackReason?: string;
}

/** 当前活跃的唯一设备镜像会话。 */
interface ActiveMirror {
  /** 目标设备。 */
  device: DeviceInfo;
  /** 会话锁定预设。 */
  preset: RecordingPreset;
  /** scrcpy 媒体与控制连接。 */
  session: ScrcpySessionHandle;
  /** 媒体预览与录制路由器。 */
  router: ScrcpyMediaRouter;
  /** 实际镜像帧率采样器。 */
  frameRate: FrameRateSampler;
  /** 最近的设备端日志。 */
  stderrTail: string;
  /** 本次设备服务端 PID。 */
  serverPid?: number;
  /** 是否正在按预期结束。 */
  expectedStop: boolean;
  /** 设备断开等外部结束原因。 */
  endReason?: Error;
  /** 共享停止任务。 */
  stopTask?: Promise<void>;
}

/** 镜像会话结束事件。 */
export interface MirrorSessionEndEvent {
  /** 结束前的设备序列号。 */
  deviceSerial: string;
  /** 非预期结束原因。 */
  error: Error;
}

/** 保留的 scrcpy 日志最大字符数。 */
const scrcpyLogTailLength = 8_192;

/** 延迟指定毫秒数。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 创建空闲镜像状态。 */
function createIdleMirrorState(): MirrorState {
  return {
    status: "idle",
    audioFallback: false
  };
}

/** 复制镜像状态，避免泄漏可变预设。 */
function cloneMirrorState(state: MirrorState): MirrorState {
  return {
    ...state,
    preset: state.preset ? { ...state.preset } : undefined
  };
}

/** 判断两个录制预设是否完全一致。 */
function isSamePreset(
  first: RecordingPreset,
  second: RecordingPreset
): boolean {
  return (
    first.resolution === second.resolution &&
    first.videoBitrateMbps === second.videoBitrateMbps &&
    first.audioMode === second.audioMode
  );
}

/** 追加并限制 scrcpy 日志长度。 */
function appendLogTail(current: string, message: string): string {
  return stripVTControlCharacters(`${current}${message}`).slice(
    -scrcpyLogTailLength
  );
}

/** 从设备端日志中提取适合展示的关键错误。 */
function summarizeScrcpyError(message: string): string | undefined {
  /** 清理后的非空日志行。 */
  const lines = stripVTControlCharacters(message)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  /** 最后一条显式错误日志。 */
  const errorLine = [...lines].reverse().find((line) =>
    /\b(?:error|failed|failure|invalid|cannot|could not|denied)\b/i.test(line)
  );

  return (errorLine ?? lines.at(-1))?.slice(0, 240);
}

/** 统一管理单设备 scrcpy 镜像、控制与录制挂载。 */
export class MirroringService {
  /** 当前镜像状态。 */
  private state = createIdleMirrorState();
  /** 当前活跃会话。 */
  private active?: ActiveMirror;
  /** 正在建立的会话任务。 */
  private startupTask?: Promise<MirrorState>;
  /** 建立会话使用的取消器。 */
  private startupAbortController?: AbortController;
  /** 启动中的目标设备和参数。 */
  private startupInput?: {
    device: DeviceInfo;
    preset: RecordingPreset;
  };
  /** 状态订阅者。 */
  private readonly stateListeners = new Set<(state: MirrorState) => void>();
  /** 非预期会话结束订阅者。 */
  private readonly sessionEndListeners = new Set<
    (event: MirrorSessionEndEvent) => void
  >();
  /** 镜像帧率刷新计时器。 */
  private frameRateTimer?: NodeJS.Timeout;

  /** 创建镜像会话服务。 */
  constructor(private readonly dependencies: MirroringServiceDependencies) {}

  /** 获取不可变的镜像状态快照。 */
  getState(): MirrorState {
    return cloneMirrorState(this.state);
  }

  /** 订阅镜像状态变化。 */
  onStateChanged(listener: (state: MirrorState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** 订阅镜像会话非预期结束。 */
  onSessionEnded(
    listener: (event: MirrorSessionEndEvent) => void
  ): () => void {
    this.sessionEndListeners.add(listener);
    return () => this.sessionEndListeners.delete(listener);
  }

  /** 判断当前是否占用设备镜像会话。 */
  isBusy(): boolean {
    return ["starting", "mirroring", "stopping"].includes(this.state.status);
  }

  /** 由用户显式开启独立镜像。 */
  start(device: DeviceInfo, preset: RecordingPreset): Promise<MirrorState> {
    return this.startSession(device, preset);
  }

  /** 获取当前可录制的镜像上下文，镜像未就绪时拒绝录制。 */
  requireRecordingContext(): MirrorRecordingContext {
    if (!this.active || this.state.status !== "mirroring") {
      throw new Error("请先开启镜像后再开始录制");
    }

    return {
      device: { ...this.active.device },
      preset: { ...this.active.preset },
      audioFallback: this.state.audioFallback,
      audioFallbackReason: this.state.audioFallbackReason
    };
  }

  /** 在下一关键帧把 MP4 封装器挂载到当前镜像流。 */
  attachRecorder(muxer: RecordingMuxer): Promise<number> {
    if (!this.active || this.state.status !== "mirroring") {
      throw new Error("镜像会话尚未就绪");
    }

    return this.active.router.attachRecorder(muxer);
  }

  /** 从当前镜像流摘除指定 MP4 封装器。 */
  detachRecorder(muxer: RecordingMuxer): void {
    this.active?.router.detachRecorder(muxer);
  }

  /** 结束用户开启的镜像；录制挂载期间拒绝操作。 */
  async stop(): Promise<MirrorState> {
    if (this.active?.router.hasRecorder()) {
      throw new Error("录制期间不能结束镜像");
    }

    await this.stopInternal();
    if (!this.active && !this.startupTask && this.state.status === "error") {
      this.dependencies.preview.end();
      this.setState(createIdleMirrorState());
    }
    return this.getState();
  }

  /** 向当前设备发送一条受限控制命令。 */
  sendControl(command: DeviceControlCommand): void {
    if (!this.active || this.state.status !== "mirroring") {
      return;
    }

    if (!this.active.session.sendControl(command)) {
      this.patchState({
        previewMessage:
          "设备未接受控制，请开启“USB 调试（安全设置）”后重试"
      });
    }
  }

  /** Worker 状态仅归入当前镜像状态。 */
  handlePreviewStatus(status: LivePreviewStatus, message?: string): void {
    if (
      !["starting", "mirroring"].includes(this.state.status) ||
      (this.state.previewStatus === status &&
        this.state.previewMessage === message)
    ) {
      return;
    }

    this.patchState({ previewStatus: status, previewMessage: message });
  }

  /** 设备断开时关闭对应镜像，并通知录制服务保全文件。 */
  handleDeviceDisconnected(serial: string): void {
    if (this.startupInput?.device.serial === serial) {
      this.startupAbortController?.abort(new Error("设备已断开连接"));
    }
    if (this.active?.device.serial === serial) {
      this.active.endReason = new Error("设备已断开连接");
      this.active.session.close();
    }
  }

  /** 应用退出时同步释放镜像连接，无需额外确认。 */
  close(): void {
    this.startupAbortController?.abort(new Error("应用正在退出"));
    this.stopFrameRateTimer();
    if (this.active) {
      this.active.expectedStop = true;
      this.active.router.end();
      this.active.session.close();
      this.active = undefined;
    }
    this.dependencies.preview.end();
    this.state = createIdleMirrorState();
  }

  /** 建立新的显式镜像会话。 */
  private startSession(
    device: DeviceInfo,
    preset: RecordingPreset
  ): Promise<MirrorState> {
    if (device.status !== "available") {
      throw new Error("设备当前不可用于镜像");
    }
    if (this.startupTask) {
      this.assertStartupMatches(device, preset);
      return this.startupTask;
    }
    if (this.active) {
      this.assertActiveMatches(device, preset);
      return Promise.resolve(this.getState());
    }
    if (this.state.status === "stopping") {
      throw new Error("镜像正在结束，请稍后重试");
    }

    /** Android 版本对应的音频方案。 */
    const audioPlan = resolveAudioPlan(device, preset.audioMode);
    this.setState({
      status: "starting",
      deviceSerial: device.serial,
      preset: { ...preset },
      audioFallback: Boolean(audioPlan.fallbackReason),
      audioFallbackReason: audioPlan.fallbackReason,
      fps: 0,
      previewStatus: "connecting"
    });
    this.dependencies.preview.begin();
    /** 本次启动输入。 */
    const startupInput = {
      device: { ...device },
      preset: { ...preset }
    };
    /** 本次启动取消器。 */
    const abortController = new AbortController();
    this.startupInput = startupInput;
    this.startupAbortController = abortController;
    this.startupTask = this.startSessionOnce(startupInput, abortController);
    return this.startupTask;
  }

  /** 完成一次 scrcpy 会话握手。 */
  private async startSessionOnce(
    input: NonNullable<MirroringService["startupInput"]>,
    abortController: AbortController
  ): Promise<MirrorState> {
    /** 实际镜像帧率采样器。 */
    const frameRate = new FrameRateSampler(() =>
      this.dependencies.now?.() ?? Date.now()
    );
    /** 媒体预览和录制路由器。 */
    const router = new ScrcpyMediaRouter(
      this.dependencies.preview,
      () => this.handleAudioDisabled(),
      () => frameRate.push()
    );
    /** 启动期间暂存的设备端日志。 */
    let stderrTail = "";

    try {
      /** 唯一 scrcpy 媒体和控制会话。 */
      const session = await this.dependencies.sessionFactory.start(
        input.device,
        input.preset,
        {
          onVideoEvent: (event) => router.handleVideoEvent(event),
          onAudioEvent: (event) => router.handleAudioEvent(event),
          onLog: (message) => {
            stderrTail = appendLogTail(stderrTail, message);
            if (this.active?.router === router) {
              this.active.stderrTail = stderrTail;
            }
          }
        },
        abortController.signal
      );
      /** 完整建立的活跃镜像。 */
      const active: ActiveMirror = {
        device: input.device,
        preset: input.preset,
        session,
        router,
        frameRate,
        stderrTail,
        expectedStop: false
      };

      this.active = active;
      active.frameRate.start();
      this.setState({
        ...this.state,
        status: "mirroring",
        previewStatus: this.state.previewStatus ?? "connecting"
      });
      this.startFrameRateTimer(active);
      this.listenToSession(active);
      void this.locateServerPid(active).then((pid) => {
        if (this.active === active) {
          active.serverPid = pid;
        }
      });
      return this.getState();
    } catch (error) {
      router.end(error instanceof Error ? error : undefined);
      /** 面向用户的镜像启动错误。 */
      const detail =
        summarizeScrcpyError(stderrTail) ||
        (error instanceof Error ? error.message : undefined);
      /** 是否由停止流程主动取消启动。 */
      const cancelled = abortController.signal.aborted;
      /** 启动期间设备断开需要保留可见错误。 */
      const deviceDisconnected =
        abortController.signal.reason instanceof Error &&
        abortController.signal.reason.message === "设备已断开连接";
      if (cancelled && !deviceDisconnected) {
        this.dependencies.preview.end();
        this.setState(createIdleMirrorState());
      } else {
        /** 用户可理解的启动失败说明。 */
        const message = detail
          ? `无法开启镜像：${detail}`
          : "无法开启设备镜像";
        this.dependencies.preview.error(message);
        this.setState({
          ...this.state,
          status: "error",
          previewStatus: "unavailable",
          errorMessage: message
        });
      }
      throw error;
    } finally {
      if (this.startupAbortController === abortController) {
        this.startupAbortController = undefined;
        this.startupInput = undefined;
        this.startupTask = undefined;
      }
    }
  }

  /** 校验启动中的会话与录制参数一致。 */
  private assertStartupMatches(
    device: DeviceInfo,
    preset: RecordingPreset
  ): void {
    if (
      !this.startupInput ||
      this.startupInput.device.serial !== device.serial ||
      !isSamePreset(this.startupInput.preset, preset)
    ) {
      throw new Error("镜像中的设备或录制参数与当前选择不一致");
    }
  }

  /** 校验已建立会话与录制参数一致。 */
  private assertActiveMatches(
    device: DeviceInfo,
    preset: RecordingPreset
  ): void {
    if (
      !this.active ||
      this.active.device.serial !== device.serial ||
      !isSamePreset(this.active.preset, preset)
    ) {
      throw new Error("镜像中的设备或录制参数与当前选择不一致");
    }
  }

  /** 执行共享停止流程。 */
  private async stopInternal(): Promise<void> {
    if (this.startupTask) {
      if (this.state.status !== "stopping") {
        this.patchState({ status: "stopping" });
      }
      this.startupAbortController?.abort(new Error("用户已取消镜像启动"));
      await this.startupTask.catch(() => undefined);
    }
    if (!this.active) {
      if (this.state.status !== "error") {
        this.setState(createIdleMirrorState());
      }
      return;
    }

    /** 当前活跃会话。 */
    const active = this.active;
    active.stopTask ??= this.stopActive(active);
    await active.stopTask;
  }

  /** 优雅关闭设备端会话，超时后强制收尾。 */
  private async stopActive(active: ActiveMirror): Promise<void> {
    active.expectedStop = true;
    this.stopFrameRateTimer();
    this.patchState({ status: "stopping" });
    active.serverPid ??= await this.locateServerPid(active, 1);

    /** 是否成功通知设备端优雅停止。 */
    let interrupted = false;
    if (active.serverPid) {
      interrupted = await this.dependencies
        .interruptServer(active.device.serial, active.serverPid)
        .then(() => true)
        .catch(() => false);
    }
    if (!interrupted) {
      active.session.close();
    }

    /** 是否在正常等待时间内排空媒体流。 */
    const closedGracefully = await this.waitForSession(active.session, 8_000);
    if (!closedGracefully) {
      if (active.serverPid) {
        await this.dependencies
          .forceStopServer(active.device.serial, active.serverPid)
          .catch(() => undefined);
      }
      active.session.close();
      await this.waitForSession(active.session, 2_000);
    }

    active.router.end();
    if (this.active === active) {
      this.active = undefined;
      this.dependencies.preview.end();
      this.setState(createIdleMirrorState());
    }
  }

  /** 监听会话意外结束并通知录制服务。 */
  private listenToSession(active: ActiveMirror): void {
    void active.session.done.then(
      () => this.handleSessionEnd(active),
      (error: unknown) =>
        this.handleSessionEnd(
          active,
          error instanceof Error ? error : new Error("scrcpy 镜像异常中断")
        )
    );
  }

  /** 收敛会话非预期结束状态。 */
  private handleSessionEnd(active: ActiveMirror, error?: Error): void {
    if (this.active !== active || active.expectedStop) {
      return;
    }

    /** 对外展示的最终会话错误。 */
    const failure =
      active.endReason ??
      error ??
      new Error(
        summarizeScrcpyError(active.stderrTail) ?? "设备镜像连接已结束"
      );
    active.router.end(failure);
    this.stopFrameRateTimer();
    this.active = undefined;
    this.dependencies.preview.error(failure.message);
    this.setState({
      ...this.state,
      status: "error",
      previewStatus: "unavailable",
      errorMessage: failure.message
    });
    /** 镜像结束事件。 */
    const event: MirrorSessionEndEvent = {
      deviceSerial: active.device.serial,
      error: failure
    };
    this.sessionEndListeners.forEach((listener) => listener(event));
  }

  /** 音频 Socket 被设备关闭时同步镜像降级状态。 */
  private handleAudioDisabled(): void {
    if (!this.state.audioFallback) {
      this.patchState({
        audioFallback: true,
        audioFallbackReason: "设备音频初始化失败，已自动改为静音"
      });
    }
  }

  /** 按固定频率同步实际镜像帧率。 */
  private startFrameRateTimer(active: ActiveMirror): void {
    this.stopFrameRateTimer();
    this.frameRateTimer = setInterval(() => {
      if (this.active === active && this.state.status === "mirroring") {
        this.patchState({ fps: active.frameRate.sample() });
      }
    }, 500);
    this.frameRateTimer.unref();
  }

  /** 停止镜像帧率刷新。 */
  private stopFrameRateTimer(): void {
    if (this.frameRateTimer) {
      clearInterval(this.frameRateTimer);
      this.frameRateTimer = undefined;
    }
  }

  /** 按 SCID 轮询并识别本次设备端服务 PID。 */
  private async locateServerPid(
    active: ActiveMirror,
    attempts = 5
  ): Promise<number | undefined> {
    /** 可替换的等待函数。 */
    const wait = this.dependencies.wait ?? delay;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      /** 与本次 SCID 完全匹配的设备端 PID。 */
      const pid = await this.dependencies
        .findServerPid(active.device.serial, active.session.scid)
        .catch(() => undefined);

      if (pid) {
        return pid;
      }
      if (attempt + 1 < attempts) {
        await wait(200);
      }
    }

    return undefined;
  }

  /** 在指定时间内等待媒体 Socket 结束。 */
  private waitForSession(
    session: ScrcpySessionHandle,
    timeoutMilliseconds: number
  ): Promise<boolean> {
    return new Promise((resolve) => {
      /** 等待媒体流结束的超时计时器。 */
      const timer = setTimeout(() => resolve(false), timeoutMilliseconds);
      timer.unref();
      session.done.then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(true);
        }
      );
    });
  }

  /** 合并更新当前状态。 */
  private patchState(patch: Partial<MirrorState>): void {
    this.setState({ ...this.state, ...patch });
  }

  /** 替换状态并通知渲染进程。 */
  private setState(state: MirrorState): void {
    this.state = cloneMirrorState(state);
    this.stateListeners.forEach((listener) => listener(this.getState()));
  }
}
