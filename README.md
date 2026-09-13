**English** | [简体中文](README.zh-CN.md)

<p align="center">
  <img src="assets/app-icon.png" width="128" alt="DroidPane icon" />
</p>

# DroidPane

**Android Mirror & Debug — A desktop toolkit for Android screen mirroring and control.**

DroidPane brings Android screen mirroring, mouse and keyboard control, recording,
and video management into one desktop workspace. Use it to demonstrate apps,
reproduce issues, record tutorials, and capture testing sessions.

Built with Electron 43.2, React 19, TypeScript, and scrcpy 4.1, DroidPane supports
macOS and Windows. Mirroring and recording run independently: control your device,
start recording when needed, and keep using the mirror after recording stops.

## Features

| Feature | What you can do |
| --- | --- |
| Device selection | Detect USB devices, network devices, and Android emulators already connected through ADB. View their model, Android version, serial number, and connection status. |
| Live mirroring | View your Android screen on the desktop, switch to fullscreen, and monitor mirror status and frame rate. |
| Mouse control | Click, drag, and scroll directly on the mirror; right-click to go back. A side panel provides Back, Home, Power, and notification shade controls. |
| Keyboard input | Type English and Chinese, paste text, and use common editing keys and shortcuts. |
| Independent recording | Start and stop recording during a mirror session without closing the mirror. Track recording time and status. |
| Video quality | Choose 720p, 1080p, or the original resolution, with video bitrates of 4, 8, or 16 Mbps. |
| Audio capture | Record internal device audio or choose silent recording. Where supported, save H.264 video and AAC audio directly to MP4. |
| Desktop audio monitoring | Toggle audio playback on your computer and adjust its volume independently, without changing the recorded audio volume. |
| Video library | Automatically discover recordings, generate thumbnails from actual video frames, search by filename, and sort by recording time. |
| Built-in player | Play, pause, seek, skip back 10 seconds, adjust volume, enter fullscreen, and watch at 1×, 1.25×, 1.5×, or 2× speed. |
| File management | Inspect duration, resolution, file size, and audio tracks; export MP4 without re-encoding; open the containing folder; move individual or multiple recordings to the system trash. |
| Storage preferences | Choose a recording directory and keep your quality and audio monitoring preferences across sessions. |

Mirroring and recording continue in the background when you switch to the video
library. You can play earlier recordings while recording; deleting videos and
changing the storage location are temporarily disabled. End the mirror session
before changing video quality settings.

## Demo

Recorded using an **Android 13 emulator**, this **1 minute 32 second** demo covers
clicking, going back, scrolling, opening the notification shade, starting and
stopping recording, and playing a recording from the video library. Idle segments
have been removed; all screenshots and footage show the actual application.

https://github.com/user-attachments/assets/e39b22ca-ded8-4b2a-b27e-e40167acd951

[View or download the demo MP4](docs/media/droidpane-demo.mp4) · [Recording environment and media notes (Chinese)](docs/media/README.md)

| Time | Demonstration |
| --- | --- |
| 00:00 | Live mirroring and opening a system settings page |
| 00:12 | Recording, going back, and scrolling |
| 00:30 | Opening the Android notification shade |
| 00:38 | Closing the notification shade and stopping recording while mirroring continues |
| 00:56 | Opening the video library to view thumbnails and file details |
| 01:18 | Playing the recording in the built-in player |

## Screenshots

These screenshots show DroidPane connected to an Android 13 emulator.

### Mirroring and device control

![DroidPane live mirroring and device controls](docs/media/mirroring.png)

### Recording in progress

![DroidPane recording timer and stop button](docs/media/recording.png)

### Video library and playback

![DroidPane video library, thumbnails, and built-in player](docs/media/video-library.png)

## Quick start

The application UI is currently in Chinese. The steps below include the matching
button labels.

1. Start an Android emulator, or connect an Android device with **USB debugging** enabled. Approve the debugging authorization prompt on a physical device when connecting for the first time.
2. Open DroidPane, click **Refresh devices (刷新设备)**, and select a device.
3. Choose a resolution, video bitrate, and audio source, then click **Start mirroring (开启镜像控制)**.
4. Interact with the device directly in the mirror. Click **Start recording (开始录制)** whenever you want to capture the session.
5. After stopping the recording, open the **Video library (视频库)** or click **View video (查看视频)** in the completion notification.
6. To share a recording, select it and click **Export MP4 (导出 MP4)**. Click **End mirroring (结束镜像)** when you finish using the device.

