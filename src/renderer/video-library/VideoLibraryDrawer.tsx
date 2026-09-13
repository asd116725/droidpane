import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { applicationName } from "../../shared/brand";
import {
  IconAlertCircle,
  IconCheck,
  IconChevronDown,
  IconFolderOpen,
  IconLoader2,
  IconPlayerPlayFilled,
  IconSearch,
  IconTrash,
  IconVideo
} from "@tabler/icons-react";
import type {
  RecordingDeleteResult,
  RecordingLibraryItem,
  RecordingLibraryReadyItem,
  RecordingLibrarySnapshot
} from "../../shared/types";
import { formatDuration, formatFileSize } from "../../shared/formatters";
import { requestRecordingThumbnail } from "./thumbnail-service";

/** 视频库排序方式。 */
export type VideoLibrarySort = "latest" | "earliest";

/** 视频库抽屉组件属性。 */
interface VideoLibraryDrawerProps {
  /** 视频库快照。 */
  snapshot: RecordingLibrarySnapshot | null;
  /** 是否正在刷新。 */
  refreshing: boolean;
  /** 当前播放条目 ID。 */
  selectedId?: string;
  /** 需要主动露出的条目 ID。 */
  revealId?: string;
  /** 当前是否禁止删除录制。 */
  deletionLocked: boolean;
  /** 选择可播放条目。 */
  onSelect(item: RecordingLibraryReadyItem): void;
  /** 将指定录制移至系统回收站。 */
  onDelete(ids: string[]): Promise<RecordingDeleteResult>;
  /** 打开录制文件夹。 */
  onOpenFolder(): void;
}

/** 日期分组数据。 */
export interface RecordingDateGroup {
  /** 分组标题。 */
  label: string;
  /** 该日期内的条目。 */
  items: RecordingLibraryItem[];
}

/** 获取本地自然日时间戳。 */
function getDayStart(value: number): number {
  /** 待归零时间。 */
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 生成人性化日期分组标题。 */
function formatDateGroup(value: number, now: number): string {
  /** 条目自然日。 */
  const day = getDayStart(value);
  /** 今天自然日。 */
  const today = getDayStart(now);
  /** 昨天自然日，使用日历运算兼容夏令时切换。 */
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === today) {
    return "今天";
  }
  if (day === yesterday.getTime()) {
    return "昨天";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(value);
}

/** 按录制日期分组并保持指定排序。 */
export function groupRecordingLibraryItems(
  items: RecordingLibraryItem[],
  sort: VideoLibrarySort,
  now = Date.now()
): RecordingDateGroup[] {
  /** 排序后的条目副本。 */
  const sorted = [...items].sort((left, right) => {
    /** 录制时间排序结果。 */
    const timeOrder =
      sort === "latest"
        ? right.recordedAt - left.recordedAt
        : left.recordedAt - right.recordedAt;
    return timeOrder || left.fileName.localeCompare(right.fileName, "zh-CN");
  });
  /** 按自然日聚合的分组。 */
  const groups = new Map<string, RecordingLibraryItem[]>();

  sorted.forEach((item) => {
    /** 当前条目的分组标题。 */
    const label = formatDateGroup(item.recordedAt, now);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  });

  return Array.from(groups, ([label, groupItems]) => ({
    label,
    items: groupItems
  }));
}

/** 格式化录制发生时间。 */
function formatRecordedTime(value: number): string {
  /** 本地时间。 */
  const date = new Date(value);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/** 单条录制缩略图属性。 */
interface RecordingThumbnailProps {
  /** 可供读取的录制条目。 */
  item: RecordingLibraryReadyItem;
}

/** 懒加载真实视频帧缩略图，并在卸载时释放 Blob URL。 */
function RecordingThumbnail({ item }: RecordingThumbnailProps): ReactNode {
  /** IntersectionObserver 观察目标。 */
  const rootRef = useRef<HTMLDivElement>(null);
  /** 条目是否进入可视区域。 */
  const [visible, setVisible] = useState(false);
  /** 当前 Blob 图片地址。 */
  const [thumbnailUrl, setThumbnailUrl] = useState<string>();
  /** 缩略图是否加载失败。 */
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    /** 当前观察目标。 */
    const element = rootRef.current;
    if (!element) {
      return undefined;
    }
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return undefined;
    }

    /** 延迟到条目接近抽屉可视区时再解码。 */
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "120px 0px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible || !item.mediaUrl) {
      return undefined;
    }

    /** 当前缩略图请求。 */
    const request = requestRecordingThumbnail(
      item.mediaUrl,
      item.durationSeconds
    );
    /** 组件是否已卸载。 */
    let disposed = false;
    /** 当前创建的 Blob 地址。 */
    let objectUrl: string | undefined;

    setFailed(false);
    void request.promise
      .then((blob) => {
        if (disposed) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setThumbnailUrl(objectUrl);
      })
      .catch(() => {
        if (!disposed) {
          setFailed(true);
        }
      });

    return () => {
      disposed = true;
      request.cancel();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [item.durationSeconds, item.mediaUrl, visible]);

  return (
    <div className="video-library__thumbnail" ref={rootRef}>
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt={`${item.fileName} 缩略图`} />
      ) : (
        <div
          className={`video-library__thumbnail-placeholder${failed ? " is-error" : ""}`}
          aria-label={failed ? "缩略图不可用" : "正在加载缩略图"}
        >
          {failed ? (
            <IconAlertCircle size={22} stroke={1.45} />
          ) : (
            <IconVideo size={22} stroke={1.45} />
          )}
        </div>
      )}
      <span className="video-library__play" aria-hidden="true">
        <IconPlayerPlayFilled size={17} />
      </span>
    </div>
  );
}

