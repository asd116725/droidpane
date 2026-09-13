import type { DeviceInfo, RecordingPreset } from "../../shared/types";
import { resolveAudioPlan } from "../recording/command";

/** 固定配套的 scrcpy-server 版本。 */
export const scrcpyServerVersion = "4.1";

/** scrcpy-server 启动参数输入。 */
export interface ScrcpyServerArgumentOptions {
  /** 目标设备。 */
  device: DeviceInfo;
  /** 当前录制预设。 */
  preset: RecordingPreset;
  /** 本次会话随机 ID。 */
  scid: number;
  /** 设备端 Server JAR 路径。 */
  remoteServerPath: string;
}

/** 分辨率对应的最大边。 */
const maxSizeMap = {
  "720p": 720,
  "1080p": 1080
} as const;

/** 后台恢复预览使用的关键帧间隔，单位秒。 */
const previewRecoveryKeyFrameIntervalSeconds = 1;

/** 将会话 ID 格式化为 scrcpy 使用的八位十六进制。 */
export function formatScrcpyScid(scid: number): string {
  return scid.toString(16).padStart(8, "0");
}

/** 构造设备端抽象 Socket 名称。 */
export function buildScrcpySocketName(scid: number): string {
  return `scrcpy_${formatScrcpyScid(scid)}`;
}

/** 构造支持镜像控制的 scrcpy-server 4.1 参数。 */
export function buildScrcpyServerArguments(
  options: ScrcpyServerArgumentOptions
): string[] {
  /** 音频采集方案。 */
  const audioPlan = resolveAudioPlan(
    options.device,
    options.preset.audioMode
  );
  /** 音频服务端参数。 */
  const audioArguments = audioPlan.enabled
    ? [
        "audio_codec=aac",
        ...(options.device.apiLevel >= 33
          ? ["audio_source=playback", "audio_dup=true"]
          : [])
      ]
    : ["audio=false"];
  /** 最大边参数。 */
  const resolutionArguments =
    options.preset.resolution === "original"
      ? []
      : [`max_size=${maxSizeMap[options.preset.resolution]}`];

  return [
    "-s",
    options.device.serial,
    "shell",
    `CLASSPATH=${options.remoteServerPath}`,
    "app_process",
    "/",
    "com.genymobile.scrcpy.Server",
    scrcpyServerVersion,
    `scid=${formatScrcpyScid(options.scid)}`,
    "log_level=warn",
    `video_bit_rate=${options.preset.videoBitrateMbps * 1_000_000}`,
    `video_codec_options=i-frame-interval=${previewRecoveryKeyFrameIntervalSeconds}`,
    ...audioArguments,
    ...resolutionArguments,
    "tunnel_forward=true",
    "control=true",
    "clipboard_autosync=false"
  ];
}
