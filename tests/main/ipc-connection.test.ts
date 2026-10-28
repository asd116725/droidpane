/** @jest-environment node */

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn(),
    removeHandler: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn()
  },
  dialog: { showSaveDialog: jest.fn(), showOpenDialog: jest.fn() },
  shell: { showItemInFolder: jest.fn(), openPath: jest.fn() }
}));

import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { registerIpcHandlers, type IpcServices } from "../../src/main/ipc";
import { ipcChannels } from "../../src/shared/ipc";
import type { DeviceInfo, RecordingPreset } from "../../src/shared/types";
import type { WirelessState } from "../../src/shared/connection";

type InvokeHandler = (event: IpcMainInvokeEvent, value?: unknown) => unknown;

const device: DeviceInfo = {
  serial: "usb-device", model: "Pixel 8", androidVersion: "14", apiLevel: 34,
  connectionType: "usb", status: "available"
};
const preset: RecordingPreset = { resolution: "1080p", videoBitrateMbps: 8, audioMode: "device" };
const endpoint = { host: "192.168.1.24", port: 42871 };
const pairInput = { endpoint: { ...endpoint, port: 37123 }, code: "482916" };
const idleWireless: WirelessState = { status: "idle", discoveries: [], profiles: [], paired: false, operationId: 0 };

/** 手动完成异步任务，精确停在旧镜像收尾或无线配对阶段。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** 仅提供连接 IPC 所需的服务行为，不触碰实际 ADB 或窗口。 */
function createServices(busy = false) {
  const wireless = {
    getState: jest.fn(() => idleWireless),
    cancel: jest.fn(() => idleWireless),
    pair: jest.fn().mockResolvedValue({ ...idleWireless, status: "paired", paired: true }),
    connect: jest.fn().mockResolvedValue({ ...idleWireless, status: "connected" }),
    disconnect: jest.fn().mockResolvedValue(idleWireless)
  };
  const recovery = {
    stop: jest.fn().mockResolvedValue({ status: "idle", audioFallback: false }),
    start: jest.fn().mockResolvedValue({ status: "mirroring", deviceSerial: device.serial, preset, audioFallback: false })
  };
  const services = {
    devices: { getDevices: jest.fn(() => [device]) },
    recording: { isBusy: jest.fn(() => busy) },
    mirroring: { getState: jest.fn(() => ({ status: "mirroring", deviceSerial: device.serial, preset, audioFallback: false })) },
    wireless,
    recovery,
    library: {}, settings: {}, windowPresentation: {},
    preview: { attach: jest.fn(), close: jest.fn() }
  } as unknown as IpcServices;
  return { services, wireless, recovery };
}

describe("无线连接 IPC 取消边界", () => {
  let handlers: Map<string, InvokeHandler>;
  let event: IpcMainInvokeEvent;
  let window: BrowserWindow;
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    handlers = new Map();
    (ipcMain.handle as jest.Mock).mockImplementation((channel: string, handler: InvokeHandler) => handlers.set(channel, handler));
    const mainFrame = {};
    const webContents = { mainFrame };
    window = { webContents } as unknown as BrowserWindow;
    event = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;
  });

  afterEach(() => { cleanup?.(); cleanup = undefined; });

  it.each([
    { name: "显式开启镜像", channel: ipcChannels.startMirroring, input: { deviceSerial: device.serial, preset } },
    { name: "主动断开无线设备", channel: ipcChannels.disconnectWirelessDevice, input: "192.168.1.24:42871" },
    { name: "取消无线操作", channel: ipcChannels.cancelWirelessOperation, input: undefined }
  ])("等待旧镜像停止时$name会阻止旧配对启动", async ({ channel, input }) => {
    const { services, wireless, recovery } = createServices();
    const stopped = deferred<void>();
    recovery.stop.mockReturnValueOnce(stopped.promise);
    cleanup = registerIpcHandlers(window, services);

    const pairing = handlers.get(ipcChannels.pairWirelessDevice)!(event, pairInput);
    expect(recovery.stop).toHaveBeenCalledTimes(1);
    expect(wireless.pair).not.toHaveBeenCalled();

    await handlers.get(channel)!(event, input);
    stopped.resolve();
    await expect(pairing).resolves.toEqual(idleWireless);
    expect(wireless.pair).not.toHaveBeenCalled();
    expect(wireless.cancel).toHaveBeenCalledTimes(2);
    if (channel === ipcChannels.startMirroring) expect(recovery.start).toHaveBeenCalledWith(device, preset);
    if (channel === ipcChannels.disconnectWirelessDevice) expect(wireless.disconnect).toHaveBeenCalledWith(input);
  });

  it("显式开启镜像前先取消已经执行的无线配对", async () => {
    const { services, wireless, recovery } = createServices();
    const started = deferred<void>();
    const finished = deferred<WirelessState>();
    wireless.pair.mockImplementation(() => { started.resolve(); return finished.promise; });
    cleanup = registerIpcHandlers(window, services);
    const pairing = handlers.get(ipcChannels.pairWirelessDevice)!(event, pairInput);
    await started.promise;
    wireless.cancel.mockImplementation(() => { finished.resolve(idleWireless); return idleWireless; });

    await handlers.get(ipcChannels.startMirroring)!(event, { deviceSerial: device.serial, preset });
    await expect(pairing).resolves.toEqual(idleWireless);
    expect(wireless.cancel).toHaveBeenCalledTimes(2);
    expect(wireless.cancel.mock.invocationCallOrder[1]).toBeLessThan(recovery.start.mock.invocationCallOrder[0]);
    expect(recovery.start).toHaveBeenCalledWith(device, preset);
  });

  it.each([
    { name: "配对", channel: ipcChannels.pairWirelessDevice, input: pairInput, error: "请先停止录制，再连接其他设备" },
    { name: "连接", channel: ipcChannels.connectWirelessDevice, input: { endpoint }, error: "请先停止录制，再连接其他设备" },
    { name: "断开", channel: ipcChannels.disconnectWirelessDevice, input: "192.168.1.24:42871", error: "请先停止录制，再断开设备" }
  ])("录制忙碌时拒绝$name且保留现有镜像", async ({ channel, input, error }) => {
    const { services, wireless, recovery } = createServices(true);
    cleanup = registerIpcHandlers(window, services);

    await expect(handlers.get(channel)!(event, input)).rejects.toThrow(error);
    expect(recovery.stop).not.toHaveBeenCalled();
    expect(recovery.start).not.toHaveBeenCalled();
    expect(wireless.cancel).not.toHaveBeenCalled();
    expect(wireless.pair).not.toHaveBeenCalled();
    expect(wireless.connect).not.toHaveBeenCalled();
    expect(wireless.disconnect).not.toHaveBeenCalled();
  });
});
