import { open, stat, type FileHandle } from "node:fs/promises";

/** 允许读取到内存的最大 moov 大小。 */
const maximumMovieBoxSize = 64 * 1_024 * 1_024;

/** MP4 文件展示所需元数据。 */
export interface Mp4Metadata {
  /** 视频时长，单位秒。 */
  durationSeconds: number;
  /** 视频像素宽度。 */
  width: number;
  /** 视频像素高度。 */
  height: number;
  /** 是否存在音轨。 */
  hasAudio: boolean;
}

/** MP4 box 位置描述。 */
interface Mp4Box {
  /** 四字符 box 类型。 */
  type: string;
  /** box 起始偏移。 */
  start: number;
  /** box 内容起始偏移。 */
  payloadStart: number;
  /** box 结束偏移。 */
  end: number;
}

/** 安全读取 64 位无符号整数。 */
function readUInt64(buffer: Buffer, offset: number): number {
  /** 原始 64 位数值。 */
  const value = buffer.readBigUInt64BE(offset);

  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("MP4 box 长度超出安全范围");
  }

  return Number(value);
}

/** 读取指定范围内的直接子 box。 */
function readBoxes(buffer: Buffer, start = 0, end = buffer.length): Mp4Box[] {
  if (start < 0 || end > buffer.length || start > end) {
    throw new Error("MP4 box 范围无效");
  }

  /** 已解析的 box。 */
  const boxes: Mp4Box[] = [];
  /** 当前读取位置。 */
  let offset = start;

  while (offset + 8 <= end) {
    /** 32 位 box 大小。 */
    const size32 = buffer.readUInt32BE(offset);
    /** box 类型。 */
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    /** 是否使用扩展长度。 */
    const extended = size32 === 1;
    /** box 头部长度。 */
    const headerSize = extended ? 16 : 8;

    if (offset + headerSize > end) {
      throw new Error("MP4 box 头部不完整");
    }

    /** box 总长度。 */
    const size = size32 === 0 ? end - offset : extended
      ? readUInt64(buffer, offset + 8)
      : size32;

    if (
      !Number.isSafeInteger(size) ||
      size < headerSize ||
      offset + size > end
    ) {
      throw new Error("MP4 box 数据不完整");
    }

    boxes.push({
      type,
      start: offset,
      payloadStart: offset + headerSize,
      end: offset + size
    });
    offset += size;
  }

  if (offset !== end) {
    throw new Error("MP4 box 尾部数据不完整");
  }

  return boxes;
}

/** 从 movie header 中读取时长。 */
function readDuration(buffer: Buffer, box: Mp4Box): number {
  /** mvhd 版本。 */
  const version = buffer.readUInt8(box.payloadStart);

  if (version !== 0 && version !== 1) {
    throw new Error("MP4 movie header 版本不受支持");
  }

  /** 时间基准偏移。 */
  const timescaleOffset = box.payloadStart + (version === 1 ? 20 : 12);
  /** 时长偏移。 */
  const durationOffset = box.payloadStart + (version === 1 ? 24 : 16);

  if (durationOffset + (version === 1 ? 8 : 4) > box.end) {
    throw new Error("MP4 movie header 数据不完整");
  }

  /** 每秒时间单位。 */
  const timescale = buffer.readUInt32BE(timescaleOffset);
  /** 原始时长。 */
  const duration = version === 1
    ? readUInt64(buffer, durationOffset)
    : buffer.readUInt32BE(durationOffset);

  return timescale ? duration / timescale : 0;
}

/** 读取轨道媒体类型。 */
function readTrackHandler(buffer: Buffer, track: Mp4Box): string {
  /** 轨道直接子 box。 */
  const trackChildren = readBoxes(buffer, track.payloadStart, track.end);
  /** media box。 */
  const media = trackChildren.find((box) => box.type === "mdia");

  if (!media) {
    return "";
  }

  /** media 子 box。 */
  const mediaChildren = readBoxes(buffer, media.payloadStart, media.end);
  /** handler box。 */
  const handler = mediaChildren.find((box) => box.type === "hdlr");

  if (!handler || handler.payloadStart + 12 > handler.end) {
    return "";
  }

  return buffer.toString(
    "ascii",
    handler.payloadStart + 8,
    handler.payloadStart + 12
  );
}

/** 从视频轨道头读取像素尺寸。 */
function readVideoSize(
  buffer: Buffer,
  track: Mp4Box
): Pick<Mp4Metadata, "width" | "height"> {
  /** track header box。 */
  const header = readBoxes(buffer, track.payloadStart, track.end).find(
    (box) => box.type === "tkhd"
  );

  if (!header) {
    return { width: 0, height: 0 };
  }

  /** tkhd 版本。 */
  const version = buffer.readUInt8(header.payloadStart);

  if (version !== 0 && version !== 1) {
    throw new Error("MP4 track header 版本不受支持");
  }

  /** 16.16 定点尺寸偏移。 */
  const dimensionOffset = header.payloadStart + (version === 1 ? 88 : 76);

  if (dimensionOffset + 8 > header.end) {
    throw new Error("MP4 track header 数据不完整");
  }

  return {
    width: Math.round(buffer.readUInt32BE(dimensionOffset) / 65_536),
    height: Math.round(buffer.readUInt32BE(dimensionOffset + 4) / 65_536)
  };
}

