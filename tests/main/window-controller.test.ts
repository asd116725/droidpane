/** @jest-environment node */

import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { WindowController } from "../../src/main/window-controller";
import { constrainWindowBounds } from "../../src/main/window-bounds";
import type { SavedWindowBounds, WindowPresentationPreferences } from "../../src/shared/connection";

function createWindow(preferences?: WindowPresentationPreferences) {
  let bounds: SavedWindowBounds = { x: 100, y: 80, width: 1200, height: 900 };
  let pinned = false;
  let fullscreen = false;
  let maximized = false;
  let workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const events = new EventEmitter();
  const window = Object.assign(events, {
    getBounds: () => ({ ...bounds }),
    getNormalBounds: () => ({ ...bounds }),
    setBounds: jest.fn((value: SavedWindowBounds) => { bounds = { ...value }; events.emit("resize"); }),
    setMinimumSize: jest.fn(),
    isDestroyed: () => false,
    isFullScreen: () => fullscreen,
    setFullScreen: jest.fn((value: boolean) => {
      fullscreen = value;
      events.emit(value ? "enter-full-screen" : "leave-full-screen");
    }),
    isMaximized: () => maximized,
    maximize: () => { maximized = true; },
    unmaximize: () => { maximized = false; },
    isAlwaysOnTop: () => pinned,
    setAlwaysOnTop: jest.fn((value: boolean) => { pinned = value; events.emit("always-on-top-changed"); })
  });
  const save = jest.fn().mockResolvedValue(undefined);
  const controller = new WindowController({
    window: window as unknown as BrowserWindow,
    preferences,
    getWorkArea: () => workArea,
    savePreferences: save
  });
  return { window, controller, save, setWorkArea: (value: typeof workArea) => { workArea = value; } };
}

describe("同窗口紧凑模式", () => {
  it("分别恢复两种尺寸，连接面板临时扩展不覆盖手机宽度", async () => {
    const { window, controller, save } = createWindow();
    const normal = window.getBounds();
    await controller.setMode("compact");
    const compact = window.getBounds();
    expect(compact.width).toBe(360);
    await controller.setAlwaysOnTop(true);
    await controller.setConnectionPanelOpen(true);
    expect(window.getBounds().width).toBe(780);
    await controller.flush();
    expect(save.mock.calls.at(-1)?.[0].compactBounds.width).toBe(360);
    await controller.setConnectionPanelOpen(false);
    expect(window.getBounds()).toEqual(compact);
    await controller.setMode("normal");
    expect(window.getBounds()).toEqual(normal);
    expect(window.isAlwaysOnTop()).toBe(false);
    await controller.setMode("compact");
    expect(window.getBounds()).toEqual(compact);
    expect(window.isAlwaysOnTop()).toBe(true);
    controller.dispose();
  });

  it("启动紧凑模式保留历史普通尺寸，退出全屏后才应用紧凑尺寸", async () => {
    const normalBounds = { x: 12, y: 30, width: 1100, height: 800 };
    const compactBounds = { x: 1400, y: 20, width: 320, height: 760 };
    const { window, controller } = createWindow({
      mode: "compact", compactAlwaysOnTop: true, normalBounds, compactBounds
    });
    await controller.initialize();
    expect(window.getBounds()).toEqual(compactBounds);
    await controller.setMode("normal");
    expect(window.getBounds()).toEqual(normalBounds);
    window.setFullScreen(true);
    await controller.setMode("compact");
    expect(window.isFullScreen()).toBe(false);
    await controller.setMode("normal");
    expect(window.isFullScreen()).toBe(true);
    controller.dispose();
  });

  it("显示器移除后把窗口收回工作区且保留置顶", async () => {
    const { window, controller, setWorkArea } = createWindow({
      mode: "compact", compactAlwaysOnTop: true,
      compactBounds: { x: 1500, y: 200, width: 360, height: 850 }
    });
    await controller.initialize();
    setWorkArea({ x: 0, y: 24, width: 800, height: 576 });
    await controller.fitToWorkArea();
    expect(window.getBounds()).toEqual({ x: 440, y: 24, width: 360, height: 576 });
    expect(controller.getState().alwaysOnTop).toBe(true);
    expect(window.setMinimumSize).toHaveBeenLastCalledWith(280, 420);
    controller.dispose();
  });

  it("恢复全屏尚未完成时，后续紧凑切换等待进入事件再退出", async () => {
    const { window, controller } = createWindow();
    const originalSetFullscreen = window.setFullScreen.getMockImplementation()!;
    window.setFullScreen(true);
    await controller.setMode("compact");
    let finishEntering!: () => void;
    window.setFullScreen.mockImplementation((enabled) => {
      if (enabled) finishEntering = () => originalSetFullscreen(true);
      else originalSetFullscreen(false);
    });
    window.setBounds.mockClear();
    const normal = controller.setMode("normal");
    await Promise.resolve();
    const compact = controller.setMode("compact");
    await Promise.resolve();
    expect(window.setBounds).toHaveBeenCalledTimes(1);
    expect(window.isFullScreen()).toBe(false);
    finishEntering();
    await Promise.all([normal, compact]);
    expect(window.isFullScreen()).toBe(false);
    expect(window.getBounds().width).toBe(360);
    expect(controller.getState().mode).toBe("compact");
    controller.dispose();
  });

  it("小于最小窗口的工作区优先保持标题栏与控制区可见", () => {
    expect(constrainWindowBounds({ x: -900, y: 1000, width: 600, height: 1000 },
      { x: 0, y: 24, width: 240, height: 300 }, "compact"))
      .toEqual({ x: 0, y: 24, width: 240, height: 300 });
  });
});
