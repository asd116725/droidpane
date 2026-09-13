/** @jest-environment node */

import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inspectMp4File,
  parseMp4Metadata
} from "../../src/main/files/mp4";

/** 创建 MP4 box。 */
function createBox(type: string, payload: Buffer): Buffer {
  /** MP4 box 头部。 */
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}

/** 创建 movie header box。 */
function createMovieHeader(): Buffer {
  /** version 0 的 mvhd 内容。 */
  const payload = Buffer.alloc(100);
  payload.writeUInt32BE(1_000, 12);
  payload.writeUInt32BE(138_000, 16);
  return createBox("mvhd", payload);
}

/** 创建带尺寸与媒体类型的 track box。 */
function createTrack(handler: "vide" | "soun", width = 0, height = 0): Buffer {
  /** version 0 的 tkhd 内容。 */
  const trackHeader = Buffer.alloc(84);
  trackHeader.writeUInt32BE(width * 65_536, 76);
  trackHeader.writeUInt32BE(height * 65_536, 80);
  /** hdlr 内容。 */
  const handlerPayload = Buffer.alloc(24);
  handlerPayload.write(handler, 8, 4, "ascii");
  /** media box。 */
  const media = createBox("mdia", createBox("hdlr", handlerPayload));

  return createBox(
    "trak",
    Buffer.concat([createBox("tkhd", trackHeader), media])
  );
}

describe("MP4 元数据读取", () => {
  it("从 moov 中读取时长、视频分辨率和音轨存在性", () => {
    /** 合成的 moov box。 */
    const movie = createBox(
      "moov",
      Buffer.concat([
        createMovieHeader(),
        createTrack("vide", 1080, 2400),
        createTrack("soun")
      ])
    );

    expect(parseMp4Metadata(movie)).toEqual({
      durationSeconds: 138,
      width: 1080,
      height: 2400,
      hasAudio: true
    });
  });

  it("拒绝没有可播放视频轨道或声明越界的 box", () => {
    /** 只有音轨的 moov box。 */
    const audioOnlyMovie = createBox(
      "moov",
      Buffer.concat([createMovieHeader(), createTrack("soun")])
    );
    /** 声明长度大于缓冲区的损坏 box。 */
    const truncatedMovie = Buffer.alloc(8);
    truncatedMovie.writeUInt32BE(128, 0);
    truncatedMovie.write("moov", 4, 4, "ascii");

    expect(() => parseMp4Metadata(audioOnlyMovie)).toThrow(
      "MP4 缺少可播放的视频轨道"
    );
    expect(() => parseMp4Metadata(truncatedMovie)).toThrow(
      "MP4 box 数据不完整"
    );
  });

  it("磁盘读取拒绝越界顶层 box 和超大 moov", async () => {
    /** 临时测试目录。 */
    const directory = await mkdtemp(
      path.join(tmpdir(), "adb-mp4-inspector-")
    );
    /** 声明越界的文件。 */
    const truncatedPath = path.join(directory, "truncated.mp4");
    /** 超过内存读取上限的稀疏 moov 文件。 */
    const oversizedPath = path.join(directory, "oversized.mp4");
    /** 越界顶层 box 头。 */
    const truncatedHeader = Buffer.alloc(8);
    truncatedHeader.writeUInt32BE(128, 0);
    truncatedHeader.write("moov", 4, 4, "ascii");
    /** 超大 moov 头。 */
    const oversizedHeader = Buffer.alloc(8);
    oversizedHeader.writeUInt32BE(64 * 1_024 * 1_024 + 1, 0);
    oversizedHeader.write("moov", 4, 4, "ascii");
    await writeFile(truncatedPath, truncatedHeader);
    await writeFile(oversizedPath, oversizedHeader);
    await truncate(oversizedPath, 64 * 1_024 * 1_024 + 1);

    try {
      await expect(inspectMp4File(truncatedPath)).rejects.toThrow(
        "MP4 顶层 box 数据不完整"
      );
      await expect(inspectMp4File(oversizedPath)).rejects.toThrow(
        "MP4 movie box 过大"
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
