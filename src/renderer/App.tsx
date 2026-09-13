import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject
} from "react";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowsMaximize,
  IconCheck,
  IconChevronDown,
  IconCircleCheck,
  IconDeviceMobile,
  IconDeviceMobileOff,
  IconFileExport,
  IconFolder,
  IconFolderOpen,
  IconGauge,
  IconHelpCircle,
  IconLibrary,
  IconLoader2,
  IconMicrophone,
  IconMicrophoneOff,
  IconMinus,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconRefresh,
  IconRotate2,
  IconSettings,
  IconSquare,
  IconSquareFilled,
  IconTerminal2,
  IconUpload,
  IconVideo,
  IconVolume,
  IconVolumeOff,
  IconX
} from "@tabler/icons-react";
import {
  ConfigProvider,
  Select,
  Tooltip,
  message as antdMessage,
  notification as antdNotification,
  theme as antdTheme,
  type ThemeConfig
} from "antd";
import type {
  AdbStudioApi,
  AppSettings,
  AudioMonitorSettings,
  DeviceInfo,
  MirrorState,
  RecordingArtifact,
  RecordingDeleteResult,
  RecordingLibraryReadyItem,
  RecordingLibrarySnapshot,
  RecordingPreset,
  RecordingState,
  WindowAction
} from "../shared/types";
import { formatDuration, formatFileSize } from "../shared/formatters";
import { applicationName } from "../shared/brand";
import applicationIcon from "../../assets/app-icon.png";
import { getDesktopApi } from "./demo-api";
import {
  useLivePreview,
  type LivePreviewController
} from "./use-live-preview";
import { VideoLibraryDrawer } from "./video-library/VideoLibraryDrawer";
import { MirrorCanvas, MirrorControlPanel } from "./MirrorControls";
import "./app.css";

/** 应用组件属性。 */
export interface AppProps {
  /** 测试或宿主注入的桌面接口。 */
  api?: AdbStudioApi;
}

/** 主工作区页签。 */
type WorkspaceTab = "device" | "library";

/** 默认录制设置。 */
const initialSettings: AppSettings = {
  preset: {
    resolution: "1080p",
    videoBitrateMbps: 8,
    audioMode: "device"
  },
  audioMonitor: {
    autoEnableOnLegacyAndroid: false,
    volume: 0.8
  },
  recordingsDirectory: ""
};

/** 默认录制状态。 */
const initialRecordingState: RecordingState = {
  status: "idle",
  elapsedMs: 0,
  fps: 0,
  audioFallback: false
};

/** 默认镜像控制状态。 */
const initialMirrorState: MirrorState = {
  status: "idle",
  audioFallback: false
};

/** 设备状态展示文本。 */
const deviceStatusLabels = {
  available: "已连接",
  unauthorized: "未授权",
  offline: "已离线"
} as const;

/** 分辨率选项。 */
const resolutionOptions = [
  { value: "720p", label: "720p" },
  { value: "1080p", label: "1080p" },
  { value: "original", label: "原始分辨率" }
] as const;

/** 码率选项。 */
const bitrateOptions = [
  { value: 4, label: "4 Mbps" },
  { value: 8, label: "8 Mbps" },
  { value: 16, label: "16 Mbps" }
] as const;

/** 音频选项。 */
const audioOptions = [
  {
    value: "device",
    label: "设备音频",
    description:
      "采集手机应用、游戏、视频等内部播放声音，最终 MP4 包含 AAC 音轨。镜像时还会显示“电脑监听”按钮，但是否从电脑扬声器播放需要单独开启。"
  },
  {
    value: "silent",
    label: "静音录制",
    description:
      "完全关闭音频采集，只录画面，最终 MP4 没有音轨。“电脑监听”入口也会隐藏。手机本身不会被静音。"
  }
] as const;

/** 镜像期间的录制参数锁定提示。 */
const presetLockMessage = "镜像进行中，结束镜像后可修改录制参数";

/** Ant Design 组件的深色工业主题。 */
const studioAntTheme: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    colorPrimary: "#28d7f3",
    colorBgContainer: "transparent",
    colorBgElevated: "#1b2024",
    colorBorder: "#3b444c",
    colorText: "#edf2f5",
    colorTextSecondary: "#99a3ac",
    borderRadius: 6,
    controlHeight: 28,
    fontSize: 14
  },
  components: {
    Select: {
      selectorBg: "transparent",
      hoverBorderColor: "transparent",
      activeBorderColor: "transparent",
      activeOutlineColor: "transparent",
      optionActiveBg: "#283139",
      optionSelectedBg: "#123b43",
      optionSelectedColor: "#45dff7",
      optionSelectedFontWeight: 600,
      optionHeight: 38,
      optionPadding: "8px 11px"
    }
  }
};

/** 录制完成通知唯一标识。 */
const recordingCompletedNotificationKey = "recording-completed";

/** 播放倍速轮换列表。 */
const playbackRates = [1, 1.25, 1.5, 2];

/** 标题栏组件属性。 */
interface TitleBarProps {
  /** 窗口控制回调。 */
  onWindowAction(action: WindowAction): void;
}

/** 自定义跨平台标题栏。 */
function TitleBar({ onWindowAction }: TitleBarProps): ReactNode {
  return (
    <header className="title-bar">
      <div className="title-bar__name">
        <img className="title-bar__icon" src={applicationIcon} alt="" />
        <span>{applicationName}</span>
        <span className="title-bar__subtitle">安卓镜像调试工具</span>
      </div>
      <div className="title-bar__controls">
        <button
          type="button"
          aria-label="最小化窗口"
          onClick={() => onWindowAction("minimize")}
        >
          <IconMinus size={17} stroke={1.7} />
        </button>
        <button
          type="button"
          aria-label="最大化窗口"
          onClick={() => onWindowAction("maximize")}
        >
          <IconSquare size={14} stroke={1.7} />
        </button>
        <button
          type="button"
          aria-label="关闭窗口"
          className="title-bar__close"
          onClick={() => onWindowAction("close")}
        >
          <IconX size={18} stroke={1.7} />
        </button>
      </div>
    </header>
  );
}

/** 设备工具栏组件属性。 */
interface DeviceToolbarProps {
  /** 当前设备列表。 */
  devices: DeviceInfo[];
  /** 当前选中序列号。 */
  selectedSerial?: string;
  /** 录制期间是否锁定设备。 */
  locked: boolean;
  /** 录制期间是否锁定存储目录。 */
  directoryLocked: boolean;
  /** 当前镜像控制状态。 */
  mirrorState: MirrorState;
  /** 当前是否允许开启镜像。 */
  canMirror: boolean;
  /** 录制流程是否占用镜像。 */
  recordingBusy: boolean;
  /** 开启独立镜像。 */
  onStartMirroring(): void;
  /** 结束独立镜像。 */
  onStopMirroring(): void;
  /** 是否正在刷新。 */
  refreshing: boolean;
  /** 选择设备。 */
  onSelect(serial: string): void;
  /** 手动刷新设备。 */
  onRefresh(): void;
  /** 当前录制文件存储目录。 */
  recordingsDirectory: string;
  /** 通过系统选择器修改录制目录。 */
  onChooseDirectory(): void;
  /** 打开录制目录。 */
  onOpenFolder(): void;
  /** 打开开发者控制台。 */
  onOpenDevTools(): void;
  /** 当前工作区页签。 */
  activeTab: WorkspaceTab;
  /** 切换工作区页签。 */
  onTabChange(tab: WorkspaceTab): void;
}

