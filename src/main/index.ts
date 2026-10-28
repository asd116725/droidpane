import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  protocol,
  screen,
  shell,
  type WebContents
} from "electron";
import { ipcChannels } from "../shared/ipc";
import { applicationName } from "../shared/brand";
import type {
  RecordingArtifact,
  RecordingLibraryReadyItem
} from "../shared/types";
import { AdbClient } from "./adb/client";
import { DeviceService } from "./adb/device-service";
import { WirelessService } from "./adb/wireless-service";
import { MirrorRecoveryService } from "./mirroring/recovery-service";
import { WindowController } from "./window-controller";
import { inspectMp4File } from "./files/mp4";
import { registerIpcHandlers } from "./ipc";
import {
  registerMediaHandler,
  registerMediaScheme
} from "./media/protocol";
import { RecordingService } from "./recording/service";
import { RecordingLibraryService } from "./recording/library";
import { ScrcpyMp4Muxer } from "./recording/muxer";
import { LivePreviewHub } from "./preview/hub";
import { MirroringService } from "./mirroring/service";
import { resolveRuntimePaths } from "./runtime/paths";
import {
  createScrcpySessionDependencies,
  ScrcpySessionFactory
} from "./scrcpy/session";
import { SettingsService } from "./settings/service";
import { resolveMainWindowBounds } from "./window-bounds";

/** 开发环境应用图标路径。 */
const developmentIconPath = path.resolve(
  process.cwd(),
  "assets",
  "app-icon.png"
);

app.setName(applicationName);
registerMediaScheme();

/** 移除文件库条目专属字段，仅返回录制产物契约。 */
function toRecordingArtifact(
  item: RecordingLibraryReadyItem
): RecordingArtifact {
  return {
    id: item.id,
    fileName: item.fileName,
    durationSeconds: item.durationSeconds,
    sizeBytes: item.sizeBytes,
    width: item.width,
    height: item.height,
    hasAudio: item.hasAudio,
    mediaUrl: item.mediaUrl
  };
}

/** 当前主窗口。 */
let mainWindow: BrowserWindow | null = null;
/** 是否允许本次窗口关闭。 */
let allowWindowClose = false;
/** 清理 IPC 处理器。 */
let cleanupIpc: (() => void) | undefined;
/** 全局设备服务。 */
let deviceService: DeviceService | undefined;
/** 全局录制服务。 */
let recordingService: RecordingService | undefined;
/** 全局镜像服务。 */
let mirroringService: MirroringService | undefined;
let wirelessService: WirelessService | undefined;
let recoveryService: MirrorRecoveryService | undefined;
let windowController: WindowController | undefined;
/** 去重系统关闭与窗口关闭同时触发的收尾。 */
let windowCloseTask: Promise<void> | undefined;

/** 仅向存活的主窗口发送事件。 */
function sendToRenderer(
  webContents: WebContents,
  channel: string,
  value: unknown
): void {
  if (!webContents.isDestroyed()) {
    webContents.send(channel, value);
  }
}

/** 创建安全的无边框主窗口。 */
function createMainWindow(
  recording: RecordingService,
  library: RecordingLibraryService
): BrowserWindow {
  /** 当前主显示器可用工作区内的窗口尺寸。 */
  const windowBounds = resolveMainWindowBounds(
    screen.getPrimaryDisplay().workAreaSize
  );
  /** 应用主窗口。 */
  const window = new BrowserWindow({
    ...windowBounds,
    show: false,
    frame: false,
    resizable: true,
    thickFrame: true,
    center: true,
    backgroundColor: "#070809",
    title: applicationName,
    icon: app.isPackaged ? undefined : developmentIconPath,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      /** 后台仍持续处理实时媒体，避免切屏后等待关键帧重连。 */
      backgroundThrottling: false
    }
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== MAIN_WINDOW_WEBPACK_ENTRY) {
      event.preventDefault();
    }
  });
  window.on("close", (event) => {
    if (!allowWindowClose) {
      event.preventDefault();
      if (recording.isBusy()) void confirmRecordingClose(window, recording);
      else void finishWindowClose(window);
    }
  });
  /** 窗口重新激活时同步外部新增或删除的录屏。 */
  const refreshLibrary = (): void => {
    void library.refresh();
  };
  window.on("focus", refreshLibrary);
  window.on("closed", () => {
    window.removeListener("focus", refreshLibrary);
    mainWindow = null;
  });
  return window;
}

