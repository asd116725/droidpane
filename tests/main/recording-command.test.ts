import { resolveAudioPlan } from "../../src/main/recording/command";
import type { DeviceInfo } from "../../src/shared/types";

/** 创建指定 API 等级的测试设备。 */
function createDevice(apiLevel: number): DeviceInfo {
  return {
    serial: "3A261FDH2001234",
    model: "Pixel 8 Pro",
    androidVersion: apiLevel >= 33 ? "14" : "12",
    apiLevel,
    connectionType: "usb",
    status: "available"
  };
}

describe("scrcpy 录制命令", () => {
  it("Android 11 及以上启用设备音频", () => {
    expect(resolveAudioPlan(createDevice(31), "device")).toEqual({
      enabled: true
    });
  });

  it("Android 10 及以下自动降级为静音并给出原因", () => {
    expect(resolveAudioPlan(createDevice(29), "device")).toEqual({
      enabled: false,
      fallbackReason: "Android 10 及以下不支持设备音频，已自动改为静音录制"
    });
  });
});
