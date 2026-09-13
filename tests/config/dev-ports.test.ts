import { createRequire } from "node:module";

/** 开发端口选择模块。 */
interface DevPortsModule {
  /** 查找可用端口对。 */
  findAvailablePortPair(
    webpackBasePort: number,
    loggerBasePort: number,
    probe?: (port: number) => Promise<boolean>
  ): Promise<{ webpackPort: number; loggerPort: number; offset: number }>;
}

/** 当前测试文件的 CommonJS 加载器。 */
const loadCommonJsModule = createRequire(__filename);
/** CommonJS 开发端口选择器。 */
const { findAvailablePortPair } = loadCommonJsModule(
  "../../scripts/dev-ports.cjs"
) as DevPortsModule;

describe("开发端口自动选择", () => {
  it("任一基准端口被占用时按相同偏移量查找下一组", async () => {
    /** 模拟被占用的端口。 */
    const occupiedPorts = new Set([3000, 9001]);
    /** 可控端口探针。 */
    const probe = jest.fn(async (port: number) => !occupiedPorts.has(port));

    await expect(findAvailablePortPair(3000, 9000, probe)).resolves.toEqual({
      webpackPort: 3002,
      loggerPort: 9002,
      offset: 2
    });
  });
});
