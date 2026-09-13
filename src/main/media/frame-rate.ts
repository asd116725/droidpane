/** 基于最近一秒视频包计算实际帧率。 */
export class FrameRateSampler {
  /** 统计开始时间。 */
  private startedAt?: number;
  /** 最近一秒收到的视频帧时间。 */
  private readonly frameReceivedAt: number[] = [];

  /** 创建使用指定时钟的帧率采样器。 */
  constructor(private readonly now: () => number) {}

  /** 开始新的帧率统计窗口。 */
  start(): void {
    this.startedAt = this.now();
    this.frameReceivedAt.length = 0;
  }

  /** 记录一帧实际视频数据。 */
  push(): void {
    if (this.startedAt !== undefined) {
      this.frameReceivedAt.push(this.now());
    }
  }

  /** 返回最近一秒帧率并清理过期样本。 */
  sample(): number {
    if (this.startedAt === undefined) {
      return 0;
    }

    /** 当前采样时间。 */
    const now = this.now();
    /** 当前 FPS 滑动窗口起点。 */
    const windowStartedAt = Math.max(this.startedAt, now - 1_000);
    while (
      this.frameReceivedAt.length &&
      this.frameReceivedAt[0] < windowStartedAt
    ) {
      this.frameReceivedAt.shift();
    }

    /** 当前窗口的实际跨度。 */
    const duration = Math.max(1, now - windowStartedAt);
    return Math.round((this.frameReceivedAt.length * 1_000) / duration);
  }
}
