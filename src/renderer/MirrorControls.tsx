import {
  useCallback,
  useEffect,
  useRef,
  type ClipboardEvent,
  type CompositionEvent,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent
} from "react";
import {
  IconArrowsMaximize,
  IconBell,
  IconBellOff,
  IconDeviceMobile,
  IconRotate2,
  IconSquareFilled
} from "@tabler/icons-react";
import type {
  AdbStudioApi,
  DeviceControlKey,
  DeviceControlModifiers
} from "../shared/types";
import type { LivePreviewController } from "./use-live-preview";

/** 镜像输入面属性。 */
interface MirrorCanvasProps {
  /** 安全桌面接口。 */
  api: Pick<AdbStudioApi, "sendDeviceControl">;
  /** 实时预览画布与尺寸。 */
  preview: LivePreviewController;
  /** 全屏切换回调。 */
  onFullscreen(): void;
  /** 切换设备下拉菜单。 */
  onToggleNotificationPanel(): void;
  /** 当前是否允许向设备发送输入。 */
  interactive: boolean;
}

/** 镜像控制面板属性。 */
interface MirrorControlPanelProps {
  /** 安全桌面接口。 */
  api: Pick<AdbStudioApi, "sendDeviceControl">;
  /** 全屏切换回调。 */
  onFullscreen(): void;
  /** 设备下拉菜单是否由当前控制按钮打开。 */
  notificationPanelOpen: boolean;
  /** 切换设备下拉菜单。 */
  onToggleNotificationPanel(): void;
}

/** 当前指针在镜像画面内的归一化位置。 */
interface NormalizedPosition {
  /** 横向位置。 */
  x: number;
  /** 纵向位置。 */
  y: number;
}

/** 无修饰键状态。 */
const emptyModifiers: DeviceControlModifiers = {
  shift: false,
  alt: false,
  ctrl: false
};

/** 从键盘事件提取 Android 修饰键。 */
function getModifiers(event: KeyboardEvent): DeviceControlModifiers {
  return {
    shift: event.shiftKey,
    alt: event.altKey,
    ctrl: event.ctrlKey || event.metaKey
  };
}

/** 向设备发送一次完整的短按键。 */
function pressDeviceKey(
  api: Pick<AdbStudioApi, "sendDeviceControl">,
  key: DeviceControlKey,
  modifiers: DeviceControlModifiers = emptyModifiers
): void {
  api.sendDeviceControl({
    type: "key",
    action: "down",
    key,
    repeat: 0,
    modifiers
  });
  api.sendDeviceControl({
    type: "key",
    action: "up",
    key,
    repeat: 0,
    modifiers
  });
}

/** 计算当前指针相对镜像输入面的坐标。 */
function getNormalizedPosition(
  element: HTMLElement,
  clientX: number,
  clientY: number
): NormalizedPosition {
  /** 镜像输入面边界。 */
  const bounds = element.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (clientY - bounds.top) / bounds.height))
  };
}

/** 把滚轮像素量压缩到 scrcpy 协议范围。 */
function normalizeScroll(value: number): number {
  return Math.min(16, Math.max(-16, -value / 50));
}

/** 更新镜像触控圆点的位置与可见状态。 */
function updateTouchCursor(
  element: HTMLDivElement,
  clientX: number,
  clientY: number,
  pointerType: string
): void {
  /** 镜像输入面边界。 */
  const bounds = element.getBoundingClientRect();
  /** 未裁剪的横向像素位置。 */
  const rawX = clientX - bounds.left;
  /** 未裁剪的纵向像素位置。 */
  const rawY = clientY - bounds.top;
  /** 鼠标当前是否位于镜像画面内。 */
  const visible =
    pointerType !== "touch" &&
    rawX >= 0 &&
    rawX <= bounds.width &&
    rawY >= 0 &&
    rawY <= bounds.height;

  element.style.setProperty(
    "--mirror-cursor-x",
    `${Math.min(bounds.width, Math.max(0, rawX))}px`
  );
  element.style.setProperty(
    "--mirror-cursor-y",
    `${Math.min(bounds.height, Math.max(0, rawY))}px`
  );
  element.classList.toggle("is-cursor-visible", visible);
}

