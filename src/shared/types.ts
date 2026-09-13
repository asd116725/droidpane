/** 安卓设备连接状态。 */
export type DeviceStatus = "available" | "unauthorized" | "offline";

/** 安卓设备连接方式。 */
export type DeviceConnectionType = "usb" | "network" | "emulator";

/** 安卓设备信息。 */
export interface DeviceInfo {
  /** ADB 序列号。 */
  serial: string;
  /** 设备型号。 */
  model: string;
  /** Android 系统版本。 */
  androidVersion: string;
  /** Android API 等级。 */
  apiLevel: number;
  /** 设备连接方式。 */
  connectionType: DeviceConnectionType;
  /** 当前连接状态。 */
  status: DeviceStatus;
}

/** 录制分辨率档位。 */
export type RecordingResolution = "720p" | "1080p" | "original";

/** 录制音频模式。 */
export type RecordingAudioMode = "device" | "silent";

/** 录制参数预设。 */
export interface RecordingPreset {
  /** 输出分辨率。 */
  resolution: RecordingResolution;
  /** 视频码率，单位 Mbps。 */
  videoBitrateMbps: 4 | 8 | 16;
  /** 音频采集模式。 */
  audioMode: RecordingAudioMode;
}

/** 镜像控制支持的设备按键。 */
export type DeviceControlKey =
  | "back"
  | "home"
  | "power"
  | "enter"
  | "backspace"
  | "delete"
  | "tab"
  | "arrow-up"
  | "arrow-down"
  | "arrow-left"
  | "arrow-right"
  | "move-home"
  | "move-end"
  | "page-up"
  | "page-down"
  | "a"
  | "c"
  | "x";

/** 镜像控制按键修饰状态。 */
export interface DeviceControlModifiers {
  /** Shift 是否按下。 */
  shift: boolean;
  /** Alt 或 Option 是否按下。 */
  alt: boolean;
  /** Ctrl 或由 Cmd 映射的控制键是否按下。 */
  ctrl: boolean;
}

/** 渲染进程可发送的受限设备控制命令。 */
export type DeviceControlCommand =
  | {
      type: "touch";
      action: "down" | "move" | "up" | "cancel";
      /** 相对镜像画面的横向坐标，范围为零到一。 */
      x: number;
      /** 相对镜像画面的纵向坐标，范围为零到一。 */
      y: number;
    }
  | {
      type: "scroll";
      /** 相对镜像画面的横向坐标，范围为零到一。 */
      x: number;
      /** 相对镜像画面的纵向坐标，范围为零到一。 */
      y: number;
      /** 横向滚动量，范围为负十六到十六。 */
      horizontal: number;
      /** 纵向滚动量，范围为负十六到十六。 */
      vertical: number;
    }
  | {
      type: "key";
      action: "down" | "up";
      key: DeviceControlKey;
      repeat: number;
      modifiers: DeviceControlModifiers;
    }
  | { type: "text"; text: string }
  | { type: "expand-notification-panel" }
  | { type: "collapse-notification-panel" };

/** 电脑端录制音频监听偏好。 */
export interface AudioMonitorSettings {
  /** Android 11/12 开始录制时是否自动开启监听。 */
  autoEnableOnLegacyAndroid: boolean;
  /** 监听音量，范围为零到一。 */
  volume: number;
}

/** 录制生命周期状态。 */
export type RecordingStatus =
  | "idle"
  | "starting"
  | "recording"
  | "stopping"
  | "ready"
  | "error";

/** 实时预览生命周期状态。 */
export type LivePreviewStatus =
  | "connecting"
  | "live"
  | "paused"
  | "unavailable";

/** 独立镜像控制生命周期状态。 */
export type MirrorStatus =
  | "idle"
  | "starting"
  | "mirroring"
  | "stopping"
  | "error";

/** 当前设备镜像控制状态。 */
export interface MirrorState {
  /** 镜像生命周期状态。 */
  status: MirrorStatus;
  /** 当前设备序列号。 */
  deviceSerial?: string;
  /** 当前会话锁定的编码参数。 */
  preset?: RecordingPreset;
  /** 最近一秒实际接收的视频帧率。 */
  fps?: number;
  /** 是否发生音频自动降级。 */
  audioFallback: boolean;
  /** 音频降级说明。 */
  audioFallbackReason?: string;
  /** 实时预览状态。 */
  previewStatus?: LivePreviewStatus;
  /** 实时预览提示。 */
  previewMessage?: string;
  /** 面向用户的镜像错误。 */
  errorMessage?: string;
}

