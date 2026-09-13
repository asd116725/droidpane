import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../src/renderer/App";
import { groupRecordingLibraryItems } from "../../src/renderer/video-library/VideoLibraryDrawer";
import type {
  AdbStudioApi,
  DeviceInfo,
  MirrorState,
  RecordingArtifact,
  RecordingLibraryReadyItem,
  RecordingLibrarySnapshot,
  RecordingState
} from "../../src/shared/types";

jest.mock("../../src/renderer/video-library/thumbnail-service", () => ({
  requestRecordingThumbnail: jest.fn(() => ({
    promise: new Promise<Blob>(() => undefined),
    cancel: jest.fn()
  }))
}));

/** 可用测试设备。 */
const availableDevice: DeviceInfo = {
  serial: "3A261FDH2001234",
  model: "Pixel 8 Pro",
  androidVersion: "14",
  apiLevel: 34,
  connectionType: "usb",
  status: "available"
};

/** 已完成测试产物。 */
const artifact: RecordingArtifact = {
  id: "019fb6c9-db73-7143-8737-e67e0c32ac80",
  fileName: "Pixel8Pro_2026-07-31_143208.mp4",
  durationSeconds: 138,
  sizeBytes: 48_600_000,
  width: 1080,
  height: 2400,
  hasAudio: true,
  mediaUrl: ""
};

/** 创建可播放的视频库测试条目。 */
function createLibraryItem(
  id: string,
  fileName: string,
  recordedAt: number,
  mediaUrl = ""
): RecordingLibraryReadyItem {
  return {
    ...artifact,
    id,
    fileName,
    mediaUrl,
    recordedAt,
    status: "ready"
  };
}

/** 创建指定快照的桌面 API。 */
function createApi(
  devices: DeviceInfo[],
  state: RecordingState,
  currentArtifact: RecordingArtifact | null = null,
  librarySnapshot: RecordingLibrarySnapshot = {
    directoryName: "DroidPane",
    items: currentArtifact
      ? [{ ...currentArtifact, status: "ready", recordedAt: Date.now() }]
      : [],
    refreshedAt: Date.now()
  }
): jest.Mocked<AdbStudioApi> {
  /** 与录制状态匹配的默认镜像状态。 */
  const mirrorState: MirrorState = ["starting", "recording", "stopping"].includes(
    state.status
  )
    ? {
        status: "mirroring",
        deviceSerial: state.deviceSerial ?? devices[0]?.serial,
        preset: {
          resolution: "1080p",
          videoBitrateMbps: 8,
          audioMode: "device"
        },
        audioFallback: state.audioFallback,
        audioFallbackReason: state.audioFallbackReason,
        previewStatus: "connecting"
      }
    : {
        status: "idle",
        audioFallback: false
      };
  return {
    getDevices: jest.fn().mockResolvedValue(devices),
    refreshDevices: jest.fn().mockResolvedValue(devices),
    onDevicesChanged: jest.fn().mockReturnValue(() => undefined),
    getRecordingState: jest.fn().mockResolvedValue(state),
    onRecordingStateChanged: jest.fn().mockReturnValue(() => undefined),
    getRecordingArtifact: jest.fn().mockResolvedValue(currentArtifact),
    onRecordingArtifactChanged: jest.fn().mockReturnValue(() => undefined),
    getRecordingLibrary: jest.fn().mockResolvedValue(librarySnapshot),
    refreshRecordingLibrary: jest.fn().mockResolvedValue(librarySnapshot),
    deleteRecordings: jest.fn().mockResolvedValue({
      deletedIds: [],
      failures: [],
      snapshot: librarySnapshot
    }),
    onRecordingLibraryChanged: jest.fn().mockReturnValue(() => undefined),
    requestLivePreview: jest.fn(),
    getMirrorState: jest.fn().mockResolvedValue(mirrorState),
    onMirrorStateChanged: jest.fn().mockReturnValue(() => undefined),
    startMirroring: jest.fn().mockResolvedValue({
      ...mirrorState,
      status: "mirroring"
    }),
    stopMirroring: jest.fn().mockResolvedValue({
      status: "idle",
      audioFallback: false
    }),
    sendDeviceControl: jest.fn(),
    startRecording: jest.fn(),
    stopRecording: jest.fn(),
    exportRecording: jest.fn().mockResolvedValue({ canceled: true }),
    openRecordingFolder: jest.fn().mockResolvedValue(undefined),
    getSettings: jest.fn().mockResolvedValue({
      preset: {
        resolution: "1080p",
        videoBitrateMbps: 8,
        audioMode: "device"
      },
      audioMonitor: {
        autoEnableOnLegacyAndroid: false,
        volume: 0.8
      },
      recordingsDirectory: "/Users/test/Movies/DroidPane"
    }),
    setSettings: jest.fn().mockImplementation(async (settings) => ({
      ...settings,
      recordingsDirectory: "/Users/test/Movies/DroidPane"
    })),
    chooseRecordingsDirectory: jest.fn().mockResolvedValue({
      canceled: true,
      settings: {
        preset: {
          resolution: "1080p",
          videoBitrateMbps: 8,
          audioMode: "device"
        },
        audioMonitor: {
          autoEnableOnLegacyAndroid: false,
          volume: 0.8
        },
        recordingsDirectory: "/Users/test/Movies/DroidPane"
      }
    }),
    controlWindow: jest.fn().mockResolvedValue(undefined)
  };
}

/** 切换到视频库工作区。 */
async function openLibrary(
  user: ReturnType<typeof userEvent.setup>
): Promise<void> {
  await user.click(await screen.findByRole("tab", { name: "视频库" }));
}

