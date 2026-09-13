/** @jest-environment node */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  DeviceInfo,
  RecordingPreset
} from "../../src/shared/types";
import {
  MirroringService,
  type MirrorSessionEndEvent,
  type MirroringServiceDependencies
} from "../../src/main/mirroring/service";
import type { RecordingMuxer } from "../../src/main/recording/service";
import type {
  ScrcpySessionCallbacks,
  ScrcpySessionHandle
} from "../../src/main/scrcpy/session";

/** 测试设备。 */
const device: DeviceInfo = {
  serial: "SERIAL",
  model: "Pixel 8 Pro",
  androidVersion: "14",
  apiLevel: 34,
  connectionType: "usb",
  status: "available"
};

/** 测试镜像预设。 */
const preset: RecordingPreset = {
  resolution: "1080p",
  videoBitrateMbps: 8,
  audioMode: "device"
};

/** 创建最小 adb shell 子进程桩。 */
function createChildProcess(): ChildProcessWithoutNullStreams {
  /** 具备进程事件能力的对象。 */
  const process = new EventEmitter() as ChildProcessWithoutNullStreams;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.kill = jest.fn().mockReturnValue(true);
  return process;
}

/** 可主动结束的镜像会话控制器。 */
interface SessionControl {
  /** scrcpy 会话句柄。 */
  handle: ScrcpySessionHandle;
  /** 正常结束会话。 */
  resolve(): void;
  /** 异常结束会话。 */
  reject(error: Error): void;
}

/** 创建镜像会话控制器。 */
function createSessionControl(
  sendControl = jest.fn().mockReturnValue(true)
): SessionControl {
  /** 完成回调。 */
  let resolve!: () => void;
  /** 失败回调。 */
  let reject!: (error: Error) => void;
  /** 可控完成任务。 */
  const done = new Promise<void>((resolveDone, rejectDone) => {
    resolve = resolveDone;
    reject = rejectDone;
  });
  /** 关闭会话。 */
  const close = jest.fn(() => resolve());

  return {
    handle: {
      scid: 0x19fb6c9,
      deviceName: device.model,
      process: createChildProcess(),
      done,
      sendControl,
      close
    },
    resolve,
    reject
  };
}

/** 创建镜像服务依赖。 */
function createDependencies(
  session: SessionControl,
  overrides: Partial<MirroringServiceDependencies> = {}
): MirroringServiceDependencies {
  return {
    sessionFactory: {
      start: jest.fn().mockResolvedValue(session.handle)
    },
    preview: {
      begin: jest.fn(),
      publishSession: jest.fn(),
      publishConfig: jest.fn(),
      publishPacket: jest.fn(),
      publishAudioConfig: jest.fn(),
      publishAudioPacket: jest.fn(),
      end: jest.fn(),
      error: jest.fn()
    },
    findServerPid: jest.fn().mockResolvedValue(undefined),
    interruptServer: jest.fn().mockImplementation(async () => session.resolve()),
    forceStopServer: jest.fn().mockResolvedValue(undefined),
    wait: async () => undefined,
    ...overrides
  };
}

/** 创建空录制封装器桩。 */
function createMuxer(): RecordingMuxer {
  return {
    handleVideoEvent: jest.fn().mockResolvedValue(undefined),
    handleAudioEvent: jest.fn().mockResolvedValue(undefined),
    finalize: jest.fn().mockResolvedValue({ hasAudio: true }),
    cancel: jest.fn().mockResolvedValue(undefined)
  };
}

