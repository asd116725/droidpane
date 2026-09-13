/** @jest-environment node */

import {
  parseAacConfig,
  parseAvcCodecString,
  ScrcpyMp4Muxer
} from "../../src/main/recording/muxer";

describe("录制 Codec 配置解析", () => {
  it("从 Annex B SPS 生成 AVC Codec String", () => {
    /** High Profile Level 3.1 SPS。 */
    const config = Buffer.from([
      0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f,
      0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80
    ]);

    expect(parseAvcCodecString(config)).toBe("avc1.64001f");
  });

  it("解析 AAC-LC 48 kHz 双声道配置", () => {
    expect(parseAacConfig(Buffer.from([0x11, 0x90]))).toEqual({
      codec: "mp4a.40.2",
      sampleRate: 48_000,
      numberOfChannels: 2
    });
  });

  it("拒绝缺少 SPS 或不完整的音频配置", () => {
    expect(() => parseAvcCodecString(Buffer.from([0, 0, 0, 1, 0x65])))
      .toThrow("H.264 配置中缺少有效 SPS");
    expect(() => parseAacConfig(Buffer.from([0x11]))).toThrow(
      "AAC 配置数据不完整"
    );
  });

  it("录制包合并配置，实时预览只接收纯视频帧", async () => {
    /** High Profile Level 3.1 SPS/PPS。 */
    const config = Buffer.from([
      0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f,
      0, 0, 0, 1, 0x68, 0xee, 0x3c, 0x80
    ]);
    /** 不含配置的 IDR 帧。 */
    const frame = Buffer.from([0, 0, 0, 1, 0x65, 0x88]);
    /** 预览视频包回调。 */
    const onVideoPacket = jest.fn();
    /** 不启动音轨前不会创建实际输出文件的封装器。 */
    const muxer = new ScrcpyMp4Muxer("/tmp/unused-preview-test.mp4", true, {
      onVideoPacket
    });

    await muxer.handleVideoEvent({
      type: "session",
      width: 480,
      height: 640,
      clientResized: false
    });
    await muxer.handleVideoEvent({
      type: "packet",
      ptsUs: 0,
      config: true,
      keyFrame: false,
      data: config
    });
    await muxer.handleVideoEvent({
      type: "packet",
      ptsUs: 1_000_000,
      config: false,
      keyFrame: true,
      data: frame
    });

    expect(onVideoPacket).toHaveBeenCalledWith({
      ptsUs: 1_000_000,
      keyFrame: true,
      data: frame
    });
    await muxer.cancel();
  });

  it("把 AAC 配置和编码包旁路给监听且不改变原始字节", async () => {
    /** AAC-LC 48 kHz 双声道配置。 */
    const config = Buffer.from([0x11, 0x90]);
    /** 原始 AAC 编码包。 */
    const frame = Buffer.from([0x21, 0x10, 0x56, 0xe5]);
    /** 监听配置回调。 */
    const onAudioConfig = jest.fn();
    /** 监听编码包回调。 */
    const onAudioPacket = jest.fn();
    /** 不启动视频轨道便不会创建实际输出文件。 */
    const muxer = new ScrcpyMp4Muxer("/tmp/unused-audio-monitor-test.mp4", true, {
      onAudioConfig,
      onAudioPacket
    });

    await muxer.handleAudioEvent({
      type: "packet",
      ptsUs: 0,
      config: true,
      keyFrame: false,
      data: config
    });
    await muxer.handleAudioEvent({
      type: "packet",
      ptsUs: 1_000_000,
      config: false,
      keyFrame: true,
      data: frame
    });

    expect(onAudioConfig).toHaveBeenCalledWith(config, {
      codec: "mp4a.40.2",
      sampleRate: 48_000,
      numberOfChannels: 2
    });
    expect(onAudioPacket).toHaveBeenCalledWith({
      ptsUs: 1_000_000,
      data: frame
    });
    await muxer.cancel();
  });

  it("监听回调异常不会中断录制音频封装", async () => {
    /** 模拟监听模块内部故障的封装器。 */
    const muxer = new ScrcpyMp4Muxer("/tmp/unused-audio-isolation-test.mp4", true, {
      onAudioConfig: () => {
        throw new Error("监听初始化失败");
      },
      onAudioPacket: () => {
        throw new Error("监听播放失败");
      }
    });

    await expect(
      muxer.handleAudioEvent({
        type: "packet",
        ptsUs: 0,
        config: true,
        keyFrame: false,
        data: Buffer.from([0x11, 0x90])
      })
    ).resolves.toBeUndefined();
    await expect(
      muxer.handleAudioEvent({
        type: "packet",
        ptsUs: 1_000_000,
        config: false,
        keyFrame: true,
        data: Buffer.from([0x21, 0x10])
      })
    ).resolves.toBeUndefined();
    await muxer.cancel();
  });
});
