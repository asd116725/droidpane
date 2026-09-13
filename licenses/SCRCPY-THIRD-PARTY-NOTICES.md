# scrcpy 4.1 与第三方组件说明

DroidPane使用 scrcpy 4.1 官方 `scrcpy-server` 协议与随发行包提供的
Android Debug Bridge 建立单路 H.264/AAC 录制会话。构建仍保留官方便携运行时，
但应用不会启动其中的 scrcpy CLI 进行第二路录制。

- 项目：Genymobile/scrcpy
- 版本：4.1
- 许可证：Apache License 2.0
- 源代码：https://github.com/Genymobile/scrcpy/tree/v4.1
- 发行包：https://github.com/Genymobile/scrcpy/releases/tag/v4.1

构建使用 `vendor/scrcpy/manifest.json` 中锁定的官方地址与 SHA-256。官方
Windows 便携包还包含以下组件；对应许可证文本均放在本目录，并随应用打包：

- Android SDK Platform-Tools 37.0.0（ADB），Apache License 2.0；源代码：
  https://android.googlesource.com/platform/packages/modules/adb/
- FFmpeg 8.1.2 共享库，GNU Lesser General Public License 2.1 或更高版本；
  许可证见 `FFMPEG-LGPL-2.1.txt`，对应源码：
  https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz
- SDL 3.4.12，zlib License；许可证见 `SDL3-LICENSE.txt`，对应源码：
  https://github.com/libsdl-org/SDL/tree/release-3.4.12
- libusb 1.0.30，GNU Lesser General Public License 2.1 或更高版本；
  许可证见 `LIBUSB-LGPL-2.1.txt`，对应源码：
  https://github.com/libusb/libusb/tree/v1.0.30
- dav1d 1.5.3，BSD 2-Clause License；许可证见 `DAV1D-LICENSE.txt`，对应源码：
  https://code.videolan.org/videolan/dav1d/-/tree/1.5.3
- zlib，zlib License；许可证见 `ZLIB-LICENSE.txt`，对应源码：
  https://github.com/madler/zlib

scrcpy 4.1 用于生成这些依赖的版本、校验值与构建参数可在其官方构建脚本中查看：
https://github.com/Genymobile/scrcpy/tree/v4.1/app/deps

DroidPane使用 Mediabunny 1.52.2 将同一条 H.264/AAC 编码流直接封装为 MP4。

- 项目：Vanilagy/mediabunny
- 版本：1.52.2
- 许可证：Mozilla Public License 2.0
- 源代码：https://github.com/Vanilagy/mediabunny

完整 MPL-2.0 文本见同目录的 `MEDIABUNNY-LICENSE.txt`。
