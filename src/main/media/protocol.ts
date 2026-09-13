import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { protocol } from "electron";
import { parseArtifactId } from "../../shared/validation";
import { parseByteRange } from "./range";

/** 安全媒体自定义协议。 */
export const mediaProtocol = "adb-studio-media";

/** 安全媒体协议允许使用的文件解析器。 */
export interface MediaFileResolver {
  /** 按会话 ID 解析当前目录中的可播放 MP4。 */
  resolveMediaFile(id: string): Promise<string | undefined>;
}

/** 在 Electron ready 前注册媒体协议权限。 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: mediaProtocol,
      privileges: {
        standard: true,
        secure: true,
        stream: true,
        corsEnabled: true,
        supportFetchAPI: true
      }
    }
  ]);
}

/** 将 Node 流转换为 Fetch Response 可接受的流。 */
function toResponseBody(stream: Readable): BodyInit {
  return Readable.toWeb(stream) as unknown as BodyInit;
}

/** 创建仅按内部产物 ID 读取 MP4 的流媒体处理器。 */
export function createMediaHandler(
  resolver: MediaFileResolver
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, {
          status: 405,
          headers: { Allow: "GET, HEAD" }
        });
      }

      /** 自定义协议地址。 */
      const url = new URL(request.url);

      if (url.hostname !== "artifact") {
        return new Response(null, { status: 404 });
      }

      /** 通过校验的内部文件 ID。 */
      const artifactId = parseArtifactId(
        decodeURIComponent(url.pathname.slice(1))
      );
      /** 仅主进程可解析的本地路径。 */
      const filePath = await resolver.resolveMediaFile(artifactId);

      if (!filePath) {
        return new Response(null, { status: 404 });
      }

      /** 本地 MP4 信息。 */
      const fileInfo = await stat(filePath);
      /** 浏览器请求的字节范围。 */
      const rangeHeader = request.headers.get("range");
      /** 通用媒体响应头。 */
      const headers = new Headers({
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers":
          "Accept-Ranges, Content-Length, Content-Range",
        "Cache-Control": "no-store",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Content-Type": "video/mp4"
      });

      if (!rangeHeader) {
        headers.set("Content-Length", String(fileInfo.size));
        return new Response(
          request.method === "HEAD"
            ? null
            : toResponseBody(createReadStream(filePath)),
          {
            status: 200,
            headers
          }
        );
      }

      /** 已校验的单一字节范围。 */
      const range = parseByteRange(rangeHeader, fileInfo.size);

      if (!range) {
        headers.set("Content-Range", `bytes */${fileInfo.size}`);
        return new Response(null, { status: 416, headers });
      }

      /** 当前范围字节长度。 */
      const contentLength = range.end - range.start + 1;
      headers.set(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${fileInfo.size}`
      );
      headers.set("Content-Length", String(contentLength));

      return new Response(
        request.method === "HEAD"
          ? null
          : toResponseBody(
              createReadStream(filePath, {
                start: range.start,
                end: range.end
              })
            ),
        {
          status: 206,
          headers
        }
      );
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}

/** 注册安全流媒体协议处理器。 */
export function registerMediaHandler(resolver: MediaFileResolver): void {
  protocol.handle(mediaProtocol, createMediaHandler(resolver));
}
