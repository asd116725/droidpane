import { contextBridge, ipcRenderer } from "electron";
import type {
  AdbStudioApi,
  DeviceInfo,
  MirrorState,
  RecordingArtifact,
  RecordingLibrarySnapshot,
  RecordingState
} from "./shared/types";
import { ipcChannels } from "./shared/ipc";

/** 创建只能接收指定通道数据的订阅函数。 */
function subscribe<T>(
  channel: string,
  listener: (value: T) => void
): () => void {
  /** 丢弃 Electron event 后的安全监听器。 */
  const wrapped = (_event: Electron.IpcRendererEvent, value: T): void =>
    listener(value);

  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/** 向渲染进程公开的最小权限 API。 */
const api: AdbStudioApi = {
  getDevices: () => ipcRenderer.invoke(ipcChannels.getDevices),
  refreshDevices: () => ipcRenderer.invoke(ipcChannels.refreshDevices),
  onDevicesChanged: (listener: (devices: DeviceInfo[]) => void) =>
    subscribe(ipcChannels.devicesChanged, listener),
  getRecordingState: () =>
    ipcRenderer.invoke(ipcChannels.getRecordingState),
  onRecordingStateChanged: (listener: (state: RecordingState) => void) =>
    subscribe(ipcChannels.recordingStateChanged, listener),
  getRecordingArtifact: () =>
    ipcRenderer.invoke(ipcChannels.getRecordingArtifact),
  onRecordingArtifactChanged: (
    listener: (artifact: RecordingArtifact | null) => void
  ) => subscribe(ipcChannels.recordingArtifactChanged, listener),
  getRecordingLibrary: () =>
    ipcRenderer.invoke(ipcChannels.getRecordingLibrary),
  refreshRecordingLibrary: () =>
    ipcRenderer.invoke(ipcChannels.refreshRecordingLibrary),
  onRecordingLibraryChanged: (
    listener: (snapshot: RecordingLibrarySnapshot) => void
  ) => subscribe(ipcChannels.recordingLibraryChanged, listener),
  deleteRecordings: (ids) =>
    ipcRenderer.invoke(ipcChannels.deleteRecordings, ids),
  requestLivePreview: () => ipcRenderer.send(ipcChannels.requestLivePreview),
  getMirrorState: () => ipcRenderer.invoke(ipcChannels.getMirrorState),
  onMirrorStateChanged: (listener: (state: MirrorState) => void) =>
    subscribe(ipcChannels.mirrorStateChanged, listener),
  startMirroring: (deviceSerial, preset) =>
    ipcRenderer.invoke(ipcChannels.startMirroring, {
      deviceSerial,
      preset
    }),
  stopMirroring: () => ipcRenderer.invoke(ipcChannels.stopMirroring),
  sendDeviceControl: (command) =>
    ipcRenderer.send(ipcChannels.deviceControl, command),
  startRecording: () => ipcRenderer.invoke(ipcChannels.startRecording),
  stopRecording: () => ipcRenderer.invoke(ipcChannels.stopRecording),
  exportRecording: (artifactId) =>
    ipcRenderer.invoke(ipcChannels.exportRecording, artifactId),
  openRecordingFolder: (artifactId) =>
    ipcRenderer.invoke(ipcChannels.openRecordingFolder, artifactId),
  getSettings: () => ipcRenderer.invoke(ipcChannels.getSettings),
  setSettings: (settings) =>
    ipcRenderer.invoke(ipcChannels.setSettings, settings),
  chooseRecordingsDirectory: () =>
    ipcRenderer.invoke(ipcChannels.chooseRecordingsDirectory),
  controlWindow: (action) =>
    ipcRenderer.invoke(ipcChannels.controlWindow, action)
};

/** 将 Electron 端口安全转交给隔离的页面主世界。 */
ipcRenderer.on(ipcChannels.livePreviewPort, (event, value: unknown) => {
  /** 主进程创建的固定预览端口。 */
  const port = event.ports[0];
  /** 主进程锁定的 Worker 地址。 */
  const workerUrl =
    value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).workerUrl === "string"
      ? ((value as Record<string, unknown>).workerUrl as string)
      : undefined;

  if (port && workerUrl) {
    window.postMessage(
      { type: ipcChannels.livePreviewPort, workerUrl },
      "*",
      [port]
    );
  }
});

contextBridge.exposeInMainWorld("adbStudio", api);
