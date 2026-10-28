import path from "node:path";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from "electron";
import { ipcChannels } from "../shared/ipc";
import { applicationName } from "../shared/brand";
import {
  parseBooleanSetting,
  parseConnectWirelessInput,
  parsePairWirelessInput,
  parseProfileId,
  parseProfileRename,
  parseWindowMode,
  parseWirelessSerial
} from "../shared/connection-validation";
import {
  parseArtifactId,
  parseArtifactIds,
  parseDeviceControlCommand,
  parseSettingsUpdate,
  parseStartMirroringInput,
  parseWindowAction
} from "../shared/validation";
import { copyRecordingFile } from "./files/export";
import type { DeviceService } from "./adb/device-service";
import type { RecordingService } from "./recording/service";
import type { RecordingLibraryService } from "./recording/library";
import type { SettingsService } from "./settings/service";
import type { LivePreviewHub } from "./preview/hub";
import type { MirroringService } from "./mirroring/service";
import type { WirelessService } from "./adb/wireless-service";
import type { MirrorRecoveryService } from "./mirroring/recovery-service";
import type { WindowController } from "./window-controller";

/** IPC 处理器所需主进程服务。 */
export interface IpcServices {
  /** 设备轮询服务。 */
  devices: DeviceService;
  /** 录制生命周期服务。 */
  recording: RecordingService;
  /** 独立镜像与设备控制服务。 */
  mirroring: MirroringService;
  /** 当前录制目录文件库。 */
  library: RecordingLibraryService;
  /** 设置持久化服务。 */
  settings: SettingsService;
  /** 实时预览消息分发器。 */
  preview: LivePreviewHub;
  /** 无线接入与最近设备。 */
  wireless: WirelessService;
  /** 显式镜像意图与异常恢复。 */
  recovery: MirrorRecoveryService;
  /** 同一窗口的布局与置顶。 */
  windowPresentation: WindowController;
}

/** 创建并确认目录可写。 */
async function ensureWritableDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await access(directory, constants.W_OK);
}

/** 确认调用来自当前主窗口的顶层渲染帧。 */
export function assertTrustedSender(
  event: IpcMainInvokeEvent | IpcMainEvent,
  window: BrowserWindow
): void {
  if (!isTrustedSender(event, window)) {
    throw new Error("拒绝来自非受信任页面的请求");
  }
}

/** 判断事件是否来自当前主窗口的顶层渲染帧。 */
function isTrustedSender(
  event: IpcMainInvokeEvent | IpcMainEvent,
  window: BrowserWindow
): boolean {
  return (
    event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame
  );
}

