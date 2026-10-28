import type { MirrorRecoveryState } from "../../shared/connection";
import type { DeviceInfo, MirrorState, RecordingPreset } from "../../shared/types";
import type { RecordingService } from "../recording/service";
import type { MirroringService, MirrorSessionEndEvent } from "./service";

/** 恢复层只恢复明确开启过的设备，不自行选择历史设备。 */
export interface MirrorRecoveryDependencies {
  mirroring: Pick<MirroringService,
    "getState" | "start" | "stop" | "cancelPendingStart" |
    "onSessionEnded" | "onStateChanged">;
  recording: Pick<RecordingService, "getState" | "stop">;
  /** 返回身份核验后的同一设备，禁止只按型号或历史 IP 匹配。 */
  resolveDevice(device: DeviceInfo, signal: AbortSignal): Promise<DeviceInfo | undefined>;
  now?(): number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

/** 对象身份用于隔离新旧用户意图，取消后旧异步结果不能复活会话。 */
interface MirrorIntent {
  device: DeviceInfo;
  preset: RecordingPreset;
  controller: AbortController;
  ready: boolean;
}

/** 每轮恢复独立计时，手动重试会替换整轮操作。 */
interface RecoveryRun {
  intent: MirrorIntent;
  controller: AbortController;
  deadline: number;
  timer?: NodeJS.Timeout;
}

/** 等待可取消的任务，同时消化晚到结果，避免旧任务继续推进。 */
function abortable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? new Error("操作已取消"));
    signal.addEventListener("abort", abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** 在两次尝试之间等待，取消时立即释放计时器。 */
function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** 串行管理显式启停与有限恢复；恢复录像必须由用户重新发起。 */
export class MirrorRecoveryService {
  private state: MirrorRecoveryState = { status: "idle", attempt: 0 };
  private intent?: MirrorIntent;
  private recovery?: RecoveryRun;
  /** 所有镜像变更共用队列，设备发现可取消且不占用此队列。 */
  private lifecycle: Promise<unknown> = Promise.resolve();
  /** 仅允许当前拥有者清理镜像，防止旧恢复的 finally 误杀新会话。 */
  private mirrorOwner?: MirrorIntent | RecoveryRun;
  private readonly listeners = new Set<(state: MirrorRecoveryState) => void>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(private readonly dependencies: MirrorRecoveryDependencies) {
    this.unsubscribe = dependencies.mirroring.onSessionEnded((event) =>
      this.handleSessionEnded(event)
    );
  }

  /** 获取恢复状态的不可变快照。 */
  getState(): MirrorRecoveryState {
    return { ...this.state };
  }

  /** 订阅当前恢复轮次的状态。 */
  onChanged(listener: (state: MirrorRecoveryState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 显式启动会替换恢复意图；同一活动会话重复启动保持幂等。 */
  async start(device: DeviceInfo, preset: RecordingPreset): Promise<MirrorState> {
    if (this.closed) throw new Error("镜像恢复服务已关闭");
    const current = this.dependencies.mirroring.getState();
    if (current.status === "mirroring" && this.intent?.ready &&
      current.deviceSerial === device.serial &&
      current.preset?.resolution === preset.resolution &&
      current.preset.videoBitrateMbps === preset.videoBitrateMbps &&
      current.preset.audioMode === preset.audioMode) {
      return this.dependencies.mirroring.start(device, preset);
    }
    if (current.status === "mirroring" &&
      ["starting", "recording", "stopping"].includes(this.dependencies.recording.getState().status)) {
      throw new Error("请先停止录制后再切换镜像");
    }

    this.clearIntent();
    const intent: MirrorIntent = {
      device: { ...device }, preset: { ...preset }, controller: new AbortController(), ready: false
    };
    this.intent = intent;
    this.publish({ status: "idle", attempt: 0 });
    return this.enqueue(async () => {
      try {
        this.assertIntent(intent);
        await abortable(this.dependencies.recording.stop(), intent.controller.signal);
        this.assertIntent(intent);
        await this.dependencies.mirroring.stop();
        this.assertIntent(intent);
        this.mirrorOwner = intent;
        const state = await this.startMirror(intent, device, intent.controller.signal);
        this.assertIntent(intent);
        intent.ready = true;
        return state;
      } catch (error) {
        if (this.intent === intent) this.intent = undefined;
        await this.cleanOwnedMirror(intent);
        throw error;
      }
    });
  }

  /** 有效停止请求先清除意图；录制中拒绝停止时保留原恢复能力。 */
  async stop(): Promise<MirrorState> {
    if (this.dependencies.mirroring.getState().status === "mirroring" &&
      ["starting", "recording", "stopping"].includes(this.dependencies.recording.getState().status)) {
      throw new Error("录制期间不能结束镜像");
    }
    this.clearIntent();
    this.publish({ status: "idle", attempt: 0 });
    return this.enqueue(async () => {
      const state = await this.dependencies.mirroring.stop();
      this.mirrorOwner = undefined;
      return state;
    });
  }

  /** 仅对尚未恢复的原设备重新开始有限重试。 */
  async retry(): Promise<MirrorRecoveryState> {
    if (this.intent && !this.intent.ready && !this.closed) this.beginRecovery(this.intent);
    return this.getState();
  }

  /** 取消当前恢复并放弃自动连接意图，不影响以后明确选择的新设备。 */
  async cancel(): Promise<MirrorRecoveryState> {
    const owner = this.recovery;
    this.clearIntent();
    this.publish({ ...this.state, status: "canceled", deadline: undefined, message: "已停止重新连接" });
    if (owner) await this.enqueue(() => this.cleanOwnedMirror(owner));
    return this.getState();
  }

  /** 退出时解除监听并中止所有等待，原生镜像资源由应用统一关闭。 */
  close(): void {
    this.closed = true;
    this.clearIntent();
    this.unsubscribe();
    this.listeners.clear();
  }

  private handleSessionEnded(event: MirrorSessionEndEvent): void {
    const intent = this.intent;
    if (!intent?.ready || this.closed || intent.device.serial !== event.deviceSerial) return;
    intent.ready = false;
    this.beginRecovery(intent);
  }

  private beginRecovery(intent: MirrorIntent): void {
    this.abortRecovery();
    const run: RecoveryRun = {
      intent,
      controller: new AbortController(),
      deadline: this.now() + (this.dependencies.timeoutMs ?? 30_000)
    };
    this.recovery = run;
    this.publish({
      status: "waiting", attempt: 0, deviceSerial: intent.device.serial,
      deviceName: intent.device.model, deadline: run.deadline,
      message: "连接已中断，正在重新连接"
    });
    run.timer = setTimeout(() => {
      if (!this.isCurrent(run)) return;
      run.controller.abort(new Error("重新连接超时"));
      this.publish({ ...this.state, status: "failed", deadline: undefined,
        message: "暂时无法连接，请确认手机无线调试已开启或重新连接 USB" });
    }, Math.max(0, run.deadline - this.now()));
    void this.runRecovery(run).catch(() => {
      if (this.isCurrent(run)) {
        run.controller.abort(new Error("恢复连接失败"));
        this.publish({ ...this.state, status: "failed", deadline: undefined,
          message: "无法恢复连接，请重试" });
      }
    }).finally(() => {
      clearTimeout(run.timer);
      if (this.recovery === run) this.recovery = undefined;
    });
  }

  private async runRecovery(run: RecoveryRun): Promise<void> {
    const signal = run.controller.signal;
    try {
      while (this.isCurrent(run)) {
        this.publish({ ...this.state, status: "connecting", attempt: this.state.attempt + 1,
          message: "正在寻找这台手机" });
        try {
          const device = await abortable(this.dependencies.resolveDevice(run.intent.device, signal), signal);
          if (!this.isCurrent(run)) break;
          if (device) {
            await this.enqueue(async () => {
              this.assertRun(run);
              await abortable(this.dependencies.recording.stop(), signal);
              this.assertRun(run);
              await this.dependencies.mirroring.stop();
              this.assertRun(run);
              this.publish({ ...this.state, status: "starting", deviceSerial: device.serial,
                message: "手机已连接，正在恢复画面" });
              this.mirrorOwner = run;
              await this.startMirror(run.intent, device, signal);
              this.assertRun(run);
              run.intent.device = { ...device };
            });
            await this.waitForLivePreview(device.serial, signal);
            this.assertRun(run);
            run.intent.ready = true;
            this.mirrorOwner = run.intent;
            clearTimeout(run.timer);
            this.publish({ ...this.state, status: "recovered", deadline: undefined,
              message: "画面已恢复" });
            return;
          }
        } catch {
          if (!this.isCurrent(run)) break;
          await this.enqueue(() => this.cleanOwnedMirror(run));
        }
        if (!this.isCurrent(run)) break;
        this.publish({ ...this.state, status: "waiting", message: "等待手机重新上线" });
        await waitForRetry(this.dependencies.retryDelayMs ?? 1_000, signal);
      }
    } finally {
      await this.enqueue(() => this.cleanOwnedMirror(run));
    }
  }

  /** 启动取消只中止当前队列内的启动，不从旧异步回调调用全局 stop。 */
  private async startMirror(
    intent: MirrorIntent, device: DeviceInfo, signal: AbortSignal
  ): Promise<MirrorState> {
    const abort = (): void => this.dependencies.mirroring.cancelPendingStart();
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const state = await this.dependencies.mirroring.start(device, intent.preset);
      signal.throwIfAborted();
      return state;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  /** 握手成功不代表恢复成功，必须等到当前设备实际预览变为 live。 */
  private waitForLivePreview(serial: string, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error): void => {
        unsubscribe();
        signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const abort = (): void => finish(new Error("恢复已取消"));
      const inspect = (state: MirrorState): void => {
        if (state.deviceSerial !== serial) return;
        if (state.status === "mirroring" && state.previewStatus === "live") finish();
        else if (state.status === "error") finish(new Error(state.errorMessage));
      };
      const unsubscribe = this.dependencies.mirroring.onStateChanged(inspect);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else inspect(this.dependencies.mirroring.getState());
    });
  }

  /** 必须在生命周期队列内调用，所有权变化后旧清理立即失效。 */
  private async cleanOwnedMirror(owner: MirrorIntent | RecoveryRun): Promise<void> {
    if (this.mirrorOwner !== owner) return;
    this.mirrorOwner = undefined;
    try {
      await this.dependencies.recording.stop();
    } finally {
      await this.dependencies.mirroring.stop();
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.lifecycle.then(operation, operation);
    this.lifecycle = task.catch(() => undefined);
    return task;
  }

  private clearIntent(): void {
    this.intent?.controller.abort(new Error("用户已结束当前镜像意图"));
    this.intent = undefined;
    this.abortRecovery();
  }

  private abortRecovery(): void {
    if (!this.recovery) return;
    clearTimeout(this.recovery.timer);
    this.recovery.controller.abort(new Error("恢复已取消"));
    this.recovery = undefined;
  }

  private assertIntent(intent: MirrorIntent): void {
    if (this.intent !== intent || intent.controller.signal.aborted || this.closed) {
      throw new Error("镜像启动已取消");
    }
  }

  private isCurrent(run: RecoveryRun): boolean {
    return this.recovery === run && this.intent === run.intent &&
      !run.controller.signal.aborted && !this.closed;
  }

  private assertRun(run: RecoveryRun): void {
    if (!this.isCurrent(run)) throw new Error("恢复已取消");
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }

  private publish(state: MirrorRecoveryState): void {
    this.state = { ...state };
    this.listeners.forEach((listener) => listener(this.getState()));
  }
}
