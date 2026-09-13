import type {
  LivePreviewStatus,
  PreviewControlMessage,
  PreviewStreamMessage
} from "../shared/types";

/** 页面发送给预览 Worker 的命令。 */
type PreviewWorkerCommand =
  | { type: "connect"; port: MessagePort }
  | { type: "canvas"; canvas: OffscreenCanvas }
  | { type: "audio-monitor"; enabled: boolean }
  | { type: "retry" };

/** Worker 回传给 React 界面的状态。 */
interface PreviewWorkerStatus {
  /** 固定消息类型。 */
  type: "status";
  /** 当前预览状态。 */
  status: LivePreviewStatus;
  /** 可选提示。 */
  message?: string;
}

/** Worker 回传给 React 的视频尺寸。 */
interface PreviewWorkerSize {
  /** 固定消息类型。 */
  type: "size";
  /** 视频像素宽度。 */
  width: number;
  /** 视频像素高度。 */
  height: number;
}

/** Worker 回传的电脑音频监听状态。 */
interface PreviewWorkerAudioStatus {
  /** 固定消息类型。 */
  type: "audio-status";
  /** 当前监听状态。 */
  status: "off" | "connecting" | "live" | "unavailable";
  /** 可选提示。 */
  message?: string;
}

/** Worker 回传给页面播放的 PCM。 */
interface PreviewWorkerAudioData {
  /** 固定消息类型。 */
  type: "audio-data";
  /** 可转移的解码音频数据。 */
  data: AudioData;
}

/** Worker 回传给 React 的受限消息。 */
type PreviewWorkerMessage =
  | PreviewWorkerStatus
  | PreviewWorkerSize
  | PreviewWorkerAudioStatus
  | PreviewWorkerAudioData;

/** 当前 Worker 全局作用域最小接口。 */
interface PreviewWorkerScope {
  /** 接收页面命令。 */
  onmessage: ((event: MessageEvent<PreviewWorkerCommand>) => void) | null;
  /** 向页面发布状态。 */
  postMessage(message: PreviewWorkerMessage, transfer?: Transferable[]): void;
}

/** 类型安全的 Worker 全局对象。 */
const workerScope = globalThis as unknown as PreviewWorkerScope;
/** 实时画布。 */
let canvas: OffscreenCanvas | undefined;
/** 画布绘制上下文。 */
let context: OffscreenCanvasRenderingContext2D | null = null;
/** 主进程媒体端口。 */
let mediaPort: MessagePort | undefined;
/** 当前视频尺寸。 */
let videoSize: { width: number; height: number } | undefined;
/** H.264 Codec String。 */
let codec: string | undefined;
/** 最新 H.264 SPS/PPS。 */
let codecConfig: Uint8Array | undefined;
/** 当前 WebCodecs 解码器。 */
let decoder: VideoDecoder | undefined;
/** 当前 AAC 解码配置。 */
let audioConfig:
  | Extract<PreviewStreamMessage, { type: "audio-config" }>
  | undefined;
/** 当前 WebCodecs 音频解码器。 */
let audioDecoder: AudioDecoder | undefined;
/** 是否开启电脑端音频监听。 */
let audioMonitoring = false;
/** 等待安全恢复解码的关键帧。 */
let awaitingKeyFrame = true;
/** 预览是否因能力或持续积压停用。 */
let unavailable = false;
/** 等待绘制的最新帧。 */
let pendingFrame: VideoFrame | undefined;
/** 下一次绘制任务。 */
let drawTimer: ReturnType<typeof setTimeout> | undefined;
/** 首次解码积压时间。 */
let backlogStartedAt: number | undefined;
/** 稳定解码后清除积压记录的任务。 */
let backlogRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
/** 当前环境是否提供 WebCodecs 视频解码。 */
const webCodecsAvailable = typeof VideoDecoder !== "undefined";
/** 当前环境是否提供 WebCodecs 音频解码。 */
const audioWebCodecsAvailable =
  typeof AudioDecoder !== "undefined" &&
  typeof EncodedAudioChunk !== "undefined";
/** 最近一次已发布的预览状态。 */
let lastStatus: LivePreviewStatus | undefined;
/** 最近一次已发布的预览提示。 */
let lastStatusMessage: string | undefined;
/** 最近一次已发布的监听状态。 */
let lastAudioStatus: PreviewWorkerAudioStatus["status"] | undefined;
/** 最近一次已发布的监听提示。 */
let lastAudioStatusMessage: string | undefined;

