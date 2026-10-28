/** @jest-environment node */

import { MirrorRecoveryService, type MirrorRecoveryDependencies } from "../../src/main/mirroring/recovery-service";
import type { MirrorSessionEndEvent } from "../../src/main/mirroring/service";
import type { DeviceInfo, MirrorState, RecordingPreset, RecordingState } from "../../src/shared/types";

const device: DeviceInfo = {
  serial: "USB-A", model: "Pixel 8", androidVersion: "14", apiLevel: 34,
  connectionType: "usb", status: "available"
};
const preset: RecordingPreset = { resolution: "1080p", videoBitrateMbps: 8, audioMode: "device" };

/** 控制晚到的设备发现或会话启动，用于验证取消竞态。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** 保留真实状态订阅时序的镜像桩，避免只断言内部方法调用。 */
function createHarness(overrides: Partial<MirrorRecoveryDependencies> = {}) {
  let state: MirrorState = { status: "idle", audioFallback: false };
  const states = new Set<(value: MirrorState) => void>();
  const ends = new Set<(event: MirrorSessionEndEvent) => void>();
  const publish = (next: MirrorState): void => {
    state = next;
    states.forEach((listener) => listener({ ...next }));
  };
  const mirroring = {
    getState: () => ({ ...state }),
    start: jest.fn(async (target: DeviceInfo, selected: RecordingPreset): Promise<MirrorState> => {
      publish({ status: "mirroring", deviceSerial: target.serial, preset: selected,
        audioFallback: false, previewStatus: "connecting" });
      return { ...state };
    }),
    stop: jest.fn(async (): Promise<MirrorState> => {
      publish({ status: "idle", audioFallback: false });
      return { ...state };
    }),
    cancelPendingStart: jest.fn(),
    onStateChanged: (listener: (value: MirrorState) => void) => {
      states.add(listener);
      return () => states.delete(listener);
    },
    onSessionEnded: (listener: (event: MirrorSessionEndEvent) => void) => {
      ends.add(listener);
      return () => ends.delete(listener);
    }
  };
  const recordingState: RecordingState = { status: "idle", elapsedMs: 0, audioFallback: false };
  const recording = {
    getState: jest.fn(() => recordingState),
    stop: jest.fn(async (): Promise<RecordingState> => recordingState)
  };
  const resolveDevice = jest.fn(async (): Promise<DeviceInfo | undefined> => device);
  const service = new MirrorRecoveryService({
    mirroring, recording, resolveDevice, retryDelayMs: 100, timeoutMs: 1_000, ...overrides
  });
  return {
    service, mirroring, recording, recordingState, resolveDevice, publish,
    live: () => publish({ ...state, previewStatus: "live" }),
    disconnect: () => {
      const serial = state.deviceSerial ?? device.serial;
      publish({ ...state, status: "error", previewStatus: "unavailable", errorMessage: "设备断开" });
      ends.forEach((listener) => listener({ deviceSerial: serial, error: new Error("设备断开") }));
    }
  };
}

