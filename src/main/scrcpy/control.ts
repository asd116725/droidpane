import type {
  DeviceControlCommand,
  DeviceControlKey,
  DeviceControlModifiers
} from "../../shared/types";
import type { ScrcpySocket } from "./session";

/** scrcpy 位置消息使用的当前视频尺寸。 */
export interface ScrcpyControlScreenSize {
  /** 视频像素宽度。 */
  width: number;
  /** 视频像素高度。 */
  height: number;
}

/** scrcpy 4.1 控制消息类型。 */
const controlMessageType = {
  keycode: 0,
  text: 1,
  touch: 2,
  scroll: 3,
  collapsePanels: 7,
  clipboard: 9
} as const;

/** 打开设备下拉菜单时每个触控步骤的间隔。 */
const notificationPanelGestureIntervalMs = 16;

/** 打开设备下拉菜单的触控步骤数。 */
const notificationPanelGestureStepCount = 20;

/** 打开设备下拉菜单的结束纵坐标。 */
const notificationPanelGestureEndY = 0.65;

/** Android KeyEvent keycode 白名单。 */
const androidKeycodes: Record<DeviceControlKey, number> = {
  back: 4,
  home: 3,
  power: 26,
  enter: 66,
  backspace: 67,
  delete: 112,
  tab: 61,
  "arrow-up": 19,
  "arrow-down": 20,
  "arrow-left": 21,
  "arrow-right": 22,
  "move-home": 122,
  "move-end": 123,
  "page-up": 92,
  "page-down": 93,
  a: 29,
  c: 31,
  x: 52
};

/** 文本注入和剪贴板协议的安全长度。 */
export const scrcpyTextLimits = {
  inject: 300,
  clipboard: (1 << 18) - 14
} as const;

/** 把范围零到一的坐标转换为当前视频像素。 */
function resolvePosition(
  value: number,
  length: number
): number {
  return Math.min(
    Math.max(0, length - 1),
    Math.floor(Math.min(1, Math.max(0, value)) * length)
  );
}

/** 写入 scrcpy 位置结构。 */
function writePosition(
  buffer: Buffer,
  offset: number,
  x: number,
  y: number,
  screen: ScrcpyControlScreenSize
): void {
  buffer.writeInt32BE(resolvePosition(x, screen.width), offset);
  buffer.writeInt32BE(resolvePosition(y, screen.height), offset + 4);
  buffer.writeUInt16BE(screen.width, offset + 8);
  buffer.writeUInt16BE(screen.height, offset + 10);
}

/** 把按键修饰状态转换为 Android metastate。 */
function resolveMetaState(modifiers: DeviceControlModifiers): number {
  return (
    (modifiers.shift ? 0x1 : 0) |
    (modifiers.alt ? 0x2 : 0) |
    (modifiers.ctrl ? 0x1000 : 0)
  );
}

/** 把浮点滚动量编码为 scrcpy 使用的 i16 定点数。 */
function resolveScroll(value: number): number {
  /** scrcpy 先把负十六到十六归一化为负一到一。 */
  const normalized = Math.min(16, Math.max(-16, value)) / 16;
  return Math.min(0x7fff, Math.trunc(normalized * 0x8000));
}

/** 按 UTF-8 字节数拆分可直接注入的文本。 */
function splitInjectText(text: string): Buffer[] {
  /** 当前字符块。 */
  let chunk = "";
  /** 拆分后的 UTF-8 数据。 */
  const chunks: Buffer[] = [];

  for (const character of text) {
    /** 追加当前字符后的候选文本。 */
    const next = `${chunk}${character}`;
    if (Buffer.byteLength(next) > scrcpyTextLimits.inject && chunk) {
      chunks.push(Buffer.from(chunk));
      chunk = character;
    } else {
      chunk = next;
    }
  }
  if (chunk) {
    chunks.push(Buffer.from(chunk));
  }
  return chunks;
}

/** 序列化直接文本注入消息。 */
function serializeText(text: string): Buffer[] {
  return splitInjectText(text).map((data) => {
    /** 类型、四字节长度与 UTF-8 文本。 */
    const buffer = Buffer.alloc(5 + data.length);
    buffer[0] = controlMessageType.text;
    buffer.writeUInt32BE(data.length, 1);
    data.copy(buffer, 5);
    return buffer;
  });
}

/** 序列化写入设备剪贴板并粘贴的消息。 */
function serializeClipboard(text: string): Buffer[] {
  /** 设备剪贴板文本。 */
  const data = Buffer.from(text);
  /** 类型、序号、粘贴标记、长度与 UTF-8 文本。 */
  const buffer = Buffer.alloc(14 + data.length);
  buffer[0] = controlMessageType.clipboard;
  buffer.writeBigUInt64BE(0n, 1);
  buffer[9] = 1;
  buffer.writeUInt32BE(data.length, 10);
  data.copy(buffer, 14);
  return [buffer];
}

