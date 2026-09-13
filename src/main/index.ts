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
    if (!allowWindowClose && recording.isBusy()) {
      event.preventDefault();
      void confirmRecordingClose(window, recording);
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
  void window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
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
    allowWindowClose = true;
    window.close();
  }
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
  preview.onStatusChanged(({ status, message }) =>
    mirroring.handlePreviewStatus(status, message)
  );
  registerMediaHandler(library);
  mainWindow = createMainWindow(recording, library);
  deviceService = devices;
  recordingService = recording;
  mirroringService = mirroring;
  cleanupIpc = registerIpcHandlers(mainWindow, {
    devices,
    recording,
    mirroring,
    library,
    settings,
    preview
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
  await devices.start();
}

void app.whenReady().then(initializeApplication);

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", (event) => {
  if (!allowWindowClose && recordingService?.isBusy() && mainWindow) {
    event.preventDefault();
    void confirmRecordingClose(mainWindow, recordingService);
  }
});

app.on("will-quit", () => {
  mirroringService?.close();
  cleanupIpc?.();
  deviceService?.stop();
  protocol.unhandle("adb-studio-media");
});
