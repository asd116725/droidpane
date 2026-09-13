import config, {
  configureWixChineseCodePage
} from "../../forge.config";
import { mainConfig } from "../../webpack.main.config";

/** 可读取名称与配置的 Maker。 */
interface ConfiguredMaker {
  name: string;
  config: unknown;
  prepareConfig(arch: "x64"): Promise<void>;
}

/** 判断 Forge Maker 是否暴露配置。 */
function isConfiguredMaker(value: unknown): value is ConfiguredMaker {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "prepareConfig" in value
  );
}

/** 查找 Windows WiX Maker。 */
function findWixMaker(): ConfiguredMaker | undefined {
  return config.makers?.find(
    (maker): maker is ConfiguredMaker =>
      isConfiguredMaker(maker) && maker.name === "wix"
  );
}

describe("Windows MSI 打包", () => {
  it("使用 WiX 安装器并允许选择安装目录", async () => {
    /** WiX Maker 配置。 */
    const wixMaker = findWixMaker();

    expect(wixMaker).toBeDefined();
    await wixMaker?.prepareConfig("x64");
    expect(wixMaker?.config).toMatchObject({
      cultures: "zh-cn",
      defaultInstallMode: "perMachine",
      language: 2_052,
      programFilesFolderName: "DroidPane",
      shortName: "DroidPane",
      ui: {
        chooseDirectory: true
      },
      upgradeCode: "DBD6F014-C2BC-4071-9436-73EC6634EDA4"
    });
  });

  it("为中文安装信息设置简体中文代码页", () => {
    /** 最小 WiX 模板。 */
    const creator = {
      wixTemplate: "<Product Id=\"product\"><Package InstallerVersion=\"405\"/>"
    };

    configureWixChineseCodePage(creator);

    expect(creator.wixTemplate).toContain(
      '<Product Codepage="936" Id="product">'
    );
    expect(creator.wixTemplate).toContain(
      '<Package SummaryCodepage="936" InstallerVersion="405"/>'
    );
  });
});

describe("macOS 打包签名", () => {
  it("临时签名关闭 Hardened Runtime 以允许加载 Electron Framework", () => {
    const osxSign = config.packagerConfig?.osxSign;

    if (!osxSign || osxSign === true) {
      throw new Error("macOS 临时签名配置缺失");
    }

    expect(osxSign.optionsForFile?.("/tmp/DroidPane")).toEqual({
      hardenedRuntime: false
    });
  });
});

describe("主进程依赖打包", () => {
  it("使用 Mediabunny ESM 入口并保留 Node 原生模块解析", () => {
    /** 主进程模块别名。 */
    const alias = mainConfig.resolve?.alias as Record<string, string>;

    expect(alias.mediabunny).toMatch(
      /mediabunny[/\\]dist[/\\]modules[/\\]src[/\\]index\.js$/
    );
    expect(mainConfig.externals).toBeUndefined();
  });
});
