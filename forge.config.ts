import path from "node:path";
import { spawnSync } from "node:child_process";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerWix } from "@electron-forge/maker-wix";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { WebpackPlugin } from "@electron-forge/plugin-webpack";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { mainConfig } from "./webpack.main.config";
import { rendererConfig } from "./webpack.renderer.config";
import { applicationId, applicationName } from "./src/shared/brand";

/** 返回 macOS 临时签名的逐文件配置。 */
const resolveAdHocSignOptions = () => ({ hardenedRuntime: false });
/** 当前 Webpack 开发端口。 */
const webpackDevelopmentPort =
  Number(process.env.ADB_STUDIO_WEBPACK_PORT) || 3000;
/** 当前 Forge 日志端口。 */
const loggerDevelopmentPort =
  Number(process.env.ADB_STUDIO_LOGGER_PORT) || 9000;

/** WiX 模板创建器。 */
interface WixTemplateCreator {
  wixTemplate: string;
}

/** 为中文安装信息设置 MSI 数据库代码页。 */
export function configureWixChineseCodePage(
  creator: WixTemplateCreator
): void {
  creator.wixTemplate = creator.wixTemplate
    .replace("<Product ", '<Product Codepage="936" ')
    .replace("<Package ", '<Package SummaryCodepage="936" ');
}

/** Electron Forge 打包配置。 */
const config: ForgeConfig = {
  packagerConfig: {
    appBundleId: applicationId,
    appCategoryType: "public.app-category.utilities",
    asar: true,
    executableName: applicationName,
    icon: path.resolve(__dirname, "assets", "app-icon"),
    osxSign: {
      identity: "-",
      identityValidation: false,
      optionsForFile: resolveAdHocSignOptions,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false
    },
    extraResource: [
      path.resolve(
        __dirname,
        "vendor",
        "scrcpy",
        `${process.platform}-${process.arch}`
      ),
      path.resolve(__dirname, "licenses")
    ],
    extendInfo: {
      LSMinimumSystemVersion: "12.0"
    }
  },
  hooks: {
    prePackage: async (forgeConfig, platform, arch) => {
      /** 本次打包的目标运行时目录名。 */
      const runtimeKey = `${platform}-${arch}`;
      /** 目标平台额外资源。 */
      const extraResource = [
        path.resolve(__dirname, "vendor", "scrcpy", runtimeKey),
        path.resolve(__dirname, "licenses")
      ];

      if (forgeConfig.packagerConfig) {
        forgeConfig.packagerConfig.extraResource = extraResource;
      }

      /** 锁定并校验当前平台的 scrcpy 运行时。 */
      const result = spawnSync(
        process.execPath,
        [
          path.resolve(__dirname, "scripts", "fetch-scrcpy.mjs"),
          "--target",
          runtimeKey
        ],
        {
          stdio: "inherit",
          shell: false
        }
      );

      if (result.status !== 0) {
        throw new Error(`scrcpy ${runtimeKey} 运行时准备失败`);
      }
    }
  },
  rebuildConfig: {},
  makers: [
    new MakerWix({
      appUserModelId: applicationId,
      beforeCreate: configureWixChineseCodePage,
      cultures: "zh-cn",
      defaultInstallMode: "perMachine",
      icon: path.resolve(__dirname, "assets", "app-icon.ico"),
      language: 2_052,
      programFilesFolderName: applicationName,
      shortName: applicationName,
      shortcutFolderName: applicationName,
      shortcutName: applicationName,
      ui: {
        chooseDirectory: true
      },
      upgradeCode: "DBD6F014-C2BC-4071-9436-73EC6634EDA4"
    }),
    new MakerDMG(
      (arch) => ({
        format: "ULFO",
        name: `${applicationName}-${arch}`
      }),
      ["darwin"]
    ),
    new MakerZIP({}, ["darwin"])
  ],
  plugins: [
    new WebpackPlugin({
      port: webpackDevelopmentPort,
      loggerPort: loggerDevelopmentPort,
      mainConfig,
      devContentSecurityPolicy:
        "default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' adb-studio-media: blob:; connect-src 'self' adb-studio-media: ws: http://localhost:*; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: "./src/index.html",
            js: "./src/renderer.tsx",
            name: "main_window",
            preload: {
              js: "./src/preload.ts"
            }
          },
          {
            js: "./src/renderer/live-preview-worker.ts",
            name: "live_preview_worker"
          },
          {
            js: "./src/renderer/video-library/thumbnail-worker.ts",
            name: "thumbnail_worker"
          }
        ]
      }
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true
    })
  ]
};

export default config;
