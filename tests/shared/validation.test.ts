import {
  parseArtifactId,
  parseArtifactIds,
  parseDeviceControlCommand,
  parseRecordingPreset,
  parseSettingsUpdate,
  parseStartMirroringInput,
  parseWindowAction
} from "../../src/shared/validation";

describe("IPC 参数校验", () => {
  it("接受受限的镜像设备序列号与录制预设", () => {
    expect(
      parseStartMirroringInput({
        deviceSerial: "192.168.1.20:5555",
        preset: {
          resolution: "1080p",
          videoBitrateMbps: 8,
          audioMode: "device"
        }
      })
    ).toEqual({
      deviceSerial: "192.168.1.20:5555",
      preset: {
        resolution: "1080p",
        videoBitrateMbps: 8,
        audioMode: "device"
      }
    });
  });

  it("镜像启动使用录制预设安全边界", () => {
    expect(
      parseStartMirroringInput({
        deviceSerial: "SERIAL",
        preset: {
          resolution: "720p",
          videoBitrateMbps: 4,
          audioMode: "silent"
        }
      })
    ).toMatchObject({ deviceSerial: "SERIAL" });
    expect(() =>
      parseStartMirroringInput({
        deviceSerial: "SERIAL\ninvalid",
        preset: {
          resolution: "720p",
          videoBitrateMbps: 4,
          audioMode: "silent"
        }
      })
    ).toThrow("镜像参数无效");
  });

  it("只接受白名单设备控制、有限坐标和文本长度", () => {
    expect(
      parseDeviceControlCommand({
        type: "touch",
        action: "move",
        x: 0.25,
        y: 0.75
      })
    ).toEqual({ type: "touch", action: "move", x: 0.25, y: 0.75 });
    expect(
      parseDeviceControlCommand({ type: "expand-notification-panel" })
    ).toEqual({ type: "expand-notification-panel" });
    expect(
      parseDeviceControlCommand({ type: "collapse-notification-panel" })
    ).toEqual({ type: "collapse-notification-panel" });
    expect(() =>
      parseDeviceControlCommand({
        type: "touch",
        action: "move",
        x: 1.1,
        y: 0.75
      })
    ).toThrow("设备控制命令无效");
    expect(() =>
      parseDeviceControlCommand({ type: "rotate" })
    ).toThrow("设备控制命令无效");
    expect(() =>
      parseDeviceControlCommand({
        type: "key",
        action: "down",
        key: "app-switch",
        repeat: 0,
        modifiers: { shift: false, alt: false, ctrl: false }
      })
    ).toThrow("设备控制命令无效");
    expect(() =>
      parseDeviceControlCommand({
        type: "key",
        action: "down",
        key: "shell",
        repeat: 0,
        modifiers: { shift: false, alt: false, ctrl: false }
      })
    ).toThrow("设备控制命令无效");
    expect(() =>
      parseDeviceControlCommand({
        type: "text",
        text: "a".repeat(1 << 18)
      })
    ).toThrow("设备控制命令无效");
  });

  it("拒绝换行序列号与未开放的码率", () => {
    expect(() =>
      parseStartMirroringInput({
        deviceSerial: "device\nshell",
        preset: {
          resolution: "1080p",
          videoBitrateMbps: 12,
          audioMode: "device"
        }
      })
    ).toThrow("镜像参数无效");
  });

  it("只接受公开档位与 UUID 产物 ID", () => {
    expect(() =>
      parseRecordingPreset({
        resolution: "4k",
        videoBitrateMbps: 8,
        audioMode: "device"
      })
    ).toThrow("录制预设无效");
    expect(() => parseArtifactId("../../secret")).toThrow("文件 ID 无效");
  });

  it("删除文件 ID 数组必须有效且返回去重结果", () => {
    /** 两个合法的会话 UUID。 */
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";

    expect(parseArtifactIds([firstId, secondId, firstId])).toEqual([
      firstId,
      secondId
    ]);
    expect(() => parseArtifactIds([])).toThrow("文件 ID 列表无效");
    expect(() => parseArtifactIds([firstId, "../../secret"])).toThrow(
      "文件 ID 列表无效"
    );
    expect(() => parseArtifactIds(firstId)).toThrow("文件 ID 列表无效");
  });

  it("只接受受限窗口操作并允许打开开发者控制台", () => {
    expect(parseWindowAction("open-devtools")).toBe("open-devtools");
    expect(() => parseWindowAction("reload")).toThrow("窗口操作无效");
  });

  it("设置更新拒绝渲染进程直接提交文件路径", () => {
    expect(() =>
      parseSettingsUpdate({
        preset: {
          resolution: "1080p",
          videoBitrateMbps: 8,
          audioMode: "device"
        },
        audioMonitor: {
          autoEnableOnLegacyAndroid: false,
          volume: 0.8
        },
        recordingsDirectory: "/tmp/injected"
      })
    ).toThrow("应用设置无效");
  });

  it("监听设置只接受布尔开关与零到一的音量", () => {
    expect(
      parseSettingsUpdate({
        preset: {
          resolution: "1080p",
          videoBitrateMbps: 8,
          audioMode: "device"
        },
        audioMonitor: {
          autoEnableOnLegacyAndroid: true,
          volume: 0.45
        }
      })
    ).toEqual({
      preset: {
        resolution: "1080p",
        videoBitrateMbps: 8,
        audioMode: "device"
      },
      audioMonitor: {
        autoEnableOnLegacyAndroid: true,
        volume: 0.45
      }
    });
    expect(() =>
      parseSettingsUpdate({
        preset: {
          resolution: "1080p",
          videoBitrateMbps: 8,
          audioMode: "device"
        },
        audioMonitor: {
          autoEnableOnLegacyAndroid: false,
          volume: 1.1
        }
      })
    ).toThrow("应用设置无效");
  });
});
