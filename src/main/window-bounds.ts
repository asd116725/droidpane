import type { SavedWindowBounds, WindowMode } from "../shared/connection";

/** 显示器工作区尺寸。 */
export interface WindowWorkAreaSize {
  /** 工作区宽度。 */
  width: number;
  /** 工作区高度。 */
  height: number;
}

/** 主窗口的初始尺寸与最小尺寸。 */
export interface MainWindowBounds extends WindowWorkAreaSize {
  /** 最小窗口宽度。 */
  minWidth: number;
  /** 最小窗口高度。 */
  minHeight: number;
}

/** 主窗口设计尺寸。 */
const preferredWindowSize: WindowWorkAreaSize = {
  width: 1_440,
  height: 1_024
};

/** 主窗口在常规工作区内允许缩小到的尺寸。 */
const minimumWindowSize: WindowWorkAreaSize = {
  width: 900,
  height: 640
};

/** 根据显示器工作区收敛主窗口尺寸。 */
export function resolveMainWindowBounds(
  workArea: WindowWorkAreaSize
): MainWindowBounds {
  return {
    width: Math.min(preferredWindowSize.width, workArea.width),
    height: Math.min(preferredWindowSize.height, workArea.height),
    minWidth: Math.min(minimumWindowSize.width, workArea.width),
    minHeight: Math.min(minimumWindowSize.height, workArea.height)
  };
}

/** 将窗口完整收回当前显示器工作区，同时遵守当前模式的最小尺寸。 */
export function constrainWindowBounds(
  bounds: SavedWindowBounds,
  workArea: SavedWindowBounds,
  mode: WindowMode
): SavedWindowBounds {
  const minimum = mode === "compact"
    ? { width: 280, height: 420 }
    : minimumWindowSize;
  const width = Math.min(workArea.width, Math.max(minimum.width, bounds.width));
  const height = Math.min(workArea.height, Math.max(minimum.height, bounds.height));
  return {
    x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - width)),
    y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - height)),
    width,
    height
  };
}
