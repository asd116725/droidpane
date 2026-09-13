import { copyFile, stat } from "node:fs/promises";

/** 无损复制录制文件并返回目标字节数。 */
export async function copyRecordingFile(
  source: string,
  destination: string
): Promise<number> {
  await copyFile(source, destination);

  /** 复制完成后的目标文件信息。 */
  const fileInfo = await stat(destination);
  return fileInfo.size;
}
