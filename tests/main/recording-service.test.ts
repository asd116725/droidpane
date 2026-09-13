/** @jest-environment node */

import type {
  DeviceInfo,
  MirrorState,
  RecordingArtifact,
  RecordingPreset,
  RecordingState
} from "../../src/shared/types";
import type { MirrorSessionEndEvent } from "../../src/main/mirroring/service";
import {
  RecordingService,
  type RecordingMirrorSession,
  type RecordingMuxer,
  type RecordingServiceDependencies
} from "../../src/main/recording/service";

/** 测试设备。 */
const device: DeviceInfo = {
  serial: "3A261FDH2001234",
  model: "Pixel 8 Pro",
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

/** 测试录制产物。 */
const artifact: RecordingArtifact = {
  id: "019fb6c9-db73-7143-8737-e67e0c32ac80",
  fileName: "Pixel_8_Pro_2026-07-31_143208.mp4",
  durationSeconds: 138,
  sizeBytes: 48_600_000,
  width: 1080,
  height: 2400,
  hasAudio: true,
  mediaUrl:
    "adb-studio-media://artifact/019fb6c9-db73-7143-8737-e67e0c32ac80"
};

/** 可主动发布事件的镜像会话桩。 */
interface MirrorControl {
  /** 录制服务看到的镜像接口。 */
  session: jest.Mocked<RecordingMirrorSession>;
  /** 发布镜像状态。 */
  emitState(state: MirrorState): void;
  /** 发布镜像意外结束。 */
  emitEnd(event: MirrorSessionEndEvent): void;
}

/** 创建统一镜像会话桩。 */
function createMirrorControl(
  state: MirrorState = {
    status: "mirroring",
    deviceSerial: device.serial,
    preset,
    audioFallback: false,
    previewStatus: "live"
  }
): MirrorControl {
  /** 镜像状态监听器。 */
  const stateListeners = new Set<(value: MirrorState) => void>();
  /** 会话结束监听器。 */
  const endListeners = new Set<(value: MirrorSessionEndEvent) => void>();
  /** 当前镜像状态。 */
  let currentState = state;
  /** 镜像接口桩。 */
  const session: jest.Mocked<RecordingMirrorSession> = {
    requireRecordingContext: jest.fn(() => {
      if (currentState.status !== "mirroring" || !currentState.preset) {
        throw new Error("请先开启镜像后再开始录制");
      }
      return {
        device: { ...device },
        preset: { ...currentState.preset },
        audioFallback: currentState.audioFallback,
        audioFallbackReason: currentState.audioFallbackReason
      };
    }),
    attachRecorder: jest.fn().mockResolvedValue(1_000_000),
    detachRecorder: jest.fn(),
    onStateChanged: jest.fn((listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    }),
    onSessionEnded: jest.fn((listener) => {
      endListeners.add(listener);
      return () => endListeners.delete(listener);
    })
  };

  return {
    session,
    emitState: (nextState) => {
      currentState = nextState;
      stateListeners.forEach((listener) => listener(nextState));
    },
    emitEnd: (event) => {
      endListeners.forEach((listener) => listener(event));
    }
  };
}

/** 创建无重编码封装器桩。 */
function createMuxer(): jest.Mocked<RecordingMuxer> {
  return {
    handleVideoEvent: jest.fn().mockResolvedValue(undefined),
    handleAudioEvent: jest.fn().mockResolvedValue(undefined),
    finalize: jest.fn().mockResolvedValue({ hasAudio: true }),
    cancel: jest.fn().mockResolvedValue(undefined)
  };
}

/** 创建录制服务测试依赖。 */
function createDependencies(
  mirroring: RecordingMirrorSession,
  muxer: jest.Mocked<RecordingMuxer>,
  overrides: Partial<RecordingServiceDependencies> = {}
): RecordingServiceDependencies {
  return {
    getRecordingsDirectory: jest.fn(() => "/videos/DroidPane"),
    ensureDirectory: jest.fn().mockResolvedValue(undefined),
    inspectFile: jest.fn().mockResolvedValue({
      durationSeconds: 138,
      sizeBytes: 48_600_000,
      width: 1080,
      height: 2400,
      hasAudio: true
    }),
    registerArtifact: jest.fn().mockResolvedValue(artifact),
    mirroring,
    createMuxer: jest.fn(() => muxer),
    now: () => new Date(2026, 6, 31, 14, 32, 8),
    ...overrides
  };
}

describe("录制服务集成", () => {
  it("镜像未开启时拒绝录制且不产生文件副作用", async () => {
    /** 空闲镜像会话。 */
    const mirror = createMirrorControl({
      status: "idle",
      audioFallback: false
    });
    /** 录制服务依赖。 */
    const dependencies = createDependencies(mirror.session, createMuxer());
    /** 录制服务。 */
    const service = new RecordingService(dependencies);

    await expect(service.start()).rejects.toThrow(
      "请先开启镜像后再开始录制"
    );
    expect(service.getState()).toMatchObject({ status: "idle" });
    expect(dependencies.ensureDirectory).not.toHaveBeenCalled();
    expect(dependencies.createMuxer).not.toHaveBeenCalled();
  });

  it("从下一关键帧挂载录制器，停止时先摘除再完成 MP4", async () => {
    /** 统一镜像会话。 */
    const mirror = createMirrorControl();
    /** MP4 封装器。 */
    const muxer = createMuxer();
    /** 录制服务依赖。 */
    const dependencies = createDependencies(mirror.session, muxer);
    /** 录制服务。 */
    const service = new RecordingService(dependencies);
    /** 状态事件序列。 */
    const states: string[] = [];
    service.onStateChanged((state) => states.push(state.status));

    await expect(service.start()).resolves.toMatchObject({
      status: "recording",
      startedAt: new Date(2026, 6, 31, 14, 32, 8).getTime()
    });
    await expect(service.stop()).resolves.toMatchObject({
      status: "ready",
      artifactId: artifact.id
    });

    expect(mirror.session.requireRecordingContext).toHaveBeenCalledTimes(1);
    expect(mirror.session.attachRecorder).toHaveBeenCalledWith(muxer);
    expect(mirror.session.detachRecorder).toHaveBeenCalledWith(muxer);
    expect(muxer.finalize).toHaveBeenCalledTimes(1);
    expect(dependencies.createMuxer).toHaveBeenCalledWith(
      "/videos/DroidPane/Pixel_8_Pro_2026-07-31_143208.mp4",
      true,
      expect.objectContaining({ onVideoPacket: expect.any(Function) })
    );
    expect(states).toEqual(["starting", "recording", "stopping", "ready"]);
  });

  it("计时只在关键帧真正挂载后开始", async () => {
    /** 统一镜像会话。 */
    const mirror = createMirrorControl();
    /** 关键帧挂载完成回调。 */
    let resolveAttach!: (ptsUs: number) => void;
    mirror.session.attachRecorder.mockReturnValue(
      new Promise((resolve) => {
        resolveAttach = resolve;
      })
    );
    /** 录制服务。 */
    const service = new RecordingService(
      createDependencies(mirror.session, createMuxer())
    );
    /** 等待下一关键帧的启动任务。 */
    const starting = service.start();

    while (!mirror.session.attachRecorder.mock.calls.length) {
      await Promise.resolve();
    }
    expect(service.getState()).toMatchObject({ status: "starting" });
    expect(service.getState()).not.toHaveProperty("startedAt");
    resolveAttach(2_000_000);
    await expect(starting).resolves.toMatchObject({
      status: "recording",
      startedAt: expect.any(Number)
    });
  });

  it("等待关键帧期间停止会取消挂载且不生成空文件", async () => {
    /** 统一镜像会话。 */
    const mirror = createMirrorControl();
    /** 挂载拒绝回调。 */
    let rejectAttach!: (error: Error) => void;
    mirror.session.attachRecorder.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectAttach = reject;
      })
    );
    mirror.session.detachRecorder.mockImplementation(() =>
      rejectAttach(new Error("录制启动已取消"))
    );
    /** MP4 封装器。 */
    const muxer = createMuxer();
    /** 录制服务。 */
    const service = new RecordingService(
      createDependencies(mirror.session, muxer)
    );
    /** 等待关键帧的启动任务。 */
    const starting = service.start();

    while (!mirror.session.attachRecorder.mock.calls.length) {
      await Promise.resolve();
    }
    await expect(service.stop()).resolves.toMatchObject({ status: "idle" });
    await expect(starting).resolves.toMatchObject({ status: "idle" });
    expect(muxer.cancel).toHaveBeenCalledTimes(1);
    expect(muxer.finalize).not.toHaveBeenCalled();
  });

  it("镜像音频降级会同步到录制并建立静音封装器", async () => {
    /** 已发生音频降级的镜像。 */
    const mirror = createMirrorControl({
      status: "mirroring",
      deviceSerial: device.serial,
      preset,
      audioFallback: true,
      audioFallbackReason: "设备音频初始化失败"
    });
    /** 录制服务依赖。 */
    const dependencies = createDependencies(mirror.session, createMuxer());
    /** 录制服务。 */
    const service = new RecordingService(dependencies);

    await expect(service.start()).resolves.toMatchObject({
      status: "recording",
      audioFallback: true,
      audioFallbackReason: "设备音频初始化失败"
    });
    expect(dependencies.createMuxer).toHaveBeenCalledWith(
      expect.any(String),
      false,
      expect.objectContaining({ onVideoPacket: expect.any(Function) })
    );
    await service.stop();
  });

  it("按最近一秒实际收到的视频包刷新录制帧率", async () => {
    jest.useFakeTimers();
    /** 可推进的录制时钟。 */
    let now = 1_000;
    /** 统一镜像会话。 */
    const mirror = createMirrorControl();
    /** 录制服务依赖。 */
    const dependencies = createDependencies(mirror.session, createMuxer(), {
      now: () => new Date(now)
    });
    /** 录制服务。 */
    const service = new RecordingService(dependencies);

    await service.start();
    /** 封装器视频包回调。 */
    const onVideoPacket = (dependencies.createMuxer as jest.Mock).mock.calls[0][2]
      .onVideoPacket as () => void;
    for (let frame = 0; frame < 15; frame += 1) {
      onVideoPacket();
    }
    now += 500;
    jest.advanceTimersByTime(500);

    expect(service.getState()).toMatchObject({ fps: 30, elapsedMs: 500 });

    now += 1_000;
    jest.advanceTimersByTime(1_000);
    expect(service.getState()).toMatchObject({ fps: 0, elapsedMs: 1_500 });

    await service.stop();
    jest.useRealTimers();
  });

  it("设备断开导致镜像中断时尽力封装已有媒体", async () => {
    /** 统一镜像会话。 */
    const mirror = createMirrorControl();
    /** MP4 封装器。 */
    const muxer = createMuxer();
    /** 录制服务。 */
    const service = new RecordingService(
      createDependencies(mirror.session, muxer)
    );
    /** 等待最终状态。 */
    const finalized = new Promise<RecordingState>((resolve) => {
      service.onStateChanged((state) => {
        if (state.status === "ready") {
          resolve(state);
        }
      });
    });

    await service.start();
    mirror.emitEnd({
      deviceSerial: device.serial,
      error: new Error("设备已断开连接")
    });

    await expect(finalized).resolves.toMatchObject({
      status: "ready",
      artifactId: artifact.id
    });
    expect(muxer.finalize).toHaveBeenCalledTimes(1);
  });

  it("同一镜像会话可连续完成多个 MP4", async () => {
    /** 持续镜像会话。 */
    const mirror = createMirrorControl();
    /** 两次录制的封装器。 */
    const muxers = [createMuxer(), createMuxer()];
    /** 录制服务依赖。 */
    const dependencies = createDependencies(mirror.session, muxers[0], {
      createMuxer: jest
        .fn()
        .mockReturnValueOnce(muxers[0])
        .mockReturnValueOnce(muxers[1])
    });
    /** 录制服务。 */
    const service = new RecordingService(dependencies);

    await service.start();
    await service.stop();
    await service.start();
    await service.stop();

    expect(mirror.session.requireRecordingContext).toHaveBeenCalledTimes(2);
    expect(mirror.session.attachRecorder).toHaveBeenCalledTimes(2);
    expect(muxers[0].finalize).toHaveBeenCalledTimes(1);
    expect(muxers[1].finalize).toHaveBeenCalledTimes(1);
  });

  it("录制目录创建失败时进入明确错误状态", async () => {
    /** 统一镜像会话。 */
    const mirror = createMirrorControl();
    /** 录制服务依赖。 */
    const dependencies = createDependencies(mirror.session, createMuxer(), {
      ensureDirectory: jest
        .fn()
        .mockRejectedValue(new Error("磁盘写入失败"))
    });
    /** 录制服务。 */
    const service = new RecordingService(dependencies);

    await expect(service.start()).rejects.toThrow("磁盘写入失败");
    expect(service.getState()).toMatchObject({
      status: "error",
      errorMessage: "磁盘写入失败"
    });
    expect(mirror.session.requireRecordingContext).toHaveBeenCalledTimes(1);
    expect(dependencies.createMuxer).not.toHaveBeenCalled();
  });
});
