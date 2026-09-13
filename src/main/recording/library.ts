import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  RecordingDeleteFailure,
  RecordingDeleteResult,
  RecordingLibraryInvalidItem,
  RecordingLibraryItem,
  RecordingLibraryReadyItem,
  RecordingLibrarySnapshot
} from "../../shared/types";
import type { Mp4Metadata } from "../files/mp4";

/** 单次目录扫描使用的最大并发数。 */
const scanConcurrency = 4;

/** 用于识别文件内容版本的轻量指纹。 */
interface FileFingerprint {
  /** 文件字节大小。 */
  sizeBytes: number;
  /** 文件最后修改时间。 */
  modifiedAtMs: number;
  /** 文件元数据最后变更时间。 */
  changedAtMs: number;
  /** 文件所在设备编号。 */
  deviceId: number;
  /** 文件 inode 编号。 */
  inode: number;
}

/** 主进程内部保存的录制文件条目。 */
interface IndexedRecording {
  /** 可安全发送给渲染进程的条目。 */
  item: RecordingLibraryItem;
  /** 不向渲染进程公开的绝对路径。 */
  filePath: string;
  /** 文件所属目录的规范键。 */
  directoryKey: string;
  /** 注册时的文件指纹。 */
  fingerprint: FileFingerprint;
}

/** 文件库服务依赖。 */
export interface RecordingLibraryDependencies {
  /** 获取当前设置中的录制目录。 */
  getRecordingsDirectory(): string;
  /** 读取一个 MP4 的展示元数据。 */
  inspectFile(
    filePath: string
  ): Promise<Mp4Metadata & { sizeBytes: number }>;
  /** 将文件移入当前系统的回收站。 */
  trashItem(filePath: string): Promise<void>;
  /** 获取当前时间戳。 */
  now?(): number;
  /** 创建仅在当前应用会话内有效的文件 ID。 */
  createId?(): string;
}

/** 创建不共享引用的文件库条目。 */
function cloneItem(item: RecordingLibraryItem): RecordingLibraryItem {
  return { ...item };
}

/** 创建不共享引用的文件库快照。 */
function cloneSnapshot(
  snapshot: RecordingLibrarySnapshot
): RecordingLibrarySnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map(cloneItem)
  };
}

