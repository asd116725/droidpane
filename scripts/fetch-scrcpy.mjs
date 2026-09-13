import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** 当前脚本目录。 */
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
/** 项目根目录。 */
const projectRoot = path.resolve(scriptDirectory, "..");
/** scrcpy 版本清单路径。 */
const manifestPath = path.join(
  projectRoot,
  "vendor",
  "scrcpy",
  "manifest.json"
);
/** scrcpy 版本清单。 */
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
/** 命令行目标参数位置。 */
const targetIndex = process.argv.indexOf("--target");
/** 指定或当前平台目标。 */
const requestedTarget =
  targetIndex >= 0
    ? process.argv[targetIndex + 1]
    : `${process.platform}-${process.arch}`;
/** 需要下载的目标列表。 */
const targetKeys = process.argv.includes("--all")
  ? Object.keys(manifest.targets)
  : [requestedTarget];

/** 判断文件是否存在。 */
async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 下载并验证单个平台的官方 scrcpy 发行包。 */
async function installTarget(targetKey) {
  /** 目标发行信息。 */
  const target = manifest.targets[targetKey];

  if (!target) {
    throw new Error(`不支持的 scrcpy 目标：${targetKey}`);
  }

  /** 最终运行时目录。 */
  const destination = path.join(
    projectRoot,
    "vendor",
    "scrcpy",
    targetKey
  );
  /** 已安装版本标记。 */
  const marker = path.join(destination, ".runtime-version");
  /** 目标 scrcpy 文件名。 */
  const executable =
    targetKey === "win32-x64"
      ? path.join(destination, "scrcpy.exe")
      : path.join(destination, "scrcpy");
  /** 应用运行与官方便携包完整性所需文件。 */
  const requiredFiles = [
    executable,
    path.join(destination, targetKey === "win32-x64" ? "adb.exe" : "adb"),
    path.join(destination, "scrcpy-server"),
    ...(targetKey === "win32-x64"
      ? ["AdbWinApi.dll", "AdbWinUsbApi.dll"].map((fileName) =>
          path.join(destination, fileName)
        )
      : [])
  ];
  /** 当前缓存是否包含全部关键运行时文件。 */
  const runtimeComplete = (
    await Promise.all(requiredFiles.map((filePath) => exists(filePath)))
  ).every(Boolean);

  if (
    (await exists(marker)) &&
    (await readFile(marker, "utf8")) === manifest.version &&
    runtimeComplete
  ) {
    process.stdout.write(`scrcpy ${manifest.version} ${targetKey} 已就绪\n`);
    return;
  }

  /** 受控临时目录。 */
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "droidpane-scrcpy-")
  );
  /** 临时发行包路径。 */
  const archivePath = path.join(temporaryDirectory, target.archive);
  /** 临时解压目录。 */
  const extractionPath = path.join(temporaryDirectory, "extracted");

  try {
    process.stdout.write(`下载 ${target.archive}\n`);
    /** GitHub 发行包响应。 */
    const response = await fetch(target.url, {
      headers: { "User-Agent": "droidpane" }
    });

    if (!response.ok) {
      throw new Error(`下载失败：HTTP ${response.status}`);
    }

    /** 完整发行包字节。 */
    const archive = Buffer.from(await response.arrayBuffer());
    /** 下载内容 SHA-256。 */
    const digest = createHash("sha256").update(archive).digest("hex");

    if (digest !== target.sha256) {
      throw new Error(`SHA-256 校验失败：${target.archive}`);
    }

    await writeFile(archivePath, archive);
    await mkdir(extractionPath, { recursive: true });
    /** 使用系统 bsdtar 解压 tar.gz 或 zip。 */
    const extraction = spawnSync(
      "tar",
      ["-xf", archivePath, "-C", extractionPath],
      {
        stdio: "inherit",
        shell: false,
        windowsHide: true
      }
    );

    if (extraction.status !== 0) {
      throw new Error(`无法解压 ${target.archive}`);
    }

    /** 发行包根目录内容。 */
    const entries = await readdir(extractionPath, {
      withFileTypes: true
    });
    /** 发行包内唯一根文件夹。 */
    const sourceDirectory = path.join(
      extractionPath,
      entries.find((entry) => entry.isDirectory()).name
    );

    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(sourceDirectory, destination, { recursive: true });
    await writeFile(marker, manifest.version, "utf8");

    if (targetKey.startsWith("darwin-")) {
      await chmod(path.join(destination, "adb"), 0o755);
      await chmod(path.join(destination, "scrcpy"), 0o755);
    }

    process.stdout.write(
      `scrcpy ${manifest.version} ${targetKey} 安装并校验完成\n`
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

for (const targetKey of targetKeys) {
  await installTarget(targetKey);
}
