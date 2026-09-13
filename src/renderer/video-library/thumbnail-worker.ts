import { ALL_FORMATS, CanvasSink, Input, UrlSource } from "mediabunny";

/** 页面发送给缩略图 Worker 的请求。 */
interface ThumbnailRequest {
  /** 固定消息类型。 */
  type: "render";
  /** 用于匹配异步结果的请求 ID。 */
  requestId: number;
  /** 应用内部安全媒体地址。 */
  mediaUrl: string;
  /** 缩略图宽度。 */
  width: number;
  /** 缩略图高度。 */
  height: number;
  /** 已由主进程解析的视频时长。 */
  durationSeconds: number;
}

/** Worker 返回给页面的成功消息。 */
interface ThumbnailResult {
  /** 固定消息类型。 */
  type: "result";
  /** 对应的请求 ID。 */
  requestId: number;
  /** 编码后的 WebP 缩略图。 */
  blob: Blob;
}

/** Worker 返回给页面的失败消息。 */
interface ThumbnailError {
  /** 固定消息类型。 */
  type: "error";
  /** 对应的请求 ID。 */
  requestId: number;
  /** 可展示的错误信息。 */
  message: string;
}

/** 缩略图 Worker 全局作用域最小接口。 */
interface ThumbnailWorkerScope {
  /** 接收页面请求。 */
  onmessage: ((event: MessageEvent<ThumbnailRequest>) => void) | null;
  /** 向页面发布结果。 */
  postMessage(message: ThumbnailResult | ThumbnailError): void;
}

/** 类型安全的 Worker 全局对象。 */
const workerScope = globalThis as unknown as ThumbnailWorkerScope;
/** 等待串行处理的缩略图请求。 */
const requestQueue: ThumbnailRequest[] = [];
/** 当前是否正在解码缩略图。 */
let rendering = false;

/** 将画布转换为轻量 WebP 图片。 */
async function canvasToBlob(canvas: OffscreenCanvas): Promise<Blob> {
  return canvas.convertToBlob({
    type: "image/webp",
    quality: 0.8
  });
}

/** 使用 Mediabunny 从真实 MP4 中抽取一帧。 */
async function renderThumbnail(request: ThumbnailRequest): Promise<Blob> {
  /** 只接受应用内部媒体协议，避免 Worker 读取任意 URL。 */
  if (!request.mediaUrl.startsWith("adb-studio-media://")) {
    throw new Error("缩略图媒体地址无效");
  }

  /** 基于安全 URL 的媒体输入。 */
  const input = new Input({
    source: new UrlSource(request.mediaUrl, {
      parallelism: 1,
      maxCacheSize: 24 * 1024 * 1024,
      getRetryDelay: () => null
    }),
    formats: ALL_FORMATS
  });

  try {
    /** MP4 主视频轨道。 */
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error("录制文件不包含视频轨道");
    }

    /** 优先避开常见的全黑开场帧。 */
    const timestamp = Math.min(
      1,
      Math.max(0.1, request.durationSeconds * 0.1)
    );
    /** 固定尺寸、等比例留黑边的画布读取器。 */
    const sink = new CanvasSink(videoTrack, {
      width: request.width,
      height: request.height,
      fit: "contain"
    });
    /** 目标帧或文件首帧。 */
    const frame =
      (await sink.getCanvas(timestamp)) ?? (await sink.getCanvas(0));

    if (!frame || !(frame.canvas instanceof OffscreenCanvas)) {
      throw new Error("无法读取录制画面");
    }

    return await canvasToBlob(frame.canvas);
  } finally {
    input.dispose();
  }
}

/** 按队列顺序处理请求，限制同时只解码一个视频。 */
async function drainQueue(): Promise<void> {
  if (rendering) {
    return;
  }

  rendering = true;
  try {
    while (requestQueue.length) {
      /** 本轮缩略图请求。 */
      const request = requestQueue.shift();
      if (!request) {
        continue;
      }

      try {
        /** 真实视频帧缩略图。 */
        const blob = await renderThumbnail(request);
        workerScope.postMessage({
          type: "result",
          requestId: request.requestId,
          blob
        });
      } catch (error) {
        workerScope.postMessage({
          type: "error",
          requestId: request.requestId,
          message:
            error instanceof Error ? error.message : "缩略图生成失败"
        });
      }
    }
  } finally {
    rendering = false;
  }
}

workerScope.onmessage = (event) => {
  if (event.data?.type !== "render") {
    return;
  }

  requestQueue.push(event.data);
  void drainQueue();
};
