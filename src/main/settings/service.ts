import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppSettings } from "../../shared/types";
import {
  parseSettings,
  parseSettingsUpdate
} from "../../shared/validation";

/** 创建首次启动使用的默认设置。 */
export function createDefaultSettings(
  recordingsDirectory: string
): AppSettings {
  return {
    preset: {
      resolution: "1080p",
      videoBitrateMbps: 8,
      audioMode: "device"
    },
    audioMonitor: {
      autoEnableOnLegacyAndroid: false,
      volume: 0.8
    },
    recordingsDirectory
  };
}

/** 创建互不共享引用的设置副本。 */
function cloneSettings(settings: AppSettings): AppSettings {
  return {
    preset: { ...settings.preset },
    audioMonitor: { ...settings.audioMonitor },
    recordingsDirectory: settings.recordingsDirectory
  };
}

/** 在用户数据目录读写应用设置。 */
export class SettingsService {
  /** 当前内存设置。 */
  private settings: AppSettings;

  /** 创建设置服务。 */
  constructor(
    private readonly filePath: string,
    private readonly defaultRecordingsDirectory: string
  ) {
    this.settings = createDefaultSettings(defaultRecordingsDirectory);
  }

  /** 从磁盘加载设置，损坏或缺失时使用默认值。 */
  async load(): Promise<AppSettings> {
    try {
      /** 设置文件文本。 */
      const content = await readFile(this.filePath, "utf8");
      /** 磁盘中的设置对象。 */
      const stored = JSON.parse(content) as Record<string, unknown>;
      /** 兼容尚未保存录制目录与监听偏好的旧版设置。 */
      const migrated = {
        ...stored,
        audioMonitor: stored.audioMonitor ?? {
          autoEnableOnLegacyAndroid: false,
          volume: 0.8
        },
        recordingsDirectory:
          stored.recordingsDirectory ?? this.defaultRecordingsDirectory
      };
      this.settings = this.validateSettings(migrated);
    } catch {
      this.settings = createDefaultSettings(this.defaultRecordingsDirectory);
    }

    return this.get();
  }

  /** 获取当前设置副本。 */
  get(): AppSettings {
    return cloneSettings(this.settings);
  }

  /** 更新录制预设与监听偏好并保留当前存储目录。 */
  async setPreferences(value: unknown): Promise<AppSettings> {
    /** 已校验的可修改设置。 */
    const preferences = parseSettingsUpdate(value);
    return this.persist({
      ...this.settings,
      ...preferences
    });
  }

  /** 更新由主进程系统选择器产生的录制目录。 */
  async setRecordingsDirectory(directory: string): Promise<AppSettings> {
    return this.persist({
      ...this.settings,
      recordingsDirectory: path.normalize(directory)
    });
  }

  /** 校验并原子保存完整设置。 */
  private async persist(value: AppSettings): Promise<AppSettings> {
    /** 已校验设置。 */
    const settings = this.validateSettings(value);
    /** 设置目录。 */
    const directory = path.dirname(this.filePath);
    /** 临时设置文件。 */
    const temporaryPath = `${this.filePath}.tmp`;

    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, JSON.stringify(settings, null, 2), "utf8");
    await rename(temporaryPath, this.filePath);
    this.settings = settings;
    return this.get();
  }

  /** 校验完整设置及当前平台绝对路径。 */
  private validateSettings(value: unknown): AppSettings {
    /** 已通过共享规则校验的设置。 */
    const settings = parseSettings(value);

    if (!path.isAbsolute(settings.recordingsDirectory)) {
      throw new Error("录制文件存储位置无效");
    }

    return settings;
  }
}
