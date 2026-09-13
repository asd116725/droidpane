/** @jest-environment node */

import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecordingLibraryService } from "../../src/main/recording/library";
import type { Mp4Metadata } from "../../src/main/files/mp4";

/** 默认测试视频元数据。 */
const metadata: Mp4Metadata & { sizeBytes: number } = {
  durationSeconds: 12.5,
  sizeBytes: 8,
  width: 1080,
  height: 1920,
  hasAudio: true
};

/** 创建顺序可预测的随机 UUID 桩。 */
function createIdFactory(start = 1): jest.Mock<string, []> {
  /** 下一个 UUID 尾号。 */
  let sequence = start;
  return jest.fn(() => {
    /** 当前 UUID 尾号。 */
    const suffix = String(sequence).padStart(12, "0");
    sequence += 1;
    return `00000000-0000-4000-8000-${suffix}`;
  });
}

/** 创建由测试控制完成时机的 Promise。 */
function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  /** 完成 Promise 的函数。 */
  let resolve!: (value: T) => void;
  /** 可控 Promise。 */
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("录制文件库", () => {
  it("仅扫描顶层 MP4、隔离损坏文件并按修改时间倒序排列", async () => {
    /** 测试录制目录。 */
    const directory = await mkdtemp(
      path.join(tmpdir(), "adb-library-scan-")
    );
    /** 较早的有效视频。 */
    const olderFile = path.join(directory, "older.mp4");
    /** 较新的损坏视频。 */
    const newerFile = path.join(directory, "broken.MP4");
    /** 不应扫描的普通文件。 */
    const textFile = path.join(directory, "notes.txt");
    /** 不应递归扫描的子目录。 */
    const nestedDirectory = path.join(directory, "nested");
    await mkdir(nestedDirectory);
    await Promise.all([
      writeFile(olderFile, "older"),
      writeFile(newerFile, "broken"),
      writeFile(textFile, "notes"),
      writeFile(path.join(nestedDirectory, "nested.mp4"), "nested")
    ]);
    await utimes(olderFile, new Date(1_000), new Date(1_000));
    await utimes(newerFile, new Date(2_000), new Date(2_000));
    /** MP4 解析桩。 */
    const inspectFile = jest.fn(async (filePath: string) => {
      if (filePath === newerFile) {
        throw new Error("moov 缺失");
      }
      return metadata;
    });
    /** 待测文件库。 */
    const library = new RecordingLibraryService({
      getRecordingsDirectory: () => directory,
      inspectFile,
      trashItem: jest.fn(),
      createId: createIdFactory(),
      now: () => 3_000
    });

    try {
      /** 首次扫描快照。 */
      const snapshot = await library.initialize();

      expect(snapshot).toMatchObject({
        directoryName: path.basename(directory),
        refreshedAt: 3_000
      });
      expect(snapshot.items.map((item) => item.fileName)).toEqual([
        "broken.MP4",
        "older.mp4"
      ]);
      expect(snapshot.items[0]).toMatchObject({
        status: "invalid",
        recordedAt: 2_000
      });
      expect(snapshot.items[1]).toMatchObject({
        status: "ready",
        recordedAt: 1_000
      });
      expect(inspectFile).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("同会话刷新复用未变文件 ID，文件替换后分配新 ID", async () => {
    /** 测试录制目录。 */
    const directory = await mkdtemp(
      path.join(tmpdir(), "adb-library-identity-")
    );
    /** 测试视频文件。 */
    const filePath = path.join(directory, "sample.mp4");
    await writeFile(filePath, "original");
    /** 顺序 UUID 桩。 */
    const createId = createIdFactory();
    /** 待测文件库。 */
    const library = new RecordingLibraryService({
      getRecordingsDirectory: () => directory,
      inspectFile: jest.fn().mockResolvedValue(metadata),
      trashItem: jest.fn(),
      createId
    });

    try {
      /** 首次分配的会话 ID。 */
      const firstId = (await library.initialize()).items[0].id;
      /** 未修改文件再次扫描的 ID。 */
      const unchangedId = (await library.refresh()).items[0].id;
      await writeFile(filePath, "replacement-with-a-new-size");
      /** 替换文件后的新 ID。 */
      const replacedId = (await library.refresh()).items[0].id;

      expect(unchangedId).toBe(firstId);
      expect(replacedId).not.toBe(firstId);
      expect(createId).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("切换目录立即清理旧映射并使旧媒体 URL 失效", async () => {
    /** 原录制目录。 */
    const firstDirectory = await mkdtemp(
      path.join(tmpdir(), "adb-library-first-")
    );
    /** 新录制目录。 */
    const secondDirectory = await mkdtemp(
      path.join(tmpdir(), "adb-library-second-")
    );
    /** 原目录视频。 */
    const filePath = path.join(firstDirectory, "sample.mp4");
    await writeFile(filePath, "video");
    /** 当前设置目录。 */
    let currentDirectory = firstDirectory;
    /** 待测文件库。 */
    const library = new RecordingLibraryService({
      getRecordingsDirectory: () => currentDirectory,
      inspectFile: jest.fn().mockResolvedValue(metadata),
      trashItem: jest.fn(),
      createId: createIdFactory()
    });

    try {
      /** 原目录条目 ID。 */
      const artifactId = (await library.initialize()).items[0].id;
      await expect(library.resolveMediaFile(artifactId)).resolves.toBe(
        filePath
      );

      currentDirectory = secondDirectory;
      /** 新目录异步刷新任务。 */
      const refreshing = library.refresh();

      expect(library.getSnapshot().items).toEqual([]);
      expect(library.getSnapshot().directoryName).toBe(
        path.basename(secondDirectory)
      );
      await expect(library.resolveMediaFile(artifactId)).resolves.toBeUndefined();
      await refreshing;
    } finally {
      await Promise.all([
        rm(firstDirectory, { recursive: true, force: true }),
        rm(secondDirectory, { recursive: true, force: true })
      ]);
    }
  });

  it("完成注册使旧扫描失效，晚到结果不能覆盖可播放条目", async () => {
    /** 测试录制目录。 */
    const directory = await mkdtemp(
      path.join(tmpdir(), "adb-library-race-")
    );
    /** 正在完成封装的文件。 */
    const filePath = path.join(directory, "recording.mp4");
    await writeFile(filePath, "completed-video");
    /** 阻塞旧扫描的元数据任务。 */
    const inspection = createDeferred<Mp4Metadata & { sizeBytes: number }>();
    /** 待测文件库。 */
    const library = new RecordingLibraryService({
      getRecordingsDirectory: () => directory,
      inspectFile: jest.fn(() => inspection.promise),
      trashItem: jest.fn(),
      createId: createIdFactory()
    });

    try {
      /** 尚未完成的旧扫描。 */
      const staleRefresh = library.refresh();
      await Promise.resolve();
      /** 录制服务已验证并注册的完成文件。 */
      const registered = await library.registerCompletedFile(
        filePath,
        metadata
      );
      inspection.resolve(metadata);
      await staleRefresh;

      expect(library.getSnapshot().items).toEqual([registered]);
      await expect(library.resolveMediaFile(registered.id)).resolves.toBe(
        filePath
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("目录扫描并发数固定不超过四个", async () => {
    /** 测试录制目录。 */
    const directory = await mkdtemp(
      path.join(tmpdir(), "adb-library-concurrency-")
    );
    await Promise.all(
      Array.from({ length: 9 }, (_, index) =>
        writeFile(path.join(directory, `${index}.mp4`), String(index))
      )
    );
    /** 当前并发解析数。 */
    let active = 0;
    /** 观察到的最大并发数。 */
    let maximumActive = 0;
    /** 带短暂异步等待的解析桩。 */
    const inspectFile = jest.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return metadata;
    });
    /** 待测文件库。 */
    const library = new RecordingLibraryService({
      getRecordingsDirectory: () => directory,
      inspectFile,
      trashItem: jest.fn(),
      createId: createIdFactory()
    });

    try {
      await library.initialize();
      expect(maximumActive).toBe(4);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("将单个有效视频移入回收站并刷新文件库", async () => {
    /** 测试录制目录。 */
    const directory = await mkdtemp(
      path.join(tmpdir(), "adb-library-delete-one-")
    );
    /** 待删除视频。 */
    const filePath = path.join(directory, "single.mp4");
    await writeFile(filePath, "video");
    /** 模拟系统回收站的删除函数。 */
    const trashItem = jest.fn((target: string) => rm(target));
    /** 待测文件库。 */
    const library = new RecordingLibraryService({
      getRecordingsDirectory: () => directory,
      inspectFile: jest.fn().mockResolvedValue(metadata),
      trashItem,
      createId: createIdFactory()
    });

    try {
      /** 首次扫描生成的内部 ID。 */
      const id = (await library.initialize()).items[0].id;
      /** 文件库刷新事件监听器。 */
      const listener = jest.fn();
      library.onChanged(listener);
      /** 删除结果。 */
      const result = await library.deleteRecordings([id]);

      expect(trashItem).toHaveBeenCalledWith(filePath);
      expect(result.deletedIds).toEqual([id]);
      expect(result.failures).toEqual([]);
      expect(result.snapshot.items).toEqual([]);
      expect(listener).toHaveBeenLastCalledWith(result.snapshot);
      await expect(library.resolveFilePath(id)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("删除期间的并发刷新等待最终删除快照", async () => {
    /** 测试录制目录。 */
    const directory = await mkdtemp(
      path.join(tmpdir(), "adb-library-delete-refresh-")
    );
    /** 待删除视频。 */
    const filePath = path.join(directory, "pending.mp4");
    await writeFile(filePath, "video");
    /** 回收站操作开始信号。 */
    const trashStarted = createDeferred<void>();
    /** 允许回收站操作完成的信号。 */
    const releaseTrash = createDeferred<void>();
    /** 可控的系统回收站操作。 */
    const trashItem = jest.fn(async (target: string) => {
      trashStarted.resolve(undefined);
      await releaseTrash.promise;
      await rm(target);
    });
    /** 待测文件库。 */
    const library = new RecordingLibraryService({
      getRecordingsDirectory: () => directory,
      inspectFile: jest.fn().mockResolvedValue(metadata),
      trashItem,
      createId: createIdFactory()
    });

    try {
      /** 首次扫描生成的内部 ID。 */
      const id = (await library.initialize()).items[0].id;
      /** 尚未完成的删除任务。 */
      const deletion = library.deleteRecordings([id]);
      await trashStarted.promise;
      /** 删除中触发的窗口聚焦刷新。 */
      let refreshResolved = false;
      const refresh = library.refresh().then((snapshot) => {
        refreshResolved = true;
        return snapshot;
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(refreshResolved).toBe(false);
      releaseTrash.resolve(undefined);
      /** 删除与并发刷新最终返回的快照。 */
      const [deleteResult, refreshSnapshot] = await Promise.all([
        deletion,
        refresh
      ]);

      expect(deleteResult.snapshot.items).toEqual([]);
      expect(refreshSnapshot.items).toEqual([]);
      expect(library.getSnapshot().items).toEqual([]);
    } finally {
      releaseTrash.resolve(undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("批量删除支持损坏文件并隔离单项回收站失败", async () => {
    /** 测试录制目录。 */
    const directory = await mkdtemp(
      path.join(tmpdir(), "adb-library-delete-many-")
    );
    /** 可播放视频。 */
    const readyFile = path.join(directory, "ready.mp4");
    /** 无法解析但仍可删除的视频。 */
    const brokenFile = path.join(directory, "broken.mp4");
    /** 模拟无权限删除的视频。 */
    const deniedFile = path.join(directory, "denied.mp4");
    await Promise.all([
      writeFile(readyFile, "ready"),
      writeFile(brokenFile, "broken"),
      writeFile(deniedFile, "denied")
    ]);
    /** 仅拒绝指定文件的回收站桩。 */
    const trashItem = jest.fn(async (target: string) => {
      if (target === deniedFile) {
        /** 带系统错误码的权限异常。 */
        const error = new Error("denied") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      await rm(target);
    });
    /** 待测文件库。 */
    const library = new RecordingLibraryService({
      getRecordingsDirectory: () => directory,
      inspectFile: jest.fn(async (target: string) => {
        if (target === brokenFile) {
          throw new Error("moov 缺失");
        }
        return metadata;
      }),
      trashItem,
      createId: createIdFactory()
    });

    try {
      /** 文件名到内部条目的映射。 */
      const entries = new Map(
        (await library.initialize()).items.map((item) => [item.fileName, item])
      );
      /** 批量删除结果。 */
      const result = await library.deleteRecordings([
        entries.get("ready.mp4")!.id,
        entries.get("broken.mp4")!.id,
        entries.get("denied.mp4")!.id
      ]);

      expect(result.deletedIds).toEqual([
        entries.get("ready.mp4")!.id,
        entries.get("broken.mp4")!.id
      ]);
      expect(result.failures).toEqual([
        {
          id: entries.get("denied.mp4")!.id,
          fileName: "denied.mp4",
          errorMessage: "没有权限将文件移入回收站"
        }
      ]);
      expect(result.snapshot.items.map((item) => item.fileName)).toEqual([
        "denied.mp4"
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("拒绝未知 ID 与扫描后被替换的文件并重新登记", async () => {
    /** 测试录制目录。 */
    const directory = await mkdtemp(
      path.join(tmpdir(), "adb-library-delete-replaced-")
    );
    /** 扫描后被替换的视频。 */
    const filePath = path.join(directory, "replaced.mp4");
    await writeFile(filePath, "original");
    /** 回收站操作桩。 */
    const trashItem = jest.fn();
    /** 待测文件库。 */
    const library = new RecordingLibraryService({
      getRecordingsDirectory: () => directory,
      inspectFile: jest.fn().mockResolvedValue(metadata),
      trashItem,
      createId: createIdFactory()
    });

    try {
      /** 文件替换前的内部 ID。 */
      const oldId = (await library.initialize()).items[0].id;
      /** 一个从未登记过的合法 UUID。 */
      const unknownId = "00000000-0000-4000-8000-999999999999";
      await writeFile(filePath, "replacement-with-different-size");
      /** 删除结果。 */
      const result = await library.deleteRecordings([oldId, unknownId]);

      expect(trashItem).not.toHaveBeenCalled();
      expect(result.deletedIds).toEqual([]);
      expect(result.failures).toHaveLength(2);
      expect(result.failures[0]).toMatchObject({
        id: oldId,
        fileName: "replaced.mp4"
      });
      expect(result.failures[1]).toEqual({
        id: unknownId,
        fileName: "未知文件",
        errorMessage: "文件不存在或文件 ID 已失效"
      });
      expect(result.snapshot.items[0].id).not.toBe(oldId);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  const testSymbolicLink = process.platform === "win32" ? it.skip : it;

  testSymbolicLink("文件被替换为越界符号链接时拒绝删除", async () => {
    /** 测试录制目录。 */
    const directory = await mkdtemp(
      path.join(tmpdir(), "adb-library-delete-link-")
    );
    /** 目录外的真实文件。 */
    const outsideDirectory = await mkdtemp(
      path.join(tmpdir(), "adb-library-delete-outside-")
    );
    /** 初始普通视频路径。 */
    const filePath = path.join(directory, "linked.mp4");
    /** 越界符号链接目标。 */
    const outsideFile = path.join(outsideDirectory, "outside.mp4");
    await Promise.all([
      writeFile(filePath, "inside"),
      writeFile(outsideFile, "outside")
    ]);
    /** 回收站操作桩。 */
    const trashItem = jest.fn();
    /** 待测文件库。 */
    const library = new RecordingLibraryService({
      getRecordingsDirectory: () => directory,
      inspectFile: jest.fn().mockResolvedValue(metadata),
      trashItem,
      createId: createIdFactory()
    });

    try {
      /** 初始普通文件 ID。 */
      const id = (await library.initialize()).items[0].id;
      await rm(filePath);
      await symlink(outsideFile, filePath);
      /** 删除结果。 */
      const result = await library.deleteRecordings([id]);

      expect(trashItem).not.toHaveBeenCalled();
      expect(result.failures).toHaveLength(1);
      await expect(writeFile(outsideFile, "still-safe")).resolves.toBeUndefined();
    } finally {
      await Promise.all([
        rm(directory, { recursive: true, force: true }),
        rm(outsideDirectory, { recursive: true, force: true })
      ]);
    }
  });
});
