# Changelog / 更新日志

## 1.1.0 — 2026-10-28

### Added / 新增

- Wireless connection center: Android 11+ pairing codes, direct connection for paired devices, mDNS discovery, and recent device names and records.
- Finite mirror recovery: retry interrupted sessions for up to 30 seconds, preserve the last frame, suspend input, and offer retry/cancel controls. Recording does not restart automatically.
- Compact phone window: switch the existing window to a phone layout, toggle always-on-top, and remember separate normal and compact bounds.
- 无线连接中心：支持 Android 11+ 配对码、已配对设备直接连接、mDNS 发现和最近设备管理。
- 断线恢复：对当前投屏进行最长 30 秒的有限重试，保留最后画面、暂停输入，并提供重试与取消；录制需手动重新开始。
- 紧凑手机窗口：同一窗口切换布局，支持置顶，分别保存完整与紧凑窗口的位置和尺寸。

### Fixed / 修复

- Cancel stale wireless operations when a newer connection or mirror action takes over.
- Keep the previous canvas pixels until a newly decoded frame replaces them, including after rotation.
- Serialize settings writes so connection and window preferences cannot overwrite recording preferences.
- Wait for macOS fullscreen transitions before applying the next window mode.
- 新操作会取消过期的无线任务；恢复期间不提前清空画布；串行保存设置，避免丢失录制偏好；窗口模式切换等待系统全屏转换完成。

### Compatibility and validation / 兼容与验证范围

- Wireless pairing requires Android 11+ and a shared Wi-Fi network. Pairing and connection ports are different. USB remains available for older devices.
- Automatic recovery requires a verifiable device identity. Unreachable networks or expired authorization require manual reconnection.
- macOS builds use an ad-hoc signature and are not notarized. The Windows installer is not code-signed.
- Automated tests and desktop UI checks cover the new flows. Real-phone wireless pairing/recovery and continuous fullscreen transitions have not been verified on hardware for this release.
- 无线配对需要 Android 11+ 且手机电脑处于同一 Wi-Fi；配对端口与连接端口不同。自动恢复需要可核验的设备身份。
- macOS 为临时签名、未经 Apple 公证，Windows 安装程序未签名。本版本尚未完成真机无线配对、断线恢复及连续全屏切换的硬件验收。
