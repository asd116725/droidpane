import type {
  DeviceConnectionType,
  DeviceInfo,
  DeviceStatus
} from "../../shared/types";
import type { WirelessDiscovery, WirelessEndpoint } from "../../shared/connection";

/** ADB 原始状态与应用状态的映射。 */
const statusMap: Record<string, DeviceStatus | undefined> = {
  device: "available",
  unauthorized: "unauthorized",
  offline: "offline"
};

/** 根据序列号判断连接方式。 */
function resolveConnectionType(serial: string): DeviceConnectionType {
  if (serial.startsWith("emulator-")) {
    return "emulator";
  }

  return serial.includes(":") || serial.includes("._adb-tls-connect._tcp")
    ? "network"
    : "usb";
}

/** 使用方括号区分 IPv6 地址中的冒号与端口分隔符。 */
export function formatWirelessEndpoint(endpoint: WirelessEndpoint): string {
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  return `${host}:${endpoint.port}`;
}

/** 读取 ADB 输出中的 IP 或主机名端点，忽略缺少有效端口的服务。 */
function parseEndpoint(value: string): WirelessEndpoint | undefined {
  const match = value.match(/^(?:\[([^\]]+)\]|([^:\s]+)):(\d+)$/);
  if (!match) {
    return undefined;
  }
  const port = Number(match[3]);
  return port > 0 && port <= 65_535
    ? { host: match[1] ?? match[2], port }
    : undefined;
}

/** 仅提取 TLS 配对与连接服务，避免把两个端口混用。 */
export function parseAdbMdnsServices(output: string): WirelessDiscovery[] {
  const discoveries = new Map<string, WirelessDiscovery>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(
      /^(\S+)\s+_adb-tls-(pairing|connect)\._tcp\.?\s+(\S+)$/
    );
    const endpoint = match && parseEndpoint(match[3]);
    if (match && endpoint) {
      const discovery: WirelessDiscovery = {
        name: match[1],
        type: match[2] === "pairing" ? "pairing" : "connection",
        endpoint
      };
      discoveries.set(`${discovery.type}:${formatWirelessEndpoint(endpoint)}`, discovery);
    }
  }
  return [...discoveries.values()];
}

/** 将 ADB 型号字段转换为可读名称。 */
function normalizeModel(model?: string): string {
  return model ? model.replace(/_/g, " ") : "未知设备";
}

/** 解析 `adb devices -l` 输出。 */
export function parseAdbDeviceList(output: string): DeviceInfo[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .flatMap((line) => {
      /** 空白分隔后的设备字段。 */
      const fields = line.trim().split(/\s+/);
      /** ADB 序列号。 */
      const serial = fields[0];
      /** 应用连接状态。 */
      const status = statusMap[fields[1]];

      if (!status) {
        return [];
      }

      /** ADB 扩展字段。 */
      const attributes = Object.fromEntries(
        fields
          .slice(2)
          .filter((field) => field.includes(":"))
          .map((field) => {
            /** 首个冒号位置。 */
            const separator = field.indexOf(":");
            return [field.slice(0, separator), field.slice(separator + 1)];
          })
      );

      return [
        {
          serial,
          model: normalizeModel(attributes.model),
          androidVersion: "",
          apiLevel: 0,
          connectionType: resolveConnectionType(serial),
          status
        }
      ];
    });
}

/** 统一读取 getprop 的键值，供展示属性和设备身份使用。 */
function parseProperties(output: string): Record<string, string> {
  return Object.fromEntries(
    output.split(/\r?\n/).flatMap((line) => {
      /** getprop 单行匹配结果。 */
      const match = line.match(/^\[([^\]]+)\]: \[([^\]]*)\]$/);
      return match ? [[match[1], match[2]]] : [];
    })
  );
}

/** 读取可验证的设备标识；没有标识时不能依赖历史 IP 自动恢复。 */
export function parseAndroidIdentity(output: string): string | undefined {
  const properties = parseProperties(output);
  const serial = [properties["ro.serialno"], properties["ro.boot.serialno"]]
    .find((value) => value && value.toLowerCase() !== "unknown");
  if (serial) {
    return `serial:${serial}`;
  }
  const guid = properties["persist.adb.wifi.guid"];
  return guid ? `wifi:${guid}` : undefined;
}

/** 解析 `adb shell getprop` 输出中的录制关键属性。 */
export function parseAndroidProperties(output: string): Pick<
  DeviceInfo,
  "model" | "androidVersion" | "apiLevel" | "identity"
> {
  const properties = parseProperties(output);
  const identity = parseAndroidIdentity(output);

  return {
    model: properties["ro.product.model"] || "未知设备",
    androidVersion: properties["ro.build.version.release"] || "",
    apiLevel: Number(properties["ro.build.version.sdk"] || 0),
    ...(identity ? { identity } : {})
  };
}
