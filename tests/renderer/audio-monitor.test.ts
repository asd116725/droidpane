/** @jest-environment jsdom */

import { AudioMonitorPlayer } from "../../src/renderer/audio-monitor";

/** 创建可观察的 Web Audio 环境。 */
function createAudioEnvironment() {
  /** 已创建的音源。 */
  const sources: Array<{
    buffer?: AudioBuffer;
    connect: jest.Mock;
    start: jest.Mock;
    stop: jest.Mock;
    onended: (() => void) | null;
  }> = [];
  /** 监听增益节点。 */
  const gain = {
    gain: { value: 1 },
    connect: jest.fn()
  };
  /** 可控音频上下文。 */
  const context = {
    currentTime: 1,
    destination: {},
    state: "suspended",
    resume: jest.fn(async () => {
      context.state = "running";
    }),
    suspend: jest.fn(async () => {
      context.state = "suspended";
    }),
    close: jest.fn(async () => undefined),
    createGain: jest.fn(() => gain),
    createBuffer: jest.fn((channels: number, frames: number) => {
      /** 各声道 PCM 缓冲。 */
      const channelData = Array.from(
        { length: channels },
        () => new Float32Array(frames)
      );
      return {
        getChannelData: (channel: number) => channelData[channel]
      } as unknown as AudioBuffer;
    }),
    createBufferSource: jest.fn(() => {
      /** 单个可调度音源。 */
      const source = {
        buffer: undefined as AudioBuffer | undefined,
        connect: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
        onended: null as (() => void) | null
      };
      sources.push(source);
      return source;
    })
  };

  return { context, gain, sources };
}

/** 创建固定双声道的 AudioData 桩。 */
function createAudioData(timestamp: number) {
  return {
    timestamp,
    numberOfChannels: 2,
    numberOfFrames: 1_024,
    sampleRate: 48_000,
    copyTo: jest.fn((destination: Float32Array, options: { planeIndex: number }) => {
      destination.fill(options.planeIndex + 0.25);
    }),
    close: jest.fn()
  } as unknown as AudioData;
}

describe("电脑端录制音频播放器", () => {
  it("按 PTS 低延迟调度双声道并实时更新监听音量", async () => {
    /** 可观察的 Web Audio 环境。 */
    const environment = createAudioEnvironment();
    /** 使用受控 AudioContext 的播放器。 */
    const player = new AudioMonitorPlayer(
      () => environment.context as unknown as AudioContext
    );
    await player.enable(0.8);
    /** 第一包监听数据。 */
    const first = createAudioData(1_000_000);
    /** 第二包监听数据。 */
    const second = createAudioData(1_021_333);

    player.play(first);
    player.setVolume(0.45);
    player.play(second);

    expect(environment.context.resume).toHaveBeenCalledTimes(1);
    expect(environment.gain.gain.value).toBe(0.45);
    expect(first.copyTo).toHaveBeenCalledTimes(2);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(environment.sources[0].start).toHaveBeenCalledWith(1.06);
    expect(environment.sources[1].start).toHaveBeenCalledWith(1.081333);
  });

  it("延迟超过 250ms 时重建时钟且关闭后立即停止残留音源", async () => {
    /** 可观察的 Web Audio 环境。 */
    const environment = createAudioEnvironment();
    /** 使用受控 AudioContext 的播放器。 */
    const player = new AudioMonitorPlayer(
      () => environment.context as unknown as AudioContext
    );
    await player.enable(0.8);
    player.play(createAudioData(1_000_000));
    environment.context.currentTime = 2;
    player.play(createAudioData(1_021_333));

    expect(environment.sources[0].stop).toHaveBeenCalledTimes(1);
    expect(environment.sources[1].start).toHaveBeenCalledWith(2.06);

    player.disable();
    expect(environment.sources[1].stop).toHaveBeenCalledTimes(1);
    expect(environment.context.suspend).toHaveBeenCalledTimes(1);
  });
});