/** 将浏览器按键映射为设备编辑键。 */
function mapEditingKey(event: KeyboardEvent): DeviceControlKey | undefined {
  /** 浏览器键名到 Android 控制白名单的映射。 */
  const keyMap: Record<string, DeviceControlKey> = {
    Enter: "enter",
    Backspace: "backspace",
    Delete: "delete",
    Tab: "tab",
    ArrowUp: "arrow-up",
    ArrowDown: "arrow-down",
    ArrowLeft: "arrow-left",
    ArrowRight: "arrow-right",
    Home: "move-home",
    End: "move-end",
    PageUp: "page-up",
    PageDown: "page-down"
  };
  /** Ctrl/Cmd 常用编辑组合键。 */
  const combination = event.ctrlKey || event.metaKey
    ? ({ a: "a", c: "c", x: "x" } as const)[
        event.key.toLowerCase() as "a" | "c" | "x"
      ]
    : undefined;
  return combination ?? keyMap[event.key];
}

/** 可接收鼠标、触控、滚轮、键盘和输入法的镜像画面。 */
export function MirrorCanvas({
  api,
  preview,
  onFullscreen,
  onToggleNotificationPanel,
  interactive
}: MirrorCanvasProps): ReactNode {
  /** 镜像输入面。 */
  const surfaceRef = useRef<HTMLDivElement>(null);
  /** 隐藏输入法捕获区。 */
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 当前按下的唯一指针。 */
  const pointerRef = useRef<number | undefined>(undefined);
  /** 最近一次触控位置。 */
  const positionRef = useRef<NormalizedPosition>({ x: 0.5, y: 0.5 });
  /** 当前仍需补发释放的按键。 */
  const pressedKeysRef = useRef(
    new Map<DeviceControlKey, DeviceControlModifiers>()
  );
  /** 输入法当前是否正在组合。 */
  const composingRef = useRef(false);

  /** 正常结束当前触控，重复结束时不再发送。 */
  const finishPointer = useCallback(
    (pointerId: number, position: NormalizedPosition): void => {
      if (pointerRef.current !== pointerId) {
        return;
      }
      positionRef.current = position;
      pointerRef.current = undefined;
      surfaceRef.current?.classList.remove("is-cursor-pressed");
      api.sendDeviceControl({ type: "touch", action: "up", ...position });
    },
    [api]
  );

  /** 释放当前触控与全部持续按键。 */
  const releaseInput = useCallback((): void => {
    if (pointerRef.current !== undefined) {
      api.sendDeviceControl({
        type: "touch",
        action: "cancel",
        ...positionRef.current
      });
      pointerRef.current = undefined;
    }
    pressedKeysRef.current.forEach((modifiers, key) => {
      api.sendDeviceControl({
        type: "key",
        action: "up",
        key,
        repeat: 0,
        modifiers
      });
    });
    pressedKeysRef.current.clear();
    surfaceRef.current?.classList.remove(
      "is-cursor-visible",
      "is-cursor-pressed"
    );
  }, [api]);

  useEffect(() => {
    /** 窗口隐藏时释放设备输入。 */
    const handleVisibility = (): void => {
      if (document.hidden) {
        releaseInput();
      }
    };
    window.addEventListener("blur", releaseInput);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      releaseInput();
      window.removeEventListener("blur", releaseInput);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [releaseInput]);

  useEffect(() => {
    if (!interactive) {
      releaseInput();
    }
  }, [interactive, releaseInput]);

  useEffect(() => {
    /** 镜像区域外松开时补发正常触控结束。 */
    const handleWindowPointerUp = (event: PointerEvent): void => {
      /** 当前镜像输入面。 */
      const surface = surfaceRef.current;
      if (!surface || pointerRef.current !== event.pointerId) {
        return;
      }
      /** 区域外坐标按设备边界收敛。 */
      const position = getNormalizedPosition(
        surface,
        event.clientX,
        event.clientY
      );
      updateTouchCursor(
        surface,
        event.clientX,
        event.clientY,
        event.pointerType
      );
      finishPointer(event.pointerId, position);
    };
    /** 系统取消指针时清理设备端持续输入。 */
    const handleWindowPointerCancel = (event: PointerEvent): void => {
      if (pointerRef.current === event.pointerId) {
        releaseInput();
      }
    };

    window.addEventListener("pointerup", handleWindowPointerUp);
    window.addEventListener("pointercancel", handleWindowPointerCancel);
    return () => {
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
    };
  }, [finishPointer, releaseInput]);

  /** 发送隐藏输入区的完整文本并清空。 */
  const flushText = useCallback(
    (input: HTMLTextAreaElement): void => {
      if (input.value) {
        api.sendDeviceControl({ type: "text", text: input.value });
        input.value = "";
      }
    },
    [api]
  );

  /** 处理快捷键与直接编辑键。 */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!interactive) {
      return;
    }
    if (event.key === "F11") {
      event.preventDefault();
      if (!event.repeat) {
        onFullscreen();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (!event.repeat) {
        pressDeviceKey(api, "back");
      }
      return;
    }
    if (event.altKey) {
      /** Alt/Option 快捷键对应的设备动作。 */
      const shortcuts: Record<
        string,
        DeviceControlKey | "toggle-notification-panel"
      > = {
        h: "home",
        p: "power",
        n: "toggle-notification-panel"
      };
      /** 当前匹配的快捷动作。 */
      const action = shortcuts[event.key.toLowerCase()] ?? shortcuts[event.key];
      if (action) {
        event.preventDefault();
        if (!event.repeat) {
          if (action === "toggle-notification-panel") {
            onToggleNotificationPanel();
          } else {
            pressDeviceKey(api, action);
          }
        }
        return;
      }
    }

    /** 当前可直接发送的编辑键。 */
    const key = mapEditingKey(event);
    if (!key) {
      return;
    }
    event.preventDefault();
    /** 首次按下时锁定相同修饰状态，便于失焦补发释放。 */
    const modifiers = pressedKeysRef.current.get(key) ?? getModifiers(event);
    pressedKeysRef.current.set(key, modifiers);
    api.sendDeviceControl({
      type: "key",
      action: "down",
      key,
      repeat: event.repeat ? 1 : 0,
      modifiers
    });
  };

  /** 释放已转发的编辑键。 */
  const handleKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (!interactive) {
      return;
    }
    /** 当前已经按下的设备键。 */
    const key = mapEditingKey(event);
    /** 按下时锁定的修饰状态。 */
    const modifiers = key ? pressedKeysRef.current.get(key) : undefined;
    if (!key || !modifiers) {
      return;
    }
    event.preventDefault();
    pressedKeysRef.current.delete(key);
    api.sendDeviceControl({
      type: "key",
      action: "up",
      key,
      repeat: 0,
      modifiers
    });
  };

  /** 开始鼠标或触控操作。 */
  const handlePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>
  ): void => {
    if (!interactive) {
      return;
    }
    event.preventDefault();
    inputRef.current?.focus({ preventScroll: true });
    if (event.button === 2) {
      pressDeviceKey(api, "back");
      return;
    }
    if (event.button !== 0 || pointerRef.current !== undefined) {
      return;
    }
    updateTouchCursor(
      event.currentTarget,
      event.clientX,
      event.clientY,
      event.pointerType
    );
    event.currentTarget.classList.add("is-cursor-pressed");
    /** 当前触控位置。 */
    const position = getNormalizedPosition(
      event.currentTarget,
      event.clientX,
      event.clientY
    );
    pointerRef.current = event.pointerId;
    positionRef.current = position;
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      /** 捕获失败时由窗口级指针事件继续兜底。 */
    }
    api.sendDeviceControl({ type: "touch", action: "down", ...position });
  };

  /** 转发按住后的拖动。 */
  const handlePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>
  ): void => {
    if (!interactive) {
      return;
    }
    updateTouchCursor(
      event.currentTarget,
      event.clientX,
      event.clientY,
      event.pointerType
    );
    if (pointerRef.current !== event.pointerId) {
      return;
    }
    /** 当前拖动位置。 */
    const position = getNormalizedPosition(
      event.currentTarget,
      event.clientX,
      event.clientY
    );
    positionRef.current = position;
    api.sendDeviceControl({ type: "touch", action: "move", ...position });
  };

  /** 结束当前触控操作。 */
  const handlePointerUp = (
    event: ReactPointerEvent<HTMLDivElement>
  ): void => {
    if (!interactive) {
      return;
    }
    if (pointerRef.current !== event.pointerId) {
      return;
    }
    updateTouchCursor(
      event.currentTarget,
      event.clientX,
      event.clientY,
      event.pointerType
    );
    /** 当前抬起位置。 */
    const position = getNormalizedPosition(
      event.currentTarget,
      event.clientX,
      event.clientY
    );
    finishPointer(event.pointerId, position);
  };

  /** 指针捕获丢失且鼠标已松开时补发触控结束。 */
  const handleLostPointerCapture = (
    event: ReactPointerEvent<HTMLDivElement>
  ): void => {
    if (event.buttons === 0) {
      finishPointer(event.pointerId, positionRef.current);
    }
  };

  /** 把滚轮操作转换为设备滚动。 */
  const handleWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (!interactive) {
      return;
    }
    event.preventDefault();
    /** 当前滚轮位置。 */
    const position = getNormalizedPosition(
      event.currentTarget,
      event.clientX,
      event.clientY
    );
    api.sendDeviceControl({
      type: "scroll",
      ...position,
      horizontal: normalizeScroll(event.deltaX),
      vertical: normalizeScroll(event.deltaY)
    });
  };

  return (
    <div
      ref={surfaceRef}
      className={`mirror-surface${interactive ? " is-interactive" : ""}`}
      style={
        preview.size
          ? ({
              "--mirror-aspect-ratio": `${preview.size.width} / ${preview.size.height}`
            } as CSSProperties)
          : undefined
      }
      onPointerDown={handlePointerDown}
      onPointerEnter={handlePointerMove}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={releaseInput}
      onLostPointerCapture={handleLostPointerCapture}
      onPointerLeave={(event) => {
        if (pointerRef.current === undefined) {
          event.currentTarget.classList.remove("is-cursor-visible");
        }
      }}
      onContextMenu={(event) => event.preventDefault()}
      onWheel={handleWheel}
    >
      <canvas
        key={preview.canvasGeneration}
        ref={preview.canvasRef}
        className="live-preview__canvas"
        aria-label="安卓设备实时预览"
      />
      <span className="mirror-surface__touch-cursor" aria-hidden="true" />
      <textarea
        ref={inputRef}
        className="mirror-surface__input"
        aria-label="镜像控制输入"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={!interactive}
        onBlur={releaseInput}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onInput={(event: FormEvent<HTMLTextAreaElement>) => {
          if (!composingRef.current) {
            flushText(event.currentTarget);
          }
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={(event: CompositionEvent<HTMLTextAreaElement>) => {
          composingRef.current = false;
          flushText(event.currentTarget);
        }}
        onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
          /** 系统剪贴板中的纯文本。 */
          const text = event.clipboardData.getData("text/plain");
          if (text) {
            event.preventDefault();
            api.sendDeviceControl({ type: "text", text });
          }
        }}
      />
    </div>
  );
}

