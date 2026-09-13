import type {
  DeviceConnectionType,
  DeviceInfo,
  DeviceStatus
} from "../../shared/types";

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

  return serial.includes(":") ? "network" : "usb";
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

/** 解析 `adb shell getprop` 输出中的录制关键属性。 */
export function parseAndroidProperties(output: string): Pick<
  DeviceInfo,
  "model" | "androidVersion" | "apiLevel"
> {
  /** 解析后的系统属性。 */
  const properties = Object.fromEntries(
    output.split(/\r?\n/).flatMap((line) => {
      /** getprop 单行匹配结果。 */
      const match = line.match(/^\[([^\]]+)\]: \[([^\]]*)\]$/);
      return match ? [[match[1], match[2]]] : [];
    })
  );

  return {
    model: properties["ro.product.model"] || "未知设备",
    androidVersion: properties["ro.build.version.release"] || "",
    apiLevel: Number(properties["ro.build.version.sdk"] || 0)
  };
}
