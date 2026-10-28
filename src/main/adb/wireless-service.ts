import { randomUUID } from "node:crypto";
import type {
  ConnectWirelessInput,
  PairWirelessInput,
  WirelessDeviceProfile,
  WirelessDiscovery,
  WirelessEndpoint,
  WirelessState
} from "../../shared/connection";
import type { DeviceInfo } from "../../shared/types";
import type { AdbClient } from "./client";
import { formatWirelessEndpoint } from "./parser";

/** 无线接入复用设备快照与设置存储，不另建 ADB 服务。 */
export interface WirelessServiceDependencies {
  adb: Pick<AdbClient, "listMdnsServices" | "pair" | "connect" | "disconnect" | "readIdentity">;
  refreshDevices(): Promise<DeviceInfo[]>;
  getProfiles(): WirelessDeviceProfile[];
  saveProfiles(profiles: WirelessDeviceProfile[]): Promise<unknown>;
}

/** 一次用户接入操作；取消后旧结果不能发布成功或启动后续连接。 */
interface WirelessOperation {
  id: number;
  controller: AbortController;
}

function sameEndpoint(first: WirelessEndpoint, second: WirelessEndpoint): boolean {
  return first.host.toLowerCase() === second.host.toLowerCase() && first.port === second.port;
}

function cloneProfile(profile: WirelessDeviceProfile): WirelessDeviceProfile {
  return { ...profile, endpoint: { ...profile.endpoint } };
}

/** ADB 既可能使用 IP 端点，也可能使用 mDNS 服务名列出同一传输。 */
function findEndpointDevice(
  devices: DeviceInfo[],
  endpoint: WirelessEndpoint,
  discoveries: WirelessDiscovery[]
): DeviceInfo | undefined {
  const serials = new Set([formatWirelessEndpoint(endpoint)]);
  for (const service of discoveries) {
    if (service.type === "connection" && sameEndpoint(service.endpoint, endpoint)) {
      const name = service.name.replace(/\.$/, "");
      serials.add(name);
      serials.add(`${name}._adb-tls-connect._tcp`);
    }
  }
  return devices.find((device) =>
    device.status === "available" &&
    device.connectionType === "network" &&
    serials.has(device.serial.replace(/\.$/, ""))
  );
}

/** 管理无线配对、连接与最近设备；镜像启动由上层显式决定。 */
export class WirelessService {
  private state: WirelessState = {
    status: "idle",
    discoveries: [],
    profiles: [],
    paired: false,
    operationId: 0
  };
  private operation?: WirelessOperation;
  private readonly listeners = new Set<(state: WirelessState) => void>();
  /** 设备改名、移除和连接结果按顺序写入，避免旧快照覆盖新修改。 */
  private profileTask: Promise<void> = Promise.resolve();

  /** 接入现有 ADB、设备刷新与持久化能力。 */
  constructor(private readonly dependencies: WirelessServiceDependencies) {}

  /** 返回副本，档案始终以持久化服务的当前值为准。 */
  getState(): WirelessState {
    return {
      ...this.state,
      discoveries: this.state.discoveries.map((item) => ({ ...item, endpoint: { ...item.endpoint } })),
      profiles: this.dependencies.getProfiles().map(cloneProfile)
    };
  }

