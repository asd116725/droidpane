import { render, screen, waitFor } from "@testing-library/react";
import { VideoLibraryDrawer } from "../../src/renderer/video-library/VideoLibraryDrawer";
import { requestRecordingThumbnail } from "../../src/renderer/video-library/thumbnail-service";
import type { RecordingLibraryReadyItem } from "../../src/shared/types";

jest.mock("../../src/renderer/video-library/thumbnail-service", () => ({
  requestRecordingThumbnail: jest.fn()
}));

/** 缩略图请求桩。 */
const requestThumbnail = requestRecordingThumbnail as jest.MockedFunction<
  typeof requestRecordingThumbnail
>;

/** 可生成缩略图的视频库条目。 */
const readyItem: RecordingLibraryReadyItem = {
  id: "thumbnail-item",
  fileName: "Thumbnail_Test.mp4",
  durationSeconds: 12,
  sizeBytes: 1024,
  width: 1080,
  height: 2400,
  hasAudio: true,
  mediaUrl: "adb-studio-media://artifact/thumbnail-item",
  status: "ready",
  recordedAt: Date.now()
};

/** 渲染只包含一个条目的视频库。 */
function renderLibrary(): ReturnType<typeof render> {
  return render(
    <VideoLibraryDrawer
      snapshot={{
        directoryName: "DroidPane",
        items: [readyItem],
        refreshedAt: Date.now()
      }}
      refreshing={false}
      deletionLocked={false}
      onSelect={jest.fn()}
      onDelete={jest.fn().mockResolvedValue({
        deletedIds: [],
        failures: [],
        snapshot: {
          directoryName: "DroidPane",
          items: [readyItem],
          refreshedAt: Date.now()
        }
      })}
      onOpenFolder={jest.fn()}
    />
  );
}

describe("视频库真实缩略图", () => {
  /** Blob URL 创建桩。 */
  const createObjectURL = jest.fn(() => "blob:thumbnail");
  /** Blob URL 释放桩。 */
  const revokeObjectURL = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL
    });
  });

  it("使用 Worker 结果展示图片并在抽屉卸载时释放 Blob URL", async () => {
    /** 请求取消桩。 */
    const cancel = jest.fn();
    requestThumbnail.mockReturnValue({
      promise: Promise.resolve(new Blob(["thumbnail"])),
      cancel
    });
    /** 当前渲染结果。 */
    const view = renderLibrary();

    expect(
      await screen.findByRole("img", { name: "Thumbnail_Test.mp4 缩略图" })
    ).toHaveAttribute("src", "blob:thumbnail");
    expect(requestThumbnail).toHaveBeenCalledWith(
      readyItem.mediaUrl,
      readyItem.durationSeconds
    );

    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail");
  });

  it("缩略图解码失败时保留条目并显示降级占位", async () => {
    requestThumbnail.mockReturnValue({
      promise: Promise.reject(new Error("解码失败")),
      cancel: jest.fn()
    });

    renderLibrary();

    await waitFor(() =>
      expect(screen.getByLabelText("缩略图不可用")).toBeInTheDocument()
    );
    expect(screen.getByText("Thumbnail_Test.mp4")).toBeInTheDocument();
  });
});
