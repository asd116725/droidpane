import { act, renderHook } from "@testing-library/react";
import { ipcChannels } from "../../src/shared/ipc";
import type { AdbStudioApi } from "../../src/shared/types";
import { useLivePreview } from "../../src/renderer/use-live-preview";

describe("实时预览后台连续性", () => {
  /** 原始 Worker 构造器。 */
  const originalWorker = globalThis.Worker;

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: originalWorker
    });
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it.each(["visible", "hidden"] as const)(
    "在 %s 状态连接后，反复切换后台复用画布和 Worker，仅显式重试才恢复预览",
    (initialVisibility) => {
      jest.useFakeTimers();
      /** 可模拟窗口遮挡、隐藏及恢复的可见性。 */
      const visibility = jest.spyOn(document, "visibilityState", "get");
      visibility.mockReturnValue(initialVisibility);
      /** 预览 Worker 桩。 */
      const worker = {
        onmessage: null as ((event: MessageEvent) => void) | null,
        postMessage: jest.fn(),
        terminate: jest.fn()
      };
      /** 可观察创建次数的 Worker 构造器。 */
      const workerConstructor = jest.fn(() => worker);
      Object.defineProperty(globalThis, "Worker", {
        configurable: true,
        value: workerConstructor
      });
      /** 只需请求媒体端口的页面 API。 */
      const api = { requestLivePreview: jest.fn() } as unknown as AdbStudioApi;
      /** 实际预览 Hook。 */
      const { result, unmount } = renderHook(() => useLivePreview(api));
      /** 待转交给 Worker 的媒体端口。 */
      const port = { close: jest.fn() };
      /** 实际舞台画布。 */
      const canvas = document.createElement("canvas");
      /** 用于检查重复转交的离屏画布桩。 */
      const transfer = jest.fn(() => ({}));
      Object.defineProperty(canvas, "transferControlToOffscreen", {
        value: transfer
      });

      act(() => {
        result.current.canvasRef(canvas);
        window.dispatchEvent(new MessageEvent("message", {
          source: window,
          data: { type: ipcChannels.livePreviewPort, workerUrl: "worker.js" },
          ports: [port as unknown as MessagePort]
        }));
        worker.onmessage?.({
          data: { type: "status", status: "live" }
        } as MessageEvent);
      });

      expect(worker.postMessage.mock.calls.map(([message]) => message.type))
        .toEqual(["connect", "canvas"]);
      worker.postMessage.mockClear();

      for (let cycle = 0; cycle < 3; cycle += 1) {
        act(() => {
          visibility.mockReturnValue("hidden");
          window.dispatchEvent(new Event("blur"));
          document.dispatchEvent(new Event("visibilitychange"));
          jest.advanceTimersByTime(5_000);
          visibility.mockReturnValue("visible");
          document.dispatchEvent(new Event("visibilitychange"));
          window.dispatchEvent(new Event("focus"));
        });
        expect(result.current.status).toBe("live");
      }

      expect(worker.postMessage).not.toHaveBeenCalled();
      expect(worker.terminate).not.toHaveBeenCalled();
      expect(workerConstructor).toHaveBeenCalledTimes(1);
      expect(api.requestLivePreview).toHaveBeenCalledTimes(1);
      expect(transfer).toHaveBeenCalledTimes(1);
      expect(result.current.canvasGeneration).toBe(0);

      act(() => result.current.retry());
      expect(worker.postMessage).toHaveBeenCalledTimes(1);
      expect(worker.postMessage).toHaveBeenLastCalledWith({ type: "retry" });
      expect(result.current.status).toBe("connecting");

      unmount();
      jest.runOnlyPendingTimers();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    }
  );
});
