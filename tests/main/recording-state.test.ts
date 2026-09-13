import {
  createInitialRecordingState,
  transitionRecordingState
} from "../../src/main/recording/state";

describe("录制状态机", () => {
  it("沿开始、录制、停止和可预览的主路径推进", () => {
    /** 初始状态。 */
    const idle = createInitialRecordingState();
    /** 开始中的状态。 */
    const starting = transitionRecordingState(idle, {
      type: "START_REQUESTED"
    });
    /** 录制中的状态。 */
    const recording = transitionRecordingState(starting, {
      type: "PROCESS_STARTED",
      startedAt: 1_000
    });
    /** 停止中的状态。 */
    const stopping = transitionRecordingState(recording, {
      type: "STOP_REQUESTED"
    });
    /** 已完成状态。 */
    const ready = transitionRecordingState(stopping, {
      type: "FINALIZED",
      artifactId: "artifact-1"
    });

    expect([
      idle.status,
      starting.status,
      recording.status,
      stopping.status,
      ready.status
    ]).toEqual(["idle", "starting", "recording", "stopping", "ready"]);
    expect(ready.artifactId).toBe("artifact-1");
    expect(idle.fps).toBe(0);
  });

  it("拒绝在录制中再次开始，确保同一时间只有一个录制任务", () => {
    /** 录制中状态。 */
    const recording = {
      ...createInitialRecordingState(),
      status: "recording" as const,
      startedAt: 1_000
    };

    expect(() =>
      transitionRecordingState(recording, {
        type: "START_REQUESTED"
      })
    ).toThrow("当前已有录制任务");
  });
});
