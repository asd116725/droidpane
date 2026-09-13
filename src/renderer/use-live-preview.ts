import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefCallback
} from "react";
import { ipcChannels } from "../shared/ipc";
import type { AdbStudioApi, LivePreviewStatus } from "../shared/types";
import { AudioMonitorPlayer } from "./audio-monitor";

/** Worker 返回的实时预览状态。 */
interface WorkerStatusMessage {
  /** 固定消息类型。 */
  type: "status";
  /** 当前预览状态。 */
  status: LivePreviewStatus;
  /** 可选提示。 */
  message?: string;
}

/** Worker 返回的视频尺寸消息。 */
interface WorkerSizeMessage {
  /** 固定消息类型。 */
  type: "size";
  /** 视频像素宽度。 */
  width: number;
  /** 视频像素高度。 */
  height: number;
}

/** Worker 返回的电脑监听状态。 */
interface WorkerAudioStatusMessage {
  /** 固定消息类型。 */
  type: "audio-status";
  /** 当前监听状态。 */
  status: AudioMonitorStatus;
  /** 可选提示。 */
  message?: string;
}

/** Worker 返回的解码音频。 */
interface WorkerAudioDataMessage {
  /** 固定消息类型。 */
  type: "audio-data";
  /** 待播放的 PCM 数据。 */
  data: AudioData;
}

/** 电脑端音频监听状态。 */
export type AudioMonitorStatus =
  | "off"
  | "connecting"
  | "live"
  | "unavailable";

/** 实时预览视频尺寸。 */
export interface LivePreviewSize {
  /** 视频像素宽度。 */
  width: number;
  /** 视频像素高度。 */
  height: number;
}

/** React 使用的实时预览控制器。 */
export interface LivePreviewController {
  /** 当前预览状态。 */
  status: LivePreviewStatus;
  /** 当前预览提示。 */
  message?: string;
  /** 当前视频尺寸。 */
  size?: LivePreviewSize;
  /** Worker 重建时用于替换已转交的画布。 */
  canvasGeneration: number;
  /** 绑定舞台画布。 */
  canvasRef: RefCallback<HTMLCanvasElement>;
  /** 从下一关键帧恢复预览。 */
  retry(): void;
  /** 电脑端监听是否开启。 */
  audioMonitoring: boolean;
  /** 电脑端监听状态。 */
  audioMonitorStatus: AudioMonitorStatus;
  /** 电脑端监听提示。 */
  audioMonitorMessage?: string;
  /** 开启或关闭电脑端监听。 */
  setAudioMonitoring(enabled: boolean, volume: number): Promise<void>;
  /** 更新电脑端监听音量。 */
  setAudioMonitorVolume(volume: number): void;
}

/** 判断 Worker 状态消息是否有效。 */
function isWorkerStatusMessage(value: unknown): value is WorkerStatusMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  /** 待校验消息。 */
  const message = value as Record<string, unknown>;
  return (
    message.type === "status" &&
    ["connecting", "live", "paused", "unavailable"].includes(
      message.status as string
    )
  );
}

/** 判断 Worker 视频尺寸消息是否有效。 */
function isWorkerSizeMessage(value: unknown): value is WorkerSizeMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  /** 待校验消息。 */
  const message = value as Record<string, unknown>;
  return (
    message.type === "size" &&
    Number.isInteger(message.width) &&
    Number(message.width) > 0 &&
    Number.isInteger(message.height) &&
    Number(message.height) > 0
  );
}

/** 判断 Worker 监听状态消息是否有效。 */
function isWorkerAudioStatusMessage(
  value: unknown
): value is WorkerAudioStatusMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  /** 待校验消息。 */
  const message = value as Record<string, unknown>;
  return (
    message.type === "audio-status" &&
    ["off", "connecting", "live", "unavailable"].includes(
      message.status as string
    )
  );
}

/** 判断 Worker 解码音频消息是否有效。 */
function isWorkerAudioDataMessage(
  value: unknown
): value is WorkerAudioDataMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as Record<string, unknown>).type === "audio-data" &&
      (value as Record<string, unknown>).data
  );
}

/** 把一个 DOM 画布转交给预览 Worker。 */
function transferCanvas(
  element: HTMLCanvasElement,
  worker: Worker,
  transferred: WeakSet<HTMLCanvasElement>
): void {
  if (transferred.has(element)) {
    return;
  }

  /** Worker 拥有的离屏画布。 */
  const canvas = element.transferControlToOffscreen();
  transferred.add(element);
  worker.postMessage({ type: "canvas", canvas }, [canvas]);
}

