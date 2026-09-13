import type { RuleSetRule } from "webpack";

/** Electron 主进程与预加载脚本共用的 TypeScript 规则。 */
export const rules: RuleSetRule[] = [
  {
    test: /\.tsx?$/,
    exclude: /node_modules/,
    use: {
      loader: "ts-loader",
      options: {
        transpileOnly: true
      }
    }
  }
];
