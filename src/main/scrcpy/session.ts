import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomInt } from "node:crypto";
import net from "node:net";
import type {
  DeviceControlCommand,
  DeviceInfo,
  RecordingPreset
} from "../../shared/types";
import type { AdbClient } from "../adb/client";
import { resolveAudioPlan } from "../recording/command";
import {
  SocketCursor,
  readScrcpyDeviceName,
  readScrcpyDummyByte
} from "./connection";
import { ScrcpyPacketParser, type ScrcpyStreamEvent } from "./protocol";
import {
  buildScrcpyServerArguments,
  buildScrcpySocketName
} from "./server-options";
import { ScrcpyControlChannel } from "./control";

/** 设备端 scrcpy-server 固定路径。 */
export const remoteScrcpyServerPath = "/data/local/tmp/scrcpy-server.jar";

/** 可用于 scrcpy 流读取的 Socket。 */
export interface ScrcpySocket extends AsyncIterable<Uint8Array> {
  /** 向 Socket 写入一段数据。 */
  write(data: Uint8Array): boolean;
  /** 监听控制 Socket 的非致命错误。 */
  on?(event: "error", listener: (error: Error) => void): unknown;
  /** 立即关闭 Socket。 */
  destroy(error?: Error): unknown;
}

/** 单流会话事件回调。 */
export interface ScrcpySessionCallbacks {
  /** 接收视频协议事件。 */
  onVideoEvent(event: ScrcpyStreamEvent): void | Promise<void>;
  /** 接收音频协议事件。 */
  onAudioEvent?(event: ScrcpyStreamEvent): void | Promise<void>;
  /** 接收设备端日志。 */
  onLog?(message: string): void;
}

/** 单流会话外部依赖。 */
export interface ScrcpySessionDependencies {
  /** 内置 ADB 路径。 */
  adbPath: string;
  /** 本地配套 scrcpy-server 路径。 */
  serverPath: string;
  /** ADB 固定操作客户端。 */
  adb: Pick<AdbClient, "pushServer" | "createForward" | "removeForward">;
  /** 启动 adb shell 服务端进程。 */
  spawnProcess(
    file: string,
    arguments_: string[]
  ): ChildProcessWithoutNullStreams;
  /** 连接本地 forward 端口。 */
  connectSocket(port: number): Promise<ScrcpySocket>;
  /** 创建 31 位会话 ID。 */
  createScid(): number;
  /** 可替换的短暂等待。 */
  wait(milliseconds: number): Promise<void>;
}

/** 已建立的 scrcpy 单流会话。 */
export interface ScrcpySessionHandle {
  /** 本次服务端会话 ID。 */
  scid: number;
  /** 设备端返回的名称。 */
  deviceName: string;
  /** adb shell 宿主进程。 */
  process: ChildProcessWithoutNullStreams;
  /** 视频和音频流结束任务。 */
  done: Promise<void>;
  /** 向当前设备发送一条受限控制命令。 */
  sendControl(command: DeviceControlCommand): boolean;
  /** 强制关闭宿主连接。 */
  close(): void;
}

/** 默认延迟函数。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 返回统一的启动取消错误。 */
function createAbortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("scrcpy 会话启动已取消");
}

/**
 * 在限定时间内等待异步任务，并在取消后释放迟到的结果。
 * @param task 当前异步任务
 * @param timeoutMilliseconds 最长等待毫秒数
 * @param signal 外部取消信号
 * @param timeoutMessage 超时错误文本
 * @param onCancelled 超时或取消时的清理动作
 * @param onLateResult 任务取消后才返回结果时的清理动作
 */