describe("镜像有限恢复", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("仅在恢复设备的实际画面 live 后宣布成功，并保留原预设", async () => {
    const h = createHarness();
    await h.service.start(device, preset);
    h.disconnect();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.service.getState()).toMatchObject({ status: "starting", attempt: 1 });
    expect(h.mirroring.start).toHaveBeenLastCalledWith(device, preset);

    h.live();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.service.getState()).toMatchObject({ status: "recovered", deadline: undefined });
    await jest.advanceTimersByTimeAsync(2_000);
    expect(h.service.getState().status).toBe("recovered");
    h.service.close();
  });

  it("主动停止后晚到的设备发现和结束事件都不能重新启动镜像", async () => {
    const found = deferred<DeviceInfo | undefined>();
    const h = createHarness({ resolveDevice: () => found.promise });
    await h.service.start(device, preset);
    h.disconnect();
    await jest.advanceTimersByTimeAsync(0);
    await h.service.stop();
    found.resolve(device);
    h.disconnect();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(h.mirroring.start).toHaveBeenCalledTimes(1);
    expect(h.service.getState().status).toBe("idle");
    h.service.close();
  });

  it("发现任务不返回也会按期限失败，手动重试从新期限开始", async () => {
    const found = deferred<DeviceInfo | undefined>();
    const h = createHarness({ resolveDevice: () => found.promise });
    await h.service.start(device, preset);
    h.disconnect();
    const firstDeadline = h.service.getState().deadline;
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.service.getState()).toMatchObject({ status: "failed", deadline: undefined });
    await h.service.retry();
    expect(h.service.getState().deadline).toBe((firstDeadline ?? 0) + 1_000);
    await h.service.cancel();
    found.resolve(device);
    await jest.advanceTimersByTimeAsync(0);
    expect(h.service.getState().status).toBe("canceled");
    expect(h.mirroring.start).toHaveBeenCalledTimes(1);
    h.service.close();
  });

  it("连接握手后没有有效画面仍会超时，并关闭本轮候选镜像", async () => {
    const h = createHarness();
    await h.service.start(device, preset);
    h.disconnect();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.mirroring.getState().status).toBe("mirroring");
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.service.getState().status).toBe("failed");
    expect(h.mirroring.getState().status).toBe("idle");
    h.service.close();
  });

  it("旧恢复启动晚到后先清理，不能覆盖或关闭用户新选的设备", async () => {
    const pending = deferred<MirrorState>();
    const h = createHarness();
    await h.service.start(device, preset);
    h.mirroring.start.mockImplementationOnce(() => pending.promise);
    h.disconnect();
    await jest.advanceTimersByTimeAsync(0);
    const other = { ...device, serial: "USB-B" };
    const newStart = h.service.start(other, preset);
    expect(h.mirroring.cancelPendingStart).toHaveBeenCalledTimes(1);
    pending.resolve({ status: "mirroring", deviceSerial: device.serial, audioFallback: false });
    await newStart;
    await jest.advanceTimersByTimeAsync(0);
    expect(h.mirroring.getState()).toMatchObject({ status: "mirroring", deviceSerial: other.serial });
    expect(h.mirroring.start).toHaveBeenCalledTimes(3);
    h.service.close();
  });

  it("等旧录制完成封装后再启动新镜像，恢复后不自动录制", async () => {
    const saved = deferred<RecordingState>();
    const h = createHarness();
    await h.service.start(device, preset);
    h.recordingState.status = "stopping";
    h.recording.stop.mockImplementationOnce(() => saved.promise);
    h.disconnect();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.mirroring.start).toHaveBeenCalledTimes(1);
    saved.resolve({ status: "ready", elapsedMs: 1_000, audioFallback: false, artifactId: "saved" });
    await jest.advanceTimersByTimeAsync(0);
    expect(h.mirroring.start).toHaveBeenCalledTimes(2);
    h.live();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.service.getState().status).toBe("recovered");
    h.service.close();
  });

  it("设备尚未上线时有限重试，退出会取消后续等待", async () => {
    const resolveDevice = jest.fn(async () => undefined);
    const h = createHarness({ resolveDevice });
    await h.service.start(device, preset);
    h.disconnect();
    await jest.advanceTimersByTimeAsync(250);
    expect(resolveDevice).toHaveBeenCalledTimes(3);
    h.service.close();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(resolveDevice).toHaveBeenCalledTimes(3);
  });

  it("显式启动尚未完成时主动停止，不留下晚到的活动镜像", async () => {
    const pending = deferred<MirrorState>();
    const h = createHarness();
    h.mirroring.start.mockImplementationOnce(() => pending.promise);
    const startup = h.service.start(device, preset);
    const rejectedStartup = expect(startup).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(0);
    const stopped = h.service.stop();
    expect(h.mirroring.cancelPendingStart).toHaveBeenCalledTimes(1);
    pending.resolve({ status: "mirroring", deviceSerial: device.serial, audioFallback: false });
    await rejectedStartup;
    await stopped;
    expect(h.mirroring.getState().status).toBe("idle");
    h.disconnect();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(h.mirroring.start).toHaveBeenCalledTimes(1);
    h.service.close();
  });

  it("重复启动同一设备不会停止正在进行的录制", async () => {
    const h = createHarness();
    await h.service.start(device, preset);
    h.recordingState.status = "recording";
    const stops = h.recording.stop.mock.calls.length;
    await h.service.start(device, { audioMode: "device", videoBitrateMbps: 8, resolution: "1080p" });
    expect(h.recording.stop).toHaveBeenCalledTimes(stops);
    await expect(h.service.start({ ...device, serial: "USB-B" }, preset)).rejects.toThrow("请先停止录制");
    expect(h.mirroring.getState().deviceSerial).toBe(device.serial);
    h.service.close();
  });

  it("录制中停止被拒绝后仍保留同一设备的自动恢复意图", async () => {
    const h = createHarness();
    await h.service.start(device, preset);
    h.recordingState.status = "recording";
    await expect(h.service.stop()).rejects.toThrow("录制期间不能结束镜像");
    h.recordingState.status = "stopping";
    h.disconnect();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.service.getState().status).toBe("starting");
    expect(h.mirroring.start).toHaveBeenCalledTimes(2);
    h.service.close();
  });

  it("超时清理录制失败仍关闭候选镜像，不产生未处理的后台拒绝", async () => {
    const h = createHarness();
    await h.service.start(device, preset);
    h.disconnect();
    await jest.advanceTimersByTimeAsync(0);
    h.recording.stop.mockRejectedValueOnce(new Error("封装失败"));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.service.getState().status).toBe("failed");
    expect(h.mirroring.getState().status).toBe("idle");
    h.service.close();
  });
});
