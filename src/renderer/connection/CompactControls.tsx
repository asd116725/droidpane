import { Dropdown } from "antd";
import { IconArrowLeft, IconCircle, IconDotsVertical, IconLoader2, IconPlayerRecordFilled, IconPower, IconSquareFilled } from "@tabler/icons-react";
import type { AdbStudioApi, DeviceControlKey, RecordingState } from "../../shared/types";
import { formatDuration } from "../../shared/formatters";

interface CompactControlsProps {
  api: Pick<AdbStudioApi, "sendDeviceControl">;
  interactive: boolean;
  canRecord: boolean;
  recording: RecordingState;
  onRecord(): void;
  onStopRecording(): void;
  onStopMirror(): void;
  onLibrary(): void;
  onRestore(): void;
}

/** 紧凑窗口常用操作；复用已有设备命令与录制生命周期。 */
export function CompactControls({ api, interactive, canRecord, recording, onRecord, onStopRecording, onStopMirror, onLibrary, onRestore }: CompactControlsProps) {
  const recordingBusy = ["starting", "recording", "stopping"].includes(recording.status);
  const transitioning = ["starting", "stopping"].includes(recording.status);
  const press = (key: DeviceControlKey) => {
    const command = { type: "key" as const, key, repeat: 0, modifiers: { shift: false, alt: false, ctrl: false } };
    api.sendDeviceControl({ ...command, action: "down" });
    api.sendDeviceControl({ ...command, action: "up" });
  };
  return <footer className="compact-controls" aria-label="紧凑窗口设备控制">
    <button type="button" disabled={!interactive} onClick={() => press("back")} aria-label="返回"><IconArrowLeft size={20} /><span>返回</span></button>
    <button type="button" disabled={!interactive} onClick={() => press("home")} aria-label="主页"><IconCircle size={19} /><span>主页</span></button>
    <button type="button" disabled={!interactive} onClick={() => press("power")} aria-label="电源"><IconPower size={20} /><span>电源</span></button>
    <button type="button" className={`compact-record${recordingBusy ? " is-recording" : ""}`}
      disabled={transitioning || (!recordingBusy && !canRecord)} aria-label={recordingBusy ? "停止录制" : "开始录制"}
      onClick={recordingBusy ? onStopRecording : onRecord}>
      {transitioning ? <IconLoader2 className="is-spinning" size={20} /> : recordingBusy ? <IconSquareFilled size={17} /> : <IconPlayerRecordFilled size={23} />}
      <span>{recordingBusy ? formatDuration(recording.elapsedMs / 1000) : "录制"}</span>
    </button>
    <Dropdown trigger={["click"]} placement="topRight" menu={{ items: [
      { key: "notifications", label: "打开下拉菜单", disabled: !interactive, onClick: () => api.sendDeviceControl({ type: "expand-notification-panel" }) },
      { key: "collapse", label: "关闭下拉菜单", disabled: !interactive, onClick: () => api.sendDeviceControl({ type: "collapse-notification-panel" }) },
      { type: "divider" },
      { key: "library", label: "打开视频库", onClick: onLibrary },
      { key: "restore", label: "完整窗口与画质设置", onClick: onRestore },
      { key: "stop", label: "结束镜像", disabled: recordingBusy || !interactive, danger: true, onClick: onStopMirror }
    ] }}><button type="button" aria-label="更多操作"><IconDotsVertical size={19} /></button></Dropdown>
  </footer>;
}
