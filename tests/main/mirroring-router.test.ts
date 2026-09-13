/** @jest-environment node */

import {
  ScrcpyMediaRouter,
  type MirrorPreviewPublisher
} from "../../src/main/mirroring/router";
import type { RecordingMuxer } from "../../src/main/recording/service";

/** 可解析 Codec String 的 H.264 SPS/PPS 配置。 */
const videoConfig = Buffer.from([
  0x00,
  0x00,
  0x00,
  0x01,
  0x67,
  0x64,
  0x00,
  0x1f,
  0x00,
  0x00,
  0x00,
  0x01,
  0x68,
  0xee,
  0x3c,
  0x80
]);

/** 创建实时预览发布器桩。 */
function createPreview(): jest.Mocked<MirrorPreviewPublisher> {
  return {
    publishSession: jest.fn(),
    publishConfig: jest.fn(),
    publishPacket: jest.fn(),
    publishAudioConfig: jest.fn(),
    publishAudioPacket: jest.fn()
  };
}

/** 创建录制封装器桩。 */
function createMuxer(): jest.Mocked<RecordingMuxer> {
  return {
    handleVideoEvent: jest.fn().mockResolvedValue(undefined),
    handleAudioEvent: jest.fn().mockResolvedValue(undefined),
    finalize: jest.fn().mockResolvedValue({ hasAudio: true }),
    cancel: jest.fn().mockResolvedValue(undefined)
  };
}

describe("镜像媒体路由", () => {
  it("持续发布预览，并从下一关键帧开始挂载录制器", async () => {
    /** 实时预览发布器。 */
    const preview = createPreview();
    /** 媒体路由。 */
    const router = new ScrcpyMediaRouter(preview);
    /** 本次 MP4 封装器。 */
    const muxer = createMuxer();

    await router.handleVideoEvent({
      type: "session",
      width: 1080,
      height: 2400,
      clientResized: false
    });
    await router.handleVideoEvent({
      type: "packet",
      ptsUs: 0,
      config: true,
      keyFrame: false,
      data: videoConfig
    });
    await router.handleAudioEvent({
      type: "packet",
      ptsUs: 0,
      config: true,
      keyFrame: false,
      data: Buffer.from([0x11, 0x90])
    });
    /** 等待下一关键帧的挂载任务。 */
    const attached = router.attachRecorder(muxer);
    await router.handleVideoEvent({
      type: "packet",
      ptsUs: 900_000,
      config: false,
      keyFrame: false,
      data: Buffer.from([0x41])
    });

    expect(muxer.handleVideoEvent).not.toHaveBeenCalled();
    await router.handleVideoEvent({
      type: "packet",
      ptsUs: 1_000_000,
      config: false,
      keyFrame: true,
      data: Buffer.from([0x65])
    });

    await expect(attached).resolves.toBe(1_000_000);
    expect(muxer.handleVideoEvent.mock.calls.map(([event]) => event)).toEqual([
      {
        type: "session",
        width: 1080,
        height: 2400,
        clientResized: false
      },
      {
        type: "packet",
        ptsUs: 0,
        config: true,
        keyFrame: false,
        data: videoConfig
      },
      {
        type: "packet",
        ptsUs: 1_000_000,
        config: false,
        keyFrame: true,
        data: Buffer.from([0x65])
      }
    ]);
    expect(muxer.handleAudioEvent).toHaveBeenCalledWith({
      type: "packet",
      ptsUs: 0,
      config: true,
      keyFrame: false,
      data: Buffer.from([0x11, 0x90])
    });
    expect(preview.publishPacket).toHaveBeenCalledTimes(2);
    expect(preview.publishConfig).toHaveBeenCalledWith(
      videoConfig,
      "avc1.64001f"
    );
  });

  it("摘除后镜像不断流，并可再次挂载新录制器", async () => {
    /** 实时预览发布器。 */
    const preview = createPreview();
    /** 媒体路由。 */
    const router = new ScrcpyMediaRouter(preview);
    /** 两次录制封装器。 */
    const first = createMuxer();
    const second = createMuxer();

    await router.handleVideoEvent({
      type: "session",
      width: 720,
      height: 1280,
      clientResized: false
    });
    await router.handleVideoEvent({
      type: "packet",
      ptsUs: 0,
      config: true,
      keyFrame: false,
      data: videoConfig
    });
    const firstAttached = router.attachRecorder(first);
    await router.handleVideoEvent({
      type: "packet",
      ptsUs: 1_000_000,
      config: false,
      keyFrame: true,
      data: Buffer.from([0x65, 0x01])
    });
    await firstAttached;
    router.detachRecorder(first);
    await router.handleVideoEvent({
      type: "packet",
      ptsUs: 1_100_000,
      config: false,
      keyFrame: false,
      data: Buffer.from([0x41])
    });

    expect(first.handleVideoEvent).toHaveBeenCalledTimes(3);
    /** 第二次挂载任务。 */
    const secondAttached = router.attachRecorder(second);
    await router.handleVideoEvent({
      type: "packet",
      ptsUs: 2_000_000,
      config: false,
      keyFrame: true,
      data: Buffer.from([0x65, 0x02])
    });

    await expect(secondAttached).resolves.toBe(2_000_000);
    expect(second.handleVideoEvent).toHaveBeenCalledTimes(3);
    expect(preview.publishPacket).toHaveBeenCalledTimes(3);
  });

  it("取消等待或会话结束时拒绝尚未挂载的录制", async () => {
    /** 媒体路由。 */
    const router = new ScrcpyMediaRouter(createPreview());
    /** 等待关键帧的录制器。 */
    const first = createMuxer();
    const cancelled = router.attachRecorder(first);
    router.detachRecorder(first);
    await expect(cancelled).rejects.toThrow("录制启动已取消");

    /** 会话结束前仍在等待的录制器。 */
    const second = createMuxer();
    const ended = router.attachRecorder(second);
    router.end(new Error("设备已断开连接"));
    await expect(ended).rejects.toThrow("设备已断开连接");
  });
});
