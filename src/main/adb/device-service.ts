import type { DeviceInfo } from "../../shared/types";
import type { AdbClient } from "./client";

/** 周期轮询并发布安卓设备列表。 */
export class DeviceService {
  /** 当前设备快照。 */
  private devices: DeviceInfo[] = [];
  /** 设备列表订阅者。 */
  private readonly listeners = new Set<(devices: DeviceInfo[]) => void>();
  /** 两秒轮询计时器。 */
  private timer?: NodeJS.Timeout;
  /** 防止重叠查询的活动任务。 */
  private refreshTask?: Promise<DeviceInfo[]>;

  /** 创建设备轮询服务。 */
  constructor(
    private readonly client: AdbClient,
    private readonly pollingInterval = 2_000
  ) {}

  /** 启动立即查询与周期轮询。 */
  async start(): Promise<void> {
    await this.refresh().catch(() => []);
    this.timer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, this.pollingInterval);
    this.timer.unref();
  }

  /** 停止设备轮询。 */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** 获取当前设备快照。 */
  getDevices(): DeviceInfo[] {
    return this.devices.map((device) => ({ ...device }));
  }

  /** 订阅设备列表变化。 */
  onChanged(listener: (devices: DeviceInfo[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 立即刷新设备列表。 */
  refresh(): Promise<DeviceInfo[]> {
    this.refreshTask ??= this.refreshOnce().finally(() => {
      this.refreshTask = undefined;
    });
    return this.refreshTask;
  }

  /** 执行一次设备查询并在变化时发布。 */
  private async refreshOnce(): Promise<DeviceInfo[]> {
    /** 最新设备列表。 */
    const devices = await this.client.listDevices();
    /** 新旧快照序列化结果。 */
    const changed = JSON.stringify(devices) !== JSON.stringify(this.devices);

    this.devices = devices;

    if (changed) {
      /** 不可变设备快照。 */
      const snapshot = this.getDevices();
      this.listeners.forEach((listener) => listener(snapshot));
    }

    return this.getDevices();
  }
}
