/** @jest-environment node */

import {
  buildScrcpyServerArguments,
  buildScrcpySocketName
} from "../../src/main/scrcpy/server-options";
import type { DeviceInfo, RecordingPreset } from "../../src/shared/types";

/** 默认录制预设。 */
const preset: RecordingPreset = {
  resolution: "1080p",
  videoBitrateMbps: 8,
  audioMode: "device"
};

/** 创建指定 API 等级的设备。 */
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

describe("scrcpy 4.1 服务端参数", () => {
  it("Android 13+ 使用单路 H.264、AAC playback 和独立控制通道", () => {
    expect(
      buildScrcpyServerArguments({
        device: createDevice(34),
        preset,
        scid: 0x19fb6c9,
        remoteServerPath: "/data/local/tmp/droidpane-server.jar"
      })
    ).toEqual([
      "-s",
      "3A261FDH2001234",
      "shell",
      "CLASSPATH=/data/local/tmp/droidpane-server.jar",
      "app_process",
      "/",
      "com.genymobile.scrcpy.Server",
      "4.1",
      "scid=019fb6c9",
      "log_level=warn",
      "video_bit_rate=8000000",
      "video_codec_options=i-frame-interval=1",
      "audio_codec=aac",
      "audio_source=playback",
      "audio_dup=true",
      "max_size=1080",
      "tunnel_forward=true",
      "control=true",
      "clipboard_autosync=false"
    ]);
    expect(buildScrcpySocketName(0x19fb6c9)).toBe("scrcpy_019fb6c9");
  });

  it("Android 10 及以下关闭音频且原始分辨率不传 max_size", () => {
    expect(
      buildScrcpyServerArguments({
        device: createDevice(29),
        preset: { ...preset, resolution: "original" },
        scid: 1,
        remoteServerPath: "/data/local/tmp/server.jar"
      })
    ).toContain("audio=false");
    expect(
      buildScrcpyServerArguments({
        device: createDevice(29),
        preset: { ...preset, resolution: "original" },
        scid: 1,
        remoteServerPath: "/data/local/tmp/server.jar"
      }).some((argument) => argument.startsWith("max_size="))
    ).toBe(false);
  });
});
