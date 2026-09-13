import path from "node:path";
import type { Configuration } from "webpack";
import { rules } from "./webpack.rules";

/** Electron 主进程 Webpack 配置。 */
export const mainConfig: Configuration = {
  entry: "./src/main/index.ts",
  module: {
    rules
  },
  resolve: {
    alias: {
      mediabunny: path.resolve(
        __dirname,
        "node_modules",
        "mediabunny",
        "dist",
        "modules",
        "src",
        "index.js"
      )
    },
    extensions: [".js", ".ts", ".tsx", ".json"]
  },
  devtool: "source-map"
};
