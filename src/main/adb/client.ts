import { execFile } from "node:child_process";
import type { DeviceInfo } from "../../shared/types";
import {
  findScrcpyServerPid,
  parseScrcpyServerPids
} from "../recording/process";
import { formatScrcpyScid } from "../scrcpy/server-options";
import { parseAdbDeviceList, parseAndroidProperties } from "./parser";

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
  timeoutMilliseconds?: number
) => Promise<ExecutableResult>;

/** 使用参数数组执行受信任的内置二进制。 */
export function runExecutable(
  file: string,
  arguments_: string[],
  timeoutMilliseconds = 10_000
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
  ): Promise<Pick<DeviceInfo, "model" | "androidVersion" | "apiLevel">> {
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
