/** @jest-environment node */

import { EventEmitter } from "node:events";

jest.mock("electron", () => ({
  MessageChannelMain: jest.fn()
}));

import { MessageChannelMain } from "electron";
import {
  LivePreviewHub,
  parsePreviewControlMessage
} from "../../src/main/preview/hub";

/** 创建可控 Electron 主进程端口。 */
function createPort() {
  /** 带消息事件的端口桩。 */
  const port = new EventEmitter() as EventEmitter & {
    postMessage: jest.Mock;
    start: jest.Mock;
    close: jest.Mock;
  };
  port.postMessage = jest.fn();
  port.start = jest.fn();
  port.close = jest.fn();
  return port;
}

describe("实时预览端口消息校验", () => {
  it("只接受固定的控制、确认和状态消息", () => {
    expect(
      parsePreviewControlMessage({ type: "visibility", visible: false })
    ).toEqual({ type: "visibility", visible: false });
    expect(parsePreviewControlMessage({ type: "retry" })).toEqual({
      type: "retry"
    });
    expect(
      parsePreviewControlMessage({ type: "audio-monitor", enabled: true })
    ).toEqual({ type: "audio-monitor", enabled: true });
    expect(
      parsePreviewControlMessage({ type: "audio-consumed", sequence: 9 })
    ).toEqual({ type: "audio-consumed", sequence: 9 });
    expect(
      parsePreviewControlMessage({ type: "consumed", sequence: 7 })
    ).toEqual({ type: "consumed", sequence: 7 });
    expect(
      parsePreviewControlMessage({
        type: "status",
        status: "unavailable",
        message: "解码失败"
      })
    ).toEqual({
      type: "status",
      status: "unavailable",
      message: "解码失败"
    });
    expect(
      parsePreviewControlMessage({ type: "visibility", visible: "yes" })
    ).toBeUndefined();
    expect(
      parsePreviewControlMessage({ type: "audio-monitor", enabled: "yes" })
    ).toBeUndefined();
    expect(
      parsePreviewControlMessage({ type: "adb", command: "shell" })
    ).toBeUndefined();
  });

  it("最多保留一个在途包和一个最新待发包", () => {
    /** 传给渲染进程的端口。 */
    const rendererPort = createPort();
    /** 主进程持有的端口。 */
    const mainPort = createPort();
    (MessageChannelMain as unknown as jest.Mock).mockImplementation(() => ({
      port1: rendererPort,
      port2: mainPort
    }));
    /** 渲染页面消息发送器。 */
    const webContents = { postMessage: jest.fn() };
    /** 带背压的预览分发器。 */
    const hub = new LivePreviewHub("worker.js");

    hub.attach(webContents as never);
    hub.publishPacket({
      ptsUs: 1,
      keyFrame: true,
      data: Buffer.from([1])
    });
    hub.publishPacket({
      ptsUs: 2,
      keyFrame: false,
      data: Buffer.from([2])
    });
    hub.publishPacket({
      ptsUs: 3,
      keyFrame: false,
      data: Buffer.from([3])
    });

    expect(mainPort.postMessage).toHaveBeenCalledTimes(1);
    expect(mainPort.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "packet", sequence: 1, ptsUs: 1 })
    );

    mainPort.emit("message", {
      data: { type: "consumed", sequence: 1 }
    });
    expect(mainPort.postMessage).toHaveBeenCalledTimes(2);
    expect(mainPort.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "packet",
        sequence: 2,
        ptsUs: 3,
        data: Uint8Array.from([3]).buffer
      })
    );
  });

  it("窗口恢复时作废后台前未确认的视频包并等待新关键帧", () => {
    /** 传给渲染进程的端口。 */
    const rendererPort = createPort();
    /** 主进程持有的端口。 */
    const mainPort = createPort();
    (MessageChannelMain as unknown as jest.Mock).mockImplementation(() => ({
      port1: rendererPort,
      port2: mainPort
    }));
    /** 可从后台背压中恢复的预览分发器。 */
    const hub = new LivePreviewHub("worker.js");
    hub.attach({ postMessage: jest.fn() } as never);

    hub.publishPacket({
      ptsUs: 1,
      keyFrame: true,
      data: Buffer.from([1])
    });
    mainPort.emit("message", {
      data: { type: "visibility", visible: false }
    });
    mainPort.emit("message", { data: { type: "retry" } });
    hub.publishPacket({
      ptsUs: 2,
      keyFrame: false,
      data: Buffer.from([2])
    });
    hub.publishPacket({
      ptsUs: 3,
      keyFrame: true,
      data: Buffer.from([3])
    });

    expect(
      mainPort.postMessage.mock.calls.filter(
        ([message]) => message.type === "packet"
      )
    ).toEqual([
      [expect.objectContaining({ sequence: 1, ptsUs: 1 })],
      [expect.objectContaining({ sequence: 2, ptsUs: 3 })]
    ]);

    mainPort.emit("message", {
      data: { type: "consumed", sequence: 1 }
    });
    hub.publishPacket({
      ptsUs: 4,
      keyFrame: false,
      data: Buffer.from([4])
    });
    mainPort.emit("message", {
      data: { type: "consumed", sequence: 2 }
    });
    expect(mainPort.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ sequence: 3, ptsUs: 4 })
    );
  });

  it("把经过校验的 Worker 状态同步给订阅者", () => {
    /** 传给渲染进程的端口。 */
    const rendererPort = createPort();
    /** 主进程持有的端口。 */
    const mainPort = createPort();
    (MessageChannelMain as unknown as jest.Mock).mockImplementation(() => ({
      port1: rendererPort,
      port2: mainPort
    }));
    /** 状态监听器。 */
    const listener = jest.fn();
    /** 预览分发器。 */
    const hub = new LivePreviewHub("worker.js");
    hub.onStatusChanged(listener);
    hub.attach({ postMessage: jest.fn() } as never);

    mainPort.emit("message", {
      data: {
        type: "status",
        status: "paused",
        message: "窗口已隐藏"
      }
    });

    expect(listener).toHaveBeenCalledWith({
      type: "status",
      status: "paused",
      message: "窗口已隐藏"
    });
  });

  it("监听开启后重放 AAC 配置并把积压限制为八包加最新一包", () => {
    /** 传给渲染进程的端口。 */
    const rendererPort = createPort();
    /** 主进程持有的端口。 */
    const mainPort = createPort();
    (MessageChannelMain as unknown as jest.Mock).mockImplementation(() => ({
      port1: rendererPort,
      port2: mainPort
    }));
    /** 带音频背压的预览分发器。 */
    const hub = new LivePreviewHub("worker.js");
    hub.attach({ postMessage: jest.fn() } as never);
    hub.publishAudioConfig(Buffer.from([0x11, 0x90]), {
      codec: "mp4a.40.2",
      sampleRate: 48_000,
      numberOfChannels: 2
    });
    hub.publishAudioPacket({ ptsUs: 0, data: Buffer.from([0]) });
    expect(mainPort.postMessage).not.toHaveBeenCalled();

    mainPort.emit("message", {
      data: { type: "audio-monitor", enabled: true }
    });
    for (let index = 1; index <= 10; index += 1) {
      hub.publishAudioPacket({ ptsUs: index, data: Buffer.from([index]) });
    }

    expect(mainPort.postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: "audio-config",
        codec: "mp4a.40.2",
        sampleRate: 48_000,
        numberOfChannels: 2
      })
    );
    expect(
      mainPort.postMessage.mock.calls.filter(
        ([message]) => message.type === "audio-packet"
      )
    ).toHaveLength(8);

    mainPort.emit("message", {
      data: { type: "audio-consumed", sequence: 1 }
    });
    expect(mainPort.postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "audio-packet",
        ptsUs: 10,
        data: Uint8Array.from([10]).buffer
      })
    );
  });

  it("窗口隐藏只暂停视频而不会停止已开启的音频监听", () => {
    /** 传给渲染进程的端口。 */
    const rendererPort = createPort();
    /** 主进程持有的端口。 */
    const mainPort = createPort();
    (MessageChannelMain as unknown as jest.Mock).mockImplementation(() => ({
      port1: rendererPort,
      port2: mainPort
    }));
    /** 区分视频可见性与音频监听状态的分发器。 */
    const hub = new LivePreviewHub("worker.js");
    hub.attach({ postMessage: jest.fn() } as never);
    mainPort.emit("message", {
      data: { type: "audio-monitor", enabled: true }
    });
    mainPort.emit("message", {
      data: { type: "visibility", visible: false }
    });

    hub.publishPacket({ ptsUs: 1, keyFrame: true, data: Buffer.from([1]) });
    hub.publishAudioPacket({ ptsUs: 2, data: Buffer.from([2]) });

    expect(mainPort.postMessage).toHaveBeenCalledTimes(1);
    expect(mainPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "audio-packet", ptsUs: 2 })
    );
  });
});
