import { execFile } from "node:child_process";
import type { DeviceInfo } from "../../shared/types";
import type { WirelessDiscovery, WirelessEndpoint } from "../../shared/connection";
import {
  findScrcpyServerPid,
  parseScrcpyServerPids
} from "../recording/process";
import { formatScrcpyScid } from "../scrcpy/server-options";
import {
  formatWirelessEndpoint,
  parseAdbDeviceList,
  parseAdbMdnsServices,
  parseAndroidIdentity,
  parseAndroidProperties
} from "./parser";

/** 可执行文件返回内容。 */
export interface ExecutableResult {
  /** 标准输出。 */
  stdout: string;
  /** 标准错误。 */
  stderr: string;
}

/** 不经过 shell 的可执行文件调用接口。 */
export type ExecutableRunner = (
  file: string,
  arguments_: string[],
  timeoutMilliseconds?: number,
  signal?: AbortSignal
) => Promise<ExecutableResult>;

/** 使用参数数组执行受信任的内置二进制。 */
export function runExecutable(
  file: string,
  arguments_: string[],
  timeoutMilliseconds = 10_000,
  signal?: AbortSignal
): Promise<ExecutableResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      arguments_,
      {
        encoding: "utf8",
        maxBuffer: 8 * 1_024 * 1_024,
        shell: false,
        timeout: timeoutMilliseconds,
        signal,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        resolve({ stdout, stderr });
      }
    );
  });
}

/** 封装固定范围的 ADB 操作。 */
export class AdbClient {
  /** 创建 ADB 客户端。 */
  constructor(
    private readonly adbPath: string,
    private readonly runner: ExecutableRunner = runExecutable
  ) {}

  /** 发现已广播的无线服务，不主动扫描局域网地址。 */
  async listMdnsServices(signal?: AbortSignal): Promise<WirelessDiscovery[]> {
    const { stdout } = await this.runner(
      this.adbPath, ["mdns", "services"], 5_000, signal
    );
    signal?.throwIfAborted();
    return parseAdbMdnsServices(stdout);
  }

  /** 配对失败只返回固定说明，避免 ADB 错误回显一次性配对码。 */
  async pair(endpoint: WirelessEndpoint, code: string, signal?: AbortSignal): Promise<void> {
    try {
      signal?.throwIfAborted();
      const { stdout } = await this.runner(
        this.adbPath, ["pair", formatWirelessEndpoint(endpoint), code], 20_000, signal
      );
      signal?.throwIfAborted();
      if (!/successfully paired to/i.test(stdout)) {
        throw new Error("配对未成功");
      }
    } catch {
      signal?.throwIfAborted();
      throw new Error("配对失败，请重新打开手机上的配对码弹窗，检查地址、端口与配对码");
    }
  }

  /** ADB 部分连接失败仍返回零退出码，需要检查结果文字。 */
  async connect(endpoint: WirelessEndpoint, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const { stdout } = await this.runner(
      this.adbPath, ["connect", formatWirelessEndpoint(endpoint)], 10_000, signal
    );
    signal?.throwIfAborted();
    if (!/(?:^|\n)(?:already )?connected to /i.test(stdout.trim())) {
      throw new Error("连接失败，请确认手机与电脑处于同一网络，并使用无线调试主页的连接端口");
    }
  }

  /** 只断开指定无线传输，不重启共享的 ADB 服务。 */
  async disconnect(serial: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.runner(this.adbPath, ["disconnect", serial], 5_000, signal);
    signal?.throwIfAborted();
  }

  /** 连接后读取真实设备属性，避免把变化的 IP 当作设备身份。 */
  async readIdentity(serial: string, signal?: AbortSignal): Promise<string | undefined> {
    signal?.throwIfAborted();
    const { stdout } = await this.runner(
      this.adbPath, ["-s", serial, "shell", "getprop"], 5_000, signal
    );
    signal?.throwIfAborted();
    return parseAndroidIdentity(stdout);
  }

  /** 列出所有设备并补齐可用设备属性。 */
  async listDevices(): Promise<DeviceInfo[]> {
    /** ADB 设备列表结果。 */
    const { stdout } = await this.runner(this.adbPath, ["devices", "-l"]);
    /** 基础设备信息。 */
    const devices = parseAdbDeviceList(stdout);

    return Promise.all(
      devices.map(async (device) => {
        if (device.status !== "available") {
          return device;
        }

        /** 单设备 Android 属性。 */
        const properties = await this.readProperties(device.serial);
        return {
          ...device,
          ...properties
        };
      })
    );
  }

  /** 查询指定设备上的 scrcpy Server PID。 */
  async listServerPids(serial: string): Promise<number[]> {
    /** Android ps 结果。 */
    const { stdout } = await this.runner(this.adbPath, [
      "-s",
      serial,
      "shell",
      "ps",
      "-A",
      "-o",
      "PID,ARGS"
    ]);

    return parseScrcpyServerPids(stdout);
  }

  /** 按本次 SCID 精确查询设备端 scrcpy Server PID。 */
  async findServerPid(
    serial: string,
    scid: number
  ): Promise<number | undefined> {
    /** Android ps 结果。 */
    const { stdout } = await this.runner(
      this.adbPath,
      ["-s", serial, "shell", "ps", "-A", "-o", "PID,ARGS"],
      1_000
    );

    return findScrcpyServerPid(stdout, formatScrcpyScid(scid));
  }

  /** 向指定设备进程发送中断信号。 */
  async interruptServer(serial: string, pid: number): Promise<void> {
    await this.runner(this.adbPath, [
      "-s",
      serial,
      "shell",
      "kill",
      "-2",
      String(pid)
    ]);
  }

  /** 强制结束指定设备进程。 */
  async forceStopServer(serial: string, pid: number): Promise<void> {
    await this.runner(this.adbPath, [
      "-s",
      serial,
      "shell",
      "kill",
      "-9",
      String(pid)
    ]);
  }

  /** 把配套 scrcpy-server 推送到指定设备。 */
  async pushServer(
    serial: string,
    localPath: string,
    remotePath: string
  ): Promise<void> {
    await this.runner(this.adbPath, [
      "-s",
      serial,
      "push",
      localPath,
      remotePath
    ]);
  }

  /** 创建动态本地端口到设备抽象 Socket 的 forward 隧道。 */
  async createForward(serial: string, socketName: string): Promise<number> {
    /** ADB 返回的动态本地端口。 */
    const { stdout } = await this.runner(this.adbPath, [
      "-s",
      serial,
      "forward",
      "tcp:0",
      `localabstract:${socketName}`
    ]);
    /** 解析后的本地端口。 */
    const port = Number.parseInt(stdout.trim(), 10);

    if (!Number.isInteger(port)) {
      throw new Error("ADB 未返回有效的 forward 端口");
    }

    return port;
  }

  /** 移除指定设备的本地 forward 隧道。 */
  async removeForward(serial: string, port: number): Promise<void> {
    await this.runner(this.adbPath, [
      "-s",
      serial,
      "forward",
      "--remove",
      `tcp:${port}`
    ]);
  }

  /** 读取指定设备的 Android 关键属性。 */
  private async readProperties(
    serial: string
  ): Promise<Pick<DeviceInfo, "model" | "androidVersion" | "apiLevel" | "identity">> {
    /** getprop 命令结果。 */
    const { stdout } = await this.runner(this.adbPath, [
      "-s",
      serial,
      "shell",
      "getprop"
    ]);

    return parseAndroidProperties(stdout);
  }
}