describe("DroidPane界面", () => {
  it("空闲时可独立开启镜像并展示五项设备控制", async () => {
    /** 空闲态 API。 */
    const api = createApi([availableDevice], {
      status: "idle",
      elapsedMs: 0,
      audioFallback: false
    });
    api.startMirroring.mockResolvedValue({
      status: "mirroring",
      deviceSerial: availableDevice.serial,
      preset: {
        resolution: "1080p",
        videoBitrateMbps: 8,
        audioMode: "device"
      },
      fps: 30,
      audioFallback: false,
      previewStatus: "connecting"
    });
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);
    await user.click(
      await screen.findByRole("button", { name: "开启镜像控制" })
    );

    expect(api.startMirroring).toHaveBeenCalledWith(
      availableDevice.serial,
      expect.objectContaining({ resolution: "1080p" })
    );
    expect(await screen.findByText("镜像控制中")).toBeInTheDocument();
    expect(screen.getByText("30 FPS")).toBeInTheDocument();
    /** 当前镜像工作区页签。 */
    const deviceTab = screen.getByRole("tab", { name: "镜像录制" });
    expect(deviceTab).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("tab", { name: "视频库" }));
    expect(
      screen.getByRole("tab", { name: /镜像录制.*镜像运行中/ })
    ).toHaveAttribute("aria-selected", "false");
    await user.click(
      screen.getByRole("tab", { name: /镜像录制.*镜像运行中/ })
    );
    expect(
      within(screen.getByRole("complementary", { name: "设备控制" }))
        .getAllByRole("button")
    ).toHaveLength(5);
    await user.click(
      screen.getByRole("button", { name: "打开下拉菜单" })
    );
    await user.click(
      screen.getByRole("button", { name: "关闭下拉菜单" })
    );
    expect(api.sendDeviceControl).toHaveBeenNthCalledWith(1, {
      type: "expand-notification-panel"
    });
    expect(api.sendDeviceControl).toHaveBeenNthCalledWith(2, {
      type: "collapse-notification-panel"
    });
    /** 镜像期间锁定的录制参数。 */
    const lockedPresetSelects = [
      screen.getByRole("combobox", { name: "录制分辨率" }),
      screen.getByRole("combobox", { name: "视频码率" }),
      screen.getByRole("combobox", { name: "录制音频" })
    ];
    lockedPresetSelects.forEach((select) => expect(select).toBeDisabled());
    expect(
      screen.getByRole("status", { name: "录制参数锁定提示" })
    ).toHaveTextContent("镜像进行中，结束镜像后可修改录制参数");
    expect(lockedPresetSelects[0].closest(".preset-select")).toHaveClass(
      "is-disabled"
    );
    expect(
      document.querySelector(".recording-dock__presets .tabler-icon-lock")
    ).not.toBeInTheDocument();
    await user.click(
      lockedPresetSelects[0].closest(".preset-select") as HTMLElement
    );
    await waitFor(() =>
      expect(
        screen.getAllByText("镜像进行中，结束镜像后可修改录制参数")
      ).toHaveLength(2)
    );
    lockedPresetSelects.forEach((select) =>
      expect(select).toHaveAttribute(
        "aria-describedby",
        "recording-preset-lock-note"
      )
    );
    expect(screen.getByRole("button", { name: "开始录制" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "结束镜像" }));
    await waitFor(() =>
      lockedPresetSelects.forEach((select) => expect(select).toBeEnabled())
    );
    expect(
      screen.queryByRole("status", { name: "录制参数锁定提示" })
    ).not.toBeInTheDocument();
  });

  it("设备可用但镜像未开启时点击录制显示 Ant Design 提示", async () => {
    /** 空闲态 API。 */
    const api = createApi([availableDevice], {
      status: "idle",
      elapsedMs: 0,
      audioFallback: false
    });
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);

    await screen.findByText(availableDevice.serial);
    /** 未开启镜像时的录制按钮。 */
    const startButton = await screen.findByRole("button", {
      name: "开始录制"
    });
    expect(startButton).not.toBeDisabled();
    expect(startButton).toHaveAttribute("aria-disabled", "true");
    expect(startButton).toHaveClass("is-disabled");
    expect(
      screen.queryByText("请先开启镜像后再开始录制")
    ).not.toBeInTheDocument();

    await user.click(startButton);

    expect(
      await screen.findByText("请先开启镜像后再开始录制")
    ).toBeInTheDocument();
    expect(api.startRecording).not.toHaveBeenCalled();
  });

  it("镜像会话运行时即使预览不可用也允许无参数启动录制", async () => {
    /** 已建立镜像但预览不可用的 API。 */
    const api = createApi([availableDevice], {
      status: "idle",
      elapsedMs: 0,
      audioFallback: false
    });
    api.getMirrorState.mockResolvedValue({
      status: "mirroring",
      deviceSerial: availableDevice.serial,
      preset: {
        resolution: "1080p",
        videoBitrateMbps: 8,
        audioMode: "device"
      },
      audioFallback: false,
      previewStatus: "unavailable",
      previewMessage: "实时预览 Worker 启动失败，录制仍可继续"
    });
    api.startRecording.mockResolvedValue({
      status: "recording",
      startedAt: Date.now(),
      elapsedMs: 0,
      fps: 0,
      deviceSerial: availableDevice.serial,
      audioFallback: false
    });
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);
    /** 当前镜像对应的录制按钮。 */
    const startButton = await screen.findByRole("button", {
      name: "开始录制"
    });
    await waitFor(() => expect(startButton).toBeEnabled());
    expect(
      screen.queryByText("请先开启镜像后再开始录制")
    ).not.toBeInTheDocument();
    await user.click(startButton);

    expect(api.startRecording).toHaveBeenCalledWith();
  });

  it("录制参数下拉框可选择并持久化分辨率、码率和音频", async () => {
    /** 空闲态 API。 */
    const api = createApi([availableDevice], {
      status: "idle",
      elapsedMs: 0,
      audioFallback: false
    });
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);

    await user.click(
      await screen.findByRole("combobox", { name: "录制分辨率" })
    );
    await user.click(
      await screen.findByRole("option", { name: "原始分辨率" })
    );
    await user.click(screen.getByRole("combobox", { name: "视频码率" }));
    await user.click(await screen.findByRole("option", { name: "16 Mbps" }));
    await user.click(screen.getByRole("combobox", { name: "录制音频" }));
    await user.hover(
      await screen.findByLabelText("设备音频实际效果说明")
    );
    expect(
      await screen.findByText(/最终 MP4 包含 AAC 音轨/)
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "静音录制" }));

    await waitFor(() =>
      expect(api.setSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          preset: {
            resolution: "original",
            videoBitrateMbps: 16,
            audioMode: "silent"
          }
        })
      )
    );
  });

  it("完成态展示播放器、文件信息并可触发 MP4 导出", async () => {
    /** 完成态 API。 */
    const api = createApi(
      [availableDevice],
      {
        status: "ready",
        elapsedMs: 138_000,
        audioFallback: false,
        artifactId: artifact.id
      },
      artifact
    );
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);

    await openLibrary(user);

    expect(screen.getAllByText("DroidPane")).toHaveLength(2);
    expect(await screen.findByText("Pixel 8 Pro")).toBeInTheDocument();
    expect(screen.getAllByText(artifact.fileName)).toHaveLength(2);
    expect(screen.getByText("48.6 MB")).toBeInTheDocument();
    expect(screen.getAllByText("1080 × 2400")).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: "重新录制" })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "导出 MP4" }));
    expect(api.exportRecording).toHaveBeenCalledWith(artifact.id);
    expect(screen.queryByText("MP4 已导出")).not.toBeInTheDocument();
  });

  it("完成态预加载录制视频并定位真实首帧", async () => {
    /** 带安全媒体地址的完成产物。 */
    const mediaArtifact = {
      ...artifact,
      mediaUrl: `adb-studio-media://artifact/${artifact.id}`
    };
    /** 完成态 API。 */
    const api = createApi(
      [availableDevice],
      {
        status: "ready",
        elapsedMs: 45_000,
        audioFallback: false,
        artifactId: artifact.id
      },
      mediaArtifact
    );
    /** 当前渲染容器。 */
    const { container } = render(<App api={api} />);

    await openLibrary(userEvent.setup());

    expect(await screen.findAllByText(mediaArtifact.fileName)).toHaveLength(2);
    /** 完成态视频元素。 */
    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 45
    });
    fireEvent.loadedMetadata(video);

    expect(video).toHaveAttribute("preload", "auto");
    expect(video).not.toHaveAttribute("poster");
    expect(video.currentTime).toBeCloseTo(0.01);
    expect(video.volume).toBeCloseTo(0.82);
    expect(video.playbackRate).toBe(1);
  });

  it("没有设备时点击视觉禁用的录制按钮显示连接提示", async () => {
    /** 空设备 API。 */
    const api = createApi([], {
      status: "idle",
      elapsedMs: 0,
      audioFallback: false
    });
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);

    expect(
      await screen.findByText("连接 Android 设备开始录制")
    ).toBeInTheDocument();
    /** 空闲态开始按钮。 */
    const startButton = screen.getByRole("button", { name: "开始录制" });
    expect(startButton).toHaveAttribute("aria-disabled", "true");
    expect(startButton).toHaveClass("is-disabled");
    expect(
      startButton.querySelector(".tabler-icon-player-play-filled")
    ).toBeInTheDocument();

    await user.click(startButton);

    expect(
      await screen.findByText("请先连接设备并开启镜像")
    ).toBeInTheDocument();
    expect(api.startRecording).not.toHaveBeenCalled();
  });

  it("未授权设备保留在列表中并提示手机确认调试授权", async () => {
    /** 未授权设备。 */
    const unauthorized: DeviceInfo = {
      ...availableDevice,
      model: "未知设备",
      status: "unauthorized"
    };
    /** 未授权 API。 */
    const api = createApi([unauthorized], {
      status: "idle",
      elapsedMs: 0,
      audioFallback: false
    });

    render(<App api={api} />);

    expect(
      await screen.findByText("请在手机上确认 USB 调试授权")
    ).toBeInTheDocument();
    expect(screen.getByText("未授权")).toBeInTheDocument();
  });

  it("录制中点击停止后立即进入 MP4 封装反馈", async () => {
    /** 停止处理中状态。 */
    const stoppingState: RecordingState = {
      status: "stopping",
      elapsedMs: 42_000,
      startedAt: Date.now() - 42_000,
      deviceSerial: availableDevice.serial,
      audioFallback: false
    };
    /** 录制态 API。 */
    const api = createApi([availableDevice], {
      ...stoppingState,
      status: "recording"
    });
    api.stopRecording.mockResolvedValue(stoppingState);
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);

    /** 录制态停止按钮。 */
    const stopButton = await screen.findByRole("button", {
      name: "停止录制"
    });
    expect(
      stopButton.querySelector(".tabler-icon-square-filled")
    ).toBeInTheDocument();
    await user.click(stopButton);

    expect(api.stopRecording).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("封装中")).toBeInTheDocument();
  });

  it("录制态隐藏无效控制并保留预览全屏与停止动作", async () => {
    /** 实时录制态 API。 */
    const api = createApi([availableDevice], {
      status: "recording",
      elapsedMs: 8_000,
      fps: 30,
      startedAt: Date.now() - 8_000,
      deviceSerial: availableDevice.serial,
      audioFallback: false
    });

    render(<App api={api} />);

    expect(await screen.findByText("30 FPS")).toBeInTheDocument();

    expect(
      await screen.findByLabelText("安卓设备实时预览")
    ).toBeInTheDocument();
    expect(screen.getByText("正在连接实时画面")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "播放" })
    ).not.toBeInTheDocument();
    expect(screen.getByText("尚未生成录制文件")).not.toBeVisible();
    expect(
      screen.queryByRole("combobox", { name: "录制分辨率" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "重新录制" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "全屏镜像" })
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "停止录制" })
    ).toBeEnabled();
    expect(api.requestLivePreview).toHaveBeenCalledTimes(1);
  });

  it("镜像与视频播放器分别使用自己的全屏目标", async () => {
    /** 带媒体地址的历史录制。 */
    const mediaArtifact = {
      ...artifact,
      mediaUrl: `adb-studio-media://artifact/${artifact.id}`
    };
    /** 录制态 API。 */
    const api = createApi(
      [availableDevice],
      {
        status: "recording",
        elapsedMs: 8_000,
        deviceSerial: availableDevice.serial,
        audioFallback: false
      },
      mediaArtifact
    );
    /** 全屏请求桩。 */
    const requestFullscreen = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen
    });
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);
    await user.click(await screen.findByRole("button", { name: "全屏镜像" }));
    await openLibrary(user);
    await user.click(screen.getByRole("button", { name: "全屏预览" }));

    expect(requestFullscreen).toHaveBeenCalledTimes(2);
    expect(requestFullscreen.mock.instances[0]).toHaveClass("stage");
    expect(requestFullscreen.mock.instances[0]).not.toHaveClass(
      "stage--playback"
    );
    expect(requestFullscreen.mock.instances[1]).toHaveClass(
      "stage--playback"
    );
    expect(requestFullscreen.mock.instances[0]).not.toBe(
      requestFullscreen.mock.instances[1]
    );
    Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
  });

  it("Android 11/12 录制停止后保持电脑监听并持久化音量", async () => {
    /** Android 12 测试设备。 */
    const legacyDevice: DeviceInfo = {
      ...availableDevice,
      androidVersion: "12",
      apiLevel: 31
    };
    /** 可与设备监听同时播放的历史视频。 */
    const listeningArtifact = {
      ...artifact,
      mediaUrl: `adb-studio-media://artifact/${artifact.id}`
    };
    /** 录制态 API。 */
    const api = createApi(
      [legacyDevice],
      {
        status: "recording",
        elapsedMs: 8_000,
        startedAt: Date.now() - 8_000,
        deviceSerial: legacyDevice.serial,
        audioFallback: false
      },
      listeningArtifact
    );
    /** 系统音频暂停桩。 */
    const suspendAudio = jest.fn();
    /** Web Audio 上下文桩。 */
    class FakeAudioContext {
      /** 当前上下文状态。 */
      state = "suspended";
      /** 当前播放时间。 */
      currentTime = 0;
      /** 系统默认输出。 */
      destination = {};
      /** 创建监听增益。 */
      createGain(): GainNode {
        return {
          gain: { value: 1 },
          connect: jest.fn()
        } as unknown as GainNode;
      }
      /** 创建未使用的 PCM 缓冲。 */
      createBuffer(): AudioBuffer {
        throw new Error("测试未播放 PCM");
      }
      /** 创建未使用的音源。 */
      createBufferSource(): AudioBufferSourceNode {
        throw new Error("测试未播放 PCM");
      }
      /** 恢复系统输出。 */
      async resume(): Promise<void> {
        this.state = "running";
      }
      /** 暂停系统输出。 */
      async suspend(): Promise<void> {
        this.state = "suspended";
        suspendAudio();
      }
      /** 关闭系统输出。 */
      async close(): Promise<void> {}
    }
    (globalThis as any).AudioContext = FakeAudioContext;
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);
    await user.click(
      await screen.findByRole("button", { name: "开启电脑监听" })
    );

    expect(
      await screen.findByRole("button", { name: "关闭电脑监听" })
    ).toHaveAttribute("aria-pressed", "true");
    /** 监听音量滑杆。 */
    const slider = screen.getByRole("slider", { name: "电脑监听音量" });
    expect(slider).toHaveValue("80");
    expect(api.setSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        audioMonitor: {
          autoEnableOnLegacyAndroid: true,
          volume: 0.8
        }
      })
    );

    fireEvent.change(slider, { target: { value: "45" } });
    await waitFor(() =>
      expect(api.setSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          audioMonitor: {
            autoEnableOnLegacyAndroid: true,
            volume: 0.45
          }
        })
      )
    );

    api.stopRecording.mockResolvedValue({
      status: "ready",
      elapsedMs: 8_000,
      fps: 30,
      deviceSerial: legacyDevice.serial,
      artifactId: artifact.id,
      audioFallback: false
    });
    await user.click(screen.getByRole("button", { name: "停止录制" }));
    expect(api.stopRecording).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("button", { name: "关闭电脑监听" })
    ).toHaveAttribute("aria-pressed", "true");

    /** 历史视频播放桩。 */
    const play = HTMLMediaElement.prototype.play as jest.Mock;
    play.mockClear();
    await openLibrary(user);
    await user.click(screen.getByRole("button", { name: "播放" }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(suspendAudio).not.toHaveBeenCalled();
    delete (globalThis as any).AudioContext;
  });

  it("Android 13+ 每次录制默认关闭电脑监听并提示回声风险", async () => {
    /** 记住旧版设备监听偏好的 API。 */
    const api = createApi([availableDevice], {
      status: "recording",
      elapsedMs: 8_000,
      startedAt: Date.now() - 8_000,
      deviceSerial: availableDevice.serial,
      audioFallback: false
    });
    api.getSettings.mockResolvedValue({
      preset: {
        resolution: "1080p",
        videoBitrateMbps: 8,
        audioMode: "device"
      },
      audioMonitor: {
        autoEnableOnLegacyAndroid: true,
        volume: 0.8
      },
      recordingsDirectory: "/Users/test/Movies/DroidPane"
    });

    render(<App api={api} />);

    expect(
      await screen.findByRole("button", { name: "开启电脑监听" })
    ).toHaveAttribute(
      "data-tooltip",
      "Android 13+ 手机已有声音，开启电脑监听可能产生回声"
    );
    expect(
      screen.queryByRole("slider", { name: "电脑监听音量" })
    ).not.toBeInTheDocument();
  });

  it("静音录制不展示电脑监听入口", async () => {
    /** 静音录制态 API。 */
    const api = createApi([availableDevice], {
      status: "recording",
      elapsedMs: 8_000,
      startedAt: Date.now() - 8_000,
      deviceSerial: availableDevice.serial,
      audioFallback: false
    });
    api.getSettings.mockResolvedValue({
      preset: {
        resolution: "1080p",
        videoBitrateMbps: 8,
        audioMode: "silent"
      },
      audioMonitor: {
        autoEnableOnLegacyAndroid: true,
        volume: 0.8
      },
      recordingsDirectory: "/Users/test/Movies/DroidPane"
    });

    render(<App api={api} />);

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "开启电脑监听" })
      ).not.toBeInTheDocument()
    );
  });

  it("错误态显示主进程返回的明确原因", async () => {
    /** 磁盘错误 API。 */
    const api = createApi([availableDevice], {
      status: "error",
      elapsedMs: 0,
      audioFallback: false,
      errorMessage: "磁盘写入失败"
    });

    render(<App api={api} />);

    await waitFor(() =>
      expect(screen.getByText("磁盘写入失败")).toBeInTheDocument()
    );
  });

  it("设置菜单可修改并打开当前录制目录，产物入口仍定位具体文件", async () => {
    /** 完成态 API。 */
    const api = createApi(
      [availableDevice],
      {
        status: "ready",
        elapsedMs: 138_000,
        audioFallback: false,
        artifactId: artifact.id
      },
      artifact
    );
    api.chooseRecordingsDirectory.mockResolvedValue({
      canceled: false,
      settings: {
        preset: {
          resolution: "1080p",
          videoBitrateMbps: 8,
          audioMode: "device"
        },
        audioMonitor: {
          autoEnableOnLegacyAndroid: false,
          volume: 0.8
        },
        recordingsDirectory: "/Volumes/录屏/Android"
      }
    });
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);

    await openLibrary(user);

    await user.click(await screen.findByRole("button", { name: "已保存" }));
    expect(api.openRecordingFolder).toHaveBeenLastCalledWith(artifact.id);

    await user.click(screen.getByRole("button", { name: "应用设置" }));
    expect(
      screen.getByText("/Users/test/Movies/DroidPane")
    ).toHaveAttribute("title", "/Users/test/Movies/DroidPane");
    await user.click(screen.getByRole("button", { name: "修改存储位置" }));
    expect(api.chooseRecordingsDirectory).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("录制存储位置已更新")).toBeInTheDocument();
    expect(screen.getByText("尚未生成录制文件")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出 MP4" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "应用设置" }));
    expect(screen.getByText("/Volumes/录屏/Android")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "打开录制文件夹" })
    );
    expect(api.openRecordingFolder).toHaveBeenLastCalledWith();

    await user.click(screen.getByRole("button", { name: "应用设置" }));
    await user.click(
      screen.getByRole("button", { name: "打开开发者控制台" })
    );
    expect(api.controlWindow).toHaveBeenLastCalledWith("open-devtools");
  });

  it("录制期间禁止修改文件存储位置", async () => {
    /** 录制态 API。 */
    const api = createApi([availableDevice], {
      status: "recording",
      elapsedMs: 8_000,
      startedAt: Date.now() - 8_000,
      deviceSerial: availableDevice.serial,
      audioFallback: false
    });
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);

    await user.click(await screen.findByRole("button", { name: "应用设置" }));
    expect(
      screen.getByRole("button", { name: "修改存储位置" })
    ).toBeDisabled();
  });

  it("视频库支持日期分组、搜索和最新最早排序", async () => {
    /** 固定测试当前时间。 */
    const now = new Date(2026, 7, 1, 15, 0, 0).getTime();
    /** 同时间用于验证文件名稳定排序的条目。 */
    const alpha = createLibraryItem("alpha", "Alpha.mp4", now);
    /** 同时间用于验证文件名稳定排序的条目。 */
    const beta = createLibraryItem("beta", "Beta.mp4", now);
    /** 昨天的录制条目。 */
    const yesterday = createLibraryItem(
      "yesterday",
      "Yesterday.mp4",
      now - 24 * 60 * 60 * 1_000
    );
    /** 分组排序结果。 */
    const groups = groupRecordingLibraryItems(
      [beta, yesterday, alpha],
      "latest",
      now
    );

    expect(groups.map((group) => group.label)).toEqual(["今天", "昨天"]);
    expect(groups[0].items.map((item) => item.fileName)).toEqual([
      "Alpha.mp4",
      "Beta.mp4"
    ]);

    /** 带视频库数据的完成态 API。 */
    const api = createApi(
      [availableDevice],
      {
        status: "ready",
        elapsedMs: 138_000,
        audioFallback: false,
        artifactId: artifact.id
      },
      artifact,
      {
        directoryName: "DroidPane",
        items: [beta, yesterday, alpha],
        refreshedAt: now
      }
    );
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);
    await openLibrary(user);

    expect(api.refreshRecordingLibrary).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("complementary", { name: "视频库" })).toBeVisible();
    expect(screen.getAllByText("Alpha.mp4")).toHaveLength(1);
    await user.type(screen.getByRole("searchbox", { name: "搜索录制视频" }), "Yesterday");
    expect(screen.queryByText("Alpha.mp4")).not.toBeInTheDocument();
    expect(screen.getByText("Yesterday.mp4")).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "视频排序" }),
      "earliest"
    );
    expect(
      screen.getByRole("combobox", { name: "视频排序" })
    ).toHaveValue("earliest");

    await user.click(screen.getByRole("tab", { name: /镜像录制/ }));
    await openLibrary(user);
    expect(screen.getByRole("searchbox", { name: "搜索录制视频" })).toHaveValue(
      "Yesterday"
    );
    expect(
      screen.getByRole("combobox", { name: "视频排序" })
    ).toHaveValue("earliest");
    expect(screen.queryByText("Alpha.mp4")).not.toBeInTheDocument();
  });

  it("点击历史录制会停在首帧，并可通过控制栏播放和暂停", async () => {
    /** 历史视频条目。 */
    const history = createLibraryItem(
      "history",
      "History_Recording.mp4",
      Date.now() - 60_000,
      "adb-studio-media://artifact/history"
    );
    /** 带历史视频的完成态 API。 */
    const api = createApi(
      [availableDevice],
      {
        status: "ready",
        elapsedMs: 138_000,
        audioFallback: false,
        artifactId: artifact.id
      },
      artifact,
      {
        directoryName: "DroidPane",
        items: [history],
        refreshedAt: Date.now()
      }
    );
    /** 媒体播放桩。 */
    const play = HTMLMediaElement.prototype.play as jest.Mock;
    /** 媒体暂停桩。 */
    const pause = HTMLMediaElement.prototype.pause as jest.Mock;
    play.mockClear();
    pause.mockClear();
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);
    await openLibrary(user);
    await user.click(
      screen.getByRole("button", { name: "播放 History_Recording.mp4" })
    );

    /** 切换后的舞台视频。 */
    const video = document.querySelector(".stage__video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: 5
    });
    /** 媒体元素实际暂停状态。 */
    let paused = true;
    Object.defineProperty(video, "paused", {
      configurable: true,
      get: () => paused
    });
    play.mockImplementationOnce(() => {
      paused = false;
      return Promise.resolve();
    });
    fireEvent.loadedMetadata(video);

    expect(play).not.toHaveBeenCalled();
    expect(video.currentTime).toBeCloseTo(0.01);
    await user.click(screen.getByRole("button", { name: "播放" }));
    expect(play).toHaveBeenCalledTimes(1);

    fireEvent.play(video);
    /** 点击暂停前已发生的暂停次数。 */
    const pauseCalls = pause.mock.calls.length;
    pause.mockImplementationOnce(() => {
      paused = true;
    });
    await user.click(screen.getByRole("button", { name: "暂停" }));
    expect(pause).toHaveBeenCalledTimes(pauseCalls + 1);
    expect(paused).toBe(true);
    expect(screen.getAllByText("History_Recording.mp4").length).toBeGreaterThan(1);
    expect(screen.queryByText(/录制已完成/)).not.toBeInTheDocument();
  });

  it("录制中可切换并播放历史视频，后台录制不中断", async () => {
    /** 历史视频条目。 */
    const history = createLibraryItem(
      "history-recording",
      "Recording_Background.mp4",
      Date.now(),
      "adb-studio-media://artifact/history-recording"
    );
    /** 录制态视频库 API。 */
    const api = createApi(
      [availableDevice],
      {
        status: "recording",
        elapsedMs: 8_000,
        deviceSerial: availableDevice.serial,
        audioFallback: false
      },
      null,
      {
        directoryName: "DroidPane",
        items: [history],
        refreshedAt: Date.now()
      }
    );
    /** 媒体播放桩。 */
    const play = HTMLMediaElement.prototype.play as jest.Mock;
    play.mockClear();
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);
    await openLibrary(user);

    expect(
      screen.getByText("录制进行中，可播放历史视频，但暂不能删除视频")
    ).toBeVisible();
    /** 录制中的历史视频入口。 */
    const historyButton = screen.getByRole("button", {
      name: "播放 Recording_Background.mp4"
    });
    expect(historyButton).toBeEnabled();
    await user.click(historyButton);
    expect(
      screen.getByRole("button", { name: "删除 Recording_Background.mp4" })
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "管理" })).toBeDisabled();

    expect(screen.getByRole("button", { name: "播放" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "播放" }));
    expect(play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("searchbox", { name: "搜索录制视频" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "停止录制" })).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "设备控制" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /镜像录制.*录制中/ })
    ).toHaveAttribute("aria-selected", "false");
    expect(api.stopRecording).not.toHaveBeenCalled();
    expect(api.requestLivePreview).toHaveBeenCalledTimes(1);
  });

  it("单条删除经确认移至回收站，并清空当前播放文件", async () => {
    /** 当前文件对应的视频库条目。 */
    const currentItem = createLibraryItem(
      artifact.id,
      artifact.fileName,
      Date.now()
    );
    /** 完成态视频库 API。 */
    const api = createApi(
      [availableDevice],
      {
        status: "ready",
        elapsedMs: 138_000,
        audioFallback: false,
        artifactId: artifact.id
      },
      artifact,
      {
        directoryName: "DroidPane",
        items: [currentItem],
        refreshedAt: Date.now()
      }
    );
    api.deleteRecordings.mockResolvedValue({
      deletedIds: [artifact.id],
      failures: [],
      snapshot: {
        directoryName: "DroidPane",
        items: [],
        refreshedAt: Date.now()
      }
    });
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);
    await openLibrary(user);
    /** 当前条目的单删触发按钮。 */
    const deleteButton = screen.getByRole("button", {
      name: `删除 ${artifact.fileName}`
    });
    await user.click(deleteButton);

    expect(
      screen.getByRole("alertdialog", { name: `删除“${artifact.fileName}”？` })
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(deleteButton).toHaveFocus());
    await user.click(deleteButton);
    await user.click(screen.getByRole("button", { name: "移至回收站" }));

    await waitFor(() =>
      expect(api.deleteRecordings).toHaveBeenCalledWith([artifact.id])
    );
    expect(screen.queryByText(artifact.fileName)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出 MP4" })).toBeDisabled();
    expect(screen.getByText("视频已移至回收站")).toBeVisible();
  });

  it("管理模式支持当前筛选全选，部分失败后仅保留失败项", async () => {
    /** 可正常删除的视频。 */
    const alpha = createLibraryItem("alpha-delete", "Alpha.mp4", Date.now());
    /** 损坏但仍可删除的视频。 */
    const broken: RecordingLibrarySnapshot["items"][number] = {
      id: "broken-delete",
      fileName: "Broken.mp4",
      sizeBytes: 0,
      recordedAt: Date.now() - 1_000,
      status: "invalid",
      errorMessage: "文件无法读取"
    };
    /** 带混合条目的视频库 API。 */
    const api = createApi(
      [availableDevice],
      {
        status: "idle",
        elapsedMs: 0,
        audioFallback: false
      },
      null,
      {
        directoryName: "DroidPane",
        items: [alpha, broken],
        refreshedAt: Date.now()
      }
    );
    api.deleteRecordings.mockResolvedValue({
      deletedIds: [alpha.id],
      failures: [
        {
          id: broken.id,
          fileName: broken.fileName,
          errorMessage: "文件正在被占用"
        }
      ],
      snapshot: {
        directoryName: "DroidPane",
        items: [broken],
        refreshedAt: Date.now()
      }
    });
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);
    await openLibrary(user);
    await user.click(screen.getByRole("button", { name: "管理" }));
    await user.click(screen.getByRole("button", { name: "全选" }));
    expect(screen.getByText("已选择 2 项")).toBeVisible();
    expect(screen.getByRole("button", { name: "取消全选" })).toBeVisible();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "视频排序" }),
      "earliest"
    );
    expect(screen.getByText("已选择 2 项")).toBeVisible();

    await user.type(
      screen.getByRole("searchbox", { name: "搜索录制视频" }),
      "Alpha"
    );
    expect(screen.getByText("已选择 1 项")).toBeVisible();
    await user.clear(screen.getByRole("searchbox", { name: "搜索录制视频" }));
    await user.click(screen.getByRole("button", { name: "选择 Broken.mp4" }));
    await user.click(screen.getByRole("button", { name: "删除 2 个视频" }));
    await user.click(screen.getByRole("button", { name: "移至回收站" }));

    await waitFor(() =>
      expect(api.deleteRecordings).toHaveBeenCalledWith([
        "alpha-delete",
        "broken-delete"
      ])
    );
    expect(screen.getByText("已选择 1 项")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "取消选择 Broken.mp4" })
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("1 个视频未能删除：文件正在被占用")
    ).toBeVisible();
    expect(screen.queryByText("Alpha.mp4")).not.toBeInTheDocument();
  });

  it("Escape 依次关闭删除确认和管理模式", async () => {
    /** 待批量选择的视频。 */
    const item = createLibraryItem("escape-delete", "Escape.mp4", Date.now());
    /** 视频库 API。 */
    const api = createApi(
      [availableDevice],
      { status: "idle", elapsedMs: 0, audioFallback: false },
      null,
      {
        directoryName: "DroidPane",
        items: [item],
        refreshedAt: Date.now()
      }
    );
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);
    await openLibrary(user);
    await user.click(screen.getByRole("button", { name: "管理" }));
    await user.click(screen.getByRole("button", { name: "选择 Escape.mp4" }));
    await user.click(screen.getByRole("button", { name: "删除 1 个视频" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("已选择 1 项")).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("已选择 1 项")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "管理" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "视频库" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("页签支持键盘切换，离开视频库暂停但保留播放位置", async () => {
    /** 用于验证播放状态保留的历史视频。 */
    const history = createLibraryItem(
      "history-tab",
      "Tab_State.mp4",
      Date.now(),
      "adb-studio-media://artifact/history-tab"
    );
    /** 带历史视频的空闲态 API。 */
    const api = createApi(
      [availableDevice],
      { status: "idle", elapsedMs: 0, audioFallback: false },
      null,
      {
        directoryName: "DroidPane",
        items: [history],
        refreshedAt: Date.now()
      }
    );
    /** 媒体暂停桩。 */
    const pause = HTMLMediaElement.prototype.pause as jest.Mock;
    pause.mockClear();
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);
    /** 镜像录制页签。 */
    const deviceTab = await screen.findByRole("tab", { name: "镜像录制" });
    /** 视频库页签。 */
    const libraryTab = screen.getByRole("tab", { name: "视频库" });
    expect(deviceTab).toHaveAttribute("aria-selected", "true");

    deviceTab.focus();
    fireEvent.keyDown(deviceTab, { key: "ArrowRight" });
    await waitFor(() => expect(libraryTab).toHaveFocus());
    expect(libraryTab).toHaveAttribute("aria-selected", "true");

    await user.click(
      screen.getByRole("button", { name: "播放 Tab_State.mp4" })
    );
    /** 保持挂载的视频元素。 */
    const video = document.querySelector(".stage__video") as HTMLVideoElement;
    Object.defineProperty(video, "duration", {
      configurable: true,
      value: history.durationSeconds
    });
    video.currentTime = 42;
    fireEvent.timeUpdate(video);
    fireEvent.play(video);
    expect(screen.getByRole("slider", { name: "播放进度" })).toHaveValue("42");

    fireEvent.keyDown(libraryTab, { key: "ArrowLeft" });
    await waitFor(() => expect(deviceTab).toHaveFocus());
    expect(deviceTab).toHaveAttribute("aria-selected", "true");
    expect(pause).toHaveBeenCalled();

    fireEvent.keyDown(deviceTab, { key: "End" });
    await waitFor(() => expect(libraryTab).toHaveFocus());
    expect(document.querySelector(".stage__video")).toBe(video);
    expect(screen.getByRole("slider", { name: "播放进度" })).toHaveValue("42");
    expect(screen.getByRole("button", { name: "播放" })).toBeEnabled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(libraryTab).toHaveAttribute("aria-selected", "true");
  });

  it("新录制完成弹出通知，查看视频时跳转视频库并选中新视频", async () => {
    /** 当前播放的历史视频。 */
    const history = createLibraryItem(
      "history-current",
      "Current_Playback.mp4",
      Date.now() - 60_000,
      "adb-studio-media://artifact/history-current"
    );
    /** 新完成的录制视频。 */
    const completed = createLibraryItem(
      "recording-completed",
      "New_Recording.mp4",
      Date.now(),
      "adb-studio-media://artifact/recording-completed"
    );
    /** 录制产物事件发布函数。 */
    let publishArtifact: ((value: RecordingArtifact | null) => void) | undefined;
    /** 视频库事件发布函数。 */
    let publishLibrary:
      | ((snapshot: RecordingLibrarySnapshot) => void)
      | undefined;
    /** 带当前历史视频的视频库 API。 */
    const api = createApi(
      [availableDevice],
      { status: "recording", elapsedMs: 8_000, audioFallback: false },
      null,
      {
        directoryName: "DroidPane",
        items: [history],
        refreshedAt: Date.now()
      }
    );
    api.onRecordingArtifactChanged.mockImplementation((listener) => {
      publishArtifact = listener;
      return () => undefined;
    });
    api.onRecordingLibraryChanged.mockImplementation((listener) => {
      publishLibrary = listener;
      return () => undefined;
    });
    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);
    await openLibrary(user);
    await user.click(
      screen.getByRole("button", { name: "播放 Current_Playback.mp4" })
    );
    await waitFor(() =>
      expect(document.querySelector(".stage__video")).not.toBeNull()
    );
    /** 当前保持挂载的视频元素。 */
    const video = document.querySelector(".stage__video") as HTMLVideoElement;
    video.currentTime = 30;
    fireEvent.timeUpdate(video);
    await user.click(screen.getByRole("tab", { name: /镜像录制/ }));

    act(() => {
      publishArtifact?.(completed);
      publishLibrary?.({
        directoryName: "DroidPane",
        items: [completed, history],
        refreshedAt: Date.now()
      });
    });

    expect(screen.getByRole("tab", { name: /镜像录制/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(
      screen.getByRole("button", {
        name: "播放 Current_Playback.mp4",
        hidden: true
      })
    ).toHaveClass("is-selected");
    expect(
      screen.getByRole("button", {
        name: "播放 New_Recording.mp4",
        hidden: true
      })
    ).not.toHaveClass("is-selected");
    expect(
      screen.getByRole("slider", { name: "播放进度", hidden: true })
    ).toHaveValue("30");
    expect(await screen.findByText("录制成功")).toBeInTheDocument();
    expect(
      screen.getByText("“New_Recording.mp4”已保存到视频库")
    ).toBeInTheDocument();
    expect(
      screen.getByText("录制成功").closest(".ant-notification-notice")
    ).toHaveClass("recording-complete-notification");
    expect(document.querySelector(".global-toast")).not.toBeInTheDocument();
    expect(document.querySelector(".stage__video")).toBe(video);

    await user.click(screen.getByRole("button", { name: "查看视频" }));

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "视频库" })).toHaveAttribute(
        "aria-selected",
        "true"
      )
    );
    expect(
      screen.getByRole("button", { name: "播放 New_Recording.mp4" })
    ).toHaveClass("is-selected");
    expect(
      screen.getByRole("button", { name: "播放 Current_Playback.mp4" })
    ).not.toHaveClass("is-selected");
    expect(screen.getByRole("slider", { name: "播放进度" })).toHaveValue(
      "0"
    );
  });

  it("视频库刷新移除当前文件时同步清空播放与导出状态", async () => {
    /** 视频库事件发布函数。 */
    let publishLibrary:
      | ((snapshot: RecordingLibrarySnapshot) => void)
      | undefined;
    /** 完成态 API。 */
    const api = createApi(
      [availableDevice],
      {
        status: "ready",
        elapsedMs: 138_000,
        audioFallback: false,
        artifactId: artifact.id
      },
      artifact
    );
    api.onRecordingLibraryChanged.mockImplementation((listener) => {
      publishLibrary = listener;
      return () => undefined;
    });

    /** 用户操作器。 */
    const user = userEvent.setup();

    render(<App api={api} />);
    await openLibrary(user);
    expect(await screen.findAllByText(artifact.fileName)).toHaveLength(2);

    act(() => {
      publishLibrary?.({
        directoryName: "DroidPane",
        items: [],
        refreshedAt: Date.now()
      });
    });

    expect(screen.queryByText(artifact.fileName)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "导出 MP4" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "播放" })).toBeDisabled();
  });
});
