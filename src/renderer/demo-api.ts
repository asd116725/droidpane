import { applicationName } from "../shared/brand";
import type { ConnectWirelessInput, MirrorRecoveryState, WindowPresentationState, WirelessState } from "../shared/connection";
import type {
  AdbStudioApi,
  AppSettings,
  DeviceInfo,
  MirrorState,
  RecordingArtifact,
  RecordingLibraryReadyItem,
  RecordingLibrarySnapshot,
  RecordingState
} from "../shared/types";

/** 浏览器视觉预览使用的设备。 */
const demoDevices: DeviceInfo[] = [
  {
    serial: "3A261FDH2001234",
    model: "Pixel 8 Pro",
    androidVersion: "14",
    apiLevel: 34,
    connectionType: "usb",
    status: "available"
  },
  {
    serial: "5E5C3B7A1109876",
    model: "Xiaomi 14",
    androidVersion: "14",
    apiLevel: 34,
    connectionType: "usb",
    status: "available"
  }
];

/** 浏览器视觉预览使用的完成产物。 */
const demoArtifact: RecordingArtifact = {
  id: "019fb6c9-db73-7143-8737-e67e0c32ac80",
  fileName: "Android_Device_2026-08-01_132544.mp4",
  durationSeconds: 4,
  sizeBytes: 146_400,
  width: 480,
  height: 640,
  hasAudio: true,
  mediaUrl: ""
};

/** 创建浏览器视觉预览使用的视频库。 */
function createDemoLibrary(): RecordingLibrarySnapshot {
  /** 当前演示时间。 */
  const now = Date.now();
  /** 可直接播放的演示条目。 */
  const items: RecordingLibraryReadyItem[] = [
    {
      ...demoArtifact,
      status: "ready",
      recordedAt: now - 4 * 60 * 1_000
    },
    {
      ...demoArtifact,
      id: "demo-pixel-8",
      fileName: "Pixel_8_2026-08-01_105428.mp4",
      durationSeconds: 12,
      sizeBytes: 324_700,
      width: 1080,
      height: 2400,
      status: "ready",
      recordedAt: now - 3 * 60 * 60 * 1_000
    },
    {
      ...demoArtifact,
      id: "demo-xiaomi-14",
      fileName: "Xiaomi_14_2026-08-01_092103.mp4",
      durationSeconds: 15,
      sizeBytes: 512_900,
      width: 1080,
      height: 2400,
      status: "ready",
      recordedAt: now - 5 * 60 * 60 * 1_000
    },
    {
      ...demoArtifact,
      id: "demo-samsung-s23",
      fileName: "Samsung_S23_2026-08-01_081512.mp4",
      durationSeconds: 8,
      sizeBytes: 278_300,
      width: 1080,
      height: 2340,
      status: "ready",
      recordedAt: now - 6 * 60 * 60 * 1_000
    },
    {
      ...demoArtifact,
      id: "demo-pixel-yesterday",
      fileName: "Pixel_8_2026-07-31_214755.mp4",
      durationSeconds: 10,
      sizeBytes: 298_100,
      width: 1080,
      height: 2400,
      status: "ready",
      recordedAt: now - 25 * 60 * 60 * 1_000
    }
  ];

  return {
    directoryName: applicationName,
    items,
    refreshedAt: now
  };
}

