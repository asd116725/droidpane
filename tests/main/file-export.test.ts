import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { copyRecordingFile } from "../../src/main/files/export";

describe("MP4 导出", () => {
  it("执行无损字节复制并返回写入大小", async () => {
    /** 临时测试目录。 */
    const directory = await mkdtemp(path.join(tmpdir(), "adb-studio-"));
    /** 源文件路径。 */
    const source = path.join(directory, "source.mp4");
    /** 导出文件路径。 */
    const destination = path.join(directory, "export.mp4");
    /** 模拟 MP4 字节。 */
    const bytes = Buffer.from([0, 1, 2, 3, 255, 42]);

    await writeFile(source, bytes);

    await expect(copyRecordingFile(source, destination)).resolves.toBe(6);
    await expect(readFile(destination)).resolves.toEqual(bytes);
  });
});