/** 从包含 moov 的缓冲区读取 MP4 元数据。 */
export function parseMp4Metadata(buffer: Buffer): Mp4Metadata {
  /** 顶层 movie box。 */
  const movie = readBoxes(buffer).find((box) => box.type === "moov");

  if (!movie) {
    throw new Error("MP4 文件尚未完成封装");
  }

  /** movie 的直接子 box。 */
  const children = readBoxes(buffer, movie.payloadStart, movie.end);
  /** movie header box。 */
  const movieHeader = children.find((box) => box.type === "mvhd");
  /** 所有媒体轨道。 */
  const tracks = children.filter((box) => box.type === "trak");
  /** 视频轨道。 */
  const videoTrack = tracks.find(
    (track) => readTrackHandler(buffer, track) === "vide"
  );
  /** 视频像素尺寸。 */
  const size = videoTrack
    ? readVideoSize(buffer, videoTrack)
    : { width: 0, height: 0 };

  /** 已解析的 MP4 元数据。 */
  const metadata = {
    durationSeconds: movieHeader ? readDuration(buffer, movieHeader) : 0,
    ...size,
    hasAudio: tracks.some(
      (track) => readTrackHandler(buffer, track) === "soun"
    )
  };

  if (
    !Number.isFinite(metadata.durationSeconds) ||
    metadata.durationSeconds <= 0 ||
    metadata.width <= 0 ||
    metadata.height <= 0
  ) {
    throw new Error("MP4 缺少可播放的视频轨道");
  }

  return metadata;
}

/** 从指定位置完整读取缓冲区。 */
async function readExactly(
  file: FileHandle,
  buffer: Buffer,
  position: number
): Promise<void> {
  /** 已完成读取的字节数。 */
  let totalBytesRead = 0;

  while (totalBytesRead < buffer.length) {
    /** 本轮文件读取结果。 */
    const { bytesRead } = await file.read(
      buffer,
      totalBytesRead,
      buffer.length - totalBytesRead,
      position + totalBytesRead
    );

    if (bytesRead === 0) {
      throw new Error("MP4 文件数据不完整");
    }

    totalBytesRead += bytesRead;
  }
}

/** 从磁盘 MP4 的 moov box 读取元数据。 */
export async function inspectMp4File(filePath: string): Promise<
  Mp4Metadata & { sizeBytes: number }
> {
  /** 文件信息。 */
  const fileInfo = await stat(filePath);

  if (!Number.isSafeInteger(fileInfo.size) || fileInfo.size <= 0) {
    throw new Error("MP4 文件大小无效");
  }

  /** 打开的 MP4 文件。 */
  const file = await open(filePath, "r");
  /** 顶层 box 当前偏移。 */
  let offset = 0;

  try {
    while (offset + 8 <= fileInfo.size) {
      /** 顶层 box 基础头部。 */
      const header = Buffer.alloc(8);
      await readExactly(file, header, offset);
      /** 32 位 box 大小。 */
      const size32 = header.readUInt32BE(0);
      /** 顶层 box 类型。 */
      const type = header.toString("ascii", 4, 8);
      /** 是否使用扩展 box 长度。 */
      const extended = size32 === 1;
      /** 顶层 box 头部长度。 */
      const headerSize = extended ? 16 : 8;
      /** 扩展长度数据。 */
      const extendedSize = extended ? Buffer.alloc(8) : undefined;

      if (extendedSize) {
        await readExactly(file, extendedSize, offset + 8);
      }

      /** 顶层 box 总长度。 */
      const boxSize = extendedSize
        ? readUInt64(extendedSize, 0)
        : size32 === 0
          ? fileInfo.size - offset
          : size32;

      if (
        !Number.isSafeInteger(boxSize) ||
        boxSize < headerSize ||
        boxSize > fileInfo.size - offset
      ) {
        throw new Error("MP4 顶层 box 数据不完整");
      }

      if (type === "moov") {
        if (boxSize > maximumMovieBoxSize) {
          throw new Error("MP4 movie box 过大");
        }

        /** 完整 moov 数据。 */
        const movieBuffer = Buffer.alloc(boxSize);
        header.copy(movieBuffer, 0);
        extendedSize?.copy(movieBuffer, 8);
        await readExactly(
          file,
          movieBuffer.subarray(headerSize),
          offset + headerSize
        );
        return {
          ...parseMp4Metadata(movieBuffer),
          sizeBytes: fileInfo.size
        };
      }

      offset += boxSize;
    }
  } finally {
    await file.close();
  }

  throw new Error("MP4 文件尚未完成封装");
}
