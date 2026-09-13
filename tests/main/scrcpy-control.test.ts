/** @jest-environment node */

import {
  ScrcpyControlChannel,
  serializeDeviceControlCommand
} from "../../src/main/scrcpy/control";
import type { ScrcpySocket } from "../../src/main/scrcpy/session";

/** 无修饰按键状态。 */
const noModifiers = { shift: false, alt: false, ctrl: false };

describe("scrcpy 4.1 控制协议", () => {
  it("按大端字段顺序序列化白名单按键与修饰状态", () => {
    /** Alt+Ctrl+Home 按下消息。 */
    const [message] = serializeDeviceControlCommand(
      {
        type: "key",
        action: "down",
        key: "home",
        repeat: 2,
        modifiers: { shift: false, alt: true, ctrl: true }
      },
      { width: 1080, height: 2400 },
      34
    );

    expect(message).toEqual(
      Buffer.from([
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x03,
        0x00,
        0x00,
        0x00,
        0x02,
        0x00,
        0x00,
        0x10,
        0x02
      ])
    );
  });

  it("精确换算触控坐标、压力、指针 ID 与屏幕尺寸", () => {
    /** 画面中心的按下消息。 */
    const [down] = serializeDeviceControlCommand(
      { type: "touch", action: "down", x: 0.5, y: 0.25 },
      { width: 1080, height: 2400 },
      34
    );
    /** 相同位置的取消消息。 */
    const [cancel] = serializeDeviceControlCommand(
      { type: "touch", action: "cancel", x: 0.5, y: 0.25 },
      { width: 1080, height: 2400 },
      34
    );

    expect(down).toHaveLength(32);
    expect(down[0]).toBe(2);
    expect(down[1]).toBe(0);
    expect(down.readBigUInt64BE(2)).toBe(0xfffffffffffffffen);
    expect(down.readInt32BE(10)).toBe(540);
    expect(down.readInt32BE(14)).toBe(600);
    expect(down.readUInt16BE(18)).toBe(1080);
    expect(down.readUInt16BE(20)).toBe(2400);
    expect(down.readUInt16BE(22)).toBe(0xffff);
    expect(down.readUInt32BE(24)).toBe(0);
    expect(down.readUInt32BE(28)).toBe(0);
    expect(cancel[1]).toBe(3);
    expect(cancel.readUInt16BE(22)).toBe(0);
  });

  it("按官方 i16 定点规则序列化滚动并保留按钮字段", () => {
    /** 达到协议边界的滚动消息。 */
    const [message] = serializeDeviceControlCommand(
      {
        type: "scroll",
        x: 1,
        y: 0,
        horizontal: 16,
        vertical: -8
      },
      { width: 720, height: 1280 },
      34
    );

    expect(message).toHaveLength(21);
    expect(message[0]).toBe(3);
    expect(message.readInt32BE(1)).toBe(719);
    expect(message.readInt32BE(5)).toBe(0);
    expect(message.readInt16BE(13)).toBe(0x7fff);
    expect(message.readInt16BE(15)).toBe(-0x4000);
    expect(message.readUInt32BE(17)).toBe(0);
  });

  it("Android 7+ 用剪贴板粘贴中文，旧系统只直接注入 ASCII", () => {
    /** Android 14 剪贴板消息。 */
    const [clipboard] = serializeDeviceControlCommand(
      { type: "text", text: "你好 A" },
      { width: 1, height: 1 },
      34
    );
    /** Android 6 兼容文本消息。 */
    const legacy = serializeDeviceControlCommand(
      { type: "text", text: "你好 A" },
      { width: 1, height: 1 },
      23
    );

    expect(clipboard[0]).toBe(9);
    expect(clipboard.readBigUInt64BE(1)).toBe(0n);
    expect(clipboard[9]).toBe(1);
    expect(clipboard.readUInt32BE(10)).toBe(Buffer.byteLength("你好 A"));
    expect(clipboard.subarray(14).toString()).toBe("你好 A");
    expect(legacy).toHaveLength(1);
    expect(legacy[0][0]).toBe(1);
    expect(legacy[0].subarray(5).toString()).toBe(" A");
  });

  it("按 300 字节安全边界拆分英文文本", () => {
    /** 超过单条消息上限的 ASCII 文本。 */
    const messages = serializeDeviceControlCommand(
      { type: "text", text: "a".repeat(301) },
      { width: 1, height: 1 },
      34
    );

    expect(messages).toHaveLength(2);
    expect(messages[0].readUInt32BE(1)).toBe(300);
    expect(messages[1].readUInt32BE(1)).toBe(1);
  });

  it("屏幕尺寸就绪后才写入位置消息，并保持 Socket 写入顺序", () => {
    /** 写入的控制消息。 */
    const writes: Buffer[] = [];
    /** 控制 Socket 桩。 */
    const socket = {
      write: jest.fn((data: Uint8Array) => {
        writes.push(Buffer.from(data));
        return true;
      }),
      destroy: jest.fn()
    } as unknown as ScrcpySocket;
    /** 控制通道。 */
    const channel = new ScrcpyControlChannel(socket, 34);

    expect(
      channel.send({ type: "touch", action: "down", x: 0, y: 0 })
    ).toBe(false);
    channel.setScreenSize({ width: 480, height: 640 });
    expect(
      channel.send({
        type: "key",
        action: "down",
        key: "back",
        repeat: 0,
        modifiers: noModifiers
      })
    ).toBe(true);
    expect(writes.map((message) => message[0])).toEqual([0]);
  });

  it("用连续的顶部下拉触控序列打开定制设备菜单", () => {
    jest.useFakeTimers();
    try {
      /** 写入的控制消息。 */
      const writes: Buffer[] = [];
      /** 控制 Socket 桩。 */
      const socket = {
        write: jest.fn((data: Uint8Array) => {
          writes.push(Buffer.from(data));
          return true;
        }),
        destroy: jest.fn()
      } as unknown as ScrcpySocket;
      /** 控制通道。 */
      const channel = new ScrcpyControlChannel(socket, 34);

      expect(
        channel.send({ type: "expand-notification-panel" })
      ).toBe(false);
      channel.setScreenSize({ width: 480, height: 640 });
      expect(channel.send({ type: "expand-notification-panel" })).toBe(true);
      expect(writes).toHaveLength(1);
      expect(writes[0][0]).toBe(2);
      expect(writes[0][1]).toBe(0);
      expect(writes[0].readInt32BE(10)).toBe(240);
      expect(writes[0].readInt32BE(14)).toBe(1);

      jest.runAllTimers();

      expect(writes).toHaveLength(21);
      expect(writes.every((message) => message[0] === 2)).toBe(true);
      expect(writes.map((message) => message[1])).toEqual([
        0,
        ...Array(19).fill(2),
        1
      ]);
      expect(writes[1].readInt32BE(14) - writes[0].readInt32BE(14)).toBeLessThan(
        24
      );
      expect(writes.at(-1)?.readInt32BE(14)).toBe(416);

      expect(channel.send({ type: "collapse-notification-panel" })).toBe(true);
      expect(writes.at(-1)).toEqual(Buffer.from([7]));
    } finally {
      jest.useRealTimers();
    }
  });
});
