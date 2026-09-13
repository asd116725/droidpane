/** 电脑监听初始缓冲时长，单位秒。 */
const monitorBufferSeconds = 0.06;
/** 允许的最大监听延迟，单位秒。 */
const maxMonitorLatencySeconds = 0.25;

/** 创建 Web Audio 上下文。 */
export type AudioContextFactory = () => AudioContext;

/** 通过 Web Audio 低延迟播放 Worker 解码出的设备音频。 */
export class AudioMonitorPlayer {
  /** 当前 Web Audio 上下文。 */
  private context?: AudioContext;
  /** 监听音量节点。 */
  private gain?: GainNode;
  /** 当前所有尚未结束的音源。 */
  private readonly sources = new Set<AudioBufferSourceNode>();
  /** 是否允许播放监听数据。 */
  private enabled = false;
  /** 首包设备时间戳。 */
  private basePtsUs?: number;
  /** 首包对应的 Web Audio 时间。 */
  private baseContextTime?: number;

  /** 创建可替换 AudioContext 的监听播放器。 */
  constructor(
    private readonly createContext: AudioContextFactory = () =>
      new AudioContext({ latencyHint: "interactive" })
  ) {}

  /** 在用户操作中准备并恢复系统音频输出。 */
  async enable(volume: number): Promise<void> {
    this.enabled = true;
    /** 可复用的音频上下文。 */
    const context = this.ensureContext();
    this.setVolume(volume);
    if (context.state !== "running") {
      try {
        await context.resume();
      } catch (error) {
        this.enabled = false;
        throw error;
      }
    }
  }

  /** 停止监听并清空已经调度的声音。 */
  disable(): void {
    this.enabled = false;
    this.resetSchedule();
    if (this.context?.state === "running") {
      void this.context.suspend().catch(() => undefined);
    }
  }

  /** 更新监听音量。 */
  setVolume(volume: number): void {
    if (this.gain) {
      this.gain.gain.value = volume;
    }
  }

  /** 按设备 PTS 调度一段解码后的 PCM。 */
  play(data: AudioData): void {
    if (!this.enabled || !this.context || !this.gain) {
      data.close();
      return;
    }

    /** 当前 PCM 对应的播放时间。 */
    let startTime = this.resolveStartTime(data.timestamp);
    /** 当前包相对播放设备的提前量。 */
    const leadTime = startTime - this.context.currentTime;
    if (leadTime < 0 || leadTime > maxMonitorLatencySeconds) {
      this.resetSchedule();
      startTime = this.resolveStartTime(data.timestamp);
    }

    /** Web Audio 可直接调度的 PCM 缓冲。 */
    let buffer: AudioBuffer;
    try {
      buffer = this.context.createBuffer(
        data.numberOfChannels,
        data.numberOfFrames,
        data.sampleRate
      );
      for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
        data.copyTo(buffer.getChannelData(channel), {
          planeIndex: channel,
          format: "f32-planar"
        });
      }
    } finally {
      data.close();
    }

    /** 当前单包音源。 */
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.onended = () => this.sources.delete(source);
    this.sources.add(source);
    source.start(startTime);
  }

  /** 释放页面持有的系统音频资源。 */
  dispose(): void {
    this.disable();
    if (this.context) {
      void this.context.close().catch(() => undefined);
      this.context = undefined;
      this.gain = undefined;
    }
  }

  /** 延迟创建 AudioContext 与统一音量节点。 */
  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = this.createContext();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
    }
    return this.context;
  }

  /** 将设备 PTS 映射为 Web Audio 播放时间。 */
  private resolveStartTime(ptsUs: number): number {
    if (
      this.basePtsUs === undefined ||
      this.baseContextTime === undefined ||
      !this.context
    ) {
      this.basePtsUs = ptsUs;
      this.baseContextTime =
        (this.context?.currentTime ?? 0) + monitorBufferSeconds;
    }
    return this.baseContextTime + (ptsUs - this.basePtsUs) / 1_000_000;
  }

  /** 停止尚未播放完成的声音并清空 PTS 时钟。 */
  private resetSchedule(): void {
    this.sources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // 已自然结束的音源无需再次停止。
      }
    });
    this.sources.clear();
    this.basePtsUs = undefined;
    this.baseContextTime = undefined;
  }
}
