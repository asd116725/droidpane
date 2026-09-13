import {
  MessageChannelMain,
  type MessagePortMain,
  type WebContents
} from "electron";
import type {
  LivePreviewStatus,
  PreviewControlMessage,
  PreviewStreamMessage
} from "../../shared/types";
import type { AacConfig } from "../../shared/codecs";
import { ipcChannels } from "../../shared/ipc";
import type {
  LiveAudioPacket,
  LiveVideoSession
} from "../recording/muxer";
import type { MergedMediaPacket } from "../scrcpy/protocol";

/** Worker 汇报的预览状态消息。 */
type PreviewStatusControl = Extract<
  PreviewControlMessage,
  { type: "status" }
>;

/** 主进程实时预览发布器。 */
export interface LivePreviewPublisher {
  /** 开始新的预览会话。 */
  begin(): void;
  /** 发布视频尺寸。 */
  publishSession(session: LiveVideoSession): void;
  /** 发布 H.264 配置。 */
  publishConfig(data: Buffer, codec: string): void;
  /** 发布实时视频包。 */
  publishPacket(packet: MergedMediaPacket): void;
  /** 发布 AAC 解码配置。 */
  publishAudioConfig(data: Buffer, config: AacConfig): void;
  /** 发布 AAC 编码包。 */
  publishAudioPacket(packet: LiveAudioPacket): void;
  /** 结束当前预览。 */
  end(): void;
  /** 发布独立预览错误。 */
  error(message: string): void;
}

/** 音频监听允许同时在途的最大包数。 */
const maxAudioPacketsInFlight = 8;

/** 复制媒体字节，避免向渲染进程暴露 Node.js Buffer。 */
function copyArrayBuffer(data: Uint8Array): ArrayBuffer {
  return Uint8Array.from(data).buffer;
}

/** 校验预览端口只接受可见性和重试消息。 */
export function parsePreviewControlMessage(
  value: unknown
): PreviewControlMessage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  /** 待校验的端口消息。 */
  const message = value as Record<string, unknown>;
  if (
    message.type === "visibility" &&
    typeof message.visible === "boolean"
  ) {
    return { type: "visibility", visible: message.visible };
  }
  if (
    message.type === "audio-monitor" &&
    typeof message.enabled === "boolean"
  ) {
    return { type: "audio-monitor", enabled: message.enabled };
  }
  if (
    message.type === "audio-consumed" &&
    Number.isSafeInteger(message.sequence) &&
    (message.sequence as number) > 0
  ) {
    return {
      type: "audio-consumed",
      sequence: message.sequence as number
    };
  }
  if (message.type === "retry") {
    return { type: "retry" };
  }
  if (
    message.type === "consumed" &&
    Number.isSafeInteger(message.sequence) &&
    (message.sequence as number) > 0
  ) {
    return { type: "consumed", sequence: message.sequence as number };
  }
  if (
    message.type === "status" &&
    ["connecting", "live", "paused", "unavailable"].includes(
      message.status as string
    ) &&
    (message.message === undefined || typeof message.message === "string")
  ) {
    return {
      type: "status",
      status: message.status as LivePreviewStatus,
      message:
        typeof message.message === "string"
          ? message.message.slice(0, 240)
          : undefined
    };
  }

  return undefined;
}

/** 在主进程与唯一主窗口之间分发只读 H.264 预览流。 */
export class LivePreviewHub {
  /** 当前渲染端口。 */
  private port?: MessagePortMain;
  /** 当前视频尺寸。 */
  private session?: LiveVideoSession;
  /** 当前 H.264 配置。 */
  private config?: { data: ArrayBuffer; codec: string };
  /** 当前 AAC 配置。 */
  private audioConfig?: AacConfig & { description: ArrayBuffer };
  /** 是否向电脑端投递音频监听数据。 */
  private audioMonitoring = false;
  /** 已投递但尚未被监听 Worker 消费的音频包。 */
  private readonly audioPacketsInFlight = new Set<number>();
  /** 音频积压时只保留的最新包。 */
  private pendingAudioPacket?: LiveAudioPacket;
  /** 下一条音频监听包序号。 */
  private nextAudioSequence = 1;
  /** 窗口当前是否消费预览。 */
  private visible = true;
  /** 恢复预览后是否正在等待关键帧。 */
  private awaitingKeyFrame = true;
  /** 当前已投递但尚未消费的包序号。 */
  private inFlightSequence?: number;
  /** 背压期间只保留的最新视频包。 */
  private pendingPacket?: MergedMediaPacket;
  /** 下一条预览包序号。 */
  private nextSequence = 1;
  /** 预览状态订阅器。 */
  private readonly statusListeners = new Set<
    (status: PreviewStatusControl) => void
  >();

