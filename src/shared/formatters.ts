/** 左侧补零到两位。 */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 将秒数格式化为播放器时间。 */
export function formatDuration(totalSeconds: number): string {
  /** 去除小数后的总秒数。 */
  const seconds = Math.max(0, Math.floor(totalSeconds));
  /** 小时数。 */
  const hours = Math.floor(seconds / 3_600);
  /** 分钟数。 */
  const minutes = Math.floor((seconds % 3_600) / 60);
  /** 剩余秒数。 */
  const remainder = seconds % 60;

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(remainder)}`
    : `${pad(minutes)}:${pad(remainder)}`;
}

/** 将字节数格式化为易读文件大小。 */
export function formatFileSize(sizeBytes: number): string {
  if (sizeBytes === 0) {
    return "0 B";
  }

  /** 十进制文件大小单位名称。 */
  const units = ["B", "KB", "MB", "GB"];
  /** 最适合的单位索引。 */
  const unitIndex = Math.min(
    Math.floor(Math.log(sizeBytes) / Math.log(1_000)),
    units.length - 1
  );
  /** 换算后的数值。 */
  const value = sizeBytes / 1_000 ** unitIndex;

  return `${unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

/** 清理不适合跨平台文件名的字符。 */
export function sanitizeFileSegment(value: string): string {
  return value
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** 生成设备型号与本地时间组成的 MP4 文件名。 */
export function buildRecordingFileName(model: string, date: Date): string {
  /** 日期部分。 */
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  /** 时间部分。 */
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

  return `${sanitizeFileSegment(model)}_${day}_${time}.mp4`;
}
