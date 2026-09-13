/** @jest-environment node */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createMediaHandler,
  type MediaFileResolver
} from "../../src/main/media/protocol";

/** 测试产物内部 ID。 */
const artifactId = "019fb6c9-db73-7143-8737-e67e0c32ac80";

describe("安全媒体协议", () => {
  it("仅通过内部 ID 返回指定 MP4 的字节范围", async () => {
    /** 测试文件目录。 */
    const directory = await mkdtemp(path.join(tmpdir(), "adb-media-test-"));
    /** 测试 MP4 路径。 */
    const filePath = path.join(directory, "sample.mp4");
    /** 可辨识的测试内容。 */
    const content = Buffer.from("0123456789");
    await writeFile(filePath, content);
    /** 仅实现协议所需方法的安全文件解析器。 */
    const resolver: MediaFileResolver = {
      resolveMediaFile: jest.fn(async (value: string) =>
        value === artifactId ? filePath : undefined
      )
    };
    /** 待测协议处理器。 */
    const handler = createMediaHandler(resolver);

    try {
      /** 合法范围响应。 */
      const response = await handler(
        new Request(`adb-studio-media://artifact/${artifactId}`, {
          headers: { range: "bytes=2-5" }
        })
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("2345");

      /** HEAD 请求只返回元数据，不创建响应体。 */
      const head = await handler(
        new Request(`adb-studio-media://artifact/${artifactId}`, {
          method: "HEAD"
        })
      );
      expect(head.status).toBe(200);
      expect(head.headers.get("Content-Length")).toBe("10");
      expect(await head.text()).toBe("");

      /** 写入方法被明确拒绝。 */
      const rejectedMethod = await handler(
        new Request(`adb-studio-media://artifact/${artifactId}`, {
          method: "POST"
        })
      );
      expect(rejectedMethod.status).toBe(405);

      /** 不存在的内部 ID 响应。 */
      const missing = await handler(
        new Request(
          "adb-studio-media://artifact/019fb6c9-db73-7143-8737-e67e0c32ac81"
        )
      );
      expect(missing.status).toBe(404);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
