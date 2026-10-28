import { z } from "zod";
import type {
  ConnectWirelessInput,
  PairWirelessInput,
  WindowMode
} from "./connection";

/** 地址单独传入 ADB 参数，不接受 URL、空白或命令选项。 */
export const wirelessEndpointSchema = z.object({
  host: z.string().trim().min(1).max(253).regex(
    /^(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:]+\]|[0-9A-Fa-f]*:[0-9A-Fa-f:]+)$/
  ),
  port: z.number().int().min(1).max(65_535)
}).strict();

/** 已连接设备的传输标识，拒绝空白和控制字符。 */
const deviceSerialSchema = z.string().min(1).max(256).regex(/^[^\s\x00-\x1f]+$/); // eslint-disable-line no-control-regex
const profileIdSchema = z.string().min(1).max(128);

/** 只持久化已验证的设备档案，不包含配对码。 */
export const wirelessProfileSchema = z.object({
  id: profileIdSchema,
  name: z.string().trim().min(1).max(80),
  model: z.string().max(256),
  identity: z.string().min(1).max(256).optional(),
  lastSerial: deviceSerialSchema,
  endpoint: wirelessEndpointSchema,
  lastConnectedAt: z.number().nonnegative().finite()
}).strict();

const savedWindowBoundsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive()
}).strict();

/** 连接面板临时扩展尺寸不进入窗口偏好。 */
export const windowPresentationSchema = z.object({
  mode: z.enum(["normal", "compact"]),
  compactAlwaysOnTop: z.boolean(),
  normalBounds: savedWindowBoundsSchema.optional(),
  compactBounds: savedWindowBoundsSchema.optional()
}).strict();

/** 校验手机配对弹窗中的信息，配对码不出现在错误文本中。 */
export function parsePairWirelessInput(value: unknown): PairWirelessInput {
  const result = z.object({
    endpoint: wirelessEndpointSchema,
    code: z.string().regex(/^\d{6}$/)
  }).strict().safeParse(value);
  if (!result.success) throw new Error("请填写有效的配对地址、端口和 6 位配对码");
  return result.data;
}

/** 校验无线调试主页的连接地址。 */
export function parseConnectWirelessInput(value: unknown): ConnectWirelessInput {
  const result = z.object({
    endpoint: wirelessEndpointSchema,
    profileId: profileIdSchema.optional()
  }).strict().safeParse(value);
  if (!result.success) throw new Error("请填写有效的连接地址与连接端口");
  return result.data;
}

export function parseWirelessSerial(value: unknown): string {
  const result = deviceSerialSchema.safeParse(value);
  if (!result.success) throw new Error("设备标识无效");
  return result.data;
}

export function parseProfileId(value: unknown): string {
  const result = profileIdSchema.safeParse(value);
  if (!result.success) throw new Error("设备记录无效");
  return result.data;
}

export function parseProfileRename(value: unknown): { id: string; name: string } {
  const result = z.object({
    id: profileIdSchema,
    name: z.string().trim().min(1).max(80)
  }).strict().safeParse(value);
  if (!result.success) throw new Error("设备名称应为 1 到 80 个字符");
  return result.data;
}

export function parseWindowMode(value: unknown): WindowMode {
  const result = z.enum(["normal", "compact"]).safeParse(value);
  if (!result.success) throw new Error("窗口模式无效");
  return result.data;
}

export function parseBooleanSetting(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("开关值无效");
  return value;
}