/** 支持短按和长按的电源控制按钮。 */
function PowerButton({
  api
}: Pick<MirrorControlPanelProps, "api">): ReactNode {
  /** 长按触发计时器。 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  /** 当前是否已发出持续按下。 */
  const longPressRef = useRef(false);

  /** 结束本次电源键按压。 */
  const finishPress = useCallback((cancelled = false): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    if (longPressRef.current) {
      api.sendDeviceControl({
        type: "key",
        action: "up",
        key: "power",
        repeat: 0,
        modifiers: emptyModifiers
      });
      longPressRef.current = false;
    } else if (!cancelled) {
      pressDeviceKey(api, "power");
    }
  }, [api]);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      if (longPressRef.current) {
        api.sendDeviceControl({
          type: "key",
          action: "up",
          key: "power",
          repeat: 0,
          modifiers: emptyModifiers
        });
      }
    },
    [api]
  );

  return (
    <button
      type="button"
      aria-label="电源键"
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }
        event.currentTarget.setPointerCapture?.(event.pointerId);
        timerRef.current = setTimeout(() => {
          longPressRef.current = true;
          api.sendDeviceControl({
            type: "key",
            action: "down",
            key: "power",
            repeat: 0,
            modifiers: emptyModifiers
          });
        }, 650);
      }}
      onPointerUp={() => finishPress()}
      onPointerCancel={() => finishPress(true)}
      onClick={(event) => {
        if (event.detail === 0) {
          pressDeviceKey(api, "power");
        }
      }}
    >
      <IconSquareFilled size={21} />
      <span>电源键</span>
      <kbd>⌥ P</kbd>
    </button>
  );
}

