/** @jest-environment node */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { DeviceInfo, RecordingPreset } from "../../src/shared/types";
import {
  ScrcpySessionFactory,
  type ScrcpySessionDependencies
} from "../../src/main/scrcpy/session";
import type { ScrcpyStreamEvent } from "../../src/main/scrcpy/protocol";

/** 测试设备。 */
const device: DeviceInfo = {
  serial: "SERIAL",
  model: "Android Device",
  androidVersion: "14",
  apiLevel: 34,
  connectionType: "usb",
  status: "available"
};

/** 测试录制预设。 */
const preset: RecordingPreset = {
  resolution: "1080p",
  videoBitrateMbps: 8,
  audioMode: "device"
};

/** 创建可控 adb shell 子进程。 */
function createChild(): ChildProcessWithoutNullStreams {
  /** 具备子进程事件和标准流的测试对象。 */
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn().mockReturnValue(true);
  Object.defineProperty(child, "pid", { value: 9_001 });
  return child;
}

/** 构造 H.264 视频流。 */
function createVideoStream(): PassThrough {
  /** 首连接握手和视频数据。 */
  const stream = new PassThrough();
  /** 固定长度设备名。 */
  const name = Buffer.alloc(64);
  name.write("Android Device");
  /** 视频会话包。 */
  const session = Buffer.alloc(12);
  session.writeUInt32BE(0x80000000, 0);
  session.writeUInt32BE(480, 4);
  session.writeUInt32BE(640, 8);
  /** 关键帧包。 */
  const frame = Buffer.alloc(12 + 5);
  frame.writeBigUInt64BE((1n << 61n) | 1_000_000n, 0);
  frame.writeUInt32BE(5, 8);
  Buffer.from([0, 0, 0, 1, 0x65]).copy(frame, 12);
  stream.end(
    Buffer.concat([
      Buffer.from([0]),
      name,
      Buffer.from([0x68, 0x32, 0x36, 0x34]),
      session,
      frame
    ])
  );
  return stream;
}

/** 创建单流会话的通用测试依赖。 */
function createDependencies(
  connectSocket: ScrcpySessionDependencies["connectSocket"],
  child = createChild()
): {
  dependencies: ScrcpySessionDependencies;
  adb: ScrcpySessionDependencies["adb"];
  child: ChildProcessWithoutNullStreams;
} {
  /** ADB 固定操作。 */
  const adb = {
    pushServer: jest.fn().mockResolvedValue(undefined),
    createForward: jest.fn().mockResolvedValue(38127),
    removeForward: jest.fn().mockResolvedValue(undefined)
  };

  return {
    adb,
    child,
    dependencies: {
      adbPath: "/runtime/adb",
      serverPath: "/runtime/scrcpy-server",
      adb,
      spawnProcess: jest.fn(() => child),
      connectSocket,
      createScid: () => 0x19fb6c9,
      wait: async () => undefined
    }
  };
}

