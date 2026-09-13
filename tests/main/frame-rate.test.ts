/** @jest-environment node */

import { FrameRateSampler } from "../../src/main/media/frame-rate";

describe("视频帧率采样器", () => {
  it("按最近一秒帧数计算并在静止后回落到零", () => {
    /** 可推进的采样时钟。 */
    let now = 1_000;
    /** 帧率采样器。 */
    const sampler = new FrameRateSampler(() => now);

    sampler.start();
    for (let frame = 0; frame < 15; frame += 1) {
      sampler.push();
    }
    now += 500;
    expect(sampler.sample()).toBe(30);

    now += 1_000;
    expect(sampler.sample()).toBe(0);
  });
});