/** 主进程发送给预览 Worker 的受限媒体消息。 */
export type PreviewStreamMessage =
  | { type: "session"; width: number; height: number }
  | { type: "config"; codec: string; data: ArrayBuffer }
  | {
      type: "packet";
      /** 预览背压使用的递增序号。 */
      sequence: number;
      ptsUs: number;
      keyFrame: boolean;
      data: ArrayBuffer;
    }
  | {
      type: "audio-config";
      codec: string;
      sampleRate: number;
      numberOfChannels: number;
      description: ArrayBuffer;
    }
  | {
      type: "audio-packet";
      /** 音频监听背压使用的递增序号。 */
      sequence: number;
      ptsUs: number;
      data: ArrayBuffer;
    }
  | { type: "end" }
  | { type: "error"; message: string };

/** 渲染端发送给主进程预览端口的控制消息。 */
export type PreviewControlMessage =
  | { type: "visibility"; visible: boolean }
  | { type: "audio-monitor"; enabled: boolean }
  | { type: "audio-consumed"; sequence: number }
  | { type: "retry" }
  | { type: "consumed"; sequence: number }
  | {
      type: "status";
      status: LivePreviewStatus;
      message?: string;
    };

/** 录制任务状态。 */
export interface RecordingState {
  /** 生命周期状态。 */
  status: RecordingStatus;
  /** 录制开始时间戳。 */
  startedAt?: number;
  /** 已录制毫秒数。 */
  elapsedMs: number;
  /** 最近一秒实际写入的视频帧率。 */
  fps?: number;
  /** 当前设备序列号。 */
  deviceSerial?: string;
  /** 完成产物的内部 ID。 */
  artifactId?: string;
  /** 是否发生音频自动降级。 */
  audioFallback: boolean;
  /** 音频降级说明。 */
  audioFallbackReason?: string;
  /** 面向用户的错误信息。 */
  errorMessage?: string;
}

/** 录制生成的 MP4 产物。 */
export interface RecordingArtifact {
  /** 仅在应用内部使用的随机 ID。 */
  id: string;
  /** 展示与导出使用的文件名。 */
  fileName: string;
  /** 视频时长，单位秒。 */
  durationSeconds: number;
  /** 文件字节大小。 */
  sizeBytes: number;
  /** 视频像素宽度。 */
  width: number;
  /** 视频像素高度。 */
  height: number;
  /** 最终是否包含音频。 */
  hasAudio: boolean;
  /** 受限自定义协议媒体地址。 */
  mediaUrl: string;
}

/** 可播放的录制文件库条目。 */
export interface RecordingLibraryReadyItem extends RecordingArtifact {
  /** 条目可直接播放。 */
  status: "ready";
  /** 录制文件最后修改时间戳。 */
  recordedAt: number;
}

/** 无法播放的录制文件库条目。 */
export interface RecordingLibraryInvalidItem {
  /** 内部文件 ID。 */
  id: string;
  /** 录制文件名。 */
  fileName: string;
  /** 文件字节大小。 */
  sizeBytes: number;
  /** 录制文件最后修改时间戳。 */
  recordedAt: number;
  /** 条目当前无法播放。 */
  status: "invalid";
  /** 面向用户的损坏说明。 */
  errorMessage: string;
}

/** 录制文件库条目。 */
export type RecordingLibraryItem =
  | RecordingLibraryReadyItem
  | RecordingLibraryInvalidItem;

/** 当前录制目录的文件库快照。 */
export interface RecordingLibrarySnapshot {
  /** 当前录制目录名称。 */
  directoryName: string;
  /** 已按录制时间倒序排列的条目。 */
  items: RecordingLibraryItem[];
  /** 最近一次刷新完成时间戳。 */
  refreshedAt: number;
  /** 整个目录无法读取时的提示。 */
  errorMessage?: string;
}

/** 单个录制文件删除失败信息。 */
export interface RecordingDeleteFailure {
  /** 内部文件 ID。 */
  id: string;
  /** 文件名，不包含真实路径。 */
  fileName: string;
  /** 面向用户的失败说明。 */
  errorMessage: string;
}

/** 批量删除录制文件的结果。 */
export interface RecordingDeleteResult {
  /** 已成功移入系统回收站的内部文件 ID。 */
  deletedIds: string[];
  /** 未能删除的文件。 */
  failures: RecordingDeleteFailure[];
  /** 删除完成后重新扫描的文件库快照。 */
  snapshot: RecordingLibrarySnapshot;
}