  /** 创建绑定固定 Worker URL 的预览分发器。 */
  constructor(private readonly workerUrl: string) {}

  /** 为受信任主窗口创建并转交固定 MessagePort。 */
  attach(webContents: WebContents): void {
    this.port?.close();
    /** 仅连接主窗口的消息通道。 */
    const channel = new MessageChannelMain();

    this.port = channel.port2;
    this.visible = true;
    this.resetVideoDelivery();
    this.audioMonitoring = false;
    this.audioPacketsInFlight.clear();
    this.pendingAudioPacket = undefined;
    this.port.on("message", (event) => this.handleControl(event.data));
    this.port.on("close", () => {
      if (this.port === channel.port2) {
        this.port = undefined;
      }
    });
    this.port.start();
    webContents.postMessage(
      ipcChannels.livePreviewPort,
      { workerUrl: this.workerUrl },
      [channel.port1]
    );
    this.replayMetadata();
  }

  /** 开始新镜像时清空旧预览元数据。 */
  begin(): void {
    this.session = undefined;
    this.config = undefined;
    this.audioConfig = undefined;
    this.resetVideoDelivery();
    this.audioPacketsInFlight.clear();
    this.pendingAudioPacket = undefined;
  }

  /** 订阅 Worker 汇报的独立预览状态。 */
  onStatusChanged(
    listener: (status: PreviewStatusControl) => void
  ): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** 发布视频尺寸变化。 */
  publishSession(session: LiveVideoSession): void {
    this.session = { ...session };
    this.post({ type: "session", ...session });
  }

  /** 发布 H.264 解码配置。 */
  publishConfig(data: Buffer, codec: string): void {
    this.config = { data: copyArrayBuffer(data), codec };
    this.resetVideoDelivery();
    this.post({
      type: "config",
      codec,
      data: this.config.data.slice(0)
    });
  }

  /** 发布可丢弃的实时视频包。 */
  publishPacket(packet: MergedMediaPacket): void {
    if (
      !this.port ||
      !this.visible ||
      (this.awaitingKeyFrame && !packet.keyFrame)
    ) {
      return;
    }

    this.awaitingKeyFrame = false;
    if (this.inFlightSequence) {
      this.pendingPacket = {
        ...packet,
        data: Buffer.from(packet.data)
      };
      return;
    }

    this.deliverPacket(packet);
  }

  /** 发布 AAC 解码配置。 */
  publishAudioConfig(data: Buffer, config: AacConfig): void {
    this.audioConfig = {
      ...config,
      description: copyArrayBuffer(data)
    };
    if (this.audioMonitoring) {
      this.replayAudioConfig();
    }
  }

  /** 发布受背压保护的 AAC 编码包。 */
  publishAudioPacket(packet: LiveAudioPacket): void {
    if (!this.port || !this.audioMonitoring) {
      return;
    }
    if (this.audioPacketsInFlight.size >= maxAudioPacketsInFlight) {
      this.pendingAudioPacket = {
        ...packet,
        data: Buffer.from(packet.data)
      };
      return;
    }

    this.deliverAudioPacket(packet);
  }

  /** 通知渲染端当前预览流结束。 */
  end(): void {
    this.post({ type: "end" });
    this.audioMonitoring = false;
    this.resetVideoDelivery();
    this.audioPacketsInFlight.clear();
    this.pendingAudioPacket = undefined;
  }

  /** 通知渲染端预览故障，录制链路仍独立收尾。 */
  error(message: string): void {
    this.post({ type: "error", message });
    this.audioMonitoring = false;
    this.resetVideoDelivery();
    this.audioPacketsInFlight.clear();
    this.pendingAudioPacket = undefined;
  }

  /** 关闭当前渲染端口。 */
  close(): void {
    this.port?.close();
    this.port = undefined;
    this.resetVideoDelivery();
    this.audioPacketsInFlight.clear();
    this.pendingAudioPacket = undefined;
    this.statusListeners.clear();
  }

