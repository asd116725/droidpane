import path from "node:path";

/** 运行时路径解析输入。 */
export interface RuntimePathOptions {
  /** 当前操作系统。 */
  platform: NodeJS.Platform;
  /** 当前 CPU 架构。 */
  arch: string;
  /** 应用是否已打包。 */
  isPackaged: boolean;
  /** 开发项目根目录。 */
  projectRoot: string;
  /** Electron resources 目录。 */
  resourcesPath: string;
}

/** scrcpy 与 adb 可执行文件路径。 */
export interface RuntimePaths {
  /** 内置运行时根目录。 */
  root: string;
  /** adb 可执行文件。 */
  adb: string;
  /** scrcpy 可执行文件。 */
  scrcpy: string;
  /** 与客户端版本锁定的 scrcpy-server。 */
  scrcpyServer: string;
}

/** 根据平台与打包状态解析内置运行时路径。 */
export function resolveRuntimePaths(
  options: RuntimePathOptions
): RuntimePaths {
  /** 使用目标系统对应的路径实现。 */
  const pathApi = options.platform === "win32" ? path.win32 : path.posix;
  /** 平台与架构目录名。 */
  const runtimeKey = `${options.platform}-${options.arch}`;
  /** 内置运行时根目录。 */
  const root = options.isPackaged
    ? pathApi.join(options.resourcesPath, runtimeKey)
    : pathApi.join(options.projectRoot, "vendor", "scrcpy", runtimeKey);
  /** Windows 可执行文件扩展名。 */
  const extension = options.platform === "win32" ? ".exe" : "";

  return {
    root,
    adb: pathApi.join(root, `adb${extension}`),
    scrcpy: pathApi.join(root, `scrcpy${extension}`),
    scrcpyServer: pathApi.join(root, "scrcpy-server")
  };
}
