import type {
  DeviceInfo,
  RecordingAudioMode
} from "../../shared/types";

/** 音频参数与降级结果。 */
export interface AudioPlan {
  /** 是否采集设备音频。 */
  enabled: boolean;
  /** 自动降级的面向用户说明。 */
  fallbackReason?: string;
}

/** 根据系统版本决定音频源与降级行为。 */
export function resolveAudioPlan(
  device: DeviceInfo,
  audioMode: RecordingAudioMode
): AudioPlan {
  if (audioMode === "silent") {
    return { enabled: false };
  }

  if (device.apiLevel <= 29) {
    return {
      enabled: false,
      fallbackReason: "Android 10 及以下不支持设备音频，已自动改为静音录制"
    };
  }

  return { enabled: true };
}