  /** 处理渲染端的可见性或恢复请求。 */
  private handleControl(value: unknown): void {
    /** 已校验的受限控制消息。 */
    const message = parsePreviewControlMessage(value);
    if (!message) {
      return;
    }

    if (message.type === "consumed") {
      this.handleConsumedPacket(message.sequence);
      return;
    }
    if (message.type === "audio-consumed") {
      this.handleConsumedAudioPacket(message.sequence);
      return;
    }
    if (message.type === "audio-monitor") {
      this.audioMonitoring = message.enabled;
      this.audioPacketsInFlight.clear();
      this.pendingAudioPacket = undefined;
      if (message.enabled) {
        this.replayAudioConfig();
      }
      return;
    }
    if (message.type === "status") {
      this.statusListeners.forEach((listener) => listener(message));
      return;
    }
    if (message.type === "visibility") {
      this.visible = message.visible;
    } else {
      this.visible = true;
    }

    this.resetVideoDelivery();
    if (this.visible) {
      this.replayMetadata();
    }
  }

  /** 按消费确认继续投递至多一个最新视频包。 */
  private handleConsumedPacket(sequence: number): void {
    if (sequence !== this.inFlightSequence) {
      return;
    }

    this.inFlightSequence = undefined;
    /** 背压期间保留的最新包。 */
    const packet = this.pendingPacket;
    this.pendingPacket = undefined;
    if (packet && this.visible) {
      this.deliverPacket(packet);
    }
  }

  /** 投递一个带递增序号的视频包。 */
  private deliverPacket(packet: MergedMediaPacket): void {
    /** 本次背压确认序号。 */
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    if (
      this.post({
        type: "packet",
        sequence,
        ptsUs: packet.ptsUs,
        keyFrame: packet.keyFrame,
        data: copyArrayBuffer(packet.data)
      })
    ) {
      this.inFlightSequence = sequence;
    }
  }

  /** 作废旧视频背压状态并从下一关键帧重新投递。 */
  private resetVideoDelivery(): void {
    this.awaitingKeyFrame = true;
    this.inFlightSequence = undefined;
    this.pendingPacket = undefined;
  }

  /** 按消费确认继续投递积压期间保留的最新音频包。 */
  private handleConsumedAudioPacket(sequence: number): void {
    if (!this.audioPacketsInFlight.delete(sequence)) {
      return;
    }
    /** 积压期间保留的最新音频包。 */
    const packet = this.pendingAudioPacket;
    if (packet && this.audioMonitoring) {
      this.pendingAudioPacket = undefined;
      this.deliverAudioPacket(packet);
    }
  }

  /** 投递一个带递增序号的音频监听包。 */
  private deliverAudioPacket(packet: LiveAudioPacket): void {
    /** 本次音频消费确认序号。 */
    const sequence = this.nextAudioSequence;
    this.nextAudioSequence += 1;
    if (
      this.post({
        type: "audio-packet",
        sequence,
        ptsUs: packet.ptsUs,
        data: copyArrayBuffer(packet.data)
      })
    ) {
      this.audioPacketsInFlight.add(sequence);
    }
  }

  /** 向新端口或恢复后的 Worker 重发当前元数据。 */
  private replayMetadata(): void {
    if (this.session) {
      this.post({ type: "session", ...this.session });
    }
    if (this.config) {
      this.post({
        type: "config",
        codec: this.config.codec,
        data: this.config.data.slice(0)
      });
    }
    if (this.audioMonitoring) {
      this.replayAudioConfig();
    }
  }

  /** 向当前监听 Worker 重放 AAC 解码配置。 */
  private replayAudioConfig(): void {
    if (!this.audioConfig) {
      return;
    }
    this.post({
      type: "audio-config",
      codec: this.audioConfig.codec,
      sampleRate: this.audioConfig.sampleRate,
      numberOfChannels: this.audioConfig.numberOfChannels,
      description: this.audioConfig.description.slice(0)
    });
  }

  /** 向存活端口发送一条结构化消息。 */
  private post(message: PreviewStreamMessage): boolean {
    if (!this.port) {
      return false;
    }

    try {
      this.port.postMessage(message);
      return true;
    } catch {
      this.port = undefined;
      this.resetVideoDelivery();
      this.audioPacketsInFlight.clear();
      this.pendingAudioPacket = undefined;
      return false;
    }
  }
}