/** 发布独立预览状态。 */
function postStatus(status: LivePreviewStatus, message?: string): void {
  if (status === lastStatus && message === lastStatusMessage) {
    return;
  }

  lastStatus = status;
  lastStatusMessage = message;
  workerScope.postMessage({ type: "status", status, message });
  sendControl({ type: "status", status, message });
}

/** 发布电脑端音频监听状态。 */
function postAudioStatus(
  status: PreviewWorkerAudioStatus["status"],
  message?: string
): void {
  if (status === lastAudioStatus && message === lastAudioStatusMessage) {
    return;
  }

  lastAudioStatus = status;
  lastAudioStatusMessage = message;
  workerScope.postMessage({ type: "audio-status", status, message });
}

/** 向主进程发送固定预览控制消息。 */
function sendControl(message: PreviewControlMessage): void {
  mediaPort?.postMessage(message);
}

/** 将当前状态同步给刚连接的主进程端口。 */
function syncCurrentStatus(): void {
  if (lastStatus) {
    sendControl({
      type: "status",
      status: lastStatus,
      message: lastStatusMessage
    });
  }
}

/** 清除解码积压恢复记录。 */
function resetBacklogTracking(): void {
  if (backlogRecoveryTimer) {
    clearTimeout(backlogRecoveryTimer);
    backlogRecoveryTimer = undefined;
  }
  backlogStartedAt = undefined;
}

/** 关闭解码器与尚未绘制的帧。 */
function resetDecoder(): void {
  if (drawTimer) {
    clearTimeout(drawTimer);
    drawTimer = undefined;
  }
  pendingFrame?.close();
  pendingFrame = undefined;
  decoder?.close();
  decoder = undefined;
  awaitingKeyFrame = true;
}

/** 关闭音频解码器并释放内部队列。 */
function resetAudioDecoder(): void {
  audioDecoder?.close();
  audioDecoder = undefined;
}

/** 隔离音频解码错误并停止上游监听投递。 */
function handleAudioDecoderError(error: DOMException): void {
  audioMonitoring = false;
  resetAudioDecoder();
  sendControl({ type: "audio-monitor", enabled: false });
  postAudioStatus("unavailable", `电脑端音频监听失败：${error.message}`);
}

/** 把解码后的 AudioData 转交页面 Web Audio 播放。 */
function handleDecodedAudio(data: AudioData): void {
  if (!audioMonitoring) {
    data.close();
    return;
  }
  try {
    workerScope.postMessage({ type: "audio-data", data }, [data]);
    postAudioStatus("live");
  } catch (error) {
    data.close();
    handleAudioDecoderError(
      error instanceof DOMException
        ? error
        : new DOMException("无法传递电脑端监听音频")
    );
  }
}

/** 在 AAC 配置齐全后创建独立音频解码器。 */
function ensureAudioDecoder(): AudioDecoder | undefined {
  if (
    audioDecoder ||
    !audioMonitoring ||
    !audioConfig ||
    !audioWebCodecsAvailable
  ) {
    return audioDecoder;
  }

  try {
    audioDecoder = new AudioDecoder({
      output: handleDecodedAudio,
      error: handleAudioDecoderError
    });
    audioDecoder.configure({
      codec: audioConfig.codec,
      sampleRate: audioConfig.sampleRate,
      numberOfChannels: audioConfig.numberOfChannels,
      description: new Uint8Array(audioConfig.description.slice(0))
    });
    return audioDecoder;
  } catch (error) {
    handleAudioDecoderError(
      error instanceof DOMException
        ? error
        : new DOMException(
            error instanceof Error ? error.message : "AAC 解码器初始化失败"
          )
    );
    return undefined;
  }
}

/** 解码一包用于电脑监听的 AAC 数据。 */
function decodeAudioPacket(
  message: Extract<PreviewStreamMessage, { type: "audio-packet" }>
): void {
  if (!audioMonitoring) {
    return;
  }
  if (audioDecoder && audioDecoder.decodeQueueSize >= 8) {
    resetAudioDecoder();
    postAudioStatus("connecting", "监听延迟过高，正在重新同步");
  }
  /** 可用的 AAC 解码器。 */
  const currentDecoder = ensureAudioDecoder();
  if (!currentDecoder) {
    return;
  }

  try {
    currentDecoder.decode(
      new EncodedAudioChunk({
        type: "key",
        timestamp: message.ptsUs,
        data: message.data
      })
    );
  } catch (error) {
    handleAudioDecoderError(
      error instanceof DOMException
        ? error
        : new DOMException("无法提交 AAC 音频包")
    );
  }
}

