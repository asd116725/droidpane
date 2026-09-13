import type { Configuration } from "webpack";
import { rules } from "./webpack.rules";

/** 渲染进程 Webpack 配置。 */
export const rendererConfig: Configuration = {
  module: {
    rules: [
      ...rules,
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"]
      },
      {
        test: /\.(png|jpg|jpeg|webp)$/i,
        type: "asset/resource"
      }
    ]
  },
  resolve: {
    extensions: [".js", ".ts", ".tsx", ".json"]
  },
  devtool: "source-map"
};