describe("scrcpy 单流会话", () => {
  it("只启动一个 Server，并按视频、音频顺序连接同一 forward 端口", async () => {
    /** 视频连接。 */
    const video = createVideoStream();
    /** 设备主动禁用的音频连接。 */
    const audio = new PassThrough();
    audio.end(Buffer.alloc(4));
    /** 设备控制连接。 */
    const control = new PassThrough();
    /** Socket 连接器。 */
    const connectSocket = jest
      .fn()
      .mockResolvedValueOnce(video)
      .mockResolvedValueOnce(audio)
      .mockResolvedValueOnce(control);
    /** 会话外部依赖。 */
    const { dependencies, adb } = createDependencies(connectSocket);
    /** 收到的视频事件。 */
    const videoEvents: ScrcpyStreamEvent[] = [];
    /** 收到的音频事件。 */
    const audioEvents: ScrcpyStreamEvent[] = [];
    /** 会话工厂。 */
    const factory = new ScrcpySessionFactory(dependencies);

    /** 已建立的单路会话。 */
    const session = await factory.start(device, preset, {
      onVideoEvent: (event) => {
        videoEvents.push(event);
      },
      onAudioEvent: (event) => {
        audioEvents.push(event);
      }
    });
    await session.done;

    expect(adb.pushServer).toHaveBeenCalledTimes(1);
    expect(adb.createForward).toHaveBeenCalledWith(
      "SERIAL",
      "scrcpy_019fb6c9"
    );
    expect(connectSocket.mock.calls).toEqual([
      [38127],
      [38127],
      [38127]
    ]);
    expect(adb.removeForward).toHaveBeenCalledWith("SERIAL", 38127);
    expect(dependencies.spawnProcess).toHaveBeenCalledTimes(1);
    expect(videoEvents).toEqual([
      { type: "codec", codec: "h264" },
      {
        type: "session",
        width: 480,
        height: 640,
        clientResized: false
      },
      {
        type: "packet",
        ptsUs: 1_000_000,
        config: false,
        keyFrame: true,
        data: Buffer.from([0, 0, 0, 1, 0x65])
      }
    ]);
    expect(audioEvents).toEqual([{ type: "disabled" }]);
    expect(session.deviceName).toBe("Android Device");
  });

  it("启动取消时立即关闭握手 Socket 并移除 forward", async () => {
    /** 一直等待 dummy byte 的视频连接。 */
    const video = new PassThrough();
    /** 可观察的视频连接器。 */
    const connectSocket = jest.fn().mockResolvedValue(video);
    /** 会话测试依赖。 */
    const { dependencies, adb, child } = createDependencies(
      connectSocket
    );
    /** 外部启动取消器。 */
    const controller = new AbortController();
    /** 尚在握手的启动任务。 */
    const start = new ScrcpySessionFactory(dependencies).start(
      device,
      preset,
      {
        onVideoEvent: jest.fn()
      },
      controller.signal
    );

    while (!connectSocket.mock.calls.length) {
      await Promise.resolve();
    }
    controller.abort(new Error("用户取消"));

    await expect(start).rejects.toThrow("用户取消");
    expect(video.destroyed).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(adb.removeForward).toHaveBeenCalledWith("SERIAL", 38127);
  });

  it("子进程早期 error 不会成为未处理异常", async () => {
    /** 正在等待握手的连接。 */
    const video = new PassThrough();
    /** 可控 adb shell 子进程。 */
    const child = createChild();
    /** 可观察的视频连接器。 */
    const connectSocket = jest.fn().mockResolvedValue(video);
    /** 会话测试依赖。 */
    const { dependencies } = createDependencies(
      connectSocket,
      child
    );
    /** 启动任务。 */
    const start = new ScrcpySessionFactory(dependencies).start(
      device,
      preset,
      { onVideoEvent: jest.fn() }
    );

    while (!connectSocket.mock.calls.length) {
      await Promise.resolve();
    }
    child.emit("error", new Error("spawn adb ENOENT"));

    await expect(start).rejects.toThrow("spawn adb ENOENT");
    expect(video.destroyed).toBe(true);
  });

  it("视频 pump 失败时关闭音频流并等待双流收尾", async () => {
    /** 含握手与错误 Codec 的视频流。 */
    const video = new PassThrough();
    /** 固定长度设备名。 */
    const name = Buffer.alloc(64);
    name.write("Android Device");
    video.end(
      Buffer.concat([
        Buffer.from([0]),
        name,
        Buffer.from([0x76, 0x70, 0x39, 0x30])
      ])
    );
    /** 保持打开的音频流。 */
    const audio = new PassThrough();
    audio.write(Buffer.from([0x00, 0x61, 0x61, 0x63]));
    /** 保持打开的控制流。 */
    const control = new PassThrough();
    /** 顺序提供视频和音频 Socket。 */
    const connectSocket = jest
      .fn()
      .mockResolvedValueOnce(video)
      .mockResolvedValueOnce(audio)
      .mockResolvedValueOnce(control);
    /** 会话测试依赖。 */
    const { dependencies, child } = createDependencies(connectSocket);
    /** 已建立的媒体会话。 */
    const session = await new ScrcpySessionFactory(dependencies).start(
      device,
      preset,
      {
        onVideoEvent: jest.fn(),
        onAudioEvent: jest.fn()
      }
    );

    await expect(session.done).rejects.toThrow("不支持的 scrcpy video Codec");
    expect(audio.destroyed).toBe(true);
    expect(control.destroyed).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