  /** 订阅主进程确认的接入状态，返回取消订阅函数。 */
  onChanged(listener: (state: WirelessState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 恢复层只按已验证的连接记录定位档案，不按型号猜测。 */
  profileForDevice(serial: string): WirelessDeviceProfile | undefined {
    const profile = this.dependencies.getProfiles().find((item) => item.lastSerial === serial);
    return profile && cloneProfile(profile);
  }

  /** 手动刷新当前网络广播的无线设备。 */
  discover(): Promise<WirelessState> {
    return this.run("discovering", async (operation) => {
      const discoveries = await this.dependencies.adb.listMdnsServices(operation.controller.signal);
      this.assertCurrent(operation);
      this.publish({ discoveries, status: this.state.paired ? "paired" : "idle" });
    });
  }

  /** 配对成功后只使用唯一的连接服务；配对端口绝不复用为连接端口。 */
  pair(input: PairWirelessInput): Promise<WirelessState> {
    return this.run("pairing", async (operation) => {
      this.publish({ paired: false });
      try {
        await this.dependencies.adb.pair(input.endpoint, input.code, operation.controller.signal);
      } catch {
        this.assertCurrent(operation);
        throw new Error("配对失败，请重新检查手机上的配对地址、端口与配对码");
      }
      this.assertCurrent(operation);
      this.publish({ paired: true, status: "paired", message: "配对成功，正在查找连接地址" });
      const discoveries = await this.discoverForConnection(operation.controller.signal);
      this.assertCurrent(operation);
      const candidates = discoveries.filter((item) =>
        item.type === "connection" &&
        item.endpoint.host.toLowerCase() === input.endpoint.host.toLowerCase() &&
        item.endpoint.port !== input.endpoint.port
      );
      this.publish({ discoveries });
      if (candidates.length !== 1) {
        this.publish({
          message: candidates.length > 1
            ? "已配对，发现多个连接地址，请在手机无线调试主页确认后手动连接"
            : "已配对，请填写手机无线调试主页的连接地址；该端口通常与配对端口不同"
        });
        return;
      }
      await this.connectWithinOperation({ endpoint: candidates[0].endpoint }, operation);
    });
  }

  /** 显式连接用户提供的端点，并在更新历史记录前核验设备身份。 */
  connect(input: ConnectWirelessInput): Promise<WirelessState> {
    return this.run("connecting", (operation) => this.connectWithinOperation(input, operation));
  }

  /** 取消只停止本次后续动作，已经完成的系统配对不会被声称撤销。 */
  cancel(): WirelessState {
    if (!this.operation) {
      return this.getState();
    }
    this.operation.controller.abort();
    this.operation = undefined;
    this.publish({
      operationId: this.state.operationId + 1,
      status: this.state.paired ? "paired" : "idle",
      deviceSerial: undefined,
      errorMessage: undefined,
      message: this.state.paired ? "已停止连接，手机配对仍保留" : "已取消"
    });
    return this.getState();
  }

  /** 仅断开已识别的无线传输，是否结束镜像由上层先行协调。 */
  disconnect(serial: string): Promise<WirelessState> {
    return this.run("idle", async (operation) => {
      if (!serial.includes(":") && !serial.includes("._adb-tls-connect._tcp")) {
        throw new Error("只能断开无线设备连接");
      }
      await this.dependencies.adb.disconnect(serial, operation.controller.signal);
      this.assertCurrent(operation);
      await this.dependencies.refreshDevices();
      this.assertCurrent(operation);
      this.publish({ status: "idle", paired: false, message: "已断开连接" });
    });
  }

  /** 更新本地昵称，不修改手机名称或配对状态。 */
  async renameProfile(id: string, name: string): Promise<WirelessState> {
    await this.updateProfiles((profiles) => {
      if (!profiles.some((item) => item.id === id)) {
        throw new Error("设备记录已不存在");
      }
      return profiles.map((item) => item.id === id ? { ...item, name } : item);
    });
    this.publish({});
    return this.getState();
  }

  /** 移除的只是最近记录，不影响手机端的 ADB 配对授权。 */
  async removeProfile(id: string): Promise<WirelessState> {
    await this.updateProfiles((profiles) => profiles.filter((item) => item.id !== id));
    this.publish({});
    return this.getState();
  }

  /**
   * 仅恢复具有可核验身份的设备；发现地址与历史地址都必须在连接后再次核验。
   * 本方法不修改用户接入操作状态，也不自动开始镜像或录制。
   */
  async reconnect(profile: WirelessDeviceProfile, signal: AbortSignal): Promise<DeviceInfo | undefined> {
    signal.throwIfAborted();
    if (!profile.identity) {
      return undefined;
    }
    const devices = await this.dependencies.refreshDevices();
    signal.throwIfAborted();
    for (const device of devices) {
      if (device.status !== "available" || device.connectionType !== "network") {
        continue;
      }
      const identity = await this.readIdentity(device.serial, signal);
      if (identity === profile.identity) {
        await this.saveConnectedProfile(device, profile.endpoint, identity, profile.id, signal);
        signal.throwIfAborted();
        return device;
      }
    }

    const discoveries = await this.discoverForConnection(signal);
    const identityValue = profile.identity.slice(profile.identity.indexOf(":") + 1);
    const candidates = discoveries.filter((item) => item.type === "connection" && (
      item.name === `adb-${identityValue}` || item.name.startsWith(`adb-${identityValue}-`)
    )).map((item) => item.endpoint);
    candidates.push(profile.endpoint);
    const endpoints = [...new Map(candidates.map((item) => [formatWirelessEndpoint(item), item])).values()];
    for (const endpoint of endpoints) {
      signal.throwIfAborted();
      try {
        await this.dependencies.adb.connect(endpoint, signal);
        const connected = await this.dependencies.refreshDevices();
        signal.throwIfAborted();
        const device = findEndpointDevice(connected, endpoint, discoveries);
        if (device && await this.readIdentity(device.serial, signal) === profile.identity) {
          await this.saveConnectedProfile(device, endpoint, profile.identity, profile.id, signal);
          signal.throwIfAborted();
          return device;
        }
      } catch {
        signal.throwIfAborted();
      }
    }
    return undefined;
  }

  private async connectWithinOperation(input: ConnectWirelessInput, operation: WirelessOperation): Promise<void> {
    const signal = operation.controller.signal;
    const expected = input.profileId
      ? this.dependencies.getProfiles().find((item) => item.id === input.profileId)
      : undefined;
    if (input.profileId && !expected) {
      throw new Error("设备记录已不存在，请手动填写连接地址");
    }
    this.publish({ status: "connecting", message: "正在连接手机" });
    await this.dependencies.adb.connect(input.endpoint, signal);
    this.assertCurrent(operation);
    const discoveries = await this.discoverForConnection(signal);
    this.assertCurrent(operation);
    const devices = await this.dependencies.refreshDevices();
    this.assertCurrent(operation);
    const device = findEndpointDevice(devices, input.endpoint, discoveries);
    if (!device) {
      throw new Error("ADB 尚未确认该手机可用，请检查手机授权与连接地址后重试");
    }
    const identity = await this.readIdentity(device.serial, signal);
    this.assertCurrent(operation);
    if (expected?.identity && identity !== expected.identity) {
      throw new Error("此地址对应的设备与历史记录不一致，请在手机上确认新的连接地址");
    }
    await this.saveConnectedProfile(device, input.endpoint, identity, expected?.id, signal);
    this.assertCurrent(operation);
    this.publish({
      status: "connected",
      discoveries,
      paired: true,
      deviceSerial: device.serial,
      message: identity ? "手机已连接" : "手机已连接；未取得设备身份，断线后需要手动连接"
    });
  }

  /** mDNS 不可用时保留手动连接能力，不把发现失败当作设备离线。 */
  private async discoverForConnection(signal: AbortSignal): Promise<WirelessDiscovery[]> {
    try {
      const discoveries = await this.dependencies.adb.listMdnsServices(signal);
      signal.throwIfAborted();
      return discoveries;
    } catch {
      signal.throwIfAborted();
      return [];
    }
  }

  private async readIdentity(serial: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const identity = await this.dependencies.adb.readIdentity(serial, signal);
      signal.throwIfAborted();
      return identity;
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  }

  private async saveConnectedProfile(
    device: DeviceInfo,
    endpoint: WirelessEndpoint,
    identity: string | undefined,
    profileId: string | undefined,
    signal: AbortSignal
  ): Promise<void> {
    await this.updateProfiles((profiles) => {
      signal.throwIfAborted();
      const existing = profiles.find((item) =>
        (identity && item.identity === identity) ||
        (item.id === profileId && (!item.identity || item.identity === identity))
      );
      const profile: WirelessDeviceProfile = {
        id: existing?.id ?? randomUUID(),
        name: existing?.name ?? device.model,
        model: device.model,
        identity,
        lastSerial: device.serial,
        endpoint: { ...endpoint },
        lastConnectedAt: Date.now()
      };
      return [profile, ...profiles.filter((item) => item.id !== profile.id)].slice(0, 100);
    });
  }

  private updateProfiles(update: (profiles: WirelessDeviceProfile[]) => WirelessDeviceProfile[]): Promise<void> {
    const task = this.profileTask.then(async () => {
      await this.dependencies.saveProfiles(update(this.dependencies.getProfiles().map(cloneProfile)));
    });
    this.profileTask = task.catch(() => undefined);
    return task;
  }

  private async run(
    status: WirelessState["status"],
    execute: (operation: WirelessOperation) => Promise<void>
  ): Promise<WirelessState> {
    this.operation?.controller.abort();
    const operation: WirelessOperation = {
      id: this.state.operationId + 1,
      controller: new AbortController()
    };
    this.operation = operation;
    this.publish({
      status,
      operationId: operation.id,
      deviceSerial: undefined,
      message: undefined,
      errorMessage: undefined
    });
    try {
      await execute(operation);
    } catch (error) {
      if (this.operation === operation && !operation.controller.signal.aborted) {
        this.publish({
          status: "error",
          errorMessage: error instanceof Error ? error.message : "无线连接失败，请重试"
        });
      }
    } finally {
      if (this.operation === operation) {
        this.operation = undefined;
      }
    }
    return this.getState();
  }

  private assertCurrent(operation: WirelessOperation): void {
    operation.controller.signal.throwIfAborted();
    if (this.operation !== operation) {
      throw new Error("连接操作已取消");
    }
  }

  private publish(patch: Partial<WirelessState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener(this.getState()));
  }
}
