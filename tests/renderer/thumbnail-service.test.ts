describe("缩略图服务", () => {
  /** 原 Worker 构造器。 */
  const originalWorker = globalThis.Worker;

  afterEach(() => {
    jest.resetModules();
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: originalWorker
    });
  });

  it("从主窗口地址解析同源 Worker 并返回缩略图", async () => {
    /** Worker 消息发送桩。 */
    const postMessage = jest.fn();
    /** 可观察监听器的 Worker 桩。 */
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      postMessage,
      terminate: jest.fn()
    };
    /** Worker 构造桩。 */
    const workerConstructor = jest.fn(() => worker);
    Object.defineProperty(globalThis, "Worker", {
      configurable: true,
      value: workerConstructor
    });

    /** 延迟载入以使用测试 Worker。 */
    const { requestRecordingThumbnail } = await import(
      "../../src/renderer/video-library/thumbnail-service"
    );
    /** 本次缩略图请求。 */
    const request = requestRecordingThumbnail(
      "adb-studio-media://artifact/video",
      5
    );

    expect(workerConstructor).toHaveBeenCalledWith(
      new URL(
        "../thumbnail_worker/index.js",
        window.location.href
      ).toString(),
      { name: "droidpane-thumbnails" }
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "render", requestId: 1 })
    );

    /** Worker 返回的缩略图。 */
    const thumbnail = new Blob(["thumbnail"], { type: "image/webp" });
    worker.onmessage?.({
      data: { type: "result", requestId: 1, blob: thumbnail }
    } as MessageEvent);
    await expect(request.promise).resolves.toBe(thumbnail);
  });
});