Network devices must already be connected through ADB; DroidPane discovers
existing ADB connections. The packaged application includes the required runtime,
so you do not need to install scrcpy separately for normal use.

## Mirror controls

Recording requires an active mirror session. The workflow is: choose settings →
start mirroring → start or stop recording → end mirroring. While mirroring, you
can click, drag, scroll, right-click to go back, type English or Chinese, and paste
text. Recording begins at the next keyframe. Stopping a recording keeps mirroring,
device control, and desktop audio monitoring running.

Focus the mirror to use these shortcuts. On macOS, use Option instead of Alt.

- `Esc`: Back
- `Alt/Option + H`: Home
- `Alt/Option + P`: Power
- `Alt/Option + N`: Open the notification shade
- `F11`: Toggle fullscreen mirroring

## Development

Requires Node.js 22.14.0 or later.

```bash
git clone https://github.com/asd116725/droidpane.git
cd droidpane
npm install
npm run fetch:scrcpy
npm start
```

Common validation commands:

```bash
npm test -- --no-watchman
npm run typecheck
npm run lint
npm run package
```

## Bundled runtime

`vendor/scrcpy/manifest.json` pins the following official scrcpy 4.1 releases and
their SHA-256 checksums:

- macOS Apple Silicon: `scrcpy-macos-aarch64-v4.1.tar.gz`
- macOS Intel: `scrcpy-macos-x86_64-v4.1.tar.gz`
- Windows x64: `scrcpy-win64-v4.1.zip`

`scripts/fetch-scrcpy.mjs` downloads, verifies, and extracts the runtime for the
target platform before development or packaging. Extracted runtime directories
are excluded from Git and included in the application as an `extraResource`.

## Packaging

Build for the current machine's architecture:

```bash
npm run make
```

Build for a specific macOS architecture:

```bash
npm run make -- --arch=arm64
npm run make -- --arch=x64
```

The resulting installers are:

- `out/make/DroidPane-arm64.dmg`
- `out/make/DroidPane-x64.dmg`

Windows MSI installers must be built on a Windows runner with WiX Toolset v3
installed. The setup wizard lets users choose an installation directory and
registers an uninstall entry in Windows Installed apps.
`.github/workflows/build-installers.yml` builds macOS x64 DMG, macOS arm64 DMG,
and Windows x64 MSI installers. Windows artifacts are written to
`out/make/wix/x64/`.

## Opening development builds

macOS development builds use an ad-hoc signature and are not yet notarized by
Apple. Windows MSI installers are not yet code-signed.

- macOS: If the first launch is blocked, choose **Open Anyway** in
  **System Settings → Privacy & Security**, or Control-click the application in
  Finder and choose **Open**.
- Windows: If SmartScreen displays a prompt, choose **More info → Run anyway**.

## Recording compatibility

- Android 5.0+: Video recording is supported.
- Android 11–12: Device audio uses the `output` source.
- Android 13+: Device audio uses `playback` with audio duplication.
- Android 10 and earlier, or if audio initialization fails: Recording falls back
  to silent video, with an explanation in the UI.

Recordings are saved directly to the `DroidPane` folder in the system's video
directory. Exporting copies the file without re-encoding.

## Security boundaries

The renderer uses context isolation and sandboxing, with no Node.js access.
The preload layer exposes a fixed set of methods for devices, recording, exports,
settings, and window controls. The main process validates all IPC arguments and
senders. Video previews use a custom protocol backed by internal UUID mappings,
without exposing arbitrary local file paths to the renderer.

## License

DroidPane source code is available under the [MIT License](LICENSE).

Third-party components distributed with the application, including scrcpy, ADB,
and FFmpeg, retain their respective licenses. See the
[third-party notices](licenses/SCRCPY-THIRD-PARTY-NOTICES.md) and the
[licenses directory](licenses/).