/** 应用持久化设置。 */
export interface AppSettings extends AppSettingsUpdate {
  /** 录制文件存储目录。 */
  recordingsDirectory: string;
}

/** 渲染进程可修改的应用设置。 */
export interface AppSettingsUpdate {
  /** 默认录制参数。 */
  preset: RecordingPreset;
  /** 电脑端录制音频监听偏好。 */
  audioMonitor: AudioMonitorSettings;
}

/** 系统目录选择结果。 */
export interface DirectorySelectionResult {
  /** 用户是否取消了目录选择。 */
  canceled: boolean;
  /** 选择完成后的完整应用设置。 */
  settings: AppSettings;
}

/** 导出操作结果。 */
export interface ExportResult {
  /** 用户是否取消了另存为窗口。 */
  canceled: boolean;
  /** 成功导出后的目标路径，仅主进程返回展示。 */
  destination?: string;
  /** 写入的文件大小。 */
  sizeBytes?: number;
}

/** 窗口控制动作。 */
export type WindowAction =
  | "minimize"
  | "maximize"
  | "close"
  | "open-devtools";

/** 渲染进程可访问的受限桌面接口。 */
export interface AdbStudioApi {
  /** 获取当前设备快照。 */
  getDevices(): Promise<DeviceInfo[]>;
  /** 立即刷新并返回设备列表。 */
  refreshDevices(): Promise<DeviceInfo[]>;
  /** 订阅设备列表变化。 */
  onDevicesChanged(listener: (devices: DeviceInfo[]) => void): () => void;
  /** 获取当前录制状态。 */
  getRecordingState(): Promise<RecordingState>;
  /** 订阅录制状态变化。 */
  onRecordingStateChanged(
    listener: (state: RecordingState) => void
  ): () => void;
  /** 获取最近一次可预览产物。 */
  getRecordingArtifact(): Promise<RecordingArtifact | null>;
  /** 订阅录制产物变化。 */
  onRecordingArtifactChanged(
    listener: (artifact: RecordingArtifact | null) => void
  ): () => void;
  /** 获取当前录制文件库快照。 */
  getRecordingLibrary(): Promise<RecordingLibrarySnapshot>;
  /** 重新扫描当前录制文件夹。 */
  refreshRecordingLibrary(): Promise<RecordingLibrarySnapshot>;
  /** 订阅录制文件库变化。 */
  onRecordingLibraryChanged(
    listener: (snapshot: RecordingLibrarySnapshot) => void
  ): () => void;
  /** 将指定录制文件移入系统回收站。 */
  deleteRecordings(ids: string[]): Promise<RecordingDeleteResult>;
  /** 请求一次固定的实时预览 MessagePort。 */
  requestLivePreview(): void;
  /** 获取当前镜像控制状态。 */
  getMirrorState(): Promise<MirrorState>;
  /** 订阅镜像控制状态变化。 */
  onMirrorStateChanged(listener: (state: MirrorState) => void): () => void;
  /** 开启指定设备的独立镜像控制。 */
  startMirroring(
    deviceSerial: string,
    preset: RecordingPreset
  ): Promise<MirrorState>;
  /** 结束当前独立镜像控制。 */
  stopMirroring(): Promise<MirrorState>;
  /** 发送一条受限设备控制命令。 */
  sendDeviceControl(command: DeviceControlCommand): void;
  /** 开始当前镜像会话录制。 */
  startRecording(): Promise<RecordingState>;
  /** 停止并封装当前录制。 */
  stopRecording(): Promise<RecordingState>;
  /** 另存为当前 MP4。 */
  exportRecording(artifactId: string): Promise<ExportResult>;
  /** 在系统文件管理器中显示当前文件或录制目录。 */
  openRecordingFolder(artifactId?: string): Promise<void>;
  /** 获取持久化设置。 */
  getSettings(): Promise<AppSettings>;
  /** 保存渲染进程可修改的设置。 */
  setSettings(settings: AppSettingsUpdate): Promise<AppSettings>;
  /** 通过系统选择器修改录制文件存储目录。 */
  chooseRecordingsDirectory(): Promise<DirectorySelectionResult>;
  /** 执行受限窗口控制。 */
  controlWindow(action: WindowAction): Promise<void>;
}