function waitForTask<T>(
  task: Promise<T>,
  timeoutMilliseconds: number,
  signal: AbortSignal | undefined,
  timeoutMessage: string,
  onCancelled?: () => void,
  onLateResult?: (value: T) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    /** 当前等待是否已经结束。 */
    let settled = false;
    /** 移除计时器与取消监听。 */
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
    };
    /** 取消当前等待。 */
    const cancel = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      onCancelled?.();
      reject(error);
    };
    /** 外部取消处理器。 */
    const handleAbort = (): void => cancel(createAbortError(signal));
    /** 截止计时器。 */
    const timer = setTimeout(
      () => cancel(new Error(timeoutMessage)),
      Math.max(1, timeoutMilliseconds)
    );
    timer.unref();
    signal?.addEventListener("abort", handleAbort, { once: true });

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    task.then(
      (value) => {
        if (settled) {
          onLateResult?.(value);
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      }
    );
  });
}

/** 创建一个本地 TCP Socket，并在超时后主动失败。 */
export function connectLocalSocket(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    /** 本地 ADB forward 连接。 */
    const socket = net.createConnection({ host: "127.0.0.1", port });
    /** 连接前错误处理器。 */
    const handleError = (error: Error): void => reject(error);

    socket.setTimeout(1_000, () =>
      socket.destroy(new Error("连接 scrcpy-server 超时"))
    );
    socket.once("error", handleError);
    socket.once("connect", () => {
      socket.off("error", handleError);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

/** 负责启动并连接单个 scrcpy-server 会话。 */
export class ScrcpySessionFactory {
  /** 创建会话工厂。 */
  constructor(private readonly dependencies: ScrcpySessionDependencies) {}

  /** 建立指定设备的单路视频/音频会话。 */
  async start(
    device: DeviceInfo,
    preset: RecordingPreset,
    callbacks: ScrcpySessionCallbacks,
    signal?: AbortSignal
  ): Promise<ScrcpySessionHandle> {
    /** 当前会话 ID。 */
    const scid = this.dependencies.createScid();
    /** 设备抽象 Socket 名称。 */
    const socketName = buildScrcpySocketName(scid);
    /** 是否需要音频 Socket。 */
    const audioEnabled = resolveAudioPlan(device, preset.audioMode).enabled;

    await this.dependencies.adb.pushServer(
      device.serial,
      this.dependencies.serverPath,
      remoteScrcpyServerPath
    );
    /** ADB 动态本地端口。 */
    const port = await this.dependencies.adb.createForward(
      device.serial,
      socketName
    );
    /** 视频连接与字节游标。 */
    let videoSocket: ScrcpySocket | undefined;
    /** 音频连接与字节游标。 */
    let audioSocket: ScrcpySocket | undefined;
    /** 设备控制连接。 */
    let controlSocket: ScrcpySocket | undefined;
    /** adb shell 服务端进程。 */
    let child: ChildProcessWithoutNullStreams | undefined;
    /** 启动或媒体会话的首个错误。 */
    let sessionError: Error | undefined;
    /** 握手是否已经完整建立。 */
    let sessionReady = false;
    /** 外部启动取消处理器。 */
    const handleAbort = (): void => {
      sessionError ??= createAbortError(signal);
      videoSocket?.destroy(sessionError);
      audioSocket?.destroy(sessionError);
      controlSocket?.destroy(sessionError);
      child?.kill("SIGTERM");
    };

    try {
      child = this.dependencies.spawnProcess(
        this.dependencies.adbPath,
        buildScrcpyServerArguments({
          device,
          preset,
          scid,
          remoteServerPath: remoteScrcpyServerPath
        })
      );
      /** 设备端子进程错误必须在任何异步等待前注册。 */
      child.once("error", (error) => {
        sessionError ??= error;
        videoSocket?.destroy(error);
        audioSocket?.destroy(error);
        controlSocket?.destroy(error);
      });
      child.once("close", (code) => {
        if (!sessionReady && !sessionError) {
          sessionError = new Error(
            `scrcpy-server 在握手前退出${code === null ? "" : `（${code}）`}`
          );
        }
        videoSocket?.destroy(sessionError);
        audioSocket?.destroy(sessionError);
        controlSocket?.destroy(sessionError);
      });
      signal?.addEventListener("abort", handleAbort, { once: true });
      if (signal?.aborted) {
        handleAbort();
      }
      this.forwardLogs(child, callbacks);

      /** 整个设备端握手的截止时间。 */
      const handshakeDeadline = Date.now() + 12_000;
      /** 已验证设备端 Socket 就绪的视频连接。 */
      const videoConnection = await this.connectVideo(
        port,
        signal,
        handshakeDeadline,
        (socket) => {
          videoSocket = socket;
        },
        () => sessionError
      );
      videoSocket = videoConnection.socket;

      if (audioEnabled) {
        audioSocket = await waitForTask(
          this.dependencies.connectSocket(port),
          handshakeDeadline - Date.now(),
          signal,
          "连接 scrcpy 音频流超时",
          undefined,
          (socket) => socket.destroy()
        );
      }

      controlSocket = await waitForTask(
        this.dependencies.connectSocket(port),
        handshakeDeadline - Date.now(),
        signal,
        "连接 scrcpy 控制通道超时",
        undefined,
        (socket) => socket.destroy()
      );
      controlSocket.on?.("error", () => {
        // 控制通道异常不影响镜像与录制媒体继续传输。
      });

      /** 服务端在全部 Socket 接入后返回的设备名。 */
      const deviceName = await waitForTask(
        readScrcpyDeviceName(videoConnection.cursor),
        handshakeDeadline - Date.now(),
        signal,
        "读取 scrcpy 设备元数据超时",
        () => {
          videoSocket?.destroy();
          audioSocket?.destroy();
          controlSocket?.destroy();
        }
      );

      if (sessionError) {
        throw sessionError;
      }

      await this.dependencies.adb.removeForward(device.serial, port);
      sessionReady = true;
      signal?.removeEventListener("abort", handleAbort);

      /** 绑定当前视频尺寸的设备控制通道。 */
      const control = new ScrcpyControlChannel(controlSocket, device.apiLevel);
      /** 视频协议读取任务。 */
      const videoTask = this.pump(
        videoConnection.cursor,
        new ScrcpyPacketParser("video"),
        async (event) => {
          if (event.type === "session") {
            control.setScreenSize({
              width: event.width,
              height: event.height
            });
          }
          await callbacks.onVideoEvent(event);
        }
      );
      /** 音频协议读取任务。 */
      const audioTask = audioSocket
        ? this.pump(
            new SocketCursor(audioSocket),
            new ScrcpyPacketParser("audio"),
            callbacks.onAudioEvent ?? (() => undefined)
          )
        : Promise.resolve();
      /** 两条媒体流完成且失败时已互相收尾的任务。 */
      const done = this.settlePumps(
        videoTask,
        audioTask,
        () => sessionError,
        (error) => {
          sessionError ??= error;
          videoSocket?.destroy(error);
          audioSocket?.destroy(error);
          controlSocket?.destroy(error);
          child?.kill("SIGTERM");
        },
        () => {
          audioSocket?.destroy();
          controlSocket?.destroy();
          child?.kill("SIGTERM");
        }
      );
      /** 已确认建立的 adb shell 进程。 */
      const sessionProcess = child;

      return {
        scid,
        deviceName,
        process: sessionProcess,
        done,
        sendControl: (command) => control.send(command),
        close: () => {
          videoSocket?.destroy();
          audioSocket?.destroy();
          controlSocket?.destroy();
          sessionProcess.kill("SIGTERM");
        }
      };
    } catch (error) {
      signal?.removeEventListener("abort", handleAbort);
      videoSocket?.destroy();
      audioSocket?.destroy();
      controlSocket?.destroy();
      child?.kill("SIGTERM");
      await this.dependencies.adb
        .removeForward(device.serial, port)
        .catch(() => undefined);
      throw sessionError ?? error;
    }
  }

  /** 重试首个视频 Socket，并通过 dummy byte 验证设备端已就绪。 */
  private async connectVideo(
    port: number,
    signal: AbortSignal | undefined,
    deadline: number,
    onSocket: (socket: ScrcpySocket | undefined) => void,
    getSessionError: () => Error | undefined
  ): Promise<{
    socket: ScrcpySocket;
    cursor: SocketCursor;
  }> {
    /** 最近一次连接错误。 */
    let lastError: unknown;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (signal?.aborted || getSessionError()) {
        throw getSessionError() ?? createAbortError(signal);
      }
      if (Date.now() >= deadline) {
        break;
      }

      /** 本次连接 Socket。 */
      let socket: ScrcpySocket | undefined;
      try {
        socket = await waitForTask(
          this.dependencies.connectSocket(port),
          Math.min(1_000, deadline - Date.now()),
          signal,
          "连接 scrcpy-server 超时",
          undefined,
          (lateSocket) => lateSocket.destroy()
        );
        onSocket(socket);
        /** 首连接字节游标。 */
        const cursor = new SocketCursor(socket);
        await waitForTask(
          readScrcpyDummyByte(cursor),
          Math.min(2_000, deadline - Date.now()),
          signal,
          "等待 scrcpy-server 握手超时",
          () => socket?.destroy()
        );
        return { socket, cursor };
      } catch (error) {
        lastError = error;
        socket?.destroy();
        onSocket(undefined);
        if (
          signal?.aborted ||
          getSessionError() ||
          (error instanceof Error &&
            /握手超时|握手字节无效/.test(error.message))
        ) {
          throw getSessionError() ?? error;
        }
        await waitForTask(
          this.dependencies.wait(100),
          Math.min(200, deadline - Date.now()),
          signal,
          "等待 scrcpy-server 启动超时"
        );
      }
    }

    throw new Error(
      lastError instanceof Error
        ? `无法连接 scrcpy-server：${lastError.message}`
        : "无法连接 scrcpy-server"
    );
  }

  /** 发生首个媒体错误时关闭双流，并等待两条 pump 都结束。 */
  private async settlePumps(
    videoTask: Promise<void>,
    audioTask: Promise<void>,
    getSessionError: () => Error | undefined,
    failSession: (error: Error) => void,
    finishVideo: () => void
  ): Promise<void> {
    /** 将单条 pump 错误提升为整个会话错误。 */
    const observe = async (task: Promise<void>): Promise<void> => {
      try {
        await task;
      } catch (error) {
        /** 统一的媒体会话错误。 */
        const failure =
          getSessionError() ??
          (error instanceof Error ? error : new Error("scrcpy 媒体流异常"));
        failSession(failure);
        throw failure;
      }
    };
    /** 视频结束意味着本次录制流已结束。 */
    const video = observe(videoTask).finally(finishVideo);
    /** 音频允许先以 disabled 正常结束。 */
    const audio = observe(audioTask);
    await Promise.allSettled([video, audio]);

    /** 两条 pump 排空后的首个错误。 */
    const failure = getSessionError();
    if (failure) {
      throw failure;
    }
  }

  /** 解析完整媒体流并顺序等待消费者处理。 */
  private async pump(
    cursor: SocketCursor,
    parser: ScrcpyPacketParser,
    listener: (event: ScrcpyStreamEvent) => void | Promise<void>
  ): Promise<void> {
    for await (const chunk of cursor.remaining()) {
      for (const event of parser.push(chunk)) {
        await listener(event);
      }
    }
    parser.finish();
  }

  /** 把 adb shell 两个日志流汇总给录制服务。 */
  private forwardLogs(
    child: ChildProcessWithoutNullStreams,
    callbacks: ScrcpySessionCallbacks
  ): void {
    [child.stdout, child.stderr].forEach((stream) => {
      stream.on("data", (chunk: Buffer) => callbacks.onLog?.(chunk.toString()));
    });
  }
}

/** 创建生产环境 scrcpy 会话依赖。 */
export function createScrcpySessionDependencies(
  adbPath: string,
  serverPath: string,
  adb: AdbClient
): ScrcpySessionDependencies {
  return {
    adbPath,
    serverPath,
    adb,
    spawnProcess: (file, arguments_) =>
      spawn(file, arguments_, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      }),
    connectSocket: connectLocalSocket,
    createScid: () => randomInt(0, 0x80000000),
    wait: delay
  };
}
