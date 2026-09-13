import type { RecordingState } from "../../shared/types";

/** 录制状态机事件。 */
export type RecordingEvent =
  | { type: "START_REQUESTED"; deviceSerial?: string }
  | { type: "PROCESS_STARTED"; startedAt: number }
  | { type: "STOP_REQUESTED" }
  | { type: "TICK"; elapsedMs: number; fps: number }
  | { type: "AUDIO_FALLBACK"; reason: string }
  | { type: "FINALIZED"; artifactId: string }
  | { type: "FAILED"; message: string }
  | { type: "RESET" };

/** 创建空闲录制状态。 */
export function createInitialRecordingState(): RecordingState {
  return {
    status: "idle",
    elapsedMs: 0,
    fps: 0,
    audioFallback: false
  };
}

/** 校验状态机事件是否来自允许的状态。 */
function assertStatus(
  state: RecordingState,
  event: RecordingEvent,
  allowed: RecordingState["status"][]
): void {
  if (!allowed.includes(state.status)) {
    if (event.type === "START_REQUESTED") {
      throw new Error("当前已有录制任务");
    }

    throw new Error(`状态 ${state.status} 无法处理事件 ${event.type}`);
  }
}

/** 按事件推进录制状态。 */
export function transitionRecordingState(
  state: RecordingState,
  event: RecordingEvent
): RecordingState {
  switch (event.type) {
    case "START_REQUESTED":
      assertStatus(state, event, ["idle", "ready", "error"]);
      return {
        status: "starting",
        elapsedMs: 0,
        fps: 0,
        deviceSerial: event.deviceSerial,
        audioFallback: false
      };
    case "PROCESS_STARTED":
      assertStatus(state, event, ["starting"]);
      return { ...state, status: "recording", startedAt: event.startedAt };
    case "STOP_REQUESTED":
      assertStatus(state, event, ["starting", "recording"]);
      return { ...state, status: "stopping" };
    case "TICK":
      assertStatus(state, event, ["recording", "stopping"]);
      return { ...state, elapsedMs: event.elapsedMs, fps: event.fps };
    case "AUDIO_FALLBACK":
      assertStatus(state, event, ["starting", "recording"]);
      return {
        ...state,
        audioFallback: true,
        audioFallbackReason: event.reason
      };
    case "FINALIZED":
      assertStatus(state, event, ["recording", "stopping"]);
      return {
        ...state,
        status: "ready",
        artifactId: event.artifactId
      };
    case "FAILED":
      return {
        ...state,
        status: "error",
        errorMessage: event.message
      };
    case "RESET":
      return createInitialRecordingState();
  }
}