/** 把最新解码帧绘制到离屏画布。 */
function drawLatestFrame(): void {
  drawTimer = undefined;
  /** 本次需要绘制的帧。 */
  const frame = pendingFrame;
  pendingFrame = undefined;

  if (!frame || !canvas || !context) {
    frame?.close();
    return;
  }

  context.drawImage(frame, 0, 0, canvas.width, canvas.height);
  frame.close();
  if (backlogStartedAt !== undefined && !backlogRecoveryTimer) {
    backlogRecoveryTimer = setTimeout(() => {
      backlogRecoveryTimer = undefined;
      backlogStartedAt = undefined;
    }, 1_000);
  }
  postStatus("live");
}

/** 仅保留最新解码帧，避免绘制队列持续增长。 */
function handleDecodedFrame(frame: VideoFrame): void {
  pendingFrame?.close();
  pendingFrame = frame;

  if (!drawTimer) {
    drawTimer = setTimeout(drawLatestFrame, 0);
  }
}

/** 将 WebCodecs 错误隔离为预览不可用。 */
function handleDecoderError(error: DOMException): void {
  unavailable = true;
  resetDecoder();
  resetBacklogTracking();
  sendControl({ type: "visibility", visible: false });
  postStatus("unavailable", `实时预览解码失败：${error.message}`);
}

/** 在元数据齐全后创建低延迟硬件优先解码器。 */
function ensureDecoder(): VideoDecoder | undefined {
  if (
    decoder ||
    unavailable ||
    !canvas ||
    !context ||
    !videoSize ||
    !codec ||
    !webCodecsAvailable
  ) {
    return decoder;
  }

  try {
    decoder = new VideoDecoder({
      output: handleDecodedFrame,
      error: handleDecoderError
    });
    decoder.configure({
      codec,
      codedWidth: videoSize.width,
      codedHeight: videoSize.height,
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware"
    });
    return decoder;
  } catch (error) {
    unavailable = true;
    resetDecoder();
    resetBacklogTracking();
    sendControl({ type: "visibility", visible: false });
    postStatus(
      "unavailable",
      error instanceof Error
        ? `实时预览不可用：${error.message}`
        : "当前环境不支持实时预览"
    );
    return undefined;
  }
}

/** 合并配置与关键帧，保证恢复后可独立解码。 */
function prependCodecConfig(data: ArrayBuffer): Uint8Array {
  /** 当前关键帧数据。 */
  const packet = new Uint8Array(data);
  if (!codecConfig) {
    return packet;
  }

  /** 带 SPS/PPS 的关键帧。 */
  const merged = new Uint8Array(codecConfig.byteLength + packet.byteLength);
  merged.set(codecConfig, 0);
  merged.set(packet, codecConfig.byteLength);
  return merged;
}

/** 解码一个实时包，积压时仅重置预览链路。 */
function decodePacket(message: Extract<PreviewStreamMessage, { type: "packet" }>): void {
  if (unavailable || !canvas) {
    return;
  }
  if (awaitingKeyFrame && !message.keyFrame) {
    return;
  }

  /** 可用的低延迟解码器。 */
  const currentDecoder = ensureDecoder();
  if (!currentDecoder) {
    return;
  }

  if (currentDecoder.decodeQueueSize > 8) {
    if (backlogRecoveryTimer) {
      clearTimeout(backlogRecoveryTimer);
      backlogRecoveryTimer = undefined;
    }
    backlogStartedAt ??= performance.now();
    /** 本轮积压持续时间。 */
    const backlogDuration = performance.now() - backlogStartedAt;
    resetDecoder();

    if (backlogDuration >= 1_000) {
      unavailable = true;
      sendControl({ type: "visibility", visible: false });
      postStatus(
        "unavailable",
        "实时预览因解码持续积压已暂停，镜像与录制仍在继续"
      );
    } else {
      postStatus("paused", "实时预览正在等待关键帧追上录制进度");
    }
    return;
  }

  /** 恢复后的首帧需要携带最新 Codec 配置。 */
  const data = awaitingKeyFrame
    ? prependCodecConfig(message.data)
    : new Uint8Array(message.data);

  try {
    currentDecoder.decode(
      new EncodedVideoChunk({
        type: message.keyFrame ? "key" : "delta",
        timestamp: message.ptsUs,
        data
      })
    );
    awaitingKeyFrame = false;
  } catch (error) {
    handleDecoderError(
      error instanceof DOMException
        ? error
        : new DOMException("无法提交 H.264 视频帧")
    );
  }
}

