import {
  parseAdbDeviceList,
  parseAdbMdnsServices,
  parseAndroidIdentity,
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

  it("将 TLS 服务序列号识别为网络设备", () => {
    const devices = parseAdbDeviceList(
      "List of devices attached\nadb-REAL-random._adb-tls-connect._tcp device model:Pixel_8\n"
    );
    expect(devices[0].connectionType).toBe("network");
  });

  it("区分配对和连接端口，兼容 IPv6 并忽略无效服务", () => {
    expect(parseAdbMdnsServices([
      "List of discovered mdns services",
      "adb-pair _adb-tls-pairing._tcp 192.168.1.20:41000",
      "adb-REAL-random _adb-tls-connect._tcp 192.168.1.20:39000",
      "adb-v6 _adb-tls-connect._tcp. [fe80::1]:39001",
      "adb-old _adb._tcp 192.168.1.20:5555",
      "adb-invalid _adb-tls-connect._tcp 192.168.1.20:99999",
      "adb-duplicate _adb-tls-connect._tcp 192.168.1.20:39000"
    ].join("\n"))).toEqual([
      { name: "adb-pair", type: "pairing", endpoint: { host: "192.168.1.20", port: 41000 } },
      { name: "adb-duplicate", type: "connection", endpoint: { host: "192.168.1.20", port: 39000 } },
      { name: "adb-v6", type: "connection", endpoint: { host: "fe80::1", port: 39001 } }
    ]);
  });

  it("优先采用实机序列号，缺失时使用无线标识，不以型号充当身份", () => {
    expect(parseAndroidIdentity("[ro.serialno]: [REAL]\n[persist.adb.wifi.guid]: [GUID]")).toBe("serial:REAL");
    expect(parseAndroidIdentity("[ro.serialno]: [unknown]\n[persist.adb.wifi.guid]: [GUID]")).toBe("wifi:GUID");
    expect(parseAndroidIdentity("[ro.serialno]: [unknown]\n[ro.boot.serialno]: [BOOT]")).toBe("serial:BOOT");
    expect(parseAndroidIdentity("[ro.product.model]: [Pixel 8]")).toBeUndefined();
    expect(parseAndroidProperties("[ro.serialno]: [REAL]")).toMatchObject({ identity: "serial:REAL" });
  });
});