/** 创建兼容当前平台路径大小写规则的比较键。 */
function createPathKey(value: string): string {
  /** 规范后的绝对路径。 */
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** 从文件信息提取用于识别替换操作的指纹。 */
function createFingerprint(fileInfo: Stats): FileFingerprint {
  return {
    sizeBytes: fileInfo.size,
    modifiedAtMs: fileInfo.mtimeMs,
    changedAtMs: fileInfo.ctimeMs,
    deviceId: fileInfo.dev,
    inode: fileInfo.ino
  };
}

/** 判断两个文件指纹是否一致。 */
function isSameFingerprint(
  left: FileFingerprint,
  right: FileFingerprint
): boolean {
  return (
    left.sizeBytes === right.sizeBytes &&
    Math.abs(left.modifiedAtMs - right.modifiedAtMs) < 0.001 &&
    Math.abs(left.changedAtMs - right.changedAtMs) < 0.001 &&
    left.deviceId === right.deviceId &&
    left.inode === right.inode
  );
}

/** 判断真实文件是否仍位于允许的目录中。 */
function isInsideDirectory(directory: string, filePath: string): boolean {
  /** 文件相对目录的位置。 */
  const relative = path.relative(directory, filePath);
  return (
    Boolean(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** 使用固定并发映射数组。 */
async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  /** 保持输入顺序的结果数组。 */
  const results = new Array<R>(values.length);
  /** 下一个待处理索引。 */
  let nextIndex = 0;
  /** 单个扫描工作器。 */
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      /** 当前工作器领取的索引。 */
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  };
  /** 实际需要启动的工作器。 */
  const workerCount = Math.min(concurrency, values.length);

  await Promise.all(
    Array.from({ length: workerCount }, () => worker())
  );
  return results;
}

/** 按录制时间倒序排列文件库条目。 */
function sortItems(items: RecordingLibraryItem[]): RecordingLibraryItem[] {
  return [...items].sort(
    (left, right) =>
      right.recordedAt - left.recordedAt ||
      left.fileName.localeCompare(right.fileName)
  );
}

/** 判断未知错误是否为指定 Node.js 错误码。 */
function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

/** 将删除异常转换为不包含真实路径的用户提示。 */
function getDeleteErrorMessage(error: unknown): string {
  if (hasErrorCode(error, "ENOENT")) {
    return "文件已不存在";
  }

  if (hasErrorCode(error, "EACCES") || hasErrorCode(error, "EPERM")) {
    return "没有权限将文件移入回收站";
  }

  return "无法将文件移入系统回收站";
}

/** 管理当前录制目录的安全媒体索引。 */
export class RecordingLibraryService {
  /** 所有本次会话内已验证的文件。 */
  private readonly entries = new Map<string, IndexedRecording>();
  /** 文件库订阅者。 */
  private readonly listeners = new Set<
    (snapshot: RecordingLibrarySnapshot) => void
  >();
  /** 当前公开快照。 */
  private snapshot: RecordingLibrarySnapshot = {
    directoryName: "",
    items: [],
    refreshedAt: 0
  };
  /** 当前快照对应的目录键。 */
  private snapshotDirectoryKey = "";
  /** 正在执行的扫描。 */
  private refreshTask?: Promise<RecordingLibrarySnapshot>;
  /** 正在扫描的目录键。 */
  private refreshDirectoryKey = "";
  /** 正在执行的回收站删除任务。 */
  private deleteTask?: Promise<RecordingDeleteResult>;
  /** 用于丢弃旧目录晚到结果的序号。 */
  private refreshGeneration = 0;

  /** 创建录制文件库服务。 */
  constructor(private readonly dependencies: RecordingLibraryDependencies) {}

  /** 初始化并扫描当前录制目录。 */
  initialize(): Promise<RecordingLibrarySnapshot> {
    return this.refresh();
  }

  /** 获取当前文件库快照。 */
  getSnapshot(): RecordingLibrarySnapshot {
    return cloneSnapshot(this.snapshot);
  }

  /** 订阅文件库变化。 */
  onChanged(
    listener: (snapshot: RecordingLibrarySnapshot) => void
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 重新扫描当前设置中的录制目录。 */
  refresh(): Promise<RecordingLibrarySnapshot> {
    /** 删除期间的刷新等待最终删除快照，避免发布中间状态。 */
    if (this.deleteTask) {
      return this.deleteTask.then((result) => cloneSnapshot(result.snapshot));
    }

    return this.startRefresh();
  }

  /** 启动一次不受删除等待门控制的目录扫描。 */
  private startRefresh(): Promise<RecordingLibrarySnapshot> {
    /** 当前要扫描的绝对目录。 */
    const directory = path.resolve(
      this.dependencies.getRecordingsDirectory()
    );
    /** 当前目录比较键。 */
    const directoryKey = createPathKey(directory);

    if (this.refreshTask && this.refreshDirectoryKey === directoryKey) {
      return this.refreshTask;
    }

    if (this.snapshotDirectoryKey !== directoryKey) {
      this.entries.clear();
      this.publishSnapshot(directory, []);
    }

    /** 本次扫描序号。 */
    const generation = ++this.refreshGeneration;
    /** 本次扫描任务。 */
    const task = this.performRefresh(directory, directoryKey, generation);
    this.refreshTask = task;
    this.refreshDirectoryKey = directoryKey;
    void task.then(
      () => this.finishRefresh(task),
      () => this.finishRefresh(task)
    );
    return task;
  }

  /** 注册刚完成封装的录制文件并立即发布。 */
  async registerCompletedFile(
    filePath: string,
    metadata: Mp4Metadata & { sizeBytes: number }
  ): Promise<RecordingLibraryReadyItem> {
    /** 规范后的录制文件路径。 */
    const resolvedPath = path.resolve(filePath);
    /** 完成文件信息。 */
    const fileInfo = await lstat(resolvedPath);

    if (!fileInfo.isFile()) {
      throw new Error("录制文件不是普通文件");
    }

    /** 完成文件指纹。 */
    const fingerprint = createFingerprint(fileInfo);
    /** 当前设置中的录制目录。 */
    const directory = path.resolve(
      this.dependencies.getRecordingsDirectory()
    );
    /** 当前录制目录键。 */
    const directoryKey = createPathKey(directory);

    if (createPathKey(path.dirname(resolvedPath)) !== directoryKey) {
      throw new Error("录制文件不在当前存储目录中");
    }

    /** 同一路径未变文件沿用的会话 ID。 */
    const reusableId = this.findReusableId(
      resolvedPath,
      directoryKey,
      fingerprint
    );
    /** 可播放文件库条目。 */
    const item = this.createReadyItem(
      resolvedPath,
      fingerprint,
      fileInfo.mtimeMs,
      metadata,
      reusableId
    );

    this.invalidateRefresh();
    this.removePath(resolvedPath);
    this.entries.set(item.id, {
      item,
      filePath: resolvedPath,
      directoryKey,
      fingerprint
    });

    if (this.snapshotDirectoryKey === directoryKey) {
      this.publishSnapshot(directory, this.readDirectoryItems(directoryKey));
    }

    return { ...item };
  }

  /** 获取指定 ID 的可播放公开条目。 */
  getReadyItem(id: string): RecordingLibraryReadyItem | undefined {
    /** 已注册的内部条目。 */
    const entry = this.entries.get(id);
    /** 当前设置中的目录键。 */
    const directoryKey = createPathKey(
      this.dependencies.getRecordingsDirectory()
    );
    return entry?.directoryKey === directoryKey &&
      entry.item.status === "ready"
      ? { ...entry.item }
      : undefined;
  }

  /** 解析可播放 ID 对应的安全本地路径。 */
  resolveMediaFile(id: string): Promise<string | undefined> {
    return this.resolveFilePath(id, true);
  }

  /** 将一个或多个录制文件移入系统回收站。 */
  deleteRecordings(ids: string[]): Promise<RecordingDeleteResult> {
    if (this.deleteTask) {
      return Promise.reject(new Error("已有视频正在移入回收站"));
    }

    /** 本次串行删除任务。 */
    const task = this.performDeleteRecordings(ids);
    this.deleteTask = task;
    void task.then(
      () => this.finishDelete(task),
      () => this.finishDelete(task)
    );
    return task;
  }

  /** 执行已串行化的逐文件回收站操作。 */
  private async performDeleteRecordings(
    ids: string[]
  ): Promise<RecordingDeleteResult> {
    /** 成功删除的内部 ID。 */
    const deletedIds: string[] = [];
    /** 独立记录的删除失败项。 */
    const failures: RecordingDeleteFailure[] = [];

    this.invalidateRefresh();

    for (const id of ids) {
      /** 删除前登记的内部条目。 */
      const entry = this.entries.get(id);
      /** 对外只返回文件名的失败信息。 */
      const fail = (errorMessage: string): void => {
        failures.push({
          id,
          fileName: entry?.item.fileName ?? "未知文件",
          errorMessage
        });
      };

      if (!entry) {
        fail("文件不存在或文件 ID 已失效");
        continue;
      }

      /** 经过目录、普通文件与指纹校验的真实文件。 */
      const filePath = await this.resolveFilePath(id);

      if (!filePath) {
        fail("文件不存在、已被替换或不在当前存储目录中");
        continue;
      }

      try {
        await this.dependencies.trashItem(filePath);
        this.entries.delete(id);
        deletedIds.push(id);
      } catch (error) {
        fail(getDeleteErrorMessage(error));
      }
    }

    this.invalidateRefresh();
    return {
      deletedIds,
      failures,
      snapshot: await this.startRefresh()
    };
  }

  /** 解析任意文件库 ID 对应的安全本地路径。 */
  async resolveFilePath(
    id: string,
    readyOnly = false
  ): Promise<string | undefined> {
    /** 已注册的内部条目。 */
    const entry = this.entries.get(id);
    /** 当前设置中的录制目录。 */
    const directory = path.resolve(
      this.dependencies.getRecordingsDirectory()
    );
    /** 当前设置中的目录键。 */
    const directoryKey = createPathKey(directory);

    if (
      !entry ||
      entry.directoryKey !== directoryKey ||
      (readyOnly && entry.item.status !== "ready")
    ) {
      return undefined;
    }

    try {
      /** 当前文件信息。 */
      const fileInfo = await lstat(entry.filePath);
      /** 当前文件指纹。 */
      const fingerprint = createFingerprint(fileInfo);

      if (
        !fileInfo.isFile() ||
        !isSameFingerprint(entry.fingerprint, fingerprint)
      ) {
        return undefined;
      }

      /** 当前设置目录的真实路径。 */
      const realDirectory = await realpath(directory);
      /** 当前文件真实路径。 */
      const realFilePath = await realpath(entry.filePath);

      return isInsideDirectory(realDirectory, realFilePath)
        ? entry.filePath
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** 执行一次目录扫描并按序号决定是否发布。 */
  private async performRefresh(
    directory: string,
    directoryKey: string,
    generation: number
  ): Promise<RecordingLibrarySnapshot> {
    try {
      /** 当前目录直接子项。 */
      const directoryEntries = await readdir(directory, {
        withFileTypes: true
      });
      /** 顶层普通 MP4 文件路径。 */
      const filePaths = directoryEntries
        .filter(
          (entry) =>
            entry.isFile() && path.extname(entry.name).toLowerCase() === ".mp4"
        )
        .map((entry) => path.join(directory, entry.name));
      /** 每个文件独立解析后的内部条目。 */
      const scanned = await mapWithConcurrency(
        filePaths,
        scanConcurrency,
        (filePath) => this.inspectRecording(filePath, directoryKey)
      );

      if (generation !== this.refreshGeneration) {
        return this.getSnapshot();
      }

      /** 仍存在的有效或损坏条目。 */
      const indexed = scanned.filter(
        (entry): entry is IndexedRecording => Boolean(entry)
      );
      this.replaceDirectoryEntries(directoryKey, indexed);
      this.publishSnapshot(
        directory,
        indexed.map((entry) => entry.item)
      );
      return this.getSnapshot();
    } catch (error) {
      if (generation !== this.refreshGeneration) {
        return this.getSnapshot();
      }

      this.replaceDirectoryEntries(directoryKey, []);
      this.publishSnapshot(
        directory,
        [],
        hasErrorCode(error, "ENOENT")
          ? undefined
          : "无法读取当前录制文件夹"
      );
      return this.getSnapshot();
    }
  }

  /** 将一个候选 MP4 转换为隔离的文件库条目。 */
  private async inspectRecording(
    filePath: string,
    directoryKey: string
  ): Promise<IndexedRecording | undefined> {
    try {
      /** 扫描开始时的普通文件信息。 */
      const fileInfo = await lstat(filePath);

      if (!fileInfo.isFile()) {
        return undefined;
      }

      /** 本次文件指纹。 */
      const fingerprint = createFingerprint(fileInfo);
      /** 对用户展示的录制时间。 */
      const recordedAt = fileInfo.mtimeMs;
      /** 同一路径未变文件沿用的会话 ID。 */
      const reusableId = this.findReusableId(
        filePath,
        directoryKey,
        fingerprint
      );

      try {
        /** MP4 展示元数据。 */
        const metadata = await this.dependencies.inspectFile(filePath);
        /** 解析结束后的文件信息。 */
        const currentInfo = await lstat(filePath);
        /** 解析结束后的文件指纹。 */
        const currentFingerprint = createFingerprint(currentInfo);

        if (
          !currentInfo.isFile() ||
          !isSameFingerprint(fingerprint, currentFingerprint)
        ) {
          throw new Error("文件扫描期间发生变化");
        }

        return {
          item: this.createReadyItem(
            filePath,
            fingerprint,
            recordedAt,
            metadata,
            reusableId
          ),
          filePath,
          directoryKey,
          fingerprint
        };
      } catch {
        /** 无法解析的文件库条目。 */
        const item: RecordingLibraryInvalidItem = {
          id: reusableId ?? this.createId(),
          fileName: path.basename(filePath),
          sizeBytes: fingerprint.sizeBytes,
          recordedAt,
          status: "invalid",
          errorMessage: "文件无法读取或尚未完成封装"
        };
        return { item, filePath, directoryKey, fingerprint };
      }
    } catch {
      return undefined;
    }
  }

  /** 创建一个可播放文件库条目。 */
  private createReadyItem(
    filePath: string,
    fingerprint: FileFingerprint,
    recordedAt: number,
    metadata: Mp4Metadata & { sizeBytes: number },
    reusableId?: string
  ): RecordingLibraryReadyItem {
    /** 文件内部 ID。 */
    const id = reusableId ?? this.createId();

    return {
      id,
      fileName: path.basename(filePath),
      durationSeconds: metadata.durationSeconds,
      sizeBytes: fingerprint.sizeBytes,
      width: metadata.width,
      height: metadata.height,
      hasAudio: metadata.hasAudio,
      mediaUrl: `adb-studio-media://artifact/${id}`,
      status: "ready",
      recordedAt
    };
  }

  /** 创建仅在当前应用会话内有效的随机 ID。 */
  private createId(): string {
    return this.dependencies.createId?.() ?? randomUUID();
  }

  /** 查找同一路径、同一文件版本已分配的会话 ID。 */
  private findReusableId(
    filePath: string,
    directoryKey: string,
    fingerprint: FileFingerprint
  ): string | undefined {
    /** 要匹配的文件路径键。 */
    const filePathKey = createPathKey(filePath);
    return [...this.entries.values()].find(
      (entry) =>
        entry.directoryKey === directoryKey &&
        createPathKey(entry.filePath) === filePathKey &&
        isSameFingerprint(entry.fingerprint, fingerprint)
    )?.item.id;
  }

  /** 删除同一路径的旧版本条目。 */
  private removePath(filePath: string): void {
    /** 要删除的文件路径键。 */
    const filePathKey = createPathKey(filePath);
    for (const [id, entry] of this.entries) {
      if (createPathKey(entry.filePath) === filePathKey) {
        this.entries.delete(id);
      }
    }
  }

  /** 用扫描结果替换指定目录的内部索引。 */
  private replaceDirectoryEntries(
    directoryKey: string,
    entries: IndexedRecording[]
  ): void {
    for (const [id, entry] of this.entries) {
      if (entry.directoryKey === directoryKey) {
        this.entries.delete(id);
      }
    }
    entries.forEach((entry) => this.entries.set(entry.item.id, entry));
  }

  /** 读取指定目录当前已注册的公开条目。 */
  private readDirectoryItems(directoryKey: string): RecordingLibraryItem[] {
    return [...this.entries.values()]
      .filter((entry) => entry.directoryKey === directoryKey)
      .map((entry) => entry.item);
  }

  /** 发布新的不可变文件库快照。 */
  private publishSnapshot(
    directory: string,
    items: RecordingLibraryItem[],
    errorMessage?: string
  ): void {
    this.snapshotDirectoryKey = createPathKey(directory);
    this.snapshot = {
      directoryName: path.basename(directory) || directory,
      items: sortItems(items).map(cloneItem),
      refreshedAt: this.dependencies.now?.() ?? Date.now(),
      ...(errorMessage ? { errorMessage } : {})
    };
    this.listeners.forEach((listener) => listener(this.getSnapshot()));
  }

  /** 清理已完成的目录刷新任务引用。 */
  private finishRefresh(task: Promise<RecordingLibrarySnapshot>): void {
    if (this.refreshTask === task) {
      this.refreshTask = undefined;
      this.refreshDirectoryKey = "";
    }
  }

  /** 清理已完成的删除任务引用。 */
  private finishDelete(task: Promise<RecordingDeleteResult>): void {
    if (this.deleteTask === task) {
      this.deleteTask = undefined;
    }
  }

  /** 使仍在运行的旧扫描无法覆盖刚完成的录制。 */
  private invalidateRefresh(): void {
    this.refreshGeneration += 1;
    this.refreshTask = undefined;
    this.refreshDirectoryKey = "";
  }
}
