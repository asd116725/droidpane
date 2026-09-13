import type { AdbStudioApi } from "./shared/types";

declare global {
  interface Window {
    /** 预加载脚本公开的受限桌面接口。 */
    adbStudio?: AdbStudioApi;
  }
}

export {};