/** 处理主进程发送的受限预览消息。 */
function handleStreamMessage(message: PreviewStreamMessage): void {
  if (message.type === "session") {
    /** 视频尺寸是否发生变化。 */
    const changed =
      videoSize?.width !== message.width ||
      videoSize?.height !== message.height;
    videoSize = { width: message.width, height: message.height };
    workerScope.postMessage({
      type: "size",
      width: message.width,
      height: message.height
    });
    if (canvas) {
      canvas.width = message.width;
      canvas.height = message.height;
    }
    if (changed) {
      resetDecoder();
      resetBacklogTracking();
      if (!unavailable) {
        postStatus("connecting", "画面尺寸变化，正在等待关键帧");
        sendControl({ type: "retry" });
      }
    }
    return;
  }
  if (message.type === "config") {
    codec = message.codec;
    codecConfig = new Uint8Array(message.data.slice(0));
    resetDecoder();
    resetBacklogTracking();
    if (!unavailable) {
      postStatus("connecting", "正在等待设备关键帧");
    }
    return;
  }
  if (message.type === "packet") {
    decodePacket(message);
    return;
  }
  if (message.type === "audio-config") {
    audioConfig = {
      ...message,
      description: message.description.slice(0)
    };
    resetAudioDecoder();
    if (audioMonitoring) {
      postAudioStatus("connecting", "正在连接电脑端音频监听");
      ensureAudioDecoder();
    }
    return;
  }
  if (message.type === "audio-packet") {
    decodeAudioPacket(message);
    return;
  }
  if (message.type === "error") {
    unavailable = true;
    resetDecoder();
    resetBacklogTracking();
    audioMonitoring = false;
    audioConfig = undefined;
    resetAudioDecoder();
    sendControl({ type: "audio-monitor", enabled: false });
    postAudioStatus("off");
    sendControl({ type: "visibility", visible: false });
    postStatus("unavailable", message.message);
    return;
  }

  resetDecoder();
  audioMonitoring = false;
  audioConfig = undefined;
  resetAudioDecoder();
  sendControl({ type: "audio-monitor", enabled: false });
  postAudioStatus("off");
}

/** 恢复预览并从下一关键帧重新开始。 */
function retryPreview(): void {
  if (!webCodecsAvailable) {
    unavailable = true;
    resetDecoder();
    resetBacklogTracking();
    sendControl({ type: "visibility", visible: false });
    postStatus("unavailable", "当前系统不支持 WebCodecs 实时预览");
    syncCurrentStatus();
    return;
  }

  unavailable = false;
  resetBacklogTracking();
  resetDecoder();
  postStatus("connecting", "正在恢复实时预览");
  sendControl({ type: "retry" });
}

/** 处理 React 页面的初始化与重试命令，解码不随窗口可见性暂停。 */
workerScope.onmessage = (event): void => {
  /** 当前页面命令。 */
  const message = event.data;
  if (message.type === "connect") {
    mediaPort?.close();
    mediaPort = message.port;
    mediaPort.onmessage = (
      portEvent: MessageEvent<PreviewStreamMessage>
    ) => {
      handleStreamMessage(portEvent.data);
      if (portEvent.data.type === "packet") {
        sendControl({
          type: "consumed",
          sequence: portEvent.data.sequence
        });
      } else if (portEvent.data.type === "audio-packet") {
        sendControl({
          type: "audio-consumed",
          sequence: portEvent.data.sequence
        });
      }
    };
    mediaPort.start();
    syncCurrentStatus();
    if (!webCodecsAvailable) {
      sendControl({ type: "visibility", visible: false });
    }
    return;
  }
  if (message.type === "audio-monitor") {
    if (message.enabled && !audioWebCodecsAvailable) {
      audioMonitoring = false;
      resetAudioDecoder();
      sendControl({ type: "audio-monitor", enabled: false });
      postAudioStatus("unavailable", "当前系统不支持电脑端音频监听");
      return;
    }

    audioMonitoring = message.enabled;
    resetAudioDecoder();
    sendControl({ type: "audio-monitor", enabled: message.enabled });
    if (message.enabled) {
      postAudioStatus("connecting", "正在连接电脑端音频监听");
      ensureAudioDecoder();
    } else {
      postAudioStatus("off");
    }
    return;
  }
  if (message.type === "canvas") {
    canvas = message.canvas;
    context = canvas.getContext("2d", {
      alpha: false,
      desynchronized: true
    });
    if (!context) {
      unavailable = true;
      sendControl({ type: "visibility", visible: false });
      postStatus("unavailable", "无法创建实时预览绘图环境");
      return;
    }
    if (videoSize) {
      canvas.width = videoSize.width;
      canvas.height = videoSize.height;
    }
    retryPreview();
    return;
  }

  if (message.type === "retry") {
    retryPreview();
  }
};

if (!webCodecsAvailable) {
  unavailable = true;
  postStatus("unavailable", "当前系统不支持 WebCodecs 实时预览");
}