/** 普通镜像控制按钮属性。 */
interface MirrorControlButtonProps {
  /** 按钮名称。 */
  label: string;
  /** 快捷键展示。 */
  shortcut: string;
  /** 按钮图标。 */
  icon: ReactNode;
  /** 是否横跨两列。 */
  wide?: boolean;
  /** 当前按钮是否处于开启状态。 */
  pressed?: boolean;
  /** 点击动作。 */
  onClick(): void;
}

/** 渲染统一样式的镜像控制按钮。 */
function MirrorControlButton({
  label,
  shortcut,
  icon,
  wide = false,
  pressed,
  onClick
}: MirrorControlButtonProps): ReactNode {
  return (
    <button
      type="button"
      className={wide ? "mirror-controls__wide-button" : undefined}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      <kbd>{shortcut}</kbd>
    </button>
  );
}

/** 镜像画面右侧的五项设备控制。 */
export function MirrorControlPanel({
  api,
  onFullscreen,
  notificationPanelOpen,
  onToggleNotificationPanel
}: MirrorControlPanelProps): ReactNode {
  return (
    <aside className="mirror-controls" aria-label="设备控制">
      <div className="mirror-controls__title">
        <span>设备控制</span>
        <small>点击画面后可用快捷键</small>
      </div>
      <div className="mirror-controls__grid">
        <MirrorControlButton
          label="返回"
          shortcut="Esc"
          icon={<IconRotate2 size={22} stroke={1.7} />}
          onClick={() => pressDeviceKey(api, "back")}
        />
        <MirrorControlButton
          label="主页"
          shortcut="⌥ H"
          icon={<IconDeviceMobile size={22} stroke={1.7} />}
          onClick={() => pressDeviceKey(api, "home")}
        />
        <PowerButton api={api} />
        <MirrorControlButton
          label={notificationPanelOpen ? "关闭下拉菜单" : "打开下拉菜单"}
          shortcut="⌥ N"
          icon={
            notificationPanelOpen ? (
              <IconBellOff size={22} stroke={1.7} />
            ) : (
              <IconBell size={22} stroke={1.7} />
            )
          }
          pressed={notificationPanelOpen}
          onClick={onToggleNotificationPanel}
        />
        <MirrorControlButton
          wide
          label="全屏镜像"
          shortcut="F11"
          icon={<IconArrowsMaximize size={22} stroke={1.7} />}
          onClick={onFullscreen}
        />
      </div>
      <div className="mirror-controls__hint">右键返回 · 滚轮滚动</div>
    </aside>
  );
}
