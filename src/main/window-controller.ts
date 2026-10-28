import type { BrowserWindow } from "electron";
import type {
  SavedWindowBounds,
  WindowMode,
  WindowPresentationPreferences,
  WindowPresentationState
} from "../shared/connection";
import { constrainWindowBounds } from "./window-bounds";

/** 只操作现有窗口，不创建第二个媒体消费者。 */
export interface WindowControllerDependencies {
  window: BrowserWindow;
  preferences?: WindowPresentationPreferences;
  getWorkArea(bounds: SavedWindowBounds): SavedWindowBounds;
  savePreferences(value: WindowPresentationPreferences): Promise<unknown>;
}

/** 连接面板展开时增加的宽度，关闭后恢复原紧凑尺寸。 */
const connectionPanelWidth = 420;

/** 同一个原生窗口的布局、置顶与两套位置记忆。 */
export class WindowController {
  private state: WindowPresentationState = {
    mode: "normal", alwaysOnTop: false, connectionPanelOpen: false
  };
  private preferences: WindowPresentationPreferences;
  private readonly listeners = new Set<(state: WindowPresentationState) => void>();
  private operation: Promise<unknown> = Promise.resolve();
  private saveTimer?: NodeJS.Timeout;
  private adjusting = false;
  private normalAlwaysOnTop = false;
  private restoreMaximized = false;
  private restoreFullscreen = false;

  constructor(private readonly dependencies: WindowControllerDependencies) {
    this.preferences = structuredClone(dependencies.preferences ?? {
      mode: "normal", compactAlwaysOnTop: false
    });
    dependencies.window.on("move", this.handleBoundsChanged);
    dependencies.window.on("resize", this.handleBoundsChanged);
    dependencies.window.on("always-on-top-changed", this.handlePinnedChanged);
  }

  /** 在显示窗口前恢复上次布局；历史位置会收敛到可用显示器。 */
  async initialize(): Promise<void> {
    const mode = this.preferences.mode;
    if (this.preferences.normalBounds) {
      this.adjusting = true;
      this.applyBounds(this.preferences.normalBounds);
      this.adjusting = false;
    }
    if (mode === "compact") {
      await this.setMode(mode);
    }
  }

  getState(): WindowPresentationState {
    return { ...this.state };
  }