/** 退出前确认并收尾当前录制。 */
async function confirmRecordingClose(
  window: BrowserWindow,
  recording: RecordingService
): Promise<void> {
  /** 退出确认结果。 */
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    title: "录制尚未结束",
    message: "退出前需要先完成当前 MP4 封装。",
    detail: "选择“结束录制并退出”后，应用会等待文件可安全播放。",
    buttons: ["结束录制并退出", "继续录制"],
    defaultId: 0,
    cancelId: 1
  });

  if (result.response === 0) {
    await recording.stop();
    await finishWindowClose(window);
  }
}

/** 关闭前保存最后一次窗口移动，完成后再允许原生窗口退出。 */
function finishWindowClose(window: BrowserWindow): Promise<void> {
  windowCloseTask ??= (async () => {
    await windowController?.flush().catch(() => undefined);
    allowWindowClose = true;
    window.close();
  })();
  return windowCloseTask;
}

/** 初始化主进程服务与事件桥接。 */
async function initializeApplication(): Promise<void> {
  if (process.platform === "darwin" && !app.isPackaged) {
    app.dock?.setIcon(developmentIconPath);
  }

  /** 当前平台的内置二进制路径。 */
  const runtime = resolveRuntimePaths({
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    projectRoot: process.cwd(),
    resourcesPath: process.resourcesPath
  });
  /** 首次启动使用的应用录制目录。 */
  const defaultRecordingsDirectory = path.join(
    app.getPath("videos"),
    applicationName
  );
  /** 设置持久化服务。 */
  const settings = new SettingsService(
    path.join(app.getPath("userData"), "settings.json"),
    defaultRecordingsDirectory
  );
  await settings.load();
  /** 当前设置目录的录制文件库。 */
  const library = new RecordingLibraryService({
    getRecordingsDirectory: () => settings.get().recordingsDirectory,
    inspectFile: inspectMp4File,
    trashItem: (filePath) => shell.trashItem(filePath)
  });
  await library.initialize();
  /** ADB 固定操作客户端。 */
  const adb = new AdbClient(runtime.adb);
  /** 设备轮询服务。 */
  const devices = new DeviceService(adb);
  const wireless = new WirelessService({
    adb,
    refreshDevices: () => devices.refresh(),
    getProfiles: () => settings.get().wirelessProfiles ?? [],
    saveProfiles: async (profiles) => { await settings.setWirelessProfiles(profiles); }
  });
  /** 主窗口只读实时预览分发器。 */
  const preview = new LivePreviewHub(LIVE_PREVIEW_WORKER_WEBPACK_ENTRY);
  /** 配套 scrcpy-server 单流会话工厂。 */
  const sessionFactory = new ScrcpySessionFactory(
    createScrcpySessionDependencies(runtime.adb, runtime.scrcpyServer, adb)
  );
  /** 独立镜像、控制和媒体路由服务。 */
  const mirroring = new MirroringService({
    sessionFactory,
    preview,
    findServerPid: (serial, scid) => adb.findServerPid(serial, scid),
    interruptServer: (serial, pid) => adb.interruptServer(serial, pid),
    forceStopServer: (serial, pid) => adb.forceStopServer(serial, pid)
  });
  /** 录制生命周期服务。 */
  const recording = new RecordingService({
    getRecordingsDirectory: () => settings.get().recordingsDirectory,
    ensureDirectory: async (directory) => {
      await mkdir(directory, { recursive: true });
    },
    inspectFile: inspectMp4File,
    mirroring,
    createMuxer: (filePath, audioExpected, callbacks) =>
      new ScrcpyMp4Muxer(filePath, audioExpected, callbacks),
    now: () => new Date(),
    registerArtifact: async (filePath, metadata) =>
      toRecordingArtifact(
        await library.registerCompletedFile(filePath, metadata)
      )
  });
  const recovery = new MirrorRecoveryService({
    mirroring,
    recording,
    resolveDevice: async (target, signal) => {
      const snapshot = await devices.refresh();
      if (signal.aborted) return undefined;
      if (target.connectionType !== "network") {
        return snapshot.find((device) => device.serial === target.serial && device.status === "available");
      }
      if (!target.identity) return undefined;
      const current = snapshot.filter((device) => device.identity === target.identity && device.status === "available");
      if (current.length === 1) return current[0];
      const profile = (settings.get().wirelessProfiles ?? []).find((item) => item.identity === target.identity);
      return profile ? wireless.reconnect(profile, signal) : undefined;
    }
  });
  preview.onStatusChanged(({ status, message }) =>
    mirroring.handlePreviewStatus(status, message)
  );
  registerMediaHandler(library);
  mainWindow = createMainWindow(recording, library);
  const presentation = new WindowController({
    window: mainWindow,
    preferences: settings.get().windowPresentation,
    getWorkArea: (bounds) => screen.getDisplayMatching(bounds).workArea,
    savePreferences: (value) => settings.setWindowPresentation(value)
  });
  windowController = presentation;
  await presentation.initialize().catch((error: unknown) => {
    console.warn("恢复窗口布局失败，将使用当前窗口继续启动", error);
  });
  const fitWindow = (): void => { void presentation.fitToWorkArea().catch(() => undefined); };
  screen.on("display-removed", fitWindow);
  screen.on("display-metrics-changed", fitWindow);
  mainWindow.once("closed", () => {
    screen.removeListener("display-removed", fitWindow);
    screen.removeListener("display-metrics-changed", fitWindow);
    presentation.dispose();
  });
  deviceService = devices;
  recordingService = recording;
  mirroringService = mirroring;
  wirelessService = wireless;
  recoveryService = recovery;
  cleanupIpc = registerIpcHandlers(mainWindow, {
    devices,
    recording,
    mirroring,
    library,
    settings,
    preview,
    wireless,
    recovery,
    windowPresentation: presentation
  });

  wireless.onChanged((state) => {
    if (mainWindow) sendToRenderer(mainWindow.webContents, ipcChannels.wirelessStateChanged, state);
  });
  recovery.onChanged((state) => {
    if (mainWindow) sendToRenderer(mainWindow.webContents, ipcChannels.mirrorRecoveryStateChanged, state);
  });
  presentation.onChanged((state) => {
    if (mainWindow) sendToRenderer(mainWindow.webContents, ipcChannels.windowPresentationChanged, state);
  });

  devices.onChanged((snapshot) => {
    if (mainWindow) {
      sendToRenderer(
        mainWindow.webContents,
        ipcChannels.devicesChanged,
        snapshot
      );
    }

    /** 当前镜像设备序列号。 */
    const activeSerial = mirroring.getState().deviceSerial;
    /** 当前镜像设备仍是否可用。 */
    const activeDevice = snapshot.find(
      (device) => device.serial === activeSerial
    );

    if (activeSerial && activeDevice?.status !== "available") {
      mirroring.handleDeviceDisconnected(activeSerial);
    }
  });
  mirroring.onStateChanged((state) => {
    if (mainWindow) {
      sendToRenderer(
        mainWindow.webContents,
        ipcChannels.mirrorStateChanged,
        state
      );
    }
  });
  recording.onStateChanged((state) => {
    if (mainWindow) {
      sendToRenderer(
        mainWindow.webContents,
        ipcChannels.recordingStateChanged,
        state
      );
    }
  });
  recording.onArtifactChanged((artifact) => {
    if (mainWindow) {
      sendToRenderer(
        mainWindow.webContents,
        ipcChannels.recordingArtifactChanged,
        artifact
      );
    }
  });
  library.onChanged((snapshot) => {
    if (mainWindow) {
      sendToRenderer(
        mainWindow.webContents,
        ipcChannels.recordingLibraryChanged,
        snapshot
      );
    }
  });
  /** 先注册全部接口再加载页面，避免首屏请求早于主进程就绪。 */
  await mainWindow.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  await devices.start();
}

void app.whenReady().then(initializeApplication);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (!allowWindowClose && mainWindow) {
    event.preventDefault();
    if (recordingService?.isBusy()) void confirmRecordingClose(mainWindow, recordingService);
    else void finishWindowClose(mainWindow);
  }
});

app.on("will-quit", () => {
  recoveryService?.close();
  wirelessService?.cancel();
  mirroringService?.close();
  cleanupIpc?.();
  deviceService?.stop();
  protocol.unhandle("adb-studio-media");
});
