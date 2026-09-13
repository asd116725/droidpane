import { resolveRuntimePaths } from "../../src/main/runtime/paths";

describe("内置运行时路径", () => {
  it("开发环境按 macOS Apple Silicon 定位 scrcpy 与 adb", () => {
    expect(
      resolveRuntimePaths({
        platform: "darwin",
        arch: "arm64",
        isPackaged: false,
        projectRoot: "/workspace",
        resourcesPath: "/resources"
      })
    ).toEqual({
      root: "/workspace/vendor/scrcpy/darwin-arm64",
      adb: "/workspace/vendor/scrcpy/darwin-arm64/adb",
      scrcpy: "/workspace/vendor/scrcpy/darwin-arm64/scrcpy",
      scrcpyServer: "/workspace/vendor/scrcpy/darwin-arm64/scrcpy-server"
    });
  });

  it("打包后的 Windows x64 使用 resources 内的 exe", () => {
    expect(
      resolveRuntimePaths({
        platform: "win32",
        arch: "x64",
        isPackaged: true,
        projectRoot: "C:\\workspace",
        resourcesPath: "C:\\app\\resources"
      })
    ).toEqual({
      root: "C:\\app\\resources\\win32-x64",
      adb: "C:\\app\\resources\\win32-x64\\adb.exe",
      scrcpy: "C:\\app\\resources\\win32-x64\\scrcpy.exe",
      scrcpyServer: "C:\\app\\resources\\win32-x64\\scrcpy-server"
    });
  });
});