  onChanged(listener: (state: WindowPresentationState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 模式切换串行执行，避免全屏退出事件和连续点击互相覆盖。 */
  setMode(mode: WindowMode): Promise<WindowPresentationState> {
    return this.run(async () => {
      if (mode === this.state.mode) return;
      const window = this.dependencies.window;
      this.rememberBounds();
      if (mode === "compact") {
        this.restoreMaximized = window.isMaximized();
        this.restoreFullscreen = window.isFullScreen();
        this.normalAlwaysOnTop = window.isAlwaysOnTop();
        await this.setFullscreen(false);
        if (window.isMaximized()) window.unmaximize();
      }
      this.state.mode = mode;
      this.preferences.mode = mode;
      let bounds = mode === "compact"
        ? this.preferences.compactBounds ?? this.initialCompactBounds()
        : this.preferences.normalBounds ?? window.getNormalBounds();
      if (mode === "compact") {
        this.preferences.compactBounds = { ...bounds };
        if (this.state.connectionPanelOpen) {
          bounds = { ...bounds, width: bounds.width + connectionPanelWidth };
        }
      }
      this.applyBounds(bounds);
      window.setAlwaysOnTop(mode === "compact"
        ? this.preferences.compactAlwaysOnTop : this.normalAlwaysOnTop);
      if (mode === "normal") {
        if (this.restoreMaximized) window.maximize();
        if (this.restoreFullscreen) await this.setFullscreen(true);
      }
      this.state.alwaysOnTop = window.isAlwaysOnTop();
      await this.persist();
    });
  }

  /** 使用系统普通置顶级别，并回显实际状态。 */
  setAlwaysOnTop(enabled: boolean): Promise<WindowPresentationState> {
    return this.run(async () => {
      this.dependencies.window.setAlwaysOnTop(enabled);
      this.state.alwaysOnTop = this.dependencies.window.isAlwaysOnTop();
      if (this.state.mode === "compact") {
        this.preferences.compactAlwaysOnTop = this.state.alwaysOnTop;
      } else {
        this.normalAlwaysOnTop = this.state.alwaysOnTop;
      }
      await this.persist();
    });
  }

  /** 紧凑窗口展开表单时暂时加宽，镜像、画布和端口保持不变。 */
  setConnectionPanelOpen(open: boolean): Promise<WindowPresentationState> {
    return this.run(async () => {
      if (open === this.state.connectionPanelOpen) return;
      this.rememberBounds();
      this.state.connectionPanelOpen = open;
      if (this.state.mode === "compact") {
        const base = this.preferences.compactBounds ?? this.initialCompactBounds();
        this.applyBounds({ ...base, width: base.width + (open ? connectionPanelWidth : 0) });
      }
    });
  }

  /** 显示器拔出或缩放改变后，标题栏和操作区域仍须位于可见工作区。 */
  fitToWorkArea(): Promise<WindowPresentationState> {
    return this.run(async () => {
      const window = this.dependencies.window;
      if (!window.isMaximized() && !window.isFullScreen()) {
        this.applyBounds(window.getBounds());
        this.rememberBounds();
        await this.persist();
      }
    });
  }

  /** 关闭前保存最后一次拖动；调用方等待保存后再退出。 */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    await this.operation.catch(() => undefined);
    this.rememberBounds();
    await this.persist();
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
    const window = this.dependencies.window;
    window.removeListener("move", this.handleBoundsChanged);
    window.removeListener("resize", this.handleBoundsChanged);
    window.removeListener("always-on-top-changed", this.handlePinnedChanged);
    this.listeners.clear();
  }

  private run(action: () => Promise<void>): Promise<WindowPresentationState> {
    const task = this.operation.then(async () => {
      this.adjusting = true;
      try {
        await action();
      } finally {
        this.adjusting = false;
        this.publish();
      }
      return this.getState();
    });
    this.operation = task.catch(() => undefined);
    return task;
  }

  private initialCompactBounds(): SavedWindowBounds {
    const current = this.dependencies.window.getNormalBounds();
    return constrainWindowBounds({ ...current, width: 360, height: 904 },
      this.dependencies.getWorkArea(current), "compact");
  }

  private applyBounds(bounds: SavedWindowBounds): void {
    const workArea = this.dependencies.getWorkArea(bounds);
    const compact = this.state.mode === "compact";
    this.dependencies.window.setMinimumSize(
      Math.min(compact ? 280 : 900, workArea.width),
      Math.min(compact ? 420 : 640, workArea.height)
    );
    this.dependencies.window.setBounds(constrainWindowBounds(bounds, workArea, this.state.mode));
  }

  private rememberBounds(): void {
    const window = this.dependencies.window;
    if (window.isDestroyed()) return;
    if (this.state.mode === "compact") {
      if (!this.state.connectionPanelOpen) {
        this.preferences.compactBounds = window.getNormalBounds();
      }
    } else {
      this.preferences.normalBounds = window.getNormalBounds();
    }
  }

  private persist(): Promise<unknown> {
    return this.dependencies.savePreferences(structuredClone(this.preferences));
  }

  private publish(): void {
    this.listeners.forEach((listener) => listener(this.getState()));
  }

  private readonly handleBoundsChanged = (): void => {
    if (this.adjusting) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.run(async () => {
        this.rememberBounds();
        await this.persist();
      }).catch(() => undefined);
    }, 250);
  };

  private readonly handlePinnedChanged = (): void => {
    this.state.alwaysOnTop = this.dependencies.window.isAlwaysOnTop();
    this.publish();
  };

  /** macOS 进出全屏均异步完成，下一次模式切换必须等待系统确认。 */
  private setFullscreen(enabled: boolean): Promise<void> {
    const window = this.dependencies.window;
    if (window.isFullScreen() === enabled) return Promise.resolve();
    const events: NodeJS.EventEmitter = window;
    const event = enabled ? "enter-full-screen" : "leave-full-screen";
    return new Promise((resolve, reject) => {
      const finish = (): void => {
        clearTimeout(timer);
        events.removeListener(event, finish);
        resolve();
      };
      const timer = setTimeout(() => {
        events.removeListener(event, finish);
        if (window.isFullScreen() !== enabled) reject(new Error("全屏切换未完成，请稍后重试"));
        else resolve();
      }, 5_000);
      events.once(event, finish);
      window.setFullScreen(enabled);
    });
  }
}
