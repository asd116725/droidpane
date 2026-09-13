/** 已解析的 scrcpy 服务端进程。 */
export interface ScrcpyServerProcess {
  /** Android 进程 PID。 */
  pid: number;
  /** 启动参数中的八位会话 ID。 */
  scid?: string;
}

/** 从 Android ps 输出解析真实 scrcpy 服务端进程。 */
export function parseScrcpyServerProcesses(
  output: string
): ScrcpyServerProcess[] {
  return output
    .split(/\r?\n/)
    .filter((line) => line.includes("com.genymobile.scrcpy.Server"))
    .flatMap((line) => {
      /** PID 与进程参数字段。 */
      const fields = line.trim().split(/\s+/);
      /** PID 字段位置。 */
      const pidIndex = fields.findIndex((field) => /^\d+$/.test(field));
      /** 实际可执行文件名。 */
      const executable = fields[pidIndex + 1] || "";
      /** 本次服务端会话 ID。 */
      const scid = line.match(/\bscid=([0-9a-f]{8})\b/i)?.[1]?.toLowerCase();

      return pidIndex >= 0 && /(?:^|\/)app_process(?:32|64)?$/.test(executable)
        ? [{ pid: Number(fields[pidIndex]), scid }]
        : [];
    });
}

/** 从 Android ps 输出解析 scrcpy 服务端 PID。 */
export function parseScrcpyServerPids(output: string): number[] {
  return parseScrcpyServerProcesses(output).map((process) => process.pid);
}

/** 按八位 SCID 精确查找本次 scrcpy 服务端 PID。 */
export function findScrcpyServerPid(
  output: string,
  scid: string
): number | undefined {
  return parseScrcpyServerProcesses(output).find(
    (process) => process.scid === scid.toLowerCase()
  )?.pid;
}