/** 注册受限 IPC 接口并返回清理函数。 */
export function registerIpcHandlers(
  window: BrowserWindow,
  services: IpcServices
): () => void {
  /** 是否正在等待系统完成回收站操作。 */
  let deletingRecordings = false;
  const invokeChannels: string[] = [];
  /** 覆盖等待旧镜像停止期间的取消，避免稍后才开始过期配对。 */
  let wirelessRequestId = 0;
  /** 注册并统一校验发送方。 */
  const handle = (
    channel: string,
    listener: (event: IpcMainInvokeEvent, value?: unknown) => unknown
  ): void => {
    ipcMain.handle(channel, (event, value) => {
      assertTrustedSender(event, window);
      return listener(event, value);
    });
    invokeChannels.push(channel);
  };

  /** 切换到新无线设备前，先完成当前镜像的显式停止。 */
  const prepareWirelessConnection = async (): Promise<boolean> => {
    if (services.recording.isBusy()) throw new Error("请先停止录制，再连接其他设备");
    const requestId = ++wirelessRequestId;
    services.wireless.cancel();
    await services.recovery.stop();
    return requestId === wirelessRequestId;
  };

  handle(ipcChannels.getWirelessState, () => services.wireless.getState());
  handle(ipcChannels.discoverWirelessDevices, () => services.wireless.discover());
  handle(ipcChannels.pairWirelessDevice, async (_event, value) => {
    const input = parsePairWirelessInput(value);
    if (!await prepareWirelessConnection()) return services.wireless.getState();
    return services.wireless.pair(input);
  });
  handle(ipcChannels.connectWirelessDevice, async (_event, value) => {
    const input = parseConnectWirelessInput(value);
    if (!await prepareWirelessConnection()) return services.wireless.getState();
    return services.wireless.connect(input);
  });
  handle(ipcChannels.cancelWirelessOperation, () => {
    wirelessRequestId += 1;
    return services.wireless.cancel();
  });
  handle(ipcChannels.disconnectWirelessDevice, async (_event, value) => {
    const serial = parseWirelessSerial(value);
    if (services.recording.isBusy()) throw new Error("请先停止录制，再断开设备");
    wirelessRequestId += 1;
    services.wireless.cancel();
    if (services.mirroring.getState().deviceSerial === serial) await services.recovery.stop();
    return services.wireless.disconnect(serial);
  });
  handle(ipcChannels.renameWirelessProfile, (_event, value) => {
    const { id, name } = parseProfileRename(value);
    return services.wireless.renameProfile(id, name);
  });
  handle(ipcChannels.removeWirelessProfile, (_event, value) => services.wireless.removeProfile(parseProfileId(value)));
  handle(ipcChannels.getMirrorRecoveryState, () => services.recovery.getState());
  handle(ipcChannels.retryMirrorRecovery, () => services.recovery.retry());
  handle(ipcChannels.cancelMirrorRecovery, () => services.recovery.cancel());
  handle(ipcChannels.getWindowPresentation, () => services.windowPresentation.getState());
  handle(ipcChannels.setWindowMode, (_event, value) => services.windowPresentation.setMode(parseWindowMode(value)));
  handle(ipcChannels.setWindowAlwaysOnTop, (_event, value) => services.windowPresentation.setAlwaysOnTop(parseBooleanSetting(value)));
  handle(ipcChannels.setConnectionPanelOpen, (_event, value) => services.windowPresentation.setConnectionPanelOpen(parseBooleanSetting(value)));

  handle(ipcChannels.getDevices, () => services.devices.getDevices());
  handle(ipcChannels.refreshDevices, () => services.devices.refresh());
  handle(ipcChannels.getRecordingState, () => services.recording.getState());
  handle(ipcChannels.getMirrorState, () => services.mirroring.getState());
  handle(ipcChannels.getRecordingArtifact, () =>
    services.recording.getArtifact()
  );
  handle(ipcChannels.getRecordingLibrary, () =>
    services.library.getSnapshot()
  );
  handle(ipcChannels.refreshRecordingLibrary, () =>
    services.library.refresh()
  );
  handle(ipcChannels.deleteRecordings, async (_event, value) => {
    if (services.recording.isBusy() || deletingRecordings) {
      throw new Error("录制或封装期间不能删除视频");
    }

    /** 已校验并去重的内部文件 ID。 */
    const ids = parseArtifactIds(value);
    deletingRecordings = true;
    try {
      return await services.library.deleteRecordings(ids);
    } finally {
      deletingRecordings = false;
    }
  });
  handle(ipcChannels.startRecording, () => {
    if (deletingRecordings) {
      throw new Error("视频移入回收站期间不能开始录制");
    }

    return services.recording.start();
  });
  handle(ipcChannels.stopRecording, () => services.recording.stop());
  handle(ipcChannels.startMirroring, (_event, value) => {
    /** 已校验开始镜像参数。 */
    const input = parseStartMirroringInput(value);
    /** 当前列表中的目标设备。 */
    const device = services.devices
      .getDevices()
      .find((item) => item.serial === input.deviceSerial);

    if (!device) {
      throw new Error("所选设备已断开连接");
    }

    wirelessRequestId += 1;
    services.wireless.cancel();
    return services.recovery.start(device, input.preset);
  });
  handle(ipcChannels.stopMirroring, () => {
    wirelessRequestId += 1;
    services.wireless.cancel();
    return services.recovery.stop();
  });
  handle(ipcChannels.exportRecording, async (_event, value) => {
    /** 已校验产物 ID。 */
    const artifactId = parseArtifactId(value);
    /** 可导出的产物。 */
    const artifact = services.library.getReadyItem(artifactId);
    /** 仅主进程可见的源文件路径。 */
    const sourcePath = await services.library.resolveMediaFile(artifactId);

    if (!artifact || !sourcePath) {
      throw new Error("录制文件不存在");
    }

    /** 系统另存为结果。 */
    const result = await dialog.showSaveDialog(window, {
      title: "导出 MP4",
      defaultPath: path.join(path.dirname(sourcePath), artifact.fileName),
      buttonLabel: "导出",
      filters: [{ name: "MP4 视频", extensions: ["mp4"] }]
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    /** 无损复制后的字节数。 */
    const sizeBytes = await copyRecordingFile(sourcePath, result.filePath);
    return {
      canceled: false,
      destination: result.filePath,
      sizeBytes
    };
  });
  handle(ipcChannels.openRecordingFolder, async (_event, value) => {
    if (value) {
      /** 已校验产物 ID。 */
      const artifactId = parseArtifactId(value);
      /** 对应文件路径。 */
      const filePath = await services.library.resolveFilePath(artifactId);

      if (!filePath) {
        throw new Error("录制文件不存在");
      }

      shell.showItemInFolder(filePath);
      return;
    }

    /** 当前设置中的录制目录。 */
    const recordingsDirectory = services.settings.get().recordingsDirectory;
    await mkdir(recordingsDirectory, { recursive: true });
    /** 系统文件管理器返回的错误说明。 */
    const errorMessage = await shell.openPath(recordingsDirectory);

    if (errorMessage) {
      throw new Error(`无法打开录制文件夹：${errorMessage}`);
    }
  });
  handle(ipcChannels.getSettings, () => services.settings.get());
  handle(ipcChannels.setSettings, (_event, value) => {
    /** 仅包含录制预设与监听偏好的设置更新。 */
    const update = parseSettingsUpdate(value);
    /** 当前镜像锁定的录制预设。 */
    const mirrorPreset = services.mirroring.getState().preset;
    if (
      services.mirroring.isBusy() &&
      mirrorPreset &&
      (mirrorPreset.resolution !== update.preset.resolution ||
        mirrorPreset.videoBitrateMbps !== update.preset.videoBitrateMbps ||
        mirrorPreset.audioMode !== update.preset.audioMode)
    ) {
      throw new Error("镜像期间不能修改分辨率、码率或音频模式");
    }
    return services.settings.setPreferences(update);
  });
  handle(ipcChannels.chooseRecordingsDirectory, async () => {
    if (services.recording.isBusy() || deletingRecordings) {
      throw new Error("录制期间不能修改文件存储位置");
    }

    /** 当前应用设置。 */
    const currentSettings = services.settings.get();
    /** 系统文件夹选择结果。 */
    const result = await dialog.showOpenDialog(window, {
      title: "选择录制文件存储位置",
      buttonLabel: "选择文件夹",
      defaultPath: currentSettings.recordingsDirectory,
      properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true, settings: currentSettings };
    }

    /** 由系统选择器返回的规范目录。 */
    const recordingsDirectory = path.normalize(result.filePaths[0]);
    await ensureWritableDirectory(recordingsDirectory);
    /** 已持久化的新设置。 */
    const settings =
      await services.settings.setRecordingsDirectory(recordingsDirectory);
    await services.library.refresh();
    return { canceled: false, settings };
  });
  handle(ipcChannels.controlWindow, (_event, value) => {
    /** 已校验窗口动作。 */
    const action = parseWindowAction(value);

    switch (action) {
      case "minimize":
        window.minimize();
        break;
      case "maximize":
        if (window.isMaximized()) {
          window.unmaximize();
        } else {
          window.maximize();
        }
        break;
      case "open-devtools":
        window.webContents.openDevTools({
          mode: "detach",
          activate: true,
          title: `${applicationName} 开发者控制台`
        });
        break;
      case "close":
        window.close();
        break;
    }
  });

  /** 仅接受主窗口顶层页面的一次性预览端口请求。 */
  const handlePreviewRequest = (event: IpcMainEvent): void => {
    if (!isTrustedSender(event, window)) {
      return;
    }
    services.preview.attach(window.webContents);
  };
  ipcMain.on(ipcChannels.requestLivePreview, handlePreviewRequest);

  /** 接收主窗口发送的受限设备控制命令。 */
  const handleDeviceControl = (
    event: IpcMainEvent,
    value: unknown
  ): void => {
    if (!isTrustedSender(event, window)) {
      return;
    }
    try {
      services.mirroring.sendControl(parseDeviceControlCommand(value));
    } catch {
      // 非法控制消息直接丢弃，避免影响镜像媒体会话。
    }
  };
  ipcMain.on(ipcChannels.deviceControl, handleDeviceControl);

  return () => {
    invokeChannels.forEach((channel) => ipcMain.removeHandler(channel));
    ipcMain.removeListener(
      ipcChannels.requestLivePreview,
      handlePreviewRequest
    );
    ipcMain.removeListener(ipcChannels.deviceControl, handleDeviceControl);
    services.preview.close();
  };
}
