/** @jest-environment node */

import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { assertTrustedSender } from "../../src/main/ipc";

describe("IPC 发送方校验", () => {
  it("仅允许当前主窗口的顶层渲染帧", () => {
    /** 主窗口顶层帧。 */
    const mainFrame = {};
    /** 主窗口 WebContents。 */
    const webContents = { mainFrame };
    /** 最小主窗口桩。 */
    const window = { webContents } as unknown as BrowserWindow;
    /** 可信 IPC 事件。 */
    const trustedEvent = {
      sender: webContents,
      senderFrame: mainFrame
    } as unknown as IpcMainInvokeEvent;
    /** 非顶层帧 IPC 事件。 */
    const untrustedFrameEvent = {
      sender: webContents,
      senderFrame: {}
    } as unknown as IpcMainInvokeEvent;
    /** 非当前窗口 IPC 事件。 */
    const untrustedSenderEvent = {
      sender: {},
      senderFrame: mainFrame
    } as unknown as IpcMainInvokeEvent;

    expect(() => assertTrustedSender(trustedEvent, window)).not.toThrow();
    expect(() => assertTrustedSender(untrustedFrameEvent, window)).toThrow(
      "拒绝来自非受信任页面的请求"
    );
    expect(() => assertTrustedSender(untrustedSenderEvent, window)).toThrow(
      "拒绝来自非受信任页面的请求"
    );
  });
});