describe("镜像会话服务", () => {
  it("独立启动单一会话并转发受限控制命令", async () => {
    /** 可控 scrcpy 会话。 */
    const session = createSessionControl();
    /** 镜像服务依赖。 */
    const dependencies = createDependencies(session);
    /** 镜像服务。 */
    const service = new MirroringService(dependencies);
    /** 状态序列。 */
    const states: string[] = [];
    service.onStateChanged((state) => states.push(state.status));

    await expect(service.start(device, preset)).resolves.toMatchObject({
      status: "mirroring",
      deviceSerial: device.serial,
      preset
    });
    service.sendControl({ type: "expand-notification-panel" });

    expect(dependencies.preview.begin).toHaveBeenCalledTimes(1);
    expect(dependencies.sessionFactory.start).toHaveBeenCalledTimes(1);
    expect(session.handle.sendControl).toHaveBeenCalledWith({
      type: "expand-notification-panel"
    });
    expect(states).toEqual(["starting", "mirroring"]);
    await service.stop();
  });

  it("相同参数重复启动保持幂等，不同设备或预设会被拒绝", async () => {
    /** 可控 scrcpy 会话。 */
    const session = createSessionControl();
    /** 镜像服务依赖。 */
    const dependencies = createDependencies(session);
    /** 镜像服务。 */
    const service = new MirroringService(dependencies);

    await service.start(device, preset);
    await expect(service.start(device, preset)).resolves.toMatchObject({
      status: "mirroring"
    });
    expect(dependencies.sessionFactory.start).toHaveBeenCalledTimes(1);
    expect(() =>
      service.start(device, { ...preset, videoBitrateMbps: 16 })
    ).toThrow("镜像中的设备或录制参数与当前选择不一致");
    await service.stop();
  });

  it("按最近一秒实际视频包刷新镜像帧率", async () => {
    jest.useFakeTimers();
    /** 可推进的镜像时钟。 */
    let now = 1_000;
    /** 可控 scrcpy 会话。 */
    const session = createSessionControl();
    /** 捕获的会话回调。 */
    let callbacks: ScrcpySessionCallbacks | undefined;
    /** 镜像服务。 */
    const service = new MirroringService(
      createDependencies(session, {
        now: () => now,
        sessionFactory: {
          start: jest.fn(async (_device, _preset, value) => {
            callbacks = value;
            return session.handle;
          })
        }
      })
    );

    await service.start(device, preset);
    for (let frame = 0; frame < 15; frame += 1) {
      await callbacks?.onVideoEvent({
        type: "packet",
        ptsUs: frame * 33_333,
        config: false,
        keyFrame: frame === 0,
        data: Buffer.from([frame])
      });
    }
    now += 500;
    jest.advanceTimersByTime(500);
    expect(service.getState()).toMatchObject({ fps: 30 });

    now += 1_000;
    jest.advanceTimersByTime(1_000);
    expect(service.getState()).toMatchObject({ fps: 0 });

    await service.stop();
    jest.useRealTimers();
  });

  it("镜像未就绪时拒绝录制上下文且不创建隐藏会话", () => {
    /** 可控 scrcpy 会话。 */
    const session = createSessionControl();
    /** 镜像服务依赖。 */
    const dependencies = createDependencies(session);
    /** 镜像服务。 */
    const service = new MirroringService(dependencies);

    expect(() => service.requireRecordingContext()).toThrow(
      "请先开启镜像后再开始录制"
    );
    expect(dependencies.sessionFactory.start).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({
      status: "idle",
      audioFallback: false
    });
  });

  it("返回当前镜像的只读录制上下文副本", async () => {
    /** 可控 scrcpy 会话。 */
    const session = createSessionControl();
    /** 镜像服务。 */
    const service = new MirroringService(createDependencies(session));

    await service.start(device, preset);
    /** 首次读取的录制上下文。 */
    const context = service.requireRecordingContext();
    context.device.model = "已修改";
    context.preset.videoBitrateMbps = 16;

    expect(service.requireRecordingContext()).toEqual({
      device,
      preset,
      audioFallback: false,
      audioFallbackReason: undefined
    });
    await service.stop();
  });

  it("独立镜像在录制器挂载期间拒绝结束，摘除后继续正常停止", async () => {
    /** 可控 scrcpy 会话。 */
    const session = createSessionControl();
    /** 镜像服务。 */
    const service = new MirroringService(createDependencies(session));
    /** 等待关键帧的录制器。 */
    const muxer = createMuxer();

    await service.start(device, preset);
    const attached = service.attachRecorder(muxer);
    await expect(service.stop()).rejects.toThrow("录制期间不能结束镜像");
    service.detachRecorder(muxer);
    await expect(attached).rejects.toThrow("录制启动已取消");
    await expect(service.stop()).resolves.toMatchObject({ status: "idle" });
  });

  it("设备断开时进入错误状态并通知录制收尾", async () => {
    /** 可控 scrcpy 会话。 */
    const session = createSessionControl();
    /** 镜像服务。 */
    const service = new MirroringService(createDependencies(session));
    /** 会话结束事件。 */
    const ended = new Promise<MirrorSessionEndEvent>((resolve) =>
      service.onSessionEnded(resolve)
    );

    await service.start(device, preset);
    service.handleDeviceDisconnected(device.serial);

    await expect(ended).resolves.toMatchObject({
      deviceSerial: device.serial,
      error: expect.objectContaining({ message: "设备已断开连接" })
    });
    expect(service.getState()).toMatchObject({
      status: "error",
      errorMessage: "设备已断开连接"
    });
  });

  it("启动握手期间可取消并恢复空闲状态", async () => {
    /** 未使用的会话。 */
    const session = createSessionControl();
    /** 等待取消信号的会话工厂。 */
    const startSession = jest.fn(
      async (
        _device: DeviceInfo,
        _preset: RecordingPreset,
        _callbacks: ScrcpySessionCallbacks,
        signal?: AbortSignal
      ): Promise<ScrcpySessionHandle> =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true
          });
        })
    );
    /** 镜像服务。 */
    const service = new MirroringService(
      createDependencies(session, {
        sessionFactory: { start: startSession }
      })
    );
    /** 启动任务。 */
    const starting = service.start(device, preset);

    while (!startSession.mock.calls.length) {
      await Promise.resolve();
    }
    await expect(service.stop()).resolves.toMatchObject({ status: "idle" });
    await expect(starting).rejects.toThrow("用户已取消镜像启动");
  });

  it("启动握手期间设备断开会保留明确错误", async () => {
    /** 未使用的会话。 */
    const session = createSessionControl();
    /** 等待设备断开信号的会话工厂。 */
    const startSession = jest.fn(
      async (
        _device: DeviceInfo,
        _preset: RecordingPreset,
        _callbacks: ScrcpySessionCallbacks,
        signal?: AbortSignal
      ): Promise<ScrcpySessionHandle> =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true
          });
        })
    );
    /** 镜像服务。 */
    const service = new MirroringService(
      createDependencies(session, {
        sessionFactory: { start: startSession }
      })
    );
    /** 启动任务。 */
    const starting = service.start(device, preset);

    service.handleDeviceDisconnected(device.serial);

    await expect(starting).rejects.toThrow("设备已断开连接");
    expect(service.getState()).toMatchObject({
      status: "error",
      errorMessage: "无法开启镜像：设备已断开连接"
    });
  });

  it("应用退出时直接关闭纯镜像会话", async () => {
    /** 可控 scrcpy 会话。 */
    const session = createSessionControl();
    /** 镜像服务依赖。 */
    const dependencies = createDependencies(session);
    /** 镜像服务。 */
    const service = new MirroringService(dependencies);

    await service.start(device, preset);
    service.close();

    expect(session.handle.close).toHaveBeenCalledTimes(1);
    expect(dependencies.preview.end).toHaveBeenCalledTimes(1);
    expect(service.getState()).toEqual({
      status: "idle",
      audioFallback: false
    });
  });

  it("音频禁用与控制失败只降级功能，不中断镜像", async () => {
    /** 拒绝控制写入的会话。 */
    const session = createSessionControl(jest.fn().mockReturnValue(false));
    /** 捕获的会话回调。 */
    let callbacks: ScrcpySessionCallbacks | undefined;
    /** 镜像服务。 */
    const service = new MirroringService(
      createDependencies(session, {
        sessionFactory: {
          start: jest.fn(async (_device, _preset, value) => {
            callbacks = value;
            return session.handle;
          })
        }
      })
    );

    await service.start(device, preset);
    await callbacks?.onAudioEvent?.({ type: "disabled" });
    service.sendControl({ type: "expand-notification-panel" });

    expect(service.getState()).toMatchObject({
      status: "mirroring",
      audioFallback: true,
      audioFallbackReason: "设备音频初始化失败，已自动改为静音",
      previewMessage:
        "设备未接受控制，请开启“USB 调试（安全设置）”后重试"
    });
    await service.stop();
  });
});
