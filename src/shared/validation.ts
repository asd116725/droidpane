import { z } from "zod";
import type {
  AppSettings,
  AppSettingsUpdate,
  DeviceControlCommand,
  RecordingPreset,
  WindowAction
} from "./types";

/** 录制预设校验规则。 */
const recordingPresetSchema = z
  .object({
    resolution: z.enum(["720p", "1080p", "original"]),
    videoBitrateMbps: z.union([z.literal(4), z.literal(8), z.literal(16)]),
    audioMode: z.enum(["device", "silent"])
  })
  .strict();

/** 电脑端音频监听设置校验规则。 */
const audioMonitorSettingsSchema = z
  .object({
    autoEnableOnLegacyAndroid: z.boolean(),
    volume: z.number().min(0).max(1)
  })
  .strict();

/** 镜像启动参数校验规则。 */
const startMirroringSchema = z
  .object({
    deviceSerial: z
      .string()
      .min(1)
      .max(256)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\s\u0000-\u001f]+$/),
    preset: recordingPresetSchema
  })
  .strict();

/** 镜像控制按键白名单。 */
const deviceControlKeySchema = z.enum([
  "back",
  "home",
  "power",
  "enter",
  "backspace",
  "delete",
  "tab",
  "arrow-up",
  "arrow-down",
  "arrow-left",
  "arrow-right",
  "move-home",
  "move-end",
  "page-up",
  "page-down",
  "a",
  "c",
  "x"
]);

/** 镜像控制命令校验规则。 */
const deviceControlCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("touch"),
      action: z.enum(["down", "move", "up", "cancel"]),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1)
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      horizontal: z.number().min(-16).max(16),
      vertical: z.number().min(-16).max(16)
    })
    .strict(),
  z
    .object({
      type: z.literal("key"),
      action: z.enum(["down", "up"]),
      key: deviceControlKeySchema,
      repeat: z.number().int().min(0).max(65_535),
      modifiers: z
        .object({
          shift: z.boolean(),
          alt: z.boolean(),
          ctrl: z.boolean()
        })
        .strict()
    })
    .strict(),
  z
    .object({
      type: z.literal("text"),
      text: z
        .string()
        .min(1)
        .refine((text) => Buffer.byteLength(text) <= (1 << 18) - 14)
    })
    .strict(),
  z.object({ type: z.literal("expand-notification-panel") }).strict(),
  z.object({ type: z.literal("collapse-notification-panel") }).strict()
]);

/** 应用设置校验规则。 */
const settingsSchema = z
  .object({
    preset: recordingPresetSchema,
    audioMonitor: audioMonitorSettingsSchema,
    recordingsDirectory: z
      .string()
      .min(1)
      .max(4_096)
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u001f]+$/)
  })
  .strict();

/** 渲染进程设置更新校验规则。 */
const settingsUpdateSchema = z
  .object({
    preset: recordingPresetSchema,
    audioMonitor: audioMonitorSettingsSchema
  })
  .strict();

/** 内部产物 ID 校验规则。 */
const artifactIdSchema = z.uuid();

/** 待删除内部产物 ID 数组校验规则。 */
const artifactIdsSchema = z
  .array(artifactIdSchema)
  .min(1)
  .max(500)
  .transform((ids) => [...new Set(ids)]);

/** 窗口动作校验规则。 */
const windowActionSchema = z.enum([
  "minimize",
  "maximize",
  "close",
  "open-devtools"
]);

/** 将未知值解析为录制预设。 */
export function parseRecordingPreset(value: unknown): RecordingPreset {
  /** 校验结果。 */
  const result = recordingPresetSchema.safeParse(value);

  if (!result.success) {
    throw new Error("录制预设无效");
  }

  return result.data;
}

/** 将未知值解析为开始镜像参数。 */
export function parseStartMirroringInput(value: unknown): {
  deviceSerial: string;
  preset: RecordingPreset;
} {
  /** 校验结果。 */
  const result = startMirroringSchema.safeParse(value);

  if (!result.success) {
    throw new Error("镜像参数无效");
  }

  return result.data;
}

/** 将未知值解析为受限设备控制命令。 */
export function parseDeviceControlCommand(
  value: unknown
): DeviceControlCommand {
  /** 校验结果。 */
  const result = deviceControlCommandSchema.safeParse(value);

  if (!result.success) {
    throw new Error("设备控制命令无效");
  }

  return result.data;
}

/** 将未知值解析为应用设置。 */
export function parseSettings(value: unknown): AppSettings {
  /** 校验结果。 */
  const result = settingsSchema.safeParse(value);

  if (!result.success) {
    throw new Error("应用设置无效");
  }

  return result.data;
}

/** 将未知值解析为渲染进程可修改的设置。 */
export function parseSettingsUpdate(value: unknown): AppSettingsUpdate {
  /** 校验结果。 */
  const result = settingsUpdateSchema.safeParse(value);

  if (!result.success) {
    throw new Error("应用设置无效");
  }

  return result.data;
}

/** 将未知值解析为内部产物 UUID。 */
export function parseArtifactId(value: unknown): string {
  /** 校验结果。 */
  const result = artifactIdSchema.safeParse(value);

  if (!result.success) {
    throw new Error("文件 ID 无效");
  }

  return result.data;
}

/** 将未知值解析为去重后的内部产物 UUID 数组。 */
export function parseArtifactIds(value: unknown): string[] {
  /** 校验结果。 */
  const result = artifactIdsSchema.safeParse(value);

  if (!result.success) {
    throw new Error("文件 ID 列表无效");
  }

  return result.data;
}

/** 将未知值解析为窗口控制动作。 */
export function parseWindowAction(value: unknown): WindowAction {
  /** 校验结果。 */
  const result = windowActionSchema.safeParse(value);

  if (!result.success) {
    throw new Error("窗口操作无效");
  }

  return result.data;
}