/** 创建仅开发预览使用的交互式桌面 API。 */
export function createDemoApi(): AdbStudioApi {
  const devices = demoDevices.map(device => ({ ...device }));
  let presentation: WindowPresentationState = { mode: "normal", alwaysOnTop: false, connectionPanelOpen: false };
  let recovery: MirrorRecoveryState = { status: "idle", attempt: 0 };
  let wireless: WirelessState = { status: "idle", discoveries: [], profiles: [], paired: false, operationId: 0 };
  const presentationListeners = new Set<(state: WindowPresentationState) => void>();
  const wirelessListeners = new Set<(state: WirelessState) => void>();
  const recoveryListeners = new Set<(state: MirrorRecoveryState) => void>();
  const emitWireless = () => { wirelessListeners.forEach(listener => listener({ ...wireless })); return { ...wireless }; };
  const emitPresentation = () => { presentationListeners.forEach(listener => listener({ ...presentation })); return { ...presentation }; };
  const emitRecovery = () => { recoveryListeners.forEach(listener => listener({ ...recovery })); return { ...recovery }; };
  const connectWireless = async ({ endpoint, profileId }: ConnectWirelessInput): Promise<WirelessState> => {
    const serial = `${endpoint.host}:${endpoint.port}`;
    if (!devices.some(device => device.serial === serial)) devices.push({ ...devices[0], serial, model: "演示 Android 手机", connectionType: "network" });
    const profile = { id: profileId || serial, name: "演示 Android 手机", model: "演示 Android 手机", lastSerial: serial, endpoint, lastConnectedAt: Date.now() };
    wireless = { ...wireless, status: "connected", paired: true, deviceSerial: serial, errorMessage: undefined,
      message: "演示设备已连接", operationId: wireless.operationId + 1,
      profiles: [profile, ...wireless.profiles.filter(item => item.id !== profile.id)] };
    deviceListeners.forEach(listener => listener(devices.map(device => ({ ...device }))));
    return emitWireless();
  };
  /** 当前演示录制状态。 */
  let recordingState: RecordingState = {
    status: "ready",
    elapsedMs: 138_000,
    fps: 30,
    audioFallback: false,
    artifactId: demoArtifact.id
  };
  /** 当前演示镜像状态。 */
  let mirrorState: MirrorState = {
    status: "idle",
    audioFallback: false
  };
  /** 当前演示产物。 */
  let artifact: RecordingArtifact | null = demoArtifact;
  /** 当前演示视频库。 */
  let library = createDemoLibrary();
  /** 当前演示设置。 */
  let settings: AppSettings = {
    preset: {
      resolution: "1080p",
      videoBitrateMbps: 8,
      audioMode: "device"
    },
    audioMonitor: {
      autoEnableOnLegacyAndroid: false,
      volume: 0.8
    },
    recordingsDirectory: `/Users/demo/Movies/${applicationName}`
  };
  /** 设备订阅者。 */
  const deviceListeners = new Set<(devices: DeviceInfo[]) => void>();
  /** 录制状态订阅者。 */
  const stateListeners = new Set<(state: RecordingState) => void>();
  /** 镜像状态订阅者。 */
  const mirrorStateListeners = new Set<(state: MirrorState) => void>();
  /** 录制产物订阅者。 */
  const artifactListeners = new Set<
    (value: RecordingArtifact | null) => void
  >();
  /** 视频库订阅者。 */
  const libraryListeners = new Set<
    (value: RecordingLibrarySnapshot) => void
  >();

  /** 发布录制状态。 */
  const emitState = (): void => {
    stateListeners.forEach((listener) => listener({ ...recordingState }));
  };
  /** 发布镜像状态。 */
  const emitMirrorState = (): void => {
    mirrorStateListeners.forEach((listener) =>
      listener({ ...mirrorState, preset: mirrorState.preset && { ...mirrorState.preset } })
    );
  };
  /** 发布录制产物。 */
  const emitArtifact = (): void => {
    artifactListeners.forEach((listener) =>
      listener(artifact ? { ...artifact } : null)
    );
  };
  /** 发布视频库快照。 */
  const emitLibrary = (): void => {
    libraryListeners.forEach((listener) =>
      listener({ ...library, items: library.items.map((item) => ({ ...item })) })
    );
  };

  return {
    getWirelessState: async () => ({ ...wireless }),
    onWirelessStateChanged: listener => { wirelessListeners.add(listener); return () => wirelessListeners.delete(listener); },
    discoverWirelessDevices: async () => {
      wireless = { ...wireless, discoveries: [
        { name: "演示手机 · 配对服务", type: "pairing", endpoint: { host: "192.168.1.24", port: 37123 } },
        { name: "演示手机 · 连接服务", type: "connection", endpoint: { host: "192.168.1.24", port: 42871 } }
      ] }; return emitWireless();
    },
    pairWirelessDevice: async ({ endpoint }) => {
      wireless = { ...wireless, status: "paired", paired: true, operationId: wireless.operationId + 1,
        message: "演示配对成功，请输入连接端口", discoveries: [{ name: "演示手机", type: "connection", endpoint: { host: endpoint.host, port: 42871 } }] };
      return emitWireless();
    },
    connectWirelessDevice: connectWireless,
    cancelWirelessOperation: async () => { wireless = { ...wireless, status: wireless.paired ? "paired" : "idle", operationId: wireless.operationId + 1 }; return emitWireless(); },
    disconnectWirelessDevice: async serial => {
      const index = devices.findIndex(device => device.serial === serial);
      if (index >= 0) devices.splice(index, 1);
      wireless = { ...wireless, status: "idle", deviceSerial: undefined }; return emitWireless();
    },
    renameWirelessProfile: async (id, name) => { wireless = { ...wireless, profiles: wireless.profiles.map(profile => profile.id === id ? { ...profile, name } : profile) }; return emitWireless(); },
    removeWirelessProfile: async id => { wireless = { ...wireless, profiles: wireless.profiles.filter(profile => profile.id !== id) }; return emitWireless(); },
    getMirrorRecoveryState: async () => ({ ...recovery }),
    onMirrorRecoveryStateChanged: listener => { recoveryListeners.add(listener); return () => recoveryListeners.delete(listener); },
    retryMirrorRecovery: async () => { recovery = { status: "recovered", attempt: 1 }; return emitRecovery(); },
    cancelMirrorRecovery: async () => { recovery = { status: "idle", attempt: 0 }; return emitRecovery(); },
    getWindowPresentation: async () => ({ ...presentation }),
    onWindowPresentationChanged: listener => { presentationListeners.add(listener); return () => presentationListeners.delete(listener); },
    setWindowMode: async mode => { presentation = { ...presentation, mode }; return emitPresentation(); },
    setWindowAlwaysOnTop: async alwaysOnTop => { presentation = { ...presentation, alwaysOnTop }; return emitPresentation(); },
    setConnectionPanelOpen: async connectionPanelOpen => { presentation = { ...presentation, connectionPanelOpen }; return emitPresentation(); },
    getDevices: async () => devices.map((device) => ({ ...device })),
    refreshDevices: async () => {
      /** 演示设备快照。 */
      const snapshot = devices.map((device) => ({ ...device }));
      deviceListeners.forEach((listener) => listener(snapshot));
      return snapshot;
    },
    onDevicesChanged: (listener) => {
      deviceListeners.add(listener);
      return () => deviceListeners.delete(listener);
    },
    getRecordingState: async () => ({ ...recordingState }),
    onRecordingStateChanged: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    getRecordingArtifact: async () => (artifact ? { ...artifact } : null),
    onRecordingArtifactChanged: (listener) => {
      artifactListeners.add(listener);
      return () => artifactListeners.delete(listener);
    },
    getRecordingLibrary: async () => ({
      ...library,
      items: library.items.map((item) => ({ ...item }))
    }),
    refreshRecordingLibrary: async () => ({
      ...library,
      refreshedAt: Date.now(),
      items: library.items.map((item) => ({ ...item }))
    }),
    deleteRecordings: async (ids) => {
      /** 本次演示删除的内部 ID。 */
      const deletedIds = [...new Set(ids)].filter((id) =>
        library.items.some((item) => item.id === id)
      );
      library = {
        ...library,
        items: library.items.filter((item) => !deletedIds.includes(item.id)),
        refreshedAt: Date.now()
      };
      emitLibrary();
      return { deletedIds, failures: [], snapshot: library };
    },
    onRecordingLibraryChanged: (listener) => {
      libraryListeners.add(listener);
      return () => libraryListeners.delete(listener);
    },
    requestLivePreview: () => undefined,
    getMirrorState: async () => ({
      ...mirrorState,
      preset: mirrorState.preset && { ...mirrorState.preset }
    }),
    onMirrorStateChanged: (listener) => {
      mirrorStateListeners.add(listener);
      return () => mirrorStateListeners.delete(listener);
    },
    startMirroring: async (deviceSerial, preset) => {
      mirrorState = {
        status: "mirroring",
        deviceSerial,
        preset: { ...preset },
        fps: 30,
        audioFallback: false,
        previewStatus: "connecting"
      };
      emitMirrorState();
      return { ...mirrorState, preset: { ...preset } };
    },
    stopMirroring: async () => {
      mirrorState = {
        status: "idle",
        audioFallback: false
      };
      emitMirrorState();
      return { ...mirrorState };
    },
    sendDeviceControl: () => undefined,
    startRecording: async () => {
      if (mirrorState.status !== "mirroring" || !mirrorState.deviceSerial) {
        throw new Error("请先开启镜像后再开始录制");
      }
      artifact = null;
      recordingState = {
        status: "recording",
        startedAt: Date.now(),
        elapsedMs: 0,
        fps: 0,
        deviceSerial: mirrorState.deviceSerial,
        audioFallback: false
      };
      emitArtifact();
      emitState();
      return { ...recordingState };
    },
    stopRecording: async () => {
      recordingState = {
        ...recordingState,
        status: "stopping"
      };
      emitState();
      setTimeout(() => {
        artifact = demoArtifact;
        library = {
          ...library,
          items: [
            {
              ...demoArtifact,
              status: "ready",
              recordedAt: Date.now()
            },
            ...library.items.filter((item) => item.id !== demoArtifact.id)
          ],
          refreshedAt: Date.now()
        };
        recordingState = {
          status: "ready",
          elapsedMs: 138_000,
          audioFallback: false,
          artifactId: demoArtifact.id
        };
        emitArtifact();
        emitLibrary();
        emitState();
      }, 700);
      return { ...recordingState };
    },
    exportRecording: async () => ({
      canceled: false,
      destination: `/演示/${demoArtifact.fileName}`,
      sizeBytes: demoArtifact.sizeBytes
    }),
    openRecordingFolder: async () => undefined,
    getSettings: async () => ({
      preset: { ...settings.preset },
      audioMonitor: { ...settings.audioMonitor },
      recordingsDirectory: settings.recordingsDirectory
    }),
    setSettings: async (value) => {
      settings = {
        ...settings,
        preset: { ...value.preset },
        audioMonitor: { ...value.audioMonitor }
      };
      return {
        preset: { ...settings.preset },
        audioMonitor: { ...settings.audioMonitor },
        recordingsDirectory: settings.recordingsDirectory
      };
    },
    chooseRecordingsDirectory: async () => {
      settings = {
        ...settings,
        recordingsDirectory: "/Users/demo/Desktop/Screen Recordings"
      };
      library = {
        directoryName: "Screen Recordings",
        items: [],
        refreshedAt: Date.now()
      };
      emitLibrary();
      return {
        canceled: false,
        settings: {
          preset: { ...settings.preset },
          audioMonitor: { ...settings.audioMonitor },
          recordingsDirectory: settings.recordingsDirectory
        }
      };
    },
    controlWindow: async () => undefined
  };
}

/** 浏览器开发预览共用 API。 */
let demoApi: AdbStudioApi | undefined;

/** 获取 Electron 预加载 API，浏览器开发态回退到演示数据。 */
export function getDesktopApi(): AdbStudioApi {
  if (window.adbStudio) {
    return window.adbStudio;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("桌面安全桥接未加载");
  }

  demoApi ??= createDemoApi();
  return demoApi;
}
