/** @jest-environment node */

describe("实时预览 Worker", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete (globalThis as any).VideoDecoder;
    delete (globalThis as any).EncodedVideoChunk;
    delete (globalThis as any).AudioDecoder;
    delete (globalThis as any).EncodedAudioChunk;
    delete (globalThis as any).onmessage;
    delete (globalThis as any).postMessage;
  });

  it("初始化解码器并在窗口隐藏后持续绘制视频帧", async () => {
    /** Worker 状态消息。 */
    const postMessage = jest.fn();
    /** 画布绘制函数。 */
    const drawImage = jest.fn();
    /** 解码后的测试帧。 */
    const frame = { close: jest.fn() } as unknown as VideoFrame;

    /** WebCodecs 解码器桩。 */
    class FakeVideoDecoder {
      /** 最近创建的解码器。 */
      static current: FakeVideoDecoder;
      /** 当前排队包数量。 */
      decodeQueueSize = 0;
      /** 解码配置函数。 */
      configure = jest.fn();
      /** 关闭解码器。 */
      close = jest.fn();

      /** 保存输出回调。 */
      constructor(
        private readonly init: {
          output(value: VideoFrame): void;
          error(value: DOMException): void;
        }
      ) {
        FakeVideoDecoder.current = this;
      }

      /** 立即输出一个测试帧。 */
      decode(): void {
        this.init.output(frame);
      }
    }

    /** 编码视频包桩。 */
    class FakeEncodedVideoChunk {
      /** 保存 WebCodecs 构造参数。 */
      constructor(readonly init: EncodedVideoChunkInit) {}
    }

    (globalThis as any).postMessage = postMessage;
    (globalThis as any).VideoDecoder = FakeVideoDecoder;
    (globalThis as any).EncodedVideoChunk = FakeEncodedVideoChunk;
    await import("../../src/renderer/live-preview-worker");

    /** Worker 页面命令入口。 */
    const handleCommand = (globalThis as any).onmessage as (
      event: MessageEvent
    ) => void;
    /** 主进程媒体端口桩。 */
    const port = {
      postMessage: jest.fn(),
      start: jest.fn(),
      close: jest.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null
    };
    /** 离屏画布桩。 */
    const canvas = {
      width: 0,
      height: 0,
      getContext: jest.fn(() => ({ drawImage }))
    };

    handleCommand({
      data: { type: "connect", port }
    } as unknown as MessageEvent);
    handleCommand({
      data: { type: "canvas", canvas }
    } as unknown as MessageEvent);
    port.onmessage?.({
      data: { type: "session", width: 480, height: 640 }
    } as MessageEvent);
    port.onmessage?.({
      data: {
        type: "config",
        codec: "avc1.64001f",
        data: Uint8Array.from([0, 0, 1, 0x67]).buffer
      }
    } as MessageEvent);
    port.onmessage?.({
      data: {
        type: "packet",
        sequence: 1,
        ptsUs: 1_000_000,
        keyFrame: true,
        data: Uint8Array.from([0, 0, 1, 0x65]).buffer
      }
    } as MessageEvent);
    jest.runOnlyPendingTimers();

    expect(canvas).toMatchObject({ width: 480, height: 640 });
    expect(postMessage).toHaveBeenCalledWith({
      type: "size",
      width: 480,
      height: 640
    });
    expect(FakeVideoDecoder.current.configure).toHaveBeenCalledWith({
      codec: "avc1.64001f",
      codedWidth: 480,
      codedHeight: 640,
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware"
    });
    expect(drawImage).toHaveBeenCalledWith(frame, 0, 0, 480, 640);
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "consumed",
      sequence: 1
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: "status",
      status: "live",
      message: undefined
    });

    handleCommand({
      data: { type: "visibility", visible: false }
    } as unknown as MessageEvent);
    port.onmessage?.({
      data: {
        type: "packet",
        sequence: 2,
        ptsUs: 1_033_333,
        keyFrame: false,
        data: Uint8Array.from([0, 0, 1, 0x41]).buffer
      }
    } as MessageEvent);
    jest.runOnlyPendingTimers();

    expect(drawImage).toHaveBeenCalledTimes(2);
    expect(FakeVideoDecoder.current.configure).toHaveBeenCalledTimes(1);
    expect(FakeVideoDecoder.current.close).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenLastCalledWith({
      type: "consumed",
      sequence: 2
    });
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "paused" })
    );
  });

  it("WebCodecs 不可用时重试仍保持不可用并停止上游投递", async () => {
    /** Worker 状态消息。 */
    const postMessage = jest.fn();
    (globalThis as any).postMessage = postMessage;
    await import("../../src/renderer/live-preview-worker");

    /** Worker 页面命令入口。 */
    const handleCommand = (globalThis as any).onmessage as (
      event: MessageEvent
    ) => void;
    /** 主进程媒体端口桩。 */
    const port = {
      postMessage: jest.fn(),
      start: jest.fn(),
      close: jest.fn(),
      onmessage: null
    };
    /** 可创建 2D Context 的离屏画布。 */
    const canvas = {
      width: 0,
      height: 0,
      getContext: jest.fn(() => ({ drawImage: jest.fn() }))
    };

    handleCommand({ data: { type: "connect", port } } as unknown as MessageEvent);
    handleCommand({ data: { type: "canvas", canvas } } as unknown as MessageEvent);
    handleCommand({ data: { type: "retry" } } as unknown as MessageEvent);

    expect(postMessage).toHaveBeenLastCalledWith({
      type: "status",
      status: "unavailable",
      message: "当前系统不支持 WebCodecs 实时预览"
    });
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "connecting" })
    );
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "visibility",
      visible: false
    });
  });

  it("解码器配置失败时关闭预览上游但保留消费确认", async () => {
    /** Worker 状态消息。 */
    const postMessage = jest.fn();
    /** 配置阶段失败的 WebCodecs 解码器。 */
    class FailingVideoDecoder {
      /** 无待解码包。 */
      decodeQueueSize = 0;
      /** 创建解码器。 */
      constructor() {}
      /** 模拟硬件解码器拒绝配置。 */
      configure(): void {
        throw new Error("不支持该 H.264 Profile");
      }
      /** 未进入实际解码。 */
      decode(): void {}
      /** 关闭失败解码器。 */
      close(): void {}
    }
    (globalThis as any).postMessage = postMessage;
    (globalThis as any).VideoDecoder = FailingVideoDecoder;
    (globalThis as any).EncodedVideoChunk = class {};
    await import("../../src/renderer/live-preview-worker");

    /** Worker 页面命令入口。 */
    const handleCommand = (globalThis as any).onmessage as (
      event: MessageEvent
    ) => void;
    /** 主进程媒体端口桩。 */
    const port = {
      postMessage: jest.fn(),
      start: jest.fn(),
      close: jest.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null
    };
    handleCommand({ data: { type: "connect", port } } as unknown as MessageEvent);
    handleCommand({
      data: {
        type: "canvas",
        canvas: {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage: jest.fn() })
        }
      }
    } as unknown as MessageEvent);
    port.onmessage?.({
      data: { type: "session", width: 480, height: 640 }
    } as MessageEvent);
    port.onmessage?.({
      data: {
        type: "config",
        codec: "avc1.64001f",
        data: Uint8Array.from([0, 0, 1, 0x67]).buffer
      }
    } as MessageEvent);
    port.onmessage?.({
      data: {
        type: "packet",
        sequence: 9,
        ptsUs: 1_000_000,
        keyFrame: true,
        data: Uint8Array.from([0, 0, 1, 0x65]).buffer
      }
    } as MessageEvent);

    expect(postMessage).toHaveBeenLastCalledWith({
      type: "status",
      status: "unavailable",
      message: "实时预览不可用：不支持该 H.264 Profile"
    });
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "visibility",
      visible: false
    });
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "consumed",
      sequence: 9
    });
  });

  it("监听开启后解码 AAC，窗口隐藏时仍持续消费音频", async () => {
    /** Worker 页面消息。 */
    const postMessage = jest.fn();
    /** 已输出的 AudioData。 */
    const audioData = { close: jest.fn() } as unknown as AudioData;
    /** WebCodecs 音频解码器桩。 */
    class FakeAudioDecoder {
      /** 最近创建的解码器。 */
      static current: FakeAudioDecoder;
      /** 当前排队包数量。 */
      decodeQueueSize = 0;
      /** 解码配置函数。 */
      configure = jest.fn();
      /** 关闭解码器。 */
      close = jest.fn();
      /** 解码 AAC 并立即输出。 */
      decode = jest.fn(() => this.init.output(audioData));

      /** 保存输出回调。 */
      constructor(
        private readonly init: {
          output(value: AudioData): void;
          error(value: DOMException): void;
        }
      ) {
        FakeAudioDecoder.current = this;
      }
    }
    /** 编码音频包桩。 */
    class FakeEncodedAudioChunk {
      /** 保存 WebCodecs 构造参数。 */
      constructor(readonly init: EncodedAudioChunkInit) {}
    }
    (globalThis as any).postMessage = postMessage;
    (globalThis as any).VideoDecoder = class {};
    (globalThis as any).AudioDecoder = FakeAudioDecoder;
    (globalThis as any).EncodedAudioChunk = FakeEncodedAudioChunk;
    await import("../../src/renderer/live-preview-worker");

    /** Worker 页面命令入口。 */
    const handleCommand = (globalThis as any).onmessage as (
      event: MessageEvent
    ) => void;
    /** 主进程媒体端口桩。 */
    const port = {
      postMessage: jest.fn(),
      start: jest.fn(),
      close: jest.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null
    };
    handleCommand({ data: { type: "connect", port } } as unknown as MessageEvent);
    handleCommand({
      data: { type: "audio-monitor", enabled: true }
    } as unknown as MessageEvent);
    port.onmessage?.({
      data: {
        type: "audio-config",
        codec: "mp4a.40.2",
        sampleRate: 48_000,
        numberOfChannels: 2,
        description: Uint8Array.from([0x11, 0x90]).buffer
      }
    } as MessageEvent);
    port.onmessage?.({
      data: {
        type: "audio-packet",
        sequence: 1,
        ptsUs: 1_000_000,
        data: Uint8Array.from([0x21, 0x10]).buffer
      }
    } as MessageEvent);
    handleCommand({
      data: { type: "visibility", visible: false }
    } as unknown as MessageEvent);
    port.onmessage?.({
      data: {
        type: "audio-packet",
        sequence: 2,
        ptsUs: 1_021_333,
        data: Uint8Array.from([0x21, 0x11]).buffer
      }
    } as MessageEvent);

    expect(FakeAudioDecoder.current.configure).toHaveBeenCalledWith({
      codec: "mp4a.40.2",
      sampleRate: 48_000,
      numberOfChannels: 2,
      description: Uint8Array.from([0x11, 0x90])
    });
    expect(FakeAudioDecoder.current.decode).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledWith(
      { type: "audio-data", data: audioData },
      [audioData]
    );
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "audio-consumed",
      sequence: 2
    });
    expect(port.postMessage).not.toHaveBeenCalledWith({
      type: "audio-monitor",
      enabled: false
    });
  });

  it("AAC 解码器不可用时只关闭监听而不关闭视频上游", async () => {
    /** Worker 页面消息。 */
    const postMessage = jest.fn();
    (globalThis as any).postMessage = postMessage;
    (globalThis as any).VideoDecoder = class {};
    await import("../../src/renderer/live-preview-worker");

    /** Worker 页面命令入口。 */
    const handleCommand = (globalThis as any).onmessage as (
      event: MessageEvent
    ) => void;
    /** 主进程媒体端口桩。 */
    const port = {
      postMessage: jest.fn(),
      start: jest.fn(),
      close: jest.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null
    };
    handleCommand({ data: { type: "connect", port } } as unknown as MessageEvent);
    handleCommand({
      data: { type: "audio-monitor", enabled: true }
    } as unknown as MessageEvent);

    expect(postMessage).toHaveBeenCalledWith({
      type: "audio-status",
      status: "unavailable",
      message: "当前系统不支持电脑端音频监听"
    });
    expect(port.postMessage).toHaveBeenCalledWith({
      type: "audio-monitor",
      enabled: false
    });
    expect(port.postMessage).not.toHaveBeenCalledWith({
      type: "visibility",
      visible: false
    });
  });
});
