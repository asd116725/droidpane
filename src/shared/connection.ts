/** 无线端点；配对端口与连接端口由调用场景明确区分。 */
export interface WirelessEndpoint {
  host: string;
  port: number;
}

/** ADB mDNS 返回的设备服务，不将临时地址作为设备身份。 */
export interface WirelessDiscovery {
  name: string;
  type: "pairing" | "connection";
  endpoint: WirelessEndpoint;
}

/** 最近成功连接的设备；身份缺失时禁止按历史地址自动恢复。 */
export interface WirelessDeviceProfile {
  id: string;
  name: string;
  model: string;
  identity?: string;
  lastSerial: string;
  endpoint: WirelessEndpoint;
  lastConnectedAt: number;
}

/** 手机配对弹窗中的地址与一次性配对码。 */
export interface PairWirelessInput {
  endpoint: WirelessEndpoint;
  code: string;
}

/** 已配对手机的连接地址，可携带预期设备档案进行身份核验。 */
export interface ConnectWirelessInput {
  endpoint: WirelessEndpoint;
  profileId?: string;
}

/** 无线接入状态独立于镜像和录制状态。 */
export interface WirelessState {
  status: "idle" | "discovering" | "pairing" | "paired" | "connecting" | "connected" | "error";
  discoveries: WirelessDiscovery[];
  profiles: WirelessDeviceProfile[];
  paired: boolean;
  operationId: number;
  deviceSerial?: string;
  message?: string;
  errorMessage?: string;
}

/** 当前镜像的有限恢复过程，不用于自动启动历史设备。 */
export interface MirrorRecoveryState {
  status: "idle" | "waiting" | "connecting" | "starting" | "recovered" | "failed" | "canceled";
  attempt: number;
  deviceSerial?: string;
  deviceName?: string;
  deadline?: number;
  message?: string;
}

/** 同一原生窗口的两种布局。 */
export type WindowMode = "normal" | "compact";

/** 可恢复的窗口工作区位置，单位为 DIP。 */
export interface SavedWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 普通与紧凑模式分别记忆，连接面板的临时扩展不落盘。 */
export interface WindowPresentationPreferences {
  mode: WindowMode;
  compactAlwaysOnTop: boolean;
  normalBounds?: SavedWindowBounds;
  compactBounds?: SavedWindowBounds;
}

/** 由主进程确认后回显的真实窗口状态。 */
export interface WindowPresentationState {
  mode: WindowMode;
  alwaysOnTop: boolean;
  connectionPanelOpen: boolean;
}

/** 无线接入、镜像恢复与窗口表现的受限接口。 */
export interface ConnectionApi {
  getWirelessState(): Promise<WirelessState>;
  onWirelessStateChanged(listener: (state: WirelessState) => void): () => void;
  discoverWirelessDevices(): Promise<WirelessState>;
  pairWirelessDevice(input: PairWirelessInput): Promise<WirelessState>;
  connectWirelessDevice(input: ConnectWirelessInput): Promise<WirelessState>;
  cancelWirelessOperation(): Promise<WirelessState>;
  disconnectWirelessDevice(serial: string): Promise<WirelessState>;
  renameWirelessProfile(id: string, name: string): Promise<WirelessState>;
  removeWirelessProfile(id: string): Promise<WirelessState>;
  getMirrorRecoveryState(): Promise<MirrorRecoveryState>;
  onMirrorRecoveryStateChanged(listener: (state: MirrorRecoveryState) => void): () => void;
  retryMirrorRecovery(): Promise<MirrorRecoveryState>;
  cancelMirrorRecovery(): Promise<MirrorRecoveryState>;
  getWindowPresentation(): Promise<WindowPresentationState>;
  onWindowPresentationChanged(listener: (state: WindowPresentationState) => void): () => void;
  setWindowMode(mode: WindowMode): Promise<WindowPresentationState>;
  setWindowAlwaysOnTop(enabled: boolean): Promise<WindowPresentationState>;
  setConnectionPanelOpen(open: boolean): Promise<WindowPresentationState>;
}
