/** Mediabunny 主视频轨查询桩。 */
const mockGetPrimaryVideoTrack = jest.fn();
/** Mediabunny 画布读取桩。 */
const mockGetCanvas = jest.fn();
/** 媒体输入释放桩。 */
const mockDispose = jest.fn();
/** 媒体输入构造桩。 */
const mockInput = jest.fn().mockImplementation(() => ({
  getPrimaryVideoTrack: mockGetPrimaryVideoTrack,
  dispose: mockDispose
}));
/** 画布读取器构造桩。 */
const mockCanvasSink = jest.fn().mockImplementation(() => ({
  getCanvas: mockGetCanvas
}));

jest.mock("mediabunny", () => ({
  ALL_FORMATS: [],
  Input: mockInput,
  UrlSource: jest.fn(),
  CanvasSink: mockCanvasSink
}));

/** 测试环境中的离屏画布。 */
class TestOffscreenCanvas {
  /** 返回可供页面创建 Blob URL 的图片。 */
  convertToBlob(): Promise<Blob> {
    return Promise.resolve(new Blob(["thumbnail"], { type: "image/webp" }));
  }
}

/** 等待 Worker 异步队列推进。 */
async function flushWorkerQueue(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 创建固定缩略图请求。 */
function createRequest(requestId: number): MessageEvent {
  return {
    data: {
      type: "render",
      requestId,
      mediaUrl: `adb-studio-media://artifact/${requestId}`,
      width: 88,
      height: 58,
      durationSeconds: 10
    }
  } as MessageEvent;
}

describe("缩略图 Worker", () => {
  /** 原离屏画布构造器。 */
  const originalOffscreenCanvas = globalThis.OffscreenCanvas;
  /** 原全局消息发送函数。 */
  const originalPostMessage = globalThis.postMessage;
  /** Worker 结果发布桩。 */
  const postMessage = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockGetPrimaryVideoTrack.mockResolvedValue({});
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      value: TestOffscreenCanvas
    });
    Object.defineProperty(globalThis, "postMessage", {
      configurable: true,
      value: postMessage
    });
  });

  afterAll(() => {
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      value: originalOffscreenCanvas
    });
    Object.defineProperty(globalThis, "postMessage", {
      configurable: true,
      value: originalPostMessage
    });
  });

  it("严格串行解码可见条目，前一项完成后才创建下一读取器", async () => {
    /** 首个缩略图的延迟完成函数。 */
    let resolveFirst: ((value: unknown) => void) | undefined;
    /** 首个延迟画布结果。 */
    const firstCanvas = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    mockGetCanvas
      .mockReturnValueOnce(firstCanvas)
      .mockResolvedValueOnce({ canvas: new TestOffscreenCanvas() });

    await import("../../src/renderer/video-library/thumbnail-worker");
    /** Worker 注册的消息入口。 */
    const handleMessage = globalThis.onmessage as (
      event: MessageEvent
    ) => void;
    handleMessage(createRequest(1));
    handleMessage(createRequest(2));

    await flushWorkerQueue();
    expect(mockCanvasSink).toHaveBeenCalledTimes(1);
    resolveFirst?.({ canvas: new TestOffscreenCanvas() });
    await flushWorkerQueue();
    await flushWorkerQueue();

    expect(mockCanvasSink).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "result",
      "result"
    ]);
    expect(mockDispose).toHaveBeenCalledTimes(2);
  });

  it("单个文件失败后发布错误并继续处理后续条目", async () => {
    mockGetPrimaryVideoTrack
      .mockRejectedValueOnce(new Error("文件损坏"))
      .mockResolvedValueOnce({});
    mockGetCanvas.mockResolvedValue({ canvas: new TestOffscreenCanvas() });

    await import("../../src/renderer/video-library/thumbnail-worker");
    /** Worker 注册的消息入口。 */
    const handleMessage = globalThis.onmessage as (
      event: MessageEvent
    ) => void;
    handleMessage(createRequest(1));
    handleMessage(createRequest(2));
    await flushWorkerQueue();
    await flushWorkerQueue();

    expect(postMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "error",
      "result"
    ]);
    expect(postMessage.mock.calls[0][0].message).toBe("文件损坏");
    expect(mockDispose).toHaveBeenCalledTimes(2);
  });
});
