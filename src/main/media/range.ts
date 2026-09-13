/** 单一 HTTP 字节范围。 */
export interface ByteRange {
  /** 首字节位置。 */
  start: number;
  /** 末字节位置。 */
  end: number;
}

/** 解析单段 HTTP Range 请求。 */
export function parseByteRange(
  header: string,
  fileSize: number
): ByteRange | null {
  /** 单段 bytes 范围匹配。 */
  const match = header.match(/^bytes=(\d*)-(\d*)$/);

  if (!match || (!match[1] && !match[2])) {
    return null;
  }

  if (!match[1]) {
    /** 请求的末尾字节数量。 */
    const suffixLength = Number(match[2]);
    return suffixLength > 0
      ? {
          start: Math.max(0, fileSize - suffixLength),
          end: fileSize - 1
        }
      : null;
  }

  /** 请求起始位置。 */
  const start = Number(match[1]);
  /** 请求结束位置。 */
  const end = match[2]
    ? Math.min(Number(match[2]), fileSize - 1)
    : fileSize - 1;

  return start < fileSize && start <= end ? { start, end } : null;
}
