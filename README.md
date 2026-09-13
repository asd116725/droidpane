<p align="center">
  <img src="assets/app-icon.png" width="128" alt="DroidPane 图标" />
</p>

# DroidPane

**Android Mirror & Debug — 安卓镜像调试工具。**

使用 Electron 43.2、React 19、TypeScript 与 scrcpy 4.1 构建的跨平台
Android 录屏客户端。应用直接生成 H.264 + AAC 的 MP4，支持独立镜像
控制、镜像期间无缝开始录制、设备选择、实时预览、视频库、无损导出和
打开文件夹。

## 镜像控制

录制以用户显式开启的镜像为前置条件，操作顺序为“选择参数 → 开启镜像
→ 开始/停止录制 → 主动结束镜像”。镜像期间可在画面中点击、拖动、
滚轮滚动、右键返回，也可直接输入中英文或粘贴文本。录制会从下一个
关键帧开始，停止录制后镜像、设备控制与电脑端音频监听保持连续。

镜像画面获得焦点后支持以下快捷键（macOS 使用 Option）：

- `Esc`：返回
- `Alt/Option + H`：主页
- `Alt/Option + P`：电源键
- `Alt/Option + N`：打开设备下拉菜单
- `F11`：切换全屏镜像

## 开发

需要 Node.js 22.14.0 或更高版本。

```bash
git clone https://github.com/asd116725/droidpane.git
cd droidpane
npm install
npm run fetch:scrcpy
npm start
```

常用验证命令：

```bash
npm test -- --no-watchman
npm run typecheck
npm run lint
npm run package
```

## 内置运行时

`vendor/scrcpy/manifest.json` 锁定了以下 scrcpy 4.1 官方发行包与 SHA-256：

- macOS Apple Silicon：`scrcpy-macos-aarch64-v4.1.tar.gz`
- macOS Intel：`scrcpy-macos-x86_64-v4.1.tar.gz`
- Windows x64：`scrcpy-win64-v4.1.zip`

`scripts/fetch-scrcpy.mjs` 会在开发或打包前下载、校验并解压当前目标。
解压后的运行时目录不会提交到版本库，但会作为 `extraResource` 进入安装包。

## 打包

本机打包当前架构：

```bash
npm run make
```

macOS 交叉构建架构：

```bash
npm run make -- --arch=arm64
npm run make -- --arch=x64
```

对应产物为：

- `out/make/DroidPane-arm64.dmg`
- `out/make/DroidPane-x64.dmg`

Windows MSI 需要在已安装 WiX Toolset v3 的 Windows runner 上构建。
安装向导支持选择安装目录，并会在 Windows“已安装的应用”中注册
卸载入口。仓库中的 `.github/workflows/build-installers.yml` 会分别
产出 macOS x64 DMG、macOS arm64 DMG 与 Windows x64 MSI。Windows 产物
位于 `out/make/wix/x64/`。

## 开发构建启动

macOS 开发构建使用 ad-hoc 临时签名，尚未进行 Apple 公证；Windows MSI
尚未进行代码签名。

- macOS：首次打开若被系统阻止，在“系统设置 → 隐私与安全性”中选择
  “仍要打开”；或在 Finder 中按住 Control 点击应用并选择“打开”。
- Windows：SmartScreen 出现提示时选择“更多信息 → 仍要运行”。

## 录制兼容性

- Android 5.0+：支持视频录制。
- Android 11–12：使用 `output` 设备音频。
- Android 13+：使用 `playback` 与音频复制。
- Android 10 及以下或音频初始化失败：自动降级为静音录制并在界面说明。

录制文件直接保存到系统“视频/DroidPane”目录，导出过程只做字节
复制，不重新编码。

## 安全边界

渲染进程启用隔离与沙箱，不具备 Node.js 权限。预加载层只公开固定的设备、
录制、导出、设置和窗口控制方法；所有 IPC 参数与发送方均在主进程校验。
视频预览使用内部 UUID 映射的自定义协议，渲染进程不会获得任意本地文件路径。

## 许可证

DroidPane 源码采用 [MIT License](LICENSE)。

随安装包分发的 scrcpy、ADB、FFmpeg 等第三方组件保留各自的许可证，
详见 [第三方声明](licenses/SCRCPY-THIRD-PARTY-NOTICES.md) 和 [licenses](licenses/) 目录。