/** 建立固定 MessagePort、Worker 与 OffscreenCanvas 预览链路。 */
export function useLivePreview(api: AdbStudioApi): LivePreviewController {
  /** 当前预览状态。 */
  const [status, setStatus] = useState<LivePreviewStatus>("connecting");
  /** 当前预览提示。 */
  const [message, setMessage] = useState<string>();
  /** 当前视频尺寸。 */
  const [size, setSize] = useState<LivePreviewSize>();
  /** 电脑端监听是否开启。 */
  const [audioMonitoring, setAudioMonitoringState] = useState(false);
  /** 电脑端监听状态。 */
  const [audioMonitorStatus, setAudioMonitorStatus] =
    useState<AudioMonitorStatus>("off");
  /** 电脑端监听提示。 */
  const [audioMonitorMessage, setAudioMonitorMessage] = useState<string>();
  /** 已转交画布的重建序号。 */
  const [canvasGeneration, setCanvasGeneration] = useState(0);
  /** 当前预览 Worker。 */
  const workerRef = useRef<Worker | undefined>(undefined);
  /** 页面侧低延迟音频播放器。 */
  const audioPlayerRef = useRef<AudioMonitorPlayer | undefined>(undefined);
  /** 跨 Worker 重建保留的监听开关。 */
  const audioMonitoringRef = useRef(false);
  if (!audioPlayerRef.current) {
    audioPlayerRef.current = new AudioMonitorPlayer();
  }
  /** 等待 Worker 的画布。 */
  const canvasRef = useRef<HTMLCanvasElement | undefined>(undefined);
  /** 已转交控制权的画布。 */
  const transferredCanvases = useRef(new WeakSet<HTMLCanvasElement>());
  /** 是否已经请求固定端口。 */
  const requested = useRef(false);
  /** StrictMode 清理延迟任务。 */
  const cleanupTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );

  useEffect(() => {
    if (cleanupTimer.current) {
      clearTimeout(cleanupTimer.current);
      cleanupTimer.current = undefined;
    }

    /** 接收预加载脚本转交的固定媒体端口。 */
    const handlePort = (event: MessageEvent): void => {
      if (
        event.source !== window ||
        !event.data ||
        event.data.type !== ipcChannels.livePreviewPort ||
        typeof event.data.workerUrl !== "string" ||
        !event.ports[0]
      ) {
        return;
      }

      /** 固定的主进程媒体端口。 */
      const port = event.ports[0];
      if (workerRef.current) {
        port.close();
        return;
      }

      /** 独立 WebCodecs 解码 Worker。 */
      let worker: Worker;
      try {
        worker = new Worker(event.data.workerUrl, {
          name: "droidpane-live-preview"
        });
      } catch {
        port.close();
        requested.current = false;
        setStatus("unavailable");
        setMessage("实时预览 Worker 启动失败，不影响镜像与录制");
        audioMonitoringRef.current = false;
        setAudioMonitoringState(false);
        setAudioMonitorStatus("unavailable");
        setAudioMonitorMessage("电脑端音频监听不可用，不影响镜像与录制");
        audioPlayerRef.current?.disable();
        return;
      }

      worker.onmessage = (workerEvent: MessageEvent<unknown>) => {
        if (isWorkerStatusMessage(workerEvent.data)) {
          setStatus(workerEvent.data.status);
          setMessage(workerEvent.data.message);
        } else if (isWorkerSizeMessage(workerEvent.data)) {
          setSize({
            width: workerEvent.data.width,
            height: workerEvent.data.height
          });
        } else if (isWorkerAudioStatusMessage(workerEvent.data)) {
          setAudioMonitorStatus(workerEvent.data.status);
          setAudioMonitorMessage(workerEvent.data.message);
          if (["off", "unavailable"].includes(workerEvent.data.status)) {
            audioMonitoringRef.current = false;
            setAudioMonitoringState(false);
            audioPlayerRef.current?.disable();
          }
        } else if (isWorkerAudioDataMessage(workerEvent.data)) {
          try {
            if (audioPlayerRef.current) {
              audioPlayerRef.current.play(workerEvent.data.data);
            } else {
              workerEvent.data.data.close();
            }
          } catch {
            audioMonitoringRef.current = false;
            setAudioMonitoringState(false);
            setAudioMonitorStatus("unavailable");
            setAudioMonitorMessage("电脑端音频播放失败，不影响镜像与录制");
            audioPlayerRef.current?.disable();
            worker.postMessage({ type: "audio-monitor", enabled: false });
          }
        }
      };
      worker.onerror = () => {
        worker.terminate();
        if (workerRef.current === worker) {
          workerRef.current = undefined;
          canvasRef.current = undefined;
          requested.current = false;
        }
        setStatus("unavailable");
        setMessage("实时预览 Worker 启动失败，不影响镜像与录制");
        audioMonitoringRef.current = false;
        setAudioMonitoringState(false);
        setAudioMonitorStatus("unavailable");
        setAudioMonitorMessage("电脑端音频监听不可用，不影响镜像与录制");
        audioPlayerRef.current?.disable();
      };
      workerRef.current = worker;
      worker.postMessage({ type: "connect", port }, [port]);
      if (audioMonitoringRef.current) {
        worker.postMessage({ type: "audio-monitor", enabled: true });
      }

      if (canvasRef.current) {
        transferCanvas(
          canvasRef.current,
          worker,
          transferredCanvases.current
        );
      }
    };

    window.addEventListener("message", handlePort);
    if (!requested.current) {
      requested.current = true;
      api.requestLivePreview();
    }

    return () => {
      window.removeEventListener("message", handlePort);
      cleanupTimer.current = setTimeout(() => {
        workerRef.current?.terminate();
        workerRef.current = undefined;
        audioPlayerRef.current?.dispose();
        audioPlayerRef.current = undefined;
        audioMonitoringRef.current = false;
      }, 0);
    };
  }, [api]);

  /** 绑定或解除当前实时画布。 */
  const attachCanvas = useCallback((element: HTMLCanvasElement | null): void => {
    canvasRef.current = element ?? undefined;
    if (element && workerRef.current) {
      try {
        transferCanvas(element, workerRef.current, transferredCanvases.current);
      } catch {
        setStatus("unavailable");
        setMessage("无法初始化实时预览画布，不影响镜像与录制");
      }
    }
  }, []);

  /** 请求 Worker 与主进程从下一关键帧恢复。 */
  const retry = useCallback((): void => {
    setStatus("connecting");
    setMessage("正在恢复实时预览");
    if (workerRef.current) {
      workerRef.current.postMessage({ type: "retry" });
      return;
    }

    setCanvasGeneration((value) => value + 1);
    if (!requested.current) {
      requested.current = true;
      api.requestLivePreview();
    }
  }, [api]);

  /** 开启或关闭电脑端音频监听。 */
  const setAudioMonitoring = useCallback(
    async (enabled: boolean, volume: number): Promise<void> => {
      if (!enabled) {
        audioMonitoringRef.current = false;
        workerRef.current?.postMessage({
          type: "audio-monitor",
          enabled: false
        });
        audioPlayerRef.current?.disable();
        setAudioMonitoringState(false);
        setAudioMonitorStatus("off");
        setAudioMonitorMessage(undefined);
        return;
      }

      audioMonitoringRef.current = true;
      setAudioMonitoringState(true);
      setAudioMonitorStatus("connecting");
      setAudioMonitorMessage("正在连接电脑音频输出");
      try {
        if (!audioPlayerRef.current) {
          audioPlayerRef.current = new AudioMonitorPlayer();
        }
        await audioPlayerRef.current.enable(volume);
        workerRef.current?.postMessage({
          type: "audio-monitor",
          enabled: true
        });
      } catch (error) {
        audioMonitoringRef.current = false;
        audioPlayerRef.current?.disable();
        setAudioMonitoringState(false);
        setAudioMonitorStatus("unavailable");
        setAudioMonitorMessage("无法打开系统音频输出，不影响镜像与录制");
        throw error;
      }
    },
    []
  );

  /** 更新电脑端音频监听音量。 */
  const setAudioMonitorVolume = useCallback((volume: number): void => {
    audioPlayerRef.current?.setVolume(volume);
  }, []);

  return {
    status,
    message,
    size,
    canvasGeneration,
    canvasRef: attachCanvas,
    retry,
    audioMonitoring,
    audioMonitorStatus,
    audioMonitorMessage,
    setAudioMonitoring,
    setAudioMonitorVolume
  };
}
