/** 缩略图 Worker 请求结果。 */
type ThumbnailWorkerMessage =
  | { type: "result"; requestId: number; blob: Blob }
  | { type: "error"; requestId: number; message: string };

/** 等待中的缩略图回调。 */
interface ThumbnailCallbacks {
  /** 成功回调。 */
  resolve(blob: Blob): void;
  /** 失败回调。 */
  reject(error: Error): void;
}

/** 可取消的缩略图请求。 */
export interface ThumbnailRequestHandle {
  /** 缩略图结果。 */
  promise: Promise<Blob>;
  /** 忽略尚未返回的结果。 */
  cancel(): void;
}

/** 复用的单一缩略图 Worker。 */
let thumbnailWorker: Worker | undefined;
/** Worker 请求递增 ID。 */
let nextRequestId = 1;
/** 尚未返回的缩略图请求。 */
const pendingRequests = new Map<number, ThumbnailCallbacks>();

/** 获取渲染进程同源的缩略图 Worker 入口。 */
function getThumbnailWorkerUrl(): string {
  return new URL(
    "../thumbnail_worker/index.js",
    window.location.href
  ).toString();
}

/** 拒绝并清理所有等待中的请求。 */
function rejectPendingRequests(message: string): void {
  pendingRequests.forEach(({ reject }) => reject(new Error(message)));
  pendingRequests.clear();
}

/** 懒创建整个视频库共用的缩略图 Worker。 */
function getThumbnailWorker(): Worker | undefined {
  if (thumbnailWorker) {
    return thumbnailWorker;
  }
  if (typeof Worker === "undefined") {
    return undefined;
  }

  try {
    thumbnailWorker = new Worker(getThumbnailWorkerUrl(), {
      name: "droidpane-thumbnails"
    });
    thumbnailWorker.onmessage = (
      event: MessageEvent<ThumbnailWorkerMessage>
    ) => {
      /** 对应请求的回调。 */
      const callbacks = pendingRequests.get(event.data.requestId);
      if (!callbacks) {
        return;
      }

      pendingRequests.delete(event.data.requestId);
      if (event.data.type === "result") {
        callbacks.resolve(event.data.blob);
      } else {
        callbacks.reject(new Error(event.data.message));
      }
    };
    thumbnailWorker.onerror = () => {
      thumbnailWorker?.terminate();
      thumbnailWorker = undefined;
      rejectPendingRequests("缩略图 Worker 运行失败");
    };
  } catch {
    thumbnailWorker = undefined;
  }

  return thumbnailWorker;
}

/** 请求一张由真实 MP4 解码生成的缩略图。 */
export function requestRecordingThumbnail(
  mediaUrl: string,
  durationSeconds: number,
  width = 88,
  height = 58
): ThumbnailRequestHandle {
  /** 本次请求使用的 Worker。 */
  const worker = getThumbnailWorker();
  /** 本次递增请求 ID。 */
  const requestId = nextRequestId++;
  /** Promise 外部回调。 */
  let callbacks: ThumbnailCallbacks | undefined;
  /** 缩略图异步结果。 */
  const promise = new Promise<Blob>((resolve, reject) => {
    callbacks = { resolve, reject };
  });

  if (!worker || !callbacks) {
    callbacks?.reject(new Error("当前环境无法生成缩略图"));
  } else {
    pendingRequests.set(requestId, callbacks);
    worker.postMessage({
      type: "render",
      requestId,
      mediaUrl,
      width,
      height,
      durationSeconds
    });
  }

  return {
    promise,
    cancel: () => pendingRequests.delete(requestId)
  };
}
