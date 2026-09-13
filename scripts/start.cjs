/** Node 子进程模块。 */
const { spawn } = require("node:child_process");
/** Node 路径模块。 */
const path = require("node:path");
/** 开发端口选择器。 */
const { findAvailablePortPair } = require("./dev-ports.cjs");

/** Webpack 默认开发端口。 */
const defaultWebpackPort = 3000;
/** Forge 日志默认端口。 */
const defaultLoggerPort = 9000;

/** 读取合法的开发端口环境变量。 */
function readPort(name, fallback) {
  /** 环境变量中的端口。 */
  const port = Number(process.env[name]);
  return Number.isInteger(port) && port >= 1024 && port <= 65_535
    ? port
    : fallback;
}

/** 自动选择端口并启动 Electron Forge。 */
async function start() {
  /** Webpack 探测起始端口。 */
  const webpackBasePort = readPort(
    "ADB_STUDIO_WEBPACK_PORT",
    defaultWebpackPort
  );
  /** 日志服务探测起始端口。 */
  const loggerBasePort = readPort(
    "ADB_STUDIO_LOGGER_PORT",
    defaultLoggerPort
  );
  /** 本次启动使用的端口对。 */
  const ports = await findAvailablePortPair(
    webpackBasePort,
    loggerBasePort
  );

  if (process.argv.includes("--print-ports")) {
    process.stdout.write(`${JSON.stringify(ports)}\n`);
    return;
  }

  process.stdout.write(
    `开发端口：Webpack ${ports.webpackPort}，日志 ${ports.loggerPort}` +
      `${ports.offset ? `（自动避让 ${ports.offset} 组占用）` : ""}\n`
  );

  /** Electron Forge CLI 路径。 */
  const forgeCli = path.resolve(
    __dirname,
    "../node_modules/@electron-forge/cli/dist/electron-forge.js"
  );
  /** 需要透传给 Forge 的命令参数。 */
  const forwardedArguments = process.argv
    .slice(2)
    .filter((argument) => argument !== "--print-ports");
  /** Electron Forge 子进程。 */
  const child = spawn(
    process.execPath,
    [forgeCli, "start", ...forwardedArguments],
    {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env,
        ADB_STUDIO_WEBPACK_PORT: String(ports.webpackPort),
        ADB_STUDIO_LOGGER_PORT: String(ports.loggerPort)
      },
      stdio: "inherit"
    }
  );

  child.once("error", (error) => {
    process.stderr.write(`Electron Forge 启动失败：${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

void start().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
