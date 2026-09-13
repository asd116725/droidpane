import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MirrorCanvas,
  MirrorControlPanel
} from "../../src/renderer/MirrorControls";
import type { AdbStudioApi } from "../../src/shared/types";
import type { LivePreviewController } from "../../src/renderer/use-live-preview";

/** 创建镜像控件测试 API。 */
function createApi(): jest.Mocked<Pick<AdbStudioApi, "sendDeviceControl">> {
  return {
    sendDeviceControl: jest.fn()
  };
}

/** 创建实时预览控制器桩。 */
function createPreview(): LivePreviewController {
  return {
    status: "live",
    size: { width: 100, height: 200 },
    canvasGeneration: 0,
    canvasRef: jest.fn(),
    retry: jest.fn(),
    audioMonitoring: false,
    audioMonitorStatus: "off",
    setAudioMonitoring: jest.fn().mockResolvedValue(undefined),
    setAudioMonitorVolume: jest.fn()
  };
}

describe("镜像画面控制", () => {
  /** jsdom 使用的最小 PointerEvent 实现。 */
  class TestPointerEvent extends MouseEvent {
    /** 当前指针 ID。 */
    readonly pointerId: number;

    /** 创建带指针 ID 的鼠标事件。 */
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }

  beforeAll(() => {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: TestPointerEvent
    });
  });

  it("左键点击拖动、滚轮和右键分别转发触控、滚动与返回", () => {
    /** 设备控制 API。 */
    const api = createApi();
    /** 渲染后的容器。 */
    const { container } = render(
      <MirrorCanvas
        api={api}
        preview={createPreview()}
        interactive
        onFullscreen={jest.fn()}
        onToggleNotificationPanel={jest.fn()}
      />
    );
    /** 镜像输入面。 */
    const surface = container.querySelector(".mirror-surface") as HTMLDivElement;
    surface.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 20,
        width: 100,
        height: 200,
        right: 110,
        bottom: 220,
        x: 10,
        y: 20,
        toJSON: () => undefined
      }) as DOMRect;

    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 7,
      clientX: 60,
      clientY: 70
    });
    fireEvent.pointerMove(surface, {
      pointerId: 7,
      clientX: 80,
      clientY: 120
    });
    fireEvent.pointerUp(surface, {
      button: 0,
      pointerId: 7,
      clientX: 80,
      clientY: 120
    });
    fireEvent.wheel(surface, {
      clientX: 60,
      clientY: 120,
      deltaX: 50,
      deltaY: -100
    });
    fireEvent.pointerDown(surface, {
      button: 2,
      pointerId: 8,
      clientX: 60,
      clientY: 120
    });

    expect(api.sendDeviceControl.mock.calls.map(([command]) => command)).toEqual([
      { type: "touch", action: "down", x: 0.5, y: 0.25 },
      { type: "touch", action: "move", x: 0.7, y: 0.5 },
      { type: "touch", action: "up", x: 0.7, y: 0.5 },
      {
        type: "scroll",
        x: 0.5,
        y: 0.5,
        horizontal: -1,
        vertical: 2
      },
      expect.objectContaining({
        type: "key",
        action: "down",
        key: "back"
      }),
      expect.objectContaining({
        type: "key",
        action: "up",
        key: "back"
      })
    ]);
  });

  it("拖出镜像区域后在窗口松开仍正常结束触控", () => {
    /** 设备控制 API。 */
    const api = createApi();
    /** 渲染后的容器。 */
    const { container } = render(
      <MirrorCanvas
        api={api}
        preview={createPreview()}
        interactive
        onFullscreen={jest.fn()}
        onToggleNotificationPanel={jest.fn()}
      />
    );
    /** 镜像输入面。 */
    const surface = container.querySelector(".mirror-surface") as HTMLDivElement;
    surface.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 20,
        width: 100,
        height: 200,
        right: 100,
        bottom: 220,
        x: 0,
        y: 20,
        toJSON: () => undefined
      }) as DOMRect;

    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 9,
      clientX: 50,
      clientY: 170
    });
    fireEvent.pointerMove(surface, {
      pointerId: 9,
      clientX: 50,
      clientY: 40
    });
    fireEvent.pointerLeave(surface, {
      pointerId: 9,
      clientX: 50,
      clientY: 10
    });
    fireEvent.pointerUp(window, {
      button: 0,
      pointerId: 9,
      clientX: 50,
      clientY: 0
    });

    /** 发送到设备的触控消息。 */
    const touchCommands = api.sendDeviceControl.mock.calls
      .map(([command]) => command)
      .filter((command) => command.type === "touch");
    expect(touchCommands).toEqual([
      { type: "touch", action: "down", x: 0.5, y: 0.75 },
      { type: "touch", action: "move", x: 0.5, y: 0.1 },
      { type: "touch", action: "up", x: 0.5, y: 0 }
    ]);
    expect(surface).not.toHaveClass("is-cursor-pressed");
  });

  it("鼠标悬停显示触控圆点，按下和移出时切换反馈", () => {
    /** 设备控制 API。 */
    const api = createApi();
    /** 渲染后的容器。 */
    const { container } = render(
      <MirrorCanvas
        api={api}
        preview={createPreview()}
        interactive
        onFullscreen={jest.fn()}
        onToggleNotificationPanel={jest.fn()}
      />
    );
    /** 镜像输入面。 */
    const surface = container.querySelector(".mirror-surface") as HTMLDivElement;
    surface.getBoundingClientRect = () =>
      ({
        left: 10,
        top: 20,
        width: 100,
        height: 200,
        right: 110,
        bottom: 220,
        x: 10,
        y: 20,
        toJSON: () => undefined
      }) as DOMRect;

    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 3,
      clientX: 60,
      clientY: 120
    });
    expect(surface).toHaveClass("is-cursor-visible");
    expect(surface).toHaveClass("is-cursor-pressed");
    expect(surface.style.getPropertyValue("--mirror-cursor-x")).toBe("50px");
    expect(surface.style.getPropertyValue("--mirror-cursor-y")).toBe("100px");
    fireEvent.pointerUp(surface, {
      button: 0,
      pointerId: 3,
      clientX: 60,
      clientY: 120
    });
    expect(surface).not.toHaveClass("is-cursor-pressed");
    expect(surface).toHaveClass("is-cursor-visible");

    fireEvent.pointerLeave(surface, { pointerId: 3 });
    expect(surface).not.toHaveClass("is-cursor-visible");
  });

  it("快捷键只在隐藏输入区获得焦点后生效", () => {
    /** 设备控制 API。 */
    const api = createApi();
    /** 全屏回调。 */
    const fullscreen = jest.fn();
    /** 下拉菜单切换回调。 */
    const toggleNotificationPanel = jest.fn();
    render(
      <MirrorCanvas
        api={api}
        preview={createPreview()}
        interactive
        onFullscreen={fullscreen}
        onToggleNotificationPanel={toggleNotificationPanel}
      />
    );
    /** 镜像输入区。 */
    const input = screen.getByRole("textbox", { name: "镜像控制输入" });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(api.sendDeviceControl).not.toHaveBeenCalled();
    input.focus();
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.keyDown(input, { key: "h", altKey: true });
    fireEvent.keyDown(input, { key: "n", altKey: true });
    fireEvent.keyDown(input, { key: "F11" });

    expect(
      api.sendDeviceControl.mock.calls.map(([command]) => command)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "key", key: "back" }),
        expect.objectContaining({ type: "key", key: "home" }),
      ])
    );
    expect(toggleNotificationPanel).toHaveBeenCalledTimes(1);
    expect(fullscreen).toHaveBeenCalledTimes(1);
  });

  it("支持中文输入法、粘贴和失焦释放", () => {
    /** 设备控制 API。 */
    const api = createApi();
    /** 渲染后的容器。 */
    const { container } = render(
      <MirrorCanvas
        api={api}
        preview={createPreview()}
        interactive
        onFullscreen={jest.fn()}
        onToggleNotificationPanel={jest.fn()}
      />
    );
    /** 镜像输入区。 */
    const input = screen.getByRole("textbox", {
      name: "镜像控制输入"
    }) as HTMLTextAreaElement;
    /** 镜像输入面。 */
    const surface = container.querySelector(".mirror-surface") as HTMLDivElement;
    surface.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 100,
        height: 200,
        right: 100,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON: () => undefined
      }) as DOMRect;

    fireEvent.compositionStart(input);
    fireEvent.input(input, { target: { value: "你好" } });
    expect(api.sendDeviceControl).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.paste(input, {
      clipboardData: { getData: () => "粘贴文本" }
    });
    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 1,
      clientX: 50,
      clientY: 100
    });
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    fireEvent.blur(input);

    expect(api.sendDeviceControl).toHaveBeenCalledWith({
      type: "text",
      text: "你好"
    });
    expect(api.sendDeviceControl).toHaveBeenCalledWith({
      type: "text",
      text: "粘贴文本"
    });
    expect(api.sendDeviceControl).toHaveBeenCalledWith({
      type: "touch",
      action: "cancel",
      x: 0.5,
      y: 0.5
    });
    expect(api.sendDeviceControl).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "key",
        action: "up",
        key: "arrow-left"
      })
    );
  });

  it("切出镜像工作区时释放持续触控和按键", () => {
    /** 设备控制 API。 */
    const api = createApi();
    /** 更新镜像交互状态。 */
    const { container, rerender } = render(
      <MirrorCanvas
        api={api}
        preview={createPreview()}
        interactive
        onFullscreen={jest.fn()}
        onToggleNotificationPanel={jest.fn()}
      />
    );
    /** 镜像输入区。 */
    const input = screen.getByRole("textbox", { name: "镜像控制输入" });
    /** 镜像输入面。 */
    const surface = container.querySelector(".mirror-surface") as HTMLDivElement;
    surface.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 100,
        height: 200,
        right: 100,
        bottom: 200,
        x: 0,
        y: 0,
        toJSON: () => undefined
      }) as DOMRect;

    fireEvent.pointerDown(surface, {
      button: 0,
      pointerId: 4,
      clientX: 25,
      clientY: 100
    });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    api.sendDeviceControl.mockClear();

    rerender(
      <MirrorCanvas
        api={api}
        preview={createPreview()}
        interactive={false}
        onFullscreen={jest.fn()}
        onToggleNotificationPanel={jest.fn()}
      />
    );

    expect(api.sendDeviceControl).toHaveBeenCalledWith({
      type: "touch",
      action: "cancel",
      x: 0.25,
      y: 0.5
    });
    expect(api.sendDeviceControl).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "key",
        action: "up",
        key: "arrow-right"
      })
    );
  });

  it("右侧展示五个按钮并触发对应设备动作", async () => {
    /** 设备控制 API。 */
    const api = createApi();
    /** 全屏回调。 */
    const fullscreen = jest.fn();
    /** 用户操作器。 */
    const user = userEvent.setup();
    /** 下拉菜单切换回调。 */
    const toggleNotificationPanel = jest.fn();
    /** 更新控制面板。 */
    const { rerender } = render(
      <MirrorControlPanel
        api={api}
        onFullscreen={fullscreen}
        notificationPanelOpen={false}
        onToggleNotificationPanel={toggleNotificationPanel}
      />
    );
    /** 设备控制面板。 */
    const panel = screen.getByRole("complementary", { name: "设备控制" });
    /** 所有控制按钮。 */
    const buttons = within(panel).getAllByRole("button");

    expect(buttons).toHaveLength(5);
    await user.click(screen.getByRole("button", { name: "返回" }));
    await user.click(screen.getByRole("button", { name: "打开下拉菜单" }));
    rerender(
      <MirrorControlPanel
        api={api}
        onFullscreen={fullscreen}
        notificationPanelOpen
        onToggleNotificationPanel={toggleNotificationPanel}
      />
    );
    await user.click(screen.getByRole("button", { name: "关闭下拉菜单" }));
    await user.click(screen.getByRole("button", { name: "全屏镜像" }));

    expect(api.sendDeviceControl).toHaveBeenCalledWith(
      expect.objectContaining({ type: "key", key: "back" })
    );
    expect(toggleNotificationPanel).toHaveBeenCalledTimes(2);
    expect(fullscreen).toHaveBeenCalledTimes(1);
  });
});