/** 顶部设备选择与刷新工具栏。 */
function DeviceToolbar({
  devices,
  selectedSerial,
  locked,
  directoryLocked,
  mirrorState,
  canMirror,
  recordingBusy,
  onStartMirroring,
  onStopMirroring,
  refreshing,
  onSelect,
  onRefresh,
  recordingsDirectory,
  onChooseDirectory,
  onOpenFolder,
  onOpenDevTools,
  activeTab,
  onTabChange
}: DeviceToolbarProps): ReactNode {
  /** 设备下拉是否展开。 */
  const [open, setOpen] = useState(false);
  /** 设置浮层是否展开。 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 镜像录制页签引用。 */
  const deviceTabRef = useRef<HTMLButtonElement>(null);
  /** 视频库页签引用。 */
  const libraryTabRef = useRef<HTMLButtonElement>(null);
  /** 当前选中设备。 */
  const selected = devices.find((device) => device.serial === selectedSerial);
  /** 镜像录制页签的后台状态。 */
  const deviceTabStatus = recordingBusy
    ? "录制中"
    : mirrorState.status === "mirroring"
      ? "镜像运行中"
      : ["starting", "stopping"].includes(mirrorState.status)
        ? "连接中"
        : undefined;
  /** 使用方向键切换工作区页签。 */
  const handleTabKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    current: WorkspaceTab
  ): void => {
    /** 当前按键对应的目标页签。 */
    const target =
      event.key === "Home"
        ? "device"
        : event.key === "End"
          ? "library"
          : ["ArrowLeft", "ArrowRight"].includes(event.key)
            ? current === "device"
              ? "library"
              : "device"
            : undefined;
    if (!target) {
      return;
    }
    event.preventDefault();
    onTabChange(target);
    (target === "device" ? deviceTabRef : libraryTabRef).current?.focus();
  };

  return (
    <section className="device-toolbar">
      <div className="device-selector">
        <button
          type="button"
          className="device-selector__trigger"
          aria-label="选择安卓设备"
          aria-expanded={open}
          disabled={locked}
          onClick={() => setOpen((value) => !value)}
        >
          <IconDeviceMobile size={21} stroke={1.65} />
          {selected ? (
            <span className="device-selector__content">
              <span className="device-selector__primary">
                <span className="device-selector__model">{selected.model}</span>
                <span
                  className={`status-dot status-dot--${selected.status}`}
                  aria-hidden="true"
                />
                <span className="device-selector__meta">
                  {selected.status === "available"
                    ? `Android ${selected.androidVersion || "—"}`
                    : deviceStatusLabels[selected.status]}
                </span>
              </span>
              <span className="device-selector__serial">
                {selected.serial}
              </span>
            </span>
          ) : (
            <span className="device-selector__empty">未检测到安卓设备</span>
          )}
          <IconChevronDown
            className={open ? "device-selector__chevron is-open" : "device-selector__chevron"}
            size={18}
            stroke={1.8}
          />
        </button>

        {open && !locked && (
          <div className="device-menu">
            {devices.length ? (
              devices.map((device) => (
                <button
                  type="button"
                  className="device-menu__item"
                  key={device.serial}
                  onClick={() => {
                    onSelect(device.serial);
                    setOpen(false);
                  }}
                >
                  <IconDeviceMobile size={20} stroke={1.6} />
                  <span className="device-menu__content">
                    <span className="device-menu__model">
                      {device.model}
                      <span
                        className={`status-dot status-dot--${device.status}`}
                      />
                    </span>
                    <span className="device-menu__meta">
                      {device.status === "available"
                        ? `Android ${device.androidVersion || "—"}`
                        : deviceStatusLabels[device.status]}
                    </span>
                  </span>
                  <span className="device-menu__serial">{device.serial}</span>
                  {device.serial === selectedSerial && (
                    <IconCheck
                      className="device-menu__check"
                      size={20}
                      stroke={2}
                    />
                  )}
                </button>
              ))
            ) : (
              <div className="device-menu__empty">连接设备后点击刷新</div>
            )}
          </div>
        )}
      </div>

      <div className="workspace-tabs" role="tablist" aria-label="主工作区">
        <button
          ref={deviceTabRef}
          id="workspace-tab-device"
          type="button"
          role="tab"
          className="workspace-tab"
          aria-selected={activeTab === "device"}
          aria-controls="workspace-panel-device"
          tabIndex={activeTab === "device" ? 0 : -1}
          onClick={() => onTabChange("device")}
          onKeyDown={(event) => handleTabKeyDown(event, "device")}
        >
          <IconDeviceMobile size={20} stroke={1.65} />
          <span className="workspace-tab__content">
            <span>镜像录制</span>
            {deviceTabStatus && (activeTab !== "device" || recordingBusy) && (
              <small
                className={recordingBusy ? "is-recording" : "is-mirroring"}
              >
                <i aria-hidden="true" />
                {deviceTabStatus}
              </small>
            )}
          </span>
        </button>
        <button
          ref={libraryTabRef}
          id="workspace-tab-library"
          type="button"
          role="tab"
          className="workspace-tab"
          aria-selected={activeTab === "library"}
          aria-controls="workspace-panel-library"
          tabIndex={activeTab === "library" ? 0 : -1}
          onClick={() => onTabChange("library")}
          onKeyDown={(event) => handleTabKeyDown(event, "library")}
        >
          <IconLibrary size={20} stroke={1.65} />
          <span className="workspace-tab__content">
            <span>视频库</span>
          </span>
        </button>
      </div>

      {activeTab === "device" && mirrorState.status === "mirroring" ? (
        <div className="mirror-toolbar-status">
          <span>
            <i aria-hidden="true" />
            镜像控制中
          </span>
          <button
            type="button"
            disabled={recordingBusy}
            title={recordingBusy ? "请先结束录制" : undefined}
            onClick={onStopMirroring}
          >
            结束镜像
          </button>
        </div>
      ) : activeTab === "device" ? (
        <button
          type="button"
          className="toolbar-button mirror-toolbar-button"
          disabled={
            !canMirror ||
            recordingBusy ||
            ["starting", "stopping"].includes(mirrorState.status)
          }
          onClick={onStartMirroring}
        >
          {mirrorState.status === "starting" ||
          mirrorState.status === "stopping" ? (
            <IconLoader2 className="is-spinning" size={21} stroke={1.7} />
          ) : (
            <IconDeviceMobile size={21} stroke={1.7} />
          )}
          <span>
            {mirrorState.status === "starting"
              ? "正在开启镜像"
              : mirrorState.status === "stopping"
                ? "正在结束镜像"
                : "开启镜像控制"}
          </span>
        </button>
      ) : null}

      <button
        type="button"
        className="toolbar-button toolbar-button--refresh"
        disabled={locked || refreshing}
        onClick={onRefresh}
      >
        <IconRefresh
          className={refreshing ? "is-spinning" : ""}
          size={22}
          stroke={1.7}
        />
        <span>刷新设备</span>
      </button>

      <span className="toolbar-divider" />

      <div className="settings-menu">
        <button
          type="button"
          className="toolbar-button settings-menu__trigger"
          aria-label="应用设置"
          aria-expanded={settingsOpen}
          onClick={() => setSettingsOpen((value) => !value)}
        >
          <IconSettings size={23} stroke={1.7} />
          <span>设置</span>
        </button>
        {settingsOpen && (
          <div className="settings-popover">
            <div className="settings-popover__location">
              <span>录制存储位置</span>
              <strong title={recordingsDirectory}>
                {recordingsDirectory || "正在读取默认位置…"}
              </strong>
            </div>
            <button
              type="button"
              disabled={directoryLocked}
              title={
                directoryLocked ? "录制结束后可修改存储位置" : undefined
              }
              onClick={() => {
                onChooseDirectory();
                setSettingsOpen(false);
              }}
            >
              <IconFolder size={18} stroke={1.7} />
              修改存储位置
            </button>
            <button
              type="button"
              onClick={() => {
                onOpenFolder();
                setSettingsOpen(false);
              }}
            >
              <IconFolderOpen size={18} stroke={1.7} />
              打开录制文件夹
            </button>
            <button
              type="button"
              onClick={() => {
                onOpenDevTools();
                setSettingsOpen(false);
              }}
            >
              <IconTerminal2 size={18} stroke={1.7} />
              打开开发者控制台
            </button>
            <div className="settings-popover__version">
              scrcpy 4.1 · H.264 / AAC
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** 镜像录制舞台属性。 */
interface DeviceStageProps {
  /** 安全桌面接口。 */
  api: Pick<AdbStudioApi, "sendDeviceControl">;
  /** 当前设备。 */
  device?: DeviceInfo;
  /** 当前录制状态。 */
  state: RecordingState;
  /** 当前镜像控制状态。 */
  mirrorState: MirrorState;
  /** 舞台引用。 */
  stageRef: RefObject<HTMLElement | null>;
  /** 实时预览画布与恢复控制。 */
  preview: LivePreviewController;
  /** 当前页签是否可见。 */
  active: boolean;
  /** 进入全屏预览。 */
  onFullscreen(): void;
  /** 是否展示电脑端音频监听。 */
  showAudioMonitor: boolean;
  /** 当前电脑端监听音量。 */
  audioMonitorVolume: number;
  /** 电脑端监听按钮提示。 */
  audioMonitorTooltip: string;
  /** 切换电脑端音频监听。 */
  onToggleAudioMonitor(): void;
  /** 修改电脑端监听音量。 */
  onAudioMonitorVolume(value: number): void;
}

/** 视频播放舞台属性。 */
interface PlaybackStageProps {
  /** 当前可播放产物。 */
  artifact: RecordingArtifact | null;
  /** 播放器引用。 */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** 舞台引用。 */
  stageRef: RefObject<HTMLElement | null>;
  /** 播放位置更新。 */
  onTimeUpdate(value: number): void;
  /** 播放结束。 */
  onEnded(): void;
  /** 播放开始。 */
  onPlay(): void;
  /** 播放暂停。 */
  onPause(): void;
  /** 当前播放器音量。 */
  volume: number;
  /** 当前播放倍速。 */
  playbackRate: number;
}

/** 将完成态视频定位到首个可解码画面。 */
function prepareFirstVideoFrame(video: HTMLVideoElement): void {
  video.currentTime = Math.min(0.01, video.duration);
}

/** 比较两个播放产物是否包含相同媒体元数据。 */
function isSameArtifact(
  left: RecordingArtifact,
  right: RecordingArtifact
): boolean {
  return (
    left.id === right.id &&
    left.fileName === right.fileName &&
    left.durationSeconds === right.durationSeconds &&
    left.sizeBytes === right.sizeBytes &&
    left.width === right.width &&
    left.height === right.height &&
    left.hasAudio === right.hasAudio &&
    left.mediaUrl === right.mediaUrl
  );
}

/** 中央镜像与录制舞台。 */
function DeviceStage({
  api,
  device,
  state,
  mirrorState,
  stageRef,
  preview,
  active,
  onFullscreen,
  showAudioMonitor,
  audioMonitorVolume,
  audioMonitorTooltip,
  onToggleAudioMonitor,
  onAudioMonitorVolume
}: DeviceStageProps): ReactNode {
  /** 当前镜像是否仍占据实时舞台。 */
  const mirrorVisible = ["starting", "mirroring", "stopping"].includes(
    mirrorState.status
  );
  /** 当前是否可以直接控制设备。 */
  const mirrorControllable = mirrorState.status === "mirroring" && active;
  /** 当前下拉菜单是否由控制按钮打开。 */
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  /** 交替打开或关闭设备下拉菜单。 */
  const toggleNotificationPanel = useCallback((): void => {
    api.sendDeviceControl({
      type: notificationPanelOpen
        ? "collapse-notification-panel"
        : "expand-notification-panel"
    });
    setNotificationPanelOpen(!notificationPanelOpen);
  }, [api, notificationPanelOpen]);

  useEffect(() => {
    if (!mirrorControllable) {
      setNotificationPanelOpen(false);
    }
  }, [mirrorControllable]);
  /** 未授权提示。 */
  const unauthorized = device?.status === "unauthorized";
  /** 离线提示。 */
  const offline = device?.status === "offline";

  return (
    <main className="stage" ref={stageRef}>
      {mirrorVisible ||
        state.status === "recording" ||
        state.status === "starting" ? (
        <div
          className={`live-preview live-preview--${preview.status}`}
        >
          <MirrorCanvas
            api={api}
            preview={preview}
            interactive={mirrorControllable}
            onFullscreen={onFullscreen}
            onToggleNotificationPanel={toggleNotificationPanel}
          />
          {preview.status !== "live" && (
            <div
              className="live-preview__placeholder"
              role={preview.status === "unavailable" ? "alert" : undefined}
            >
              {preview.status === "connecting" ? (
                <IconLoader2 className="is-spinning" size={38} stroke={1.5} />
              ) : (
                <IconAlertTriangle size={39} stroke={1.5} />
              )}
              <div className="stage-state__title">
                {preview.status === "connecting"
                  ? "正在连接实时画面"
                  : "实时预览已暂停"}
              </div>
              <p>
                {preview.message ||
                  (preview.status === "connecting"
                    ? "镜像启动后将自动显示设备画面"
                    : "镜像与录制仍会继续，可点击恢复画面")}
              </p>
              {preview.status !== "connecting" && (
                <button
                  type="button"
                  className="live-preview__retry"
                  onClick={preview.retry}
                >
                  <IconRefresh size={18} stroke={1.7} />
                  恢复预览
                </button>
              )}
            </div>
          )}
          {["starting", "recording", "stopping"].includes(state.status) ? (
            <div className="live-preview__recording-badge">
              <span className="recording-pulse" />
              <span className="live-preview__rec">
                {state.status === "starting"
                  ? "等待关键帧"
                  : state.status === "stopping"
                    ? "封装中"
                    : "REC"}
              </span>
              <span className="live-preview__timer">
                {formatDuration(state.elapsedMs / 1_000)}
              </span>
              <span className="live-preview__device">{device?.model}</span>
              {state.status === "recording" && (
                <span
                  className="live-preview__fps"
                  aria-label={`实际录制帧率 ${Math.round(state.fps ?? 0)} FPS`}
                  title="实际录制帧率"
                >
                  {Math.round(state.fps ?? 0)} FPS
                </span>
              )}
            </div>
          ) : (
            <div className="live-preview__mirror-badge">
              <span className="live-preview__mirror-pulse" />
              <span className="live-preview__mirror-label">
                镜像控制中 · {device?.model}
              </span>
              {mirrorState.status === "mirroring" && (
                <span
                  className="live-preview__mirror-fps"
                  aria-label={`实际镜像帧率 ${Math.round(mirrorState.fps ?? 0)} FPS`}
                  title="实际镜像帧率"
                >
                  {Math.round(mirrorState.fps ?? 0)} FPS
                </span>
              )}
            </div>
          )}
          {(mirrorState.audioFallbackReason || state.audioFallbackReason) && (
            <div className="live-preview__notice">
              <IconAlertTriangle size={18} stroke={1.7} />
              {mirrorState.audioFallbackReason || state.audioFallbackReason}
            </div>
          )}
          {mirrorControllable && (
            <MirrorControlPanel
              api={api}
              onFullscreen={onFullscreen}
              notificationPanelOpen={notificationPanelOpen}
              onToggleNotificationPanel={toggleNotificationPanel}
            />
          )}
          <div className="live-preview__controls">
            {showAudioMonitor && (
              <div className="audio-monitor">
                <button
                  type="button"
                  className="audio-monitor__toggle"
                  aria-label={
                    preview.audioMonitoring
                      ? "关闭电脑监听"
                      : preview.audioMonitorStatus === "unavailable"
                        ? "重试电脑监听"
                        : "开启电脑监听"
                  }
                  aria-pressed={preview.audioMonitoring}
                  data-tooltip={audioMonitorTooltip}
                  onClick={onToggleAudioMonitor}
                >
                  {preview.audioMonitorStatus === "connecting" &&
                  preview.audioMonitoring ? (
                    <IconLoader2
                      className="is-spinning"
                      size={22}
                      stroke={1.7}
                    />
                  ) : preview.audioMonitorStatus === "unavailable" ? (
                    <IconAlertCircle size={22} stroke={1.7} />
                  ) : preview.audioMonitoring ? (
                    <IconVolume size={22} stroke={1.7} />
                  ) : (
                    <IconVolumeOff size={22} stroke={1.7} />
                  )}
                </button>
                {preview.audioMonitoring && (
                  <input
                    className="audio-monitor__volume"
                    type="range"
                    min="0"
                    max="100"
                    value={Math.round(audioMonitorVolume * 100)}
                    aria-label="电脑监听音量"
                    onChange={(event) =>
                      onAudioMonitorVolume(
                        Number(event.currentTarget.value) / 100
                      )
                    }
                  />
                )}
              </div>
            )}
            {!mirrorControllable && (
              <button
                type="button"
                className="live-preview__fullscreen"
                aria-label="全屏预览"
                onClick={onFullscreen}
              >
                <IconArrowsMaximize size={24} stroke={1.65} />
              </button>
            )}
          </div>
        </div>
      ) : state.status === "stopping" ? (
        <div className="stage-state">
          <IconLoader2 className="is-spinning" size={42} stroke={1.5} />
          <div className="stage-state__title">正在完成 MP4 封装</div>
          <p>请稍候，文件写入完成后即可拖动预览</p>
        </div>
      ) : state.status === "error" ? (
        <div className="stage-state stage-state--error" role="alert">
          <IconAlertCircle size={43} stroke={1.5} />
          <div className="stage-state__title">录制未完成</div>
          <p>{state.errorMessage || "发生未知错误"}</p>
        </div>
      ) : mirrorState.status === "error" ? (
        <div className="stage-state stage-state--error" role="alert">
          <IconAlertCircle size={43} stroke={1.5} />
          <div className="stage-state__title">镜像连接未完成</div>
          <p>{mirrorState.errorMessage || "无法连接设备镜像"}</p>
        </div>
      ) : unauthorized ? (
        <div className="stage-state stage-state--warning">
          <IconAlertTriangle size={43} stroke={1.5} />
          <div className="stage-state__title">
            请在手机上确认 USB 调试授权
          </div>
          <p>确认“始终允许这台电脑”后，设备会自动变为可用</p>
        </div>
      ) : offline ? (
        <div className="stage-state stage-state--warning">
          <IconDeviceMobileOff size={43} stroke={1.5} />
          <div className="stage-state__title">设备当前离线</div>
          <p>重新连接数据线，或检查无线调试网络</p>
        </div>
      ) : (
        <div className="stage-state">
          <IconDeviceMobileOff size={47} stroke={1.35} />
          <div className="stage-state__title">
            {device ? "准备开始设备录屏" : "连接 Android 设备开始录制"}
          </div>
          <p>
            {device
              ? "选择画质与音频设置，然后点击开始录制"
              : "请开启 USB 调试，并使用数据线或无线 ADB 连接"}
          </p>
        </div>
      )}
    </main>
  );
}

/** 独立的视频播放舞台。 */
function PlaybackStage({
  artifact,
  videoRef,
  stageRef,
  onTimeUpdate,
  onEnded,
  onPlay,
  onPause,
  volume,
  playbackRate
}: PlaybackStageProps): ReactNode {
  return (
    <main className="stage stage--playback" ref={stageRef}>
      {artifact ? (
        <video
          key={artifact.id}
          ref={videoRef}
          className="stage__video"
          src={artifact.mediaUrl || undefined}
          preload="auto"
          onLoadedMetadata={(event) => {
            prepareFirstVideoFrame(event.currentTarget);
            event.currentTarget.volume = volume;
            event.currentTarget.playbackRate = playbackRate;
          }}
          onTimeUpdate={(event) =>
            onTimeUpdate(event.currentTarget.currentTime)
          }
          onEnded={onEnded}
          onPlay={onPlay}
          onPause={onPause}
        />
      ) : (
        <div className="stage-state">
          <IconVideo size={47} stroke={1.35} />
          <div className="stage-state__title">从左侧视频库选择视频</div>
          <p>镜像与录制会继续在后台运行</p>
        </div>
      )}
    </main>
  );
}

/** 播放器控制区属性。 */
interface PlayerControlsProps {
  /** 可播放产物。 */
  artifact: RecordingArtifact | null;
  /** 当前播放时间。 */
  currentTime: number;
  /** 是否正在播放。 */
  playing: boolean;
  /** 当前音量。 */
  volume: number;
  /** 当前播放速度。 */
  playbackRate: number;
  /** 播放或暂停。 */
  onTogglePlayback(): void;
  /** 拖动播放进度。 */
  onSeek(value: number): void;
  /** 修改音量。 */
  onVolume(value: number): void;
  /** 切换倍速。 */
  onCycleRate(): void;
  /** 进入全屏。 */
  onFullscreen(): void;
}

/** 参考图对应的自定义播放器控制区。 */
function PlayerControls({
  artifact,
  currentTime,
  playing,
  volume,
  playbackRate,
  onTogglePlayback,
  onSeek,
  onVolume,
  onCycleRate,
  onFullscreen
}: PlayerControlsProps): ReactNode {
  /** 视频总时长。 */
  const duration = artifact?.durationSeconds || 0;
  /** 播放进度百分比。 */
  const progress = duration ? (currentTime / duration) * 100 : 0;
  /** 音量百分比。 */
  const volumePercent = volume * 100;
  /** 完成态播放控制是否可用。 */
  const playbackEnabled = Boolean(artifact);

  return (
    <section className="player-controls">
      <button
        type="button"
        className="player-controls__primary"
        aria-label={playing ? "暂停" : "播放"}
        disabled={!playbackEnabled}
        onClick={onTogglePlayback}
      >
        {playing ? (
          <IconPlayerPauseFilled size={25} />
        ) : (
          <IconPlayerPlayFilled size={27} />
        )}
      </button>
      <button
        type="button"
        className="player-controls__secondary"
        aria-label="后退 10 秒"
        disabled={!playbackEnabled}
        onClick={() => onSeek(Math.max(0, currentTime - 10))}
      >
        <IconRotate2 size={24} stroke={1.65} />
        <span>10</span>
      </button>
      <span className="player-controls__time">
        {formatDuration(currentTime)}&nbsp; / &nbsp;
        {formatDuration(duration)}
      </span>
      <input
        className="range-control range-control--progress"
        aria-label="播放进度"
        type="range"
        min={0}
        max={duration || 1}
        step={0.1}
        value={Math.min(currentTime, duration || 1)}
        disabled={!playbackEnabled}
        style={{ "--range-progress": `${progress}%` } as CSSProperties}
        onChange={(event) => onSeek(Number(event.target.value))}
      />
      <IconVolume
        className="player-controls__volume-icon"
        size={25}
        stroke={1.7}
      />
      <input
        className="range-control range-control--volume"
        aria-label="音量"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        disabled={!playbackEnabled}
        style={
          { "--range-progress": `${volumePercent}%` } as CSSProperties
        }
        onChange={(event) => onVolume(Number(event.target.value))}
      />
      <span className="player-controls__divider" />
      <button
        type="button"
        className="player-controls__rate"
        disabled={!playbackEnabled}
        onClick={onCycleRate}
      >
        {playbackRate}×
        <IconChevronDown size={16} stroke={1.7} />
      </button>
      <button
        type="button"
        className="player-controls__fullscreen"
        aria-label="全屏预览"
        disabled={!playbackEnabled}
        onClick={onFullscreen}
      >
        <IconArrowsMaximize size={25} stroke={1.65} />
      </button>
    </section>
  );
}

/** 产物信息栏属性。 */
interface ArtifactBarProps {
  /** 当前产物。 */
  artifact: RecordingArtifact | null;
  /** 是否正在导出。 */
  exporting: boolean;
  /** 导出 MP4。 */
  onExport(): void;
  /** 打开文件夹。 */
  onOpenFolder(): void;
}

/** MP4 文件元数据与导出操作栏。 */
function ArtifactBar({
  artifact,
  exporting,
  onExport,
  onOpenFolder
}: ArtifactBarProps): ReactNode {
  return (
    <section className="artifact-bar">
      <div className="artifact-bar__info">
        <IconFileExport size={25} stroke={1.55} />
        <span className="artifact-bar__filename">
          {artifact?.fileName || "尚未生成录制文件"}
        </span>
        <span className="artifact-bar__divider" />
        <span className="artifact-bar__size">
          {artifact ? formatFileSize(artifact.sizeBytes) : "—"}
        </span>
        <span className="artifact-bar__divider" />
        <span className="artifact-bar__resolution">
          {artifact ? `${artifact.width} × ${artifact.height}` : "— × —"}
        </span>
        <span className="artifact-bar__divider" />
        <button
          type="button"
          className="artifact-bar__saved"
          disabled={!artifact}
          onClick={onOpenFolder}
        >
          <IconCircleCheck size={20} stroke={1.8} />
          {artifact ? "已保存" : "待录制"}
        </button>
      </div>
      <button
        type="button"
        className="export-button"
        disabled={!artifact || exporting}
        onClick={onExport}
      >
        {exporting ? (
          <IconLoader2 className="is-spinning" size={22} stroke={1.7} />
        ) : (
          <IconUpload size={23} stroke={1.7} />
        )}
        导出 MP4
      </button>
    </section>
  );
}

/** 录制预设可选值。 */
type PresetSelectValue = string | number;

/** 录制预设选项。 */
interface PresetSelectOption<Value extends PresetSelectValue> {
  /** 选项值。 */
  value: Value;
  /** 展示文本。 */
  label: string;
  /** 鼠标悬停时展示的效果说明。 */
  description?: string;
}

/** 录制预设选项内容属性。 */
interface PresetOptionContentProps {
  /** 展示文本。 */
  label: string;
  /** 实际效果说明。 */
  description?: string;
}

/** 渲染带问号说明入口的录制预设选项。 */
function PresetOptionContent({
  label,
  description
}: PresetOptionContentProps): ReactNode {
  return (
    <span className="preset-option" aria-label={label}>
      <span aria-hidden="true">{label}</span>
      {description ? (
        <Tooltip
          title={description}
          placement="right"
          trigger={["hover", "focus"]}
          classNames={{ root: "recording-option-tooltip" }}
        >
          <span
            className="preset-option__help"
            tabIndex={0}
            aria-label={`${label}实际效果说明`}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <IconHelpCircle aria-hidden="true" size={15} stroke={1.8} />
          </span>
        </Tooltip>
      ) : null}
    </span>
  );
}

/** 带图标的录制预设选项属性。 */
interface PresetSelectProps<Value extends PresetSelectValue> {
  /** 无障碍名称。 */
  label: string;
  /** 展示名称。 */
  caption: string;
  /** 当前值。 */
  value: Value;
  /** 左侧图标。 */
  icon: ReactNode;
  /** 可选项。 */
  options: readonly PresetSelectOption<Value>[];
  /** 是否禁用。 */
  disabled: boolean;
  /** 禁用时点击回调。 */
  onDisabledClick(): void;
  /** 修改回调。 */
  onChange(value: Value): void;
}

/** 紧凑的 Ant Design 录制预设选择控件。 */
function PresetSelect<Value extends PresetSelectValue>({
  label,
  caption,
  value,
  icon,
  options,
  disabled,
  onDisabledClick,
  onChange
}: PresetSelectProps<Value>): ReactNode {
  return (
    <div
      className={`preset-select${disabled ? " is-disabled" : ""}`}
      onClick={disabled ? onDisabledClick : undefined}
    >
      <span className="preset-select__icon">{icon}</span>
      <span className="preset-select__field">
        <span className="preset-select__caption">{caption}</span>
        <Select<Value, PresetSelectOption<Value>>
          className="preset-select__control"
          classNames={{ popup: { root: "recording-preset-popup" } }}
          variant="borderless"
          showSearch={false}
          virtual={false}
          popupMatchSelectWidth={false}
          suffixIcon={<IconChevronDown size={15} stroke={1.8} />}
          options={[...options]}
          optionRender={(option) => (
            <PresetOptionContent
              label={option.data.label}
              description={option.data.description}
            />
          )}
          value={value}
          disabled={disabled}
          onChange={onChange}
          aria-label={label}
          aria-describedby={
            disabled ? "recording-preset-lock-note" : undefined
          }
        />
      </span>
    </div>
  );
}

/** 底部录制栏属性。 */
interface RecordingDockProps {
  /** 当前录制预设。 */
  preset: RecordingPreset;
  /** 当前录制状态。 */
  state: RecordingState;
  /** 镜像或录制期间是否锁定预设。 */
  presetLocked: boolean;
  /** 当前设备是否可开始。 */
  canRecord: boolean;
  /** 当前不可录制时的前置条件说明。 */
  prerequisiteMessage?: string;
  /** 修改预设。 */
  onPresetChange(value: Partial<RecordingPreset>): void;
  /** 开始录制。 */
  onStart(): void;
  /** 停止录制。 */
  onStop(): void;
}

/** 画质、音频与主录制操作栏。 */
function RecordingDock({
  preset,
  state,
  presetLocked,
  canRecord,
  prerequisiteMessage,
  onPresetChange,
  onStart,
  onStop
}: RecordingDockProps): ReactNode {
  /** Ant Design 录制提示实例。 */
  const [messageApi, messageContextHolder] = antdMessage.useMessage();
  /** 录制参数是否锁定。 */
  const recordingLocked = ["starting", "recording", "stopping"].includes(
    state.status
  );
  /** 是否展示停止动作。 */
  const recording = ["starting", "recording"].includes(state.status);
  /** 开始录制是否仅保留提示交互。 */
  const recordingUnavailable = !recording && !canRecord;
  /** 主操作无障碍名称。 */
  const actionLabel = recording
    ? "停止录制"
    : state.status === "stopping"
      ? "正在封装"
      : "开始录制";
  /** 执行录制主操作或提示前置条件。 */
  const handleRecordingAction = (): void => {
    if (recording) {
      onStop();
      return;
    }
    if (recordingUnavailable) {
      void messageApi.warning({
        content: prerequisiteMessage ?? "当前无法开始录制",
        duration: 2,
        key: "recording-prerequisite"
      });
      return;
    }
    onStart();
  };
  /** 提示镜像期间不能修改录制参数。 */
  const handleLockedPresetClick = (): void => {
    void messageApi.warning({
      content: presetLockMessage,
      duration: 2,
      key: "recording-preset-lock"
    });
  };

  return (
    <ConfigProvider theme={studioAntTheme}>
      {messageContextHolder}
      <section
        className={`recording-dock${recordingLocked ? " is-compact" : ""}`}
      >
        {!recordingLocked && (
          <div className="recording-dock__presets">
            <PresetSelect
              label="录制分辨率"
              caption="分辨率"
              value={preset.resolution}
              icon={<IconVideo size={20} stroke={1.65} />}
              options={resolutionOptions}
              disabled={presetLocked}
              onDisabledClick={handleLockedPresetClick}
              onChange={(resolution) => onPresetChange({ resolution })}
            />
            <PresetSelect
              label="视频码率"
              caption="视频码率"
              value={preset.videoBitrateMbps}
              icon={<IconGauge size={20} stroke={1.65} />}
              options={bitrateOptions}
              disabled={presetLocked}
              onDisabledClick={handleLockedPresetClick}
              onChange={(videoBitrateMbps) =>
                onPresetChange({ videoBitrateMbps })
              }
            />
            <PresetSelect
              label="录制音频"
              caption="音频来源"
              value={preset.audioMode}
              icon={
                preset.audioMode === "device" ? (
                  <IconMicrophone size={20} stroke={1.65} />
                ) : (
                  <IconMicrophoneOff size={20} stroke={1.65} />
                )
              }
              options={audioOptions}
              disabled={presetLocked}
              onDisabledClick={handleLockedPresetClick}
              onChange={(audioMode) => onPresetChange({ audioMode })}
            />
            {presetLocked && (
              <span
                id="recording-preset-lock-note"
                className="recording-dock__lock-note"
                role="status"
                aria-label="录制参数锁定提示"
              >
                {presetLockMessage}
              </span>
            )}
          </div>
        )}

        <div className="recording-action">
          <button
            type="button"
            className={`record-button${recording ? " is-recording" : ""}${recordingUnavailable ? " is-disabled" : ""}`}
            aria-label={actionLabel}
            aria-disabled={recordingUnavailable || undefined}
            disabled={state.status === "stopping"}
            onClick={handleRecordingAction}
          >
            {state.status === "stopping" ? (
              <IconLoader2 className="is-spinning" size={28} stroke={1.8} />
            ) : recording ? (
              <IconSquareFilled size={23} />
            ) : (
              <IconPlayerPlayFilled size={25} />
            )}
          </button>
          <span>{actionLabel}</span>
        </div>
      </section>
    </ConfigProvider>
  );
}

/** DroidPane 主界面。 */
export function App({ api }: AppProps): ReactNode {
  /** 当前使用的安全桌面接口。 */
  const desktopApi = useMemo(() => api ?? getDesktopApi(), [api]);
  /** 独立 Worker 驱动的实时预览。 */
  const livePreview = useLivePreview(desktopApi);
  /** Ant Design 全局通知实例。 */
  const [notificationApi, notificationContextHolder] =
    antdNotification.useNotification({
      maxCount: 2
    });
  /** 从下一关键帧恢复实时预览。 */
  const retryLivePreview = livePreview.retry;
  /** 切换电脑端音频监听。 */
  const setAudioMonitoring = livePreview.setAudioMonitoring;
  /** 更新电脑端音频监听音量。 */
  const setAudioMonitorVolume = livePreview.setAudioMonitorVolume;
  /** 当前设备列表。 */
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  /** 当前选中设备序列号。 */
  const [selectedSerial, setSelectedSerial] = useState<string>();
  /** 当前录制状态。 */
  const [recordingState, setRecordingState] = useState(
    initialRecordingState
  );
  /** 当前独立镜像控制状态。 */
  const [mirrorState, setMirrorState] = useState(initialMirrorState);
  /** 当前工作区页签。 */
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("device");
  /** 中央舞台当前播放的录制产物。 */
  const [playbackArtifact, setPlaybackArtifact] =
    useState<RecordingArtifact | null>(null);
  /** 需要在视频库主动露出的录制 ID。 */
  const [libraryRevealId, setLibraryRevealId] = useState<string>();
  /** 视频库快照。 */
  const [librarySnapshot, setLibrarySnapshot] =
    useState<RecordingLibrarySnapshot | null>(null);
  /** 是否正在刷新视频库。 */
  const [libraryRefreshing, setLibraryRefreshing] = useState(false);
  /** 当前应用设置。 */
  const [settings, setSettings] = useState(initialSettings);
  /** 是否正在刷新设备。 */
  const [refreshing, setRefreshing] = useState(false);
  /** 是否正在导出。 */
  const [exporting, setExporting] = useState(false);
  /** 临时操作提示。 */
  const [toast, setToast] = useState<string>();
  /** 当前播放时间。 */
  const [currentTime, setCurrentTime] = useState(0);
  /** 是否正在播放。 */
  const [playing, setPlaying] = useState(false);
  /** 当前音量。 */
  const [volume, setVolume] = useState(0.82);
  /** 当前播放倍速。 */
  const [playbackRate, setPlaybackRate] = useState(1);
  /** 视频元素引用。 */
  const videoRef = useRef<HTMLVideoElement>(null);
  /** 镜像录制舞台引用。 */
  const deviceStageRef = useRef<HTMLElement>(null);
  /** 视频播放舞台引用。 */
  const playbackStageRef = useRef<HTMLElement>(null);
  /** 供视频库事件读取的当前播放产物。 */
  const playbackArtifactRef = useRef<RecordingArtifact | null>(null);
  /** 当前选中设备。 */
  const selectedDevice = devices.find(
    (device) => device.serial === selectedSerial
  );
  /** 是否锁定设备和参数。 */
  const recordingLocked = ["starting", "recording", "stopping"].includes(
    recordingState.status
  );
  /** 镜像会话是否锁定设备和录制参数。 */
  const mirrorLocked = ["starting", "mirroring", "stopping"].includes(
    mirrorState.status
  );
  /** 当前设备与参数是否被媒体会话锁定。 */
  const sessionLocked = recordingLocked || mirrorLocked;
  /** 当前是否有可监听的镜像媒体会话。 */
  const mirrorActive = ["starting", "mirroring"].includes(
    mirrorState.status
  );
  /** 当前镜像是否支持电脑端音频监听。 */
  const showAudioMonitor = Boolean(
    mirrorActive &&
      (mirrorState.preset?.audioMode ?? settings.preset.audioMode) ===
        "device" &&
      !mirrorState.audioFallback &&
      selectedDevice &&
      selectedDevice.apiLevel >= 30
  );
  /** 当前监听按钮提示。 */
  const audioMonitorTooltip =
    selectedDevice && selectedDevice.apiLevel >= 33
      ? "Android 13+ 手机已有声音，开启电脑监听可能产生回声"
      : livePreview.audioMonitorMessage || "在电脑上播放录制中的设备声音";
  /** 当前设备是否允许建立镜像。 */
  const canMirror = selectedDevice?.status === "available";
  /** 当前是否允许开始录制。 */
  const canRecord = Boolean(canMirror && mirrorState.status === "mirroring");
  /** 当前不可录制时的显式操作提示。 */
  const recordingPrerequisiteMessage = canRecord
    ? undefined
    : canMirror
      ? "请先开启镜像后再开始录制"
      : "请先连接设备并开启镜像";
  /** 停止当前播放并清空中央舞台选择。 */
  const clearPlayback = useCallback((): void => {
    videoRef.current?.pause();
    playbackArtifactRef.current = null;
    setPlaybackArtifact(null);
    setCurrentTime(0);
    setPlaying(false);
  }, []);
  /** 跳转到视频库并选中新完成的录制。 */
  const handleOpenCompletedRecording = useCallback(
    (artifact: RecordingArtifact): void => {
      notificationApi.destroy(recordingCompletedNotificationKey);
      videoRef.current?.pause();
      setPlaying(false);
      setCurrentTime(0);
      playbackArtifactRef.current = artifact;
      setPlaybackArtifact(artifact);
      setLibraryRevealId(artifact.id);
      setActiveTab("library");
    },
    [notificationApi]
  );
  /** 展示可跳转到新录制的成功通知。 */
  const showRecordingCompletedNotification = useCallback(
    (artifact: RecordingArtifact): void => {
      notificationApi.success({
        key: recordingCompletedNotificationKey,
        title: "录制成功",
        description: `“${artifact.fileName}”已保存到视频库`,
        actions: (
          <button
            type="button"
            className="recording-complete-notification__action"
            onClick={() => handleOpenCompletedRecording(artifact)}
          >
            查看视频
          </button>
        ),
        className: "recording-complete-notification",
        duration: 6,
        pauseOnHover: true,
        role: "status",
      });
    },
    [handleOpenCompletedRecording, notificationApi]
  );
  /** 应用视频库快照并清理失效的当前播放文件。 */
  const applyLibrarySnapshot = useCallback(
    (snapshot: RecordingLibrarySnapshot): void => {
      setLibrarySnapshot(snapshot);
      /** 当前正在播放或展示的产物。 */
      const current = playbackArtifactRef.current;
      if (!current) {
        return;
      }

      /** 快照中同 ID 的可播放条目。 */
      const readyItem = snapshot.items.find(
        (item): item is RecordingLibraryReadyItem =>
          item.status === "ready" && item.id === current.id
      );
      if (!readyItem) {
        clearPlayback();
        return;
      }

      if (!isSameArtifact(current, readyItem)) {
        playbackArtifactRef.current = readyItem;
        setPlaybackArtifact(readyItem);
      }
    },
    [clearPlayback]
  );

  useEffect(() => {
    playbackArtifactRef.current = playbackArtifact;
  }, [playbackArtifact]);

  useEffect(() => {
    /** 是否已卸载。 */
    let disposed = false;

    void Promise.all([
      desktopApi.getDevices(),
      desktopApi.getRecordingState(),
      desktopApi.getMirrorState(),
      desktopApi.getRecordingArtifact(),
      desktopApi.getSettings(),
      desktopApi.getRecordingLibrary().catch(
        (error): RecordingLibrarySnapshot => ({
          directoryName: applicationName,
          items: [],
          refreshedAt: Date.now(),
          errorMessage:
            error instanceof Error ? error.message : "视频库读取失败"
        })
      )
    ])
      .then(
        ([
          deviceSnapshot,
          state,
          currentMirrorState,
          currentArtifact,
          currentSettings,
          currentLibrary
        ]) => {
          if (!disposed) {
            setDevices(deviceSnapshot);
            setRecordingState(state);
            setMirrorState(currentMirrorState);
            setPlaybackArtifact(currentArtifact);
            setSettings(currentSettings);
            setLibrarySnapshot(currentLibrary);
            setSelectedSerial(
              currentMirrorState.deviceSerial ||
                state.deviceSerial ||
                deviceSnapshot.find((device) => device.status === "available")
                  ?.serial ||
                deviceSnapshot[0]?.serial
            );
          }
        }
      )
      .catch((error: Error) => {
        if (!disposed) {
          setRecordingState({
            status: "error",
            elapsedMs: 0,
            fps: 0,
            audioFallback: false,
            errorMessage: error.message
          });
        }
      });

    /** 设备订阅清理函数。 */
    const unsubscribeDevices = desktopApi.onDevicesChanged((snapshot) => {
      setDevices(snapshot);
      setSelectedSerial((current) =>
        snapshot.some((device) => device.serial === current)
          ? current
          : snapshot.find((device) => device.status === "available")?.serial ||
            snapshot[0]?.serial
      );
    });
    /** 状态订阅清理函数。 */
    const unsubscribeState = desktopApi.onRecordingStateChanged(
      setRecordingState
    );
    /** 镜像状态订阅清理函数。 */
    const unsubscribeMirrorState =
      desktopApi.onMirrorStateChanged(setMirrorState);
    /** 视频库订阅清理函数。 */
    const unsubscribeLibrary = desktopApi.onRecordingLibraryChanged(
      applyLibrarySnapshot
    );

    return () => {
      disposed = true;
      unsubscribeDevices();
      unsubscribeState();
      unsubscribeMirrorState();
      unsubscribeLibrary();
    };
  }, [applyLibrarySnapshot, desktopApi]);

  useEffect(
    () =>
      desktopApi.onRecordingArtifactChanged((currentArtifact) => {
        if (currentArtifact) {
          showRecordingCompletedNotification(currentArtifact);
        }
      }),
    [desktopApi, showRecordingCompletedNotification]
  );

  useEffect(() => {
    videoRef.current?.pause();
    setCurrentTime(0);
    setPlaying(false);
  }, [playbackArtifact]);

  useEffect(() => {
    if (!showAudioMonitor && livePreview.audioMonitoring) {
      void setAudioMonitoring(false, settings.audioMonitor.volume);
    }
  }, [
    livePreview.audioMonitoring,
    setAudioMonitoring,
    showAudioMonitor,
    settings.audioMonitor.volume
  ]);

  useEffect(() => {
    if (!toast) {
      return undefined;
    }

    /** 自动隐藏提示的计时器。 */
    const timer = setTimeout(() => setToast(undefined), 2_500);
    return () => clearTimeout(timer);
  }, [toast]);

  /** 将错误转换为界面状态。 */
  const showError = useCallback((error: unknown): void => {
    /** 可展示的错误信息。 */
    const message = error instanceof Error ? error.message : "操作失败";
    setRecordingState((state) => ({
      ...state,
      status: "error",
      errorMessage: message
    }));
  }, []);

  /** 将镜像错误转换为独立界面状态。 */
  const showMirrorError = useCallback((error: unknown): void => {
    /** 可展示的镜像错误。 */
    const message = error instanceof Error ? error.message : "镜像操作失败";
    setMirrorState((state) => ({
      ...state,
      status: "error",
      errorMessage: message
    }));
  }, []);

  /** 执行受限窗口动作。 */
  const handleWindowAction = useCallback(
    (action: WindowAction): void => {
      void desktopApi.controlWindow(action);
    },
    [desktopApi]
  );

  /** 手动刷新设备。 */
  const handleRefresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      setDevices(await desktopApi.refreshDevices());
    } catch (error) {
      showError(error);
    } finally {
      setRefreshing(false);
    }
  }, [desktopApi, showError]);

  /** 重新扫描当前录制目录。 */
  const handleRefreshLibrary = useCallback(async (): Promise<void> => {
    setLibraryRefreshing(true);
    try {
      applyLibrarySnapshot(await desktopApi.refreshRecordingLibrary());
    } catch (error) {
      /** 视频库错误不改变录制主状态。 */
      const message = error instanceof Error ? error.message : "视频库读取失败";
      setLibrarySnapshot((current) => ({
        directoryName: current?.directoryName || applicationName,
        items: current?.items || [],
        refreshedAt: Date.now(),
        errorMessage: message
      }));
    } finally {
      setLibraryRefreshing(false);
    }
  }, [applyLibrarySnapshot, desktopApi]);

  /** 切换工作区，并在离开视频库时暂停播放。 */
  const handleTabChange = useCallback(
    (tab: WorkspaceTab): void => {
      if (tab === activeTab) {
        return;
      }
      if (tab === "device") {
        videoRef.current?.pause();
        setPlaying(false);
      } else {
        void handleRefreshLibrary();
      }
      setActiveTab(tab);
    },
    [activeTab, handleRefreshLibrary]
  );

  /** 切换到历史录制并停在首个可解码画面。 */
  const handleSelectLibraryItem = useCallback(
    (item: RecordingLibraryReadyItem): void => {
      videoRef.current?.pause();
      setPlaying(false);
      setCurrentTime(0);
      playbackArtifactRef.current = item;
      setPlaybackArtifact(item);
      setLibraryRevealId(undefined);
    },
    []
  );

  /** 将视频库条目移至系统回收站并同步最新快照。 */
  const handleDeleteRecordings = useCallback(
    async (ids: string[]): Promise<RecordingDeleteResult> => {
      /** 主进程返回的逐文件删除结果。 */
      const result = await desktopApi.deleteRecordings(ids);
      applyLibrarySnapshot(result.snapshot);
      if (!result.failures.length) {
        setToast(
          result.deletedIds.length === 1
            ? "视频已移至回收站"
            : `${result.deletedIds.length} 个视频已移至回收站`
        );
      }
      return result;
    },
    [applyLibrarySnapshot, desktopApi]
  );

  /** 持久化修改后的录制预设。 */
  const handlePresetChange = useCallback(
    (value: Partial<RecordingPreset>): void => {
      /** 合并后的录制预设。 */
      const preset = {
        ...settings.preset,
        ...value
      };
      /** 渲染进程可修改的设置。 */
      const update = {
        preset,
        audioMonitor: settings.audioMonitor
      };

      setSettings((current) => ({
        ...current,
        preset
      }));
      void desktopApi.setSettings(update).then(setSettings).catch(showError);
    },
    [desktopApi, settings.audioMonitor, settings.preset, showError]
  );

  /** 持久化电脑端音频监听偏好。 */
  const persistAudioMonitor = useCallback(
    (audioMonitor: AudioMonitorSettings): void => {
      setSettings((current) => ({ ...current, audioMonitor }));
      void desktopApi
        .setSettings({ preset: settings.preset, audioMonitor })
        .then(setSettings)
        .catch((error: unknown) => {
          /** 偏好保存错误不影响正在进行的录制。 */
          const message =
            error instanceof Error ? error.message : "监听设置保存失败";
          setToast(message);
        });
    },
    [desktopApi, settings.preset]
  );

  /** 切换当前录制的电脑端音频监听。 */
  const handleToggleAudioMonitor = useCallback(async (): Promise<void> => {
    /** 本次操作后的监听状态。 */
    const enabled = !livePreview.audioMonitoring;
    try {
      await setAudioMonitoring(enabled, settings.audioMonitor.volume);
    } catch {
      setToast("电脑端音频监听不可用，不影响镜像与录制");
      return;
    }

    if (selectedDevice && selectedDevice.apiLevel < 33) {
      persistAudioMonitor({
        ...settings.audioMonitor,
        autoEnableOnLegacyAndroid: enabled
      });
    }
  }, [
    livePreview.audioMonitoring,
    persistAudioMonitor,
    selectedDevice,
    setAudioMonitoring,
    settings.audioMonitor
  ]);

  /** 修改并持久化电脑端音频监听音量。 */
  const handleAudioMonitorVolume = useCallback(
    (volume: number): void => {
      setAudioMonitorVolume(volume);
      persistAudioMonitor({ ...settings.audioMonitor, volume });
    },
    [persistAudioMonitor, setAudioMonitorVolume, settings.audioMonitor]
  );

  /** 按设备版本恢复本次媒体会话的电脑监听偏好。 */
  const prepareAudioMonitoring = useCallback(
    async (device: DeviceInfo): Promise<void> => {
      /** Android 11/12 恢复偏好，Android 13+ 每次从关闭开始。 */
      const enabled =
        settings.preset.audioMode === "device" &&
        device.apiLevel >= 30 &&
        device.apiLevel < 33 &&
        settings.audioMonitor.autoEnableOnLegacyAndroid;
      try {
        await setAudioMonitoring(enabled, settings.audioMonitor.volume);
      } catch {
        setToast("电脑端音频监听不可用，镜像与录制仍可继续");
      }
    },
    [setAudioMonitoring, settings.audioMonitor, settings.preset.audioMode]
  );

  /** 开启当前设备的独立镜像控制。 */
  const handleStartMirroring = useCallback(async (): Promise<void> => {
    if (!selectedDevice || selectedDevice.status !== "available") {
      return;
    }

    setMirrorState({
      status: "starting",
      deviceSerial: selectedDevice.serial,
      preset: { ...settings.preset },
      audioFallback: false,
      previewStatus: "connecting"
    });
    retryLivePreview();
    await prepareAudioMonitoring(selectedDevice);
    try {
      setMirrorState(
        await desktopApi.startMirroring(
          selectedDevice.serial,
          settings.preset
        )
      );
    } catch (error) {
      showMirrorError(error);
    }
  }, [
    desktopApi,
    prepareAudioMonitoring,
    retryLivePreview,
    selectedDevice,
    settings.preset,
    showMirrorError
  ]);

  /** 结束独立镜像并恢复此前选择的录制文件。 */
  const handleStopMirroring = useCallback(async (): Promise<void> => {
    try {
      setMirrorState((state) => ({ ...state, status: "stopping" }));
      await setAudioMonitoring(false, settings.audioMonitor.volume);
      setMirrorState(await desktopApi.stopMirroring());
    } catch (error) {
      showMirrorError(error);
    }
  }, [
    desktopApi,
    setAudioMonitoring,
    settings.audioMonitor.volume,
    showMirrorError
  ]);

  /** 通过系统选择器修改后续录制文件的存储目录。 */
  const handleChooseDirectory = useCallback(async (): Promise<void> => {
    try {
      /** 系统目录选择结果。 */
      const result = await desktopApi.chooseRecordingsDirectory();

      if (!result.canceled) {
        setSettings(result.settings);
        clearPlayback();
        setLibrarySnapshot(null);
        await handleRefreshLibrary();
        setToast("录制存储位置已更新");
      }
    } catch (error) {
      showError(error);
    }
  }, [clearPlayback, desktopApi, handleRefreshLibrary, showError]);

  /** 打开当前设置中的录制目录。 */
  const handleOpenRecordingsDirectory = useCallback((): void => {
    void desktopApi.openRecordingFolder().catch(showError);
  }, [desktopApi, showError]);

  /** 在系统文件管理器中显示当前录制文件。 */
  const handleShowRecordingFile = useCallback((): void => {
    if (!playbackArtifact) {
      return;
    }

    void desktopApi
      .openRecordingFolder(playbackArtifact.id)
      .catch(showError);
  }, [desktopApi, playbackArtifact, showError]);

  /** 开始当前设备录制。 */
  const handleStart = useCallback(async (): Promise<void> => {
    if (
      !selectedDevice ||
      selectedDevice.status !== "available" ||
      mirrorState.status !== "mirroring"
    ) {
      return;
    }

    try {
      setRecordingState({
        status: "starting",
        elapsedMs: 0,
        fps: 0,
        deviceSerial: selectedDevice.serial,
        audioFallback: false
      });
      setRecordingState(await desktopApi.startRecording());
    } catch (error) {
      showError(error);
    }
  }, [
    desktopApi,
    mirrorState.status,
    selectedDevice,
    showError
  ]);

  /** 停止当前录制并等待封装。 */
  const handleStop = useCallback(async (): Promise<void> => {
    try {
      setRecordingState(await desktopApi.stopRecording());
    } catch (error) {
      showError(error);
    }
  }, [desktopApi, showError]);

  /** 无损导出当前 MP4。 */
  const handleExport = useCallback(async (): Promise<void> => {
    if (!playbackArtifact) {
      return;
    }

    setExporting(true);
    try {
      /** 系统另存为结果。 */
      const result = await desktopApi.exportRecording(playbackArtifact.id);

      if (!result.canceled) {
        setToast("MP4 已导出");
      }
    } catch (error) {
      showError(error);
    } finally {
      setExporting(false);
    }
  }, [desktopApi, playbackArtifact, showError]);

  /** 切换播放器播放状态。 */
  const handleTogglePlayback = useCallback((): void => {
    if (!playbackArtifact) {
      return;
    }

    if (playbackArtifact.mediaUrl && videoRef.current) {
      /** 以媒体元素真实状态为准，避免 React 事件更新延迟造成反向操作。 */
      const video = videoRef.current;
      if (!video.paused) {
        video.pause();
      } else {
        void video
          .play()
          .catch((error: Error) => setToast(`播放失败：${error.message}`));
      }
      return;
    }
  }, [playbackArtifact]);

  /** 跳转播放器时间。 */
  const handleSeek = useCallback((value: number): void => {
    if (videoRef.current?.src) {
      videoRef.current.currentTime = value;
    }
    setCurrentTime(value);
  }, []);

  /** 修改播放器音量。 */
  const handleVolume = useCallback((value: number): void => {
    if (videoRef.current) {
      videoRef.current.volume = value;
    }
    setVolume(value);
  }, []);

  /** 切换到下一播放倍速。 */
  const handleCycleRate = useCallback((): void => {
    /** 当前倍速索引。 */
    const index = playbackRates.indexOf(playbackRate);
    /** 下一倍速。 */
    const next = playbackRates[(index + 1) % playbackRates.length];

    if (videoRef.current) {
      videoRef.current.playbackRate = next;
    }
    setPlaybackRate(next);
  }, [playbackRate]);

  /** 将指定舞台切换为全屏。 */
  const handleFullscreen = useCallback((stage: HTMLElement | null): void => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(showError);
      return;
    }
    void stage?.requestFullscreen().catch(showError);
  }, [showError]);

  return (
    <div className="app-shell">
      <ConfigProvider theme={studioAntTheme}>
        {notificationContextHolder}
      </ConfigProvider>
      <TitleBar onWindowAction={handleWindowAction} />
      <DeviceToolbar
        devices={devices}
        selectedSerial={selectedSerial}
        locked={sessionLocked}
        directoryLocked={recordingLocked}
        mirrorState={mirrorState}
        canMirror={Boolean(canMirror)}
        recordingBusy={recordingLocked}
        onStartMirroring={() => void handleStartMirroring()}
        onStopMirroring={() => void handleStopMirroring()}
        refreshing={refreshing}
        onSelect={setSelectedSerial}
        onRefresh={() => void handleRefresh()}
        recordingsDirectory={settings.recordingsDirectory}
        onChooseDirectory={() => void handleChooseDirectory()}
        onOpenFolder={handleOpenRecordingsDirectory}
        onOpenDevTools={() => handleWindowAction("open-devtools")}
        activeTab={activeTab}
        onTabChange={handleTabChange}
      />
      <section className="studio-workspace">
        <section
          id="workspace-panel-device"
          className="workspace-panel workspace-panel--device"
          role="tabpanel"
          aria-labelledby="workspace-tab-device"
          hidden={activeTab !== "device"}
        >
          <div className="studio-workspace__content">
            <DeviceStage
              api={desktopApi}
              device={selectedDevice}
              state={recordingState}
              mirrorState={mirrorState}
              stageRef={deviceStageRef}
              preview={livePreview}
              active={activeTab === "device"}
              onFullscreen={() =>
                handleFullscreen(deviceStageRef.current)
              }
              showAudioMonitor={showAudioMonitor}
              audioMonitorVolume={settings.audioMonitor.volume}
              audioMonitorTooltip={audioMonitorTooltip}
              onToggleAudioMonitor={() => void handleToggleAudioMonitor()}
              onAudioMonitorVolume={handleAudioMonitorVolume}
            />
          </div>
          {activeTab === "device" && (
            <RecordingDock
              preset={settings.preset}
              state={recordingState}
              presetLocked={sessionLocked}
              canRecord={canRecord}
              prerequisiteMessage={recordingPrerequisiteMessage}
              onPresetChange={handlePresetChange}
              onStart={() => void handleStart()}
              onStop={() => void handleStop()}
            />
          )}
        </section>
        <section
          id="workspace-panel-library"
          className="workspace-panel workspace-panel--library"
          role="tabpanel"
          aria-labelledby="workspace-tab-library"
          hidden={activeTab !== "library"}
        >
          <VideoLibraryDrawer
            key={settings.recordingsDirectory}
            snapshot={librarySnapshot}
            refreshing={libraryRefreshing}
            selectedId={playbackArtifact?.id}
            revealId={libraryRevealId}
            deletionLocked={recordingLocked}
            onSelect={handleSelectLibraryItem}
            onDelete={handleDeleteRecordings}
            onOpenFolder={handleOpenRecordingsDirectory}
          />
          <div className="studio-workspace__content">
            <PlaybackStage
              artifact={playbackArtifact}
              videoRef={videoRef}
              stageRef={playbackStageRef}
              onTimeUpdate={setCurrentTime}
              onEnded={() => setPlaying(false)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              volume={volume}
              playbackRate={playbackRate}
            />
            <PlayerControls
              artifact={playbackArtifact}
              currentTime={currentTime}
              playing={playing}
              volume={volume}
              playbackRate={playbackRate}
              onTogglePlayback={handleTogglePlayback}
              onSeek={handleSeek}
              onVolume={handleVolume}
              onCycleRate={handleCycleRate}
              onFullscreen={() =>
                handleFullscreen(playbackStageRef.current)
              }
            />
            <ArtifactBar
              artifact={playbackArtifact}
              exporting={exporting}
              onExport={() => void handleExport()}
              onOpenFolder={handleShowRecordingFile}
            />
          </div>
        </section>
      </section>
      {toast && (
        <div className="global-toast" role="status">
          <IconCircleCheck size={19} stroke={1.9} />
          {toast}
        </div>
      )}
    </div>
  );
}