/** 视频库条目属性。 */
interface VideoLibraryItemProps {
  /** 录制库条目。 */
  item: RecordingLibraryItem;
  /** 是否是当前播放条目。 */
  selected: boolean;
  /** 当前是否禁止删除录制。 */
  deletionLocked: boolean;
  /** 是否处于批量管理模式。 */
  managing: boolean;
  /** 是否已勾选。 */
  checked: boolean;
  /** 选择可播放条目。 */
  onSelect(item: RecordingLibraryReadyItem): void;
  /** 切换批量选择状态。 */
  onToggle(item: RecordingLibraryItem): void;
  /** 请求删除单个条目。 */
  onRequestDelete(item: RecordingLibraryItem, trigger: HTMLButtonElement): void;
}

/** 单个视频库条目。 */
function VideoLibraryItem({
  item,
  selected,
  deletionLocked,
  managing,
  checked,
  onSelect,
  onToggle,
  onRequestDelete
}: VideoLibraryItemProps): ReactNode {
  /** 当前条目是否可播放。 */
  const ready = item.status === "ready";
  /** 不可选原因。 */
  const disabledReason = ready ? undefined : item.errorMessage;
  /** 当前条目的主操作。 */
  const handleItemAction = (): void => {
    if (managing) {
      onToggle(item);
    } else if (ready) {
      onSelect(item);
    }
  };

  return (
    <div
      className={`video-library__item${selected ? " is-selected" : ""}${checked ? " is-checked" : ""}${managing ? " is-managing" : ""}${ready ? "" : " is-invalid"}`}
    >
      {managing && (
        <button
          type="button"
          className="video-library__checkbox"
          aria-label={`${checked ? "取消选择" : "选择"} ${item.fileName}`}
          aria-pressed={checked}
          disabled={deletionLocked}
          onClick={() => onToggle(item)}
        >
          {checked && <IconCheck size={14} stroke={2.5} />}
        </button>
      )}
      <button
        type="button"
        className={`video-library__item-main${selected ? " is-selected" : ""}`}
        disabled={(managing && deletionLocked) || (!managing && !ready)}
        title={disabledReason}
        aria-label={
          managing
            ? `切换选择 ${item.fileName}`
            : `${ready ? "播放" : "不可播放"} ${item.fileName}`
        }
        aria-pressed={managing ? checked : undefined}
        onClick={handleItemAction}
      >
        {ready ? (
          <RecordingThumbnail item={item} />
        ) : (
          <span className="video-library__thumbnail video-library__thumbnail--invalid">
            <IconAlertCircle size={24} stroke={1.45} />
          </span>
        )}
        <span className="video-library__item-content">
          <strong>{item.fileName}</strong>
          <span className="video-library__item-meta">
            {formatRecordedTime(item.recordedAt)}
            <i />
            {ready ? formatDuration(item.durationSeconds) : "文件不可用"}
            <i />
            {formatFileSize(item.sizeBytes)}
          </span>
          <span className="video-library__item-resolution">
            {ready ? `${item.width} × ${item.height}` : item.errorMessage}
          </span>
        </span>
      </button>
      {!managing && (
        <button
          type="button"
          className="video-library__item-delete"
          aria-label={`删除 ${item.fileName}`}
          title={deletionLocked ? "录制结束后可删除视频" : "移至回收站"}
          disabled={deletionLocked}
          onClick={(event) => onRequestDelete(item, event.currentTarget)}
        >
          <IconTrash size={18} stroke={1.65} />
        </button>
      )}
    </div>
  );
}

