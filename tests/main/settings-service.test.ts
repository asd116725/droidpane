/** @jest-environment node */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SettingsService } from "../../src/main/settings/service";

describe("设置持久化服务", () => {
  /** 每个用例使用的临时目录。 */
  let temporaryDirectory: string;
  /** 测试设置文件路径。 */
  let settingsPath: string;
  /** 默认录制目录。 */
  let defaultRecordingsDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "droidpane-settings-")
    );
    settingsPath = path.join(temporaryDirectory, "settings.json");
    defaultRecordingsDirectory = path.join(temporaryDirectory, "Videos");
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("缺少设置文件时返回系统默认录制目录", async () => {
    /** 空设置服务。 */
    const service = new SettingsService(
      settingsPath,
      defaultRecordingsDirectory
    );

    await expect(service.load()).resolves.toMatchObject({
      recordingsDirectory: defaultRecordingsDirectory,
      audioMonitor: {
        autoEnableOnLegacyAndroid: false,
        volume: 0.8
      },
      preset: {
        resolution: "1080p",
        videoBitrateMbps: 8,
        audioMode: "device"
      }
    });
  });

  it("迁移旧版设置并保留原有录制预设", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        preset: {
          resolution: "720p",
          videoBitrateMbps: 4,
          audioMode: "silent"
        }
      }),
      "utf8"
    );
    /** 加载旧配置的设置服务。 */
    const service = new SettingsService(
      settingsPath,
      defaultRecordingsDirectory
    );

    await expect(service.load()).resolves.toEqual({
      preset: {
        resolution: "720p",
        videoBitrateMbps: 4,
        audioMode: "silent"
      },
      audioMonitor: {
        autoEnableOnLegacyAndroid: false,
        volume: 0.8
      },
      recordingsDirectory: defaultRecordingsDirectory
    });
  });

  it("分别更新预设与录制目录并在重启后恢复", async () => {
    /** 第一次启动的设置服务。 */
    const firstService = new SettingsService(
      settingsPath,
      defaultRecordingsDirectory
    );
    /** 用户选择的新录制目录。 */
    const selectedDirectory = path.join(temporaryDirectory, "Recordings");
    await firstService.load();
    await firstService.setRecordingsDirectory(selectedDirectory);
    await firstService.setPreferences({
      preset: {
        resolution: "original",
        videoBitrateMbps: 16,
        audioMode: "device"
      },
      audioMonitor: {
        autoEnableOnLegacyAndroid: true,
        volume: 0.45
      }
    });

    /** 模拟应用重启后的设置服务。 */
    const restartedService = new SettingsService(
      settingsPath,
      defaultRecordingsDirectory
    );
    await expect(restartedService.load()).resolves.toEqual({
      preset: {
        resolution: "original",
        videoBitrateMbps: 16,
        audioMode: "device"
      },
      audioMonitor: {
        autoEnableOnLegacyAndroid: true,
        volume: 0.45
      },
      recordingsDirectory: selectedDirectory
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(
      restartedService.get()
    );
  });

  it("相对目录配置无效时回退到安全默认值", async () => {
    await writeFile(
      settingsPath,
      JSON.stringify({
        preset: {
          resolution: "720p",
          videoBitrateMbps: 4,
          audioMode: "silent"
        },
        recordingsDirectory: "../relative"
      }),
      "utf8"
    );
    /** 加载无效目录的设置服务。 */
    const service = new SettingsService(
      settingsPath,
      defaultRecordingsDirectory
    );

    await expect(service.load()).resolves.toMatchObject({
      recordingsDirectory: defaultRecordingsDirectory,
      audioMonitor: {
        autoEnableOnLegacyAndroid: false,
        volume: 0.8
      },
      preset: {
        resolution: "1080p",
        videoBitrateMbps: 8,
        audioMode: "device"
      }
    });
  });
});
