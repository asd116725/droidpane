import {
  parseAdbDeviceList,
  parseAndroidProperties
} from "../../src/main/adb/parser";

describe("ADB 输出解析", () => {
  it("区分可用、未授权、离线与网络设备，避免隐藏需要处理的设备", () => {
    /** adb devices -l 的典型输出。 */
    const output = [
      "List of devices attached",
      "3A261FDH2001234 device product:husky model:Pixel_8_Pro device:husky transport_id:1",
      "192.168.1.20:5555 unauthorized transport_id:2",
      "5E5C3B7A1109876 offline usb:2-3 transport_id:3",
      ""
    ].join("\n");

    expect(parseAdbDeviceList(output)).toEqual([
      {
        serial: "3A261FDH2001234",
        model: "Pixel 8 Pro",
        androidVersion: "",
        apiLevel: 0,
        connectionType: "usb",
        status: "available"
      },
      {
        serial: "192.168.1.20:5555",
        model: "未知设备",
        androidVersion: "",
        apiLevel: 0,
        connectionType: "network",
        status: "unauthorized"
      },
      {
        serial: "5E5C3B7A1109876",
        model: "未知设备",
        androidVersion: "",
        apiLevel: 0,
        connectionType: "usb",
        status: "offline"
      }
    ]);
  });

  it("读取 getprop 中的型号、Android 版本和 API 等级", () => {
    /** getprop 的典型输出。 */
    const output = [
      "[ro.product.model]: [Pixel 8 Pro]",
      "[ro.build.version.release]: [14]",
      "[ro.build.version.sdk]: [34]"
    ].join("\n");

    expect(parseAndroidProperties(output)).toEqual({
      model: "Pixel 8 Pro",
      androidVersion: "14",
      apiLevel: 34
    });
  });
});
