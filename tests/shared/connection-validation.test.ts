import {
  parseBooleanSetting, parseConnectWirelessInput, parsePairWirelessInput,
  parseWindowMode
} from "../../src/shared/connection-validation";

describe("无线接入边界", () => {
  it("配对码只接受六位数字，地址和端口分开校验", () => {
    expect(parsePairWirelessInput({
      endpoint: { host: "192.168.1.24", port: 37123 }, code: "482916"
    }).endpoint.port).toBe(37123);
    expect(() => parsePairWirelessInput({
      endpoint: { host: "192.168.1.24", port: 37123 }, code: "4829167"
    })).toThrow("6 位配对码");
    expect(() => parseConnectWirelessInput({ endpoint: { host: "phone.local", port: 65536 } })).toThrow();
    expect(() => parseConnectWirelessInput({ endpoint: { host: "--help", port: 5555 } })).toThrow();
    expect(() => parseConnectWirelessInput({ endpoint: { host: "host\nshell", port: 5555 } })).toThrow();
    expect(() => parseConnectWirelessInput({ endpoint: { host: "http://phone", port: 5555 } })).toThrow();
    expect(parseConnectWirelessInput({ endpoint: { host: "[::1]", port: 5555 } }).endpoint.host).toBe("[::1]");
  });

  it("窗口接口拒绝字符串布尔值与任意窗口属性", () => {
    expect(parseWindowMode("compact")).toBe("compact");
    expect(() => parseWindowMode("fullscreen")).toThrow();
    expect(parseBooleanSetting(false)).toBe(false);
    expect(() => parseBooleanSetting("false")).toThrow();
  });
});