/** 序列化一条受限设备控制命令。 */
export function serializeDeviceControlCommand(
  command: DeviceControlCommand,
  screen: ScrcpyControlScreenSize,
  apiLevel: number
): Buffer[] {
  if (command.type === "touch") {
    /** 固定三十二字节触控消息。 */
    const buffer = Buffer.alloc(32);
    /** Android MotionEvent action。 */
    const actions = { down: 0, up: 1, move: 2, cancel: 3 } as const;
    buffer[0] = controlMessageType.touch;
    buffer[1] = actions[command.action];
    buffer.writeBigUInt64BE(BigInt.asUintN(64, -2n), 2);
    writePosition(buffer, 10, command.x, command.y, screen);
    buffer.writeUInt16BE(
      ["up", "cancel"].includes(command.action) ? 0 : 0xffff,
      22
    );
    return [buffer];
  }

  if (command.type === "scroll") {
    /** 固定二十一字节滚动消息。 */
    const buffer = Buffer.alloc(21);
    buffer[0] = controlMessageType.scroll;
    writePosition(buffer, 1, command.x, command.y, screen);
    buffer.writeInt16BE(resolveScroll(command.horizontal), 13);
    buffer.writeInt16BE(resolveScroll(command.vertical), 15);
    return [buffer];
  }

  if (command.type === "key") {
    /** 固定十四字节按键消息。 */
    const buffer = Buffer.alloc(14);
    buffer[0] = controlMessageType.keycode;
    buffer[1] = command.action === "down" ? 0 : 1;
    buffer.writeUInt32BE(androidKeycodes[command.key], 2);
    buffer.writeUInt32BE(command.repeat, 6);
    buffer.writeUInt32BE(resolveMetaState(command.modifiers), 10);
    return [buffer];
  }

  if (command.type === "expand-notification-panel") {
    /** 从屏幕顶部向下展开菜单的纵向轨迹。 */
    const verticalPositions = Array.from(
      { length: notificationPanelGestureStepCount + 1 },
      (_, index) => {
        /** 当前触控步骤的线性进度。 */
        const progress = index / notificationPanelGestureStepCount;
        /** 从屏幕顶部开始，避免系统把起点裁剪到画面之外。 */
        const startY = 1 / screen.height;
        return startY + (notificationPanelGestureEndY - startY) * progress;
      }
    );
    return verticalPositions.map((y, index) =>
      serializeDeviceControlCommand(
        {
          type: "touch",
          action:
            index === 0
              ? "down"
              : index === verticalPositions.length - 1
                ? "up"
                : "move",
          x: 0.5,
          y
        },
        screen,
        apiLevel
      )[0]
    );
  }

  if (command.type === "collapse-notification-panel") {
    return [Buffer.from([controlMessageType.collapsePanels])];
  }

  /** Android 7+ 使用剪贴板可靠注入非 ASCII 文本。 */
  const requiresClipboard = /[^\x20-\x7e\n\t]/.test(command.text);
  if (requiresClipboard && apiLevel >= 24) {
    return serializeClipboard(command.text);
  }
  /** Android 7 以下只保留可由按键事件表达的 ASCII 文本。 */
  const compatibleText =
    apiLevel < 24
      ? command.text.replace(/[^\x20-\x7e\n\t]/g, "")
      : command.text;
  return serializeText(compatibleText);
}

/** 管理单个 scrcpy 控制 Socket 的尺寸与写入。 */
export class ScrcpyControlChannel {
  /** 当前视频尺寸。 */
  private screen?: ScrcpyControlScreenSize;

  /** 创建控制通道。 */
  constructor(
    private readonly socket: ScrcpySocket,
    private readonly apiLevel: number
  ) {}

  /** 更新触控与滚动使用的视频尺寸。 */
  setScreenSize(screen: ScrcpyControlScreenSize): void {
    this.screen = { ...screen };
  }

  /** 尝试按顺序写入一条控制命令。 */
  send(command: DeviceControlCommand): boolean {
    if (
      !this.screen &&
      ["touch", "scroll", "expand-notification-panel"].includes(command.type)
    ) {
      return false;
    }

    /** 非位置消息使用的占位尺寸不会写入协议。 */
    const screen = this.screen ?? { width: 1, height: 1 };
    try {
      /** 当前命令对应的有序控制消息。 */
      const messages = serializeDeviceControlCommand(
        command,
        screen,
        this.apiLevel
      );
      if (command.type === "expand-notification-panel") {
        this.sendNotificationPanelGesture(messages);
      } else {
        messages.forEach((message) => this.socket.write(message));
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 按固定节奏发送顶部下拉触控序列。 */
  private sendNotificationPanelGesture(messages: Buffer[]): void {
    messages.forEach((message, index) => {
      if (index === 0) {
        this.socket.write(message);
        return;
      }

      /** 当前触控步骤的延迟发送计时器。 */
      const timer = setTimeout(() => {
        try {
          this.socket.write(message);
        } catch {
          // 控制通道关闭后忽略尚未发送的手势步骤。
        }
      }, index * notificationPanelGestureIntervalMs);
      timer.unref();
    });
  }
}
