/** Node TCP 服务模块。 */
const net = require("node:net");

/** TCP 最大端口号。 */
const maximumPort = 65_535;

/** 检查指定 TCP 端口是否可绑定。 */
function isPortAvailable(port) {
  return new Promise((resolve, reject) => {
    /** 临时端口探测服务。 */
    const server = net.createServer();

    server.unref();
    server.once("error", (error) => {
      if (["EADDRINUSE", "EACCES"].includes(error.code)) {
        resolve(false);
        return;
      }
      reject(error);
    });
    server.listen({ port, exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** 从基准端口开始查找同偏移量的可用端口对。 */
async function findAvailablePortPair(
  webpackBasePort,
  loggerBasePort,
  probe = isPortAvailable
) {
  /** 当前尝试的配对偏移量。 */
  let offset = 0;

  while (Math.max(webpackBasePort, loggerBasePort) + offset <= maximumPort) {
    /** 当前 Webpack 端口。 */
    const webpackPort = webpackBasePort + offset;
    /** 当前日志端口。 */
    const loggerPort = loggerBasePort + offset;
    /** 两个端口的可用状态。 */
    const [webpackAvailable, loggerAvailable] = await Promise.all([
      probe(webpackPort),
      probe(loggerPort)
    ]);

    if (webpackAvailable && loggerAvailable) {
      return { webpackPort, loggerPort, offset };
    }
    offset += 1;
  }

  throw new Error("没有可用的 Electron Forge 开发端口");
}

module.exports = { findAvailablePortPair, isPortAvailable };
