import "@testing-library/jest-dom";

if (typeof MessageChannel === "undefined") {
  /** jsdom 中的消息端口最小桩。 */
  interface MessagePortMock {
    /** 消息回调。 */
    onmessage: ((event: MessageEvent) => void) | null;
    /** 投递消息。 */
    postMessage?(data: unknown): void;
  }

  /** jsdom 中的消息通道桩。 */
  class MessageChannelMock {
    /** 接收消息的端口。 */
    readonly port1: MessagePortMock = { onmessage: null };

    /** 发送消息的端口。 */
    readonly port2: MessagePortMock = {
      onmessage: null,
      postMessage: (data) => {
        setTimeout(() => {
          this.port1.onmessage?.(new MessageEvent("message", { data }));
        }, 0);
      }
    };
  }

  Object.defineProperty(globalThis, "MessageChannel", {
    configurable: true,
    value: MessageChannelMock
  });
}

if (typeof ResizeObserver === "undefined") {
  /** jsdom 中的尺寸观察器桩。 */
  class ResizeObserverMock implements ResizeObserver {
    /** 开始观察目标。 */
    observe(): void {}

    /** 停止观察目标。 */
    unobserve(): void {}

    /** 断开全部观察。 */
    disconnect(): void {}
  }

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverMock
  });
}

if (typeof HTMLMediaElement !== "undefined") {
  /** 测试环境中的媒体播放桩。 */
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: jest.fn().mockResolvedValue(undefined)
  });

  /** 测试环境中的媒体暂停桩。 */
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: jest.fn()
  });
}
