/** @jest-environment node */

jest.mock("electron", () => ({
  ipcMain: {
    handle: jest.fn(),
    removeHandler: jest.fn(),
    on: jest.fn(),
    removeListener: jest.fn()
  },
  dialog: {
    showSaveDialog: jest.fn(),
    showOpenDialog: jest.fn()
  },
  shell: {
    showItemInFolder: jest.fn(),
    openPath: jest.fn()
  }
}));

import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { registerIpcHandlers, type IpcServices } from "../../src/main/ipc";
import { ipcChannels } from "../../src/shared/ipc";
import type { RecordingDeleteResult } from "../../src/shared/types";

/** 受测 IPC 调用处理器。 */
type InvokeHandler = (
  event: IpcMainInvokeEvent,
  value?: unknown
) => unknown;

/** 创建最小主窗口与可信事件。 */
function createTrustedContext(): {
  window: BrowserWindow;
  event: IpcMainInvokeEvent;
} {
  /** 主窗口顶层帧。 */
  const mainFrame = {};
  /** 主窗口 WebContents。 */
  const webContents = { mainFrame };
  return {
    window: { webContents } as unknown as BrowserWindow,
    event: {
      sender: webContents,
      senderFrame: mainFrame
    } as unknown as IpcMainInvokeEvent
  };
}

/** 创建只覆盖删除场景的主进程服务桩。 */
function createServices(isBusy: boolean): {
  services: IpcServices;
  deleteRecordings: jest.Mock;
  startRecording: jest.Mock;
} {
  /** 删除后的空文件库结果。 */
  const result: RecordingDeleteResult = {
    deletedIds: [],
    failures: [],
    snapshot: {
      directoryName: "录制视频",
      items: [],
      refreshedAt: 1
    }
  };
  /** 文件库删除函数桩。 */
  const deleteRecordings = jest.fn().mockResolvedValue(result);
  /** 无参数录制启动函数桩。 */
  const startRecording = jest.fn().mockResolvedValue({
    status: "starting",
    elapsedMs: 0,
    audioFallback: false
  });
  /** IPC 所需服务桩。 */
  const services = {
    devices: {},
    recording: { isBusy: jest.fn(() => isBusy), start: startRecording },
    library: { deleteRecordings },
    settings: {},
    preview: { attach: jest.fn(), close: jest.fn() }
  } as unknown as IpcServices;
  return { services, deleteRecordings, startRecording };
}

describe("录制文件删除 IPC", () => {
  /** 每个通道最新注册的调用处理器。 */
  let handlers: Map<string, InvokeHandler>;

  beforeEach(() => {
    handlers = new Map();
    jest.clearAllMocks();
    (ipcMain.handle as jest.Mock).mockImplementation(
      (channel: string, handler: InvokeHandler) => {
        handlers.set(channel, handler);
      }
    );
  });

  it("校验并去重内部 ID 后调用文件库服务", async () => {
    /** 两个合法内部 UUID。 */
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    /** IPC 可信上下文。 */
    const context = createTrustedContext();
    /** 主进程服务桩。 */
    const { services, deleteRecordings } = createServices(false);
    /** 清理注册副作用的函数。 */
    const cleanup = registerIpcHandlers(context.window, services);

    try {
      /** 删除通道调用处理器。 */
      const handler = handlers.get(ipcChannels.deleteRecordings)!;
      await handler(context.event, [firstId, secondId, firstId]);

      expect(deleteRecordings).toHaveBeenCalledWith([firstId, secondId]);
    } finally {
      cleanup();
    }
  });

  it("拒绝路径参数且不调用文件系统服务", async () => {
    /** IPC 可信上下文。 */
    const context = createTrustedContext();
    /** 主进程服务桩。 */
    const { services, deleteRecordings } = createServices(false);
    /** 清理注册副作用的函数。 */
    const cleanup = registerIpcHandlers(context.window, services);

    try {
      /** 删除通道调用处理器。 */
      const handler = handlers.get(ipcChannels.deleteRecordings)!;

      await expect(
        handler(context.event, ["../../secret.mp4"])
      ).rejects.toThrow(
        "文件 ID 列表无效"
      );
      expect(deleteRecordings).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("录制或封装忙碌时优先拒绝删除", async () => {
    /** IPC 可信上下文。 */
    const context = createTrustedContext();
    /** 忙碌的主进程服务桩。 */
    const { services, deleteRecordings } = createServices(true);
    /** 清理注册副作用的函数。 */
    const cleanup = registerIpcHandlers(context.window, services);

    try {
      /** 删除通道调用处理器。 */
      const handler = handlers.get(ipcChannels.deleteRecordings)!;

      await expect(handler(context.event, [])).rejects.toThrow(
        "录制或封装期间不能删除视频"
      );
      expect(deleteRecordings).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("启动录制时不再转发设备或预设参数", async () => {
    /** IPC 可信上下文。 */
    const context = createTrustedContext();
    /** 主进程服务桩。 */
    const { services, startRecording } = createServices(false);
    /** 清理注册副作用的函数。 */
    const cleanup = registerIpcHandlers(context.window, services);

    try {
      /** 开始录制通道调用处理器。 */
      const handler = handlers.get(ipcChannels.startRecording)!;
      await handler(context.event);

      expect(startRecording).toHaveBeenCalledWith();
    } finally {
      cleanup();
    }
  });

  it("回收站操作未完成时拒绝启动录制和切换目录", async () => {
    /** 一个合法的内部 UUID。 */
    const artifactId = "00000000-0000-4000-8000-000000000001";
    /** IPC 可信上下文。 */
    const context = createTrustedContext();
    /** 空删除结果。 */
    const result: RecordingDeleteResult = {
      deletedIds: [artifactId],
      failures: [],
      snapshot: {
        directoryName: "录制视频",
        items: [],
        refreshedAt: 1
      }
    };
    /** 完成可控的回收站任务。 */
    let completeDelete!: (value: RecordingDeleteResult) => void;
    const pendingDelete = new Promise<RecordingDeleteResult>((resolve) => {
      completeDelete = resolve;
    });
    /** 主进程服务桩。 */
    const { services, deleteRecordings } = createServices(false);
    deleteRecordings.mockReturnValue(pendingDelete);
    /** 清理注册副作用的函数。 */
    const cleanup = registerIpcHandlers(context.window, services);

    try {
      /** 删除通道调用处理器。 */
      const deleteHandler = handlers.get(ipcChannels.deleteRecordings)!;
      /** 开始录制通道调用处理器。 */
      const startHandler = handlers.get(ipcChannels.startRecording)!;
      /** 切换存储目录通道调用处理器。 */
      const chooseDirectoryHandler = handlers.get(
        ipcChannels.chooseRecordingsDirectory
      )!;
      /** 尚未完成的删除 IPC。 */
      const deleting = deleteHandler(context.event, [artifactId]);

      expect(() => startHandler(context.event)).toThrow(
        "视频移入回收站期间不能开始录制"
      );
      await expect(chooseDirectoryHandler(context.event)).rejects.toThrow(
        "录制期间不能修改文件存储位置"
      );

      completeDelete(result);
      await expect(deleting).resolves.toEqual(result);
    } finally {
      completeDelete(result);
      cleanup();
    }
  });
});
