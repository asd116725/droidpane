import {
  buildRecordingFileName,
  formatDuration,
  formatFileSize,
  sanitizeFileSegment
} from "../../src/shared/formatters";

describe("录制信息格式化", () => {
  it("将秒数稳定格式化为播放器时间", () => {
    expect(formatDuration(138)).toBe("02:18");
    expect(formatDuration(3_725)).toBe("1:02:05");
  });

  it("按可读单位显示文件大小", () => {
    expect(formatFileSize(48_600_000)).toBe("48.6 MB");
    expect(formatFileSize(0)).toBe("0 B");
  });

  it("清理跨平台文件名中的非法字符", () => {
    expect(sanitizeFileSegment("Pixel 8 Pro:/测试")).toBe("Pixel_8_Pro_测试");
  });

  it("生成包含设备型号和本地时间的 MP4 文件名", () => {
    /** 固定测试时间。 */
    const date = new Date(2026, 6, 31, 14, 32, 8);

    expect(buildRecordingFileName("Pixel 8 Pro", date)).toBe(
      "Pixel_8_Pro_2026-07-31_143208.mp4"
    );
  });
});