/** 待确认的删除操作。 */
interface DeleteConfirmation {
  /** 待删除内部 ID。 */
  ids: string[];
  /** 单条删除时展示的文件名。 */
  fileName?: string;
  /** 是否来自管理模式。 */
  batch: boolean;
}

/** 删除确认框属性。 */
interface DeleteConfirmationDialogProps {
  /** 待确认操作。 */
  confirmation: DeleteConfirmation;
  /** 是否正在提交删除。 */
  deleting: boolean;
  /** 取消操作。 */
  onCancel(): void;
  /** 确认操作。 */
  onConfirm(): void;
}

/** 将文件移至系统回收站的确认框。 */
function DeleteConfirmationDialog({
  confirmation,
  deleting,
  onCancel,
  onConfirm
}: DeleteConfirmationDialogProps): ReactNode {
  /** 待删除视频数量。 */
  const count = confirmation.ids.length;

  return createPortal(
    <div className="video-library-dialog__backdrop">
      <section
        className="video-library-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="video-library-delete-title"
        aria-describedby="video-library-delete-description"
      >
        <span className="video-library-dialog__icon" aria-hidden="true">
          <IconTrash size={27} stroke={1.65} />
        </span>
        <h2 id="video-library-delete-title">
          {confirmation.batch
            ? `删除 ${count} 个视频？`
            : `删除“${confirmation.fileName}”？`}
        </h2>
        <p id="video-library-delete-description">
          文件将移至系统回收站，可在回收站中恢复。
        </p>
        <div className="video-library-dialog__actions">
          <button type="button" disabled={deleting} autoFocus onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="is-danger"
            disabled={deleting}
            onClick={onConfirm}
          >
            {deleting ? (
              <IconLoader2 className="is-spinning" size={18} stroke={1.8} />
            ) : (
              <IconTrash size={18} stroke={1.8} />
            )}
            移至回收站
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}

/** 左侧录制视频库抽屉。 */
export function VideoLibraryDrawer({
  snapshot,
  refreshing,
  selectedId,
  revealId,
  deletionLocked,
  onSelect,
  onDelete,
  onOpenFolder
}: VideoLibraryDrawerProps): ReactNode {
  /** 文件名搜索词。 */
  const [query, setQuery] = useState("");
  /** 日期排序方向。 */
  const [sort, setSort] = useState<VideoLibrarySort>("latest");
  /** 是否处于批量管理模式。 */
  const [managing, setManaging] = useState(false);
  /** 当前勾选的内部 ID。 */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  /** 当前待确认删除操作。 */
  const [confirmation, setConfirmation] = useState<DeleteConfirmation>();
  /** 是否正在执行回收站操作。 */
  const [deleting, setDeleting] = useState(false);
  /** 最近一次删除失败提示。 */
  const [deleteMessage, setDeleteMessage] = useState<string>();
  /** 当前删除确认触发按钮，用于取消后恢复焦点。 */
  const confirmationTriggerRef = useRef<HTMLButtonElement | null>(null);
  /** 上次渲染的存储目录名称。 */
  const directoryNameRef = useRef(snapshot?.directoryName);
  /** 搜索过滤后的条目。 */
  const filteredItems = useMemo(() => {
    /** 标准化搜索词。 */
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) {
      return snapshot?.items ?? [];
    }
    return (snapshot?.items ?? []).filter((item) =>
      item.fileName.toLocaleLowerCase().includes(normalized)
    );
  }, [query, snapshot?.items]);
  /** 按日期聚合后的展示分组。 */
  const groups = useMemo(
    () => groupRecordingLibraryItems(filteredItems, sort),
    [filteredItems, sort]
  );
  /** 当前筛选结果是否已全部选中。 */
  const allFilteredSelected = Boolean(
    filteredItems.length &&
      filteredItems.every((item) => selectedIds.has(item.id))
  );
  /** 清空选择并退出管理模式。 */
  const exitManagement = useCallback((): void => {
    setManaging(false);
    setSelectedIds(new Set());
    setConfirmation(undefined);
    setDeleteMessage(undefined);
  }, []);
  /** 关闭确认框并按需恢复单删按钮焦点。 */
  const closeConfirmation = useCallback((restoreFocus = true): void => {
    setConfirmation(undefined);
    if (!restoreFocus || !confirmationTriggerRef.current) {
      return;
    }

    /** 确认框卸载后恢复焦点。 */
    const restore = (): void => confirmationTriggerRef.current?.focus();
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(restore);
    } else {
      setTimeout(restore, 0);
    }
  }, []);
  /** 切换单个条目勾选状态。 */
  const toggleItem = useCallback((item: RecordingLibraryItem): void => {
    setSelectedIds((current) => {
      /** 修改后的勾选集合。 */
      const next = new Set(current);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else {
        next.add(item.id);
      }
      return next;
    });
    setDeleteMessage(undefined);
  }, []);
  /** 切换当前筛选结果的全选状态。 */
  const toggleAllFiltered = useCallback((): void => {
    setSelectedIds(
      allFilteredSelected
        ? new Set()
        : new Set(filteredItems.map((item) => item.id))
    );
    setDeleteMessage(undefined);
  }, [allFilteredSelected, filteredItems]);
  /** 打开单条删除确认框。 */
  const requestSingleDelete = useCallback(
    (item: RecordingLibraryItem, trigger: HTMLButtonElement): void => {
      confirmationTriggerRef.current = trigger;
      setDeleteMessage(undefined);
      setConfirmation({ ids: [item.id], fileName: item.fileName, batch: false });
    },
    []
  );
  /** 打开批量删除确认框。 */
  const requestBatchDelete = useCallback(
    (trigger: HTMLButtonElement): void => {
      confirmationTriggerRef.current = trigger;
      setConfirmation({ ids: [...selectedIds], batch: true });
    },
    [selectedIds]
  );
  /** 执行已确认的单条或批量删除。 */
  const confirmDelete = useCallback(async (): Promise<void> => {
    if (!confirmation || deleting) {
      return;
    }

    setDeleting(true);
    try {
      /** 主进程返回的逐文件删除结果。 */
      const result = await onDelete(confirmation.ids);
      /** 仍需保留勾选的失败条目。 */
      const failedIds = new Set(result.failures.map((failure) => failure.id));

      if (result.failures.length) {
        setDeleteMessage(
          `${result.failures.length} 个视频未能删除：${result.failures[0].errorMessage}`
        );
        if (confirmation.batch) {
          setSelectedIds(failedIds);
        }
        closeConfirmation();
      } else if (confirmation.batch) {
        exitManagement();
      } else {
        setConfirmation(undefined);
      }
    } catch (error) {
      setDeleteMessage(
        error instanceof Error ? error.message : "视频移至回收站失败"
      );
      closeConfirmation();
    } finally {
      setDeleting(false);
    }
  }, [closeConfirmation, confirmation, deleting, exitManagement, onDelete]);

  useEffect(() => {
    if (!managing) {
      return;
    }

    /** 搜索收窄后只保留仍可见的勾选项。 */
    const visibleIds = new Set(filteredItems.map((item) => item.id));
    setSelectedIds((current) => {
      /** 过滤后的勾选集合。 */
      const next = new Set([...current].filter((id) => visibleIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [filteredItems, managing]);

  useEffect(() => {
    if (!revealId) {
      return;
    }
    setQuery("");
    setSort("latest");
    exitManagement();
  }, [exitManagement, revealId]);

  useEffect(() => {
    if (deletionLocked) {
      exitManagement();
    }
  }, [deletionLocked, exitManagement]);

  useEffect(() => {
    if (!confirmation) {
      return undefined;
    }

    /** 模态确认期间禁止背景控件获取焦点或响应指针。 */
    const appShell = document.querySelector<HTMLElement>(".app-shell");
    appShell?.setAttribute("inert", "");
    return () => appShell?.removeAttribute("inert");
  }, [confirmation]);

  useEffect(() => {
    /** 当前目录名称，目录切换时快照会先被清空。 */
    const directoryName = snapshot?.directoryName;
    if (directoryNameRef.current !== directoryName) {
      exitManagement();
      directoryNameRef.current = directoryName;
    }
  }, [exitManagement, snapshot?.directoryName]);

  useEffect(() => {
    /** Escape 依次关闭确认框和管理模式。 */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") {
        return;
      }
      if (deleting) {
        return;
      }
      if (confirmation) {
        event.preventDefault();
        closeConfirmation();
      } else if (managing) {
        event.preventDefault();
        exitManagement();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    closeConfirmation,
    confirmation,
    deleting,
    exitManagement,
    managing
  ]);

  return (
    <aside
      id="recording-library"
      className="video-library"
      aria-label="视频库"
      aria-busy={refreshing}
    >
      <header className="video-library__header">
        <div>
          <h2>视频库</h2>
          <p>{snapshot?.directoryName || applicationName}</p>
        </div>
        <div className="video-library__header-actions">
          <button
            type="button"
            className="video-library__manage"
            disabled={deletionLocked}
            onClick={managing ? exitManagement : () => setManaging(true)}
          >
            {managing ? "完成" : "管理"}
          </button>
        </div>
      </header>

      {managing && (
        <div className="video-library__selection-summary">
          <span>已选择 {selectedIds.size} 项</span>
          <button
            type="button"
            disabled={!filteredItems.length || deletionLocked}
            onClick={toggleAllFiltered}
          >
            {allFilteredSelected ? "取消全选" : "全选"}
          </button>
        </div>
      )}

      <div className="video-library__filters">
        <label className="video-library__search">
          <IconSearch size={19} stroke={1.7} />
          <input
            type="search"
            aria-label="搜索录制视频"
            placeholder="搜索录制视频"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="video-library__sort">
          <select
            aria-label="视频排序"
            value={sort}
            onChange={(event) =>
              setSort(event.target.value as VideoLibrarySort)
            }
          >
            <option value="latest">最新录制</option>
            <option value="earliest">最早录制</option>
          </select>
          <IconChevronDown size={17} stroke={1.7} />
        </label>
      </div>

      {deletionLocked && (
        <div className="video-library__locked-note">
          录制进行中，可播放历史视频，但暂不能删除视频
        </div>
      )}
      {deleteMessage && (
        <div className="video-library__error" role="status">
          <IconAlertCircle size={17} stroke={1.6} />
          {deleteMessage}
        </div>
      )}
      {snapshot?.errorMessage && (
        <div className="video-library__error" role="status">
          <IconAlertCircle size={17} stroke={1.6} />
          {snapshot.errorMessage}
        </div>
      )}

      <div className="video-library__list">
        {!snapshot ? (
          <div className="video-library__empty">
            <IconLoader2 className="is-spinning" size={25} stroke={1.5} />
            正在读取录制视频…
          </div>
        ) : groups.length ? (
          groups.map((group) => (
            <section className="video-library__group" key={group.label}>
              <h3>{group.label}</h3>
              {group.items.map((item) => (
                <VideoLibraryItem
                  key={item.id}
                  item={item}
                  selected={item.id === selectedId}
                  deletionLocked={deletionLocked}
                  managing={managing}
                  checked={selectedIds.has(item.id)}
                  onSelect={onSelect}
                  onToggle={toggleItem}
                  onRequestDelete={requestSingleDelete}
                />
              ))}
            </section>
          ))
        ) : (
          <div className="video-library__empty">
            <IconVideo size={28} stroke={1.45} />
            {query ? "没有匹配的录制视频" : "还没有录制视频"}
          </div>
        )}
      </div>

      {managing ? (
        <div className="video-library__management-footer">
          <button type="button" disabled={deleting} onClick={exitManagement}>
            取消
          </button>
          <button
            type="button"
            className="is-danger"
            disabled={!selectedIds.size || deleting || deletionLocked}
            onClick={(event) => requestBatchDelete(event.currentTarget)}
          >
            <IconTrash size={19} stroke={1.8} />
            删除 {selectedIds.size} 个视频
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="video-library__folder"
          onClick={onOpenFolder}
        >
          <IconFolderOpen size={23} stroke={1.55} />
          打开存储文件夹
        </button>
      )}

      {confirmation && (
        <DeleteConfirmationDialog
          confirmation={confirmation}
          deleting={deleting}
          onCancel={() => closeConfirmation()}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </aside>
  );
}
