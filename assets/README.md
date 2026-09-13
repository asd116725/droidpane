# DroidPane 图标

图标以叠映屏幕和字母 D 表达安卓镜像，使用薄荷绿、深青色和石墨黑。
原稿由内置图像生成工具生成，随后统一尺寸并封装为桌面图标格式。

- `app-icon.png`：1024 × 1024 标准图稿，用于标题栏、文档和开发环境。
- `app-icon.icns`：macOS 多尺寸图标，包含 16–1024 像素图像。
- `app-icon.ico`：Windows 多尺寸图标，包含 16、24、32、48、64、128、256 像素图像。

三个文件必须同步更新，避免开发窗口与安装包使用不同图标。

## 最终生成提示词

基于已选定的双屏 D 标志进行编辑，最终使用以下提示词生成独立图稿：

> Edit this app icon image only to remove the entire checkerboard area and make the icon suitable as an application asset. Keep the approved mint green D-shaped mirrored-screen logo exactly unchanged. Enlarge the graphite black tile to fill the ENTIRE square canvas edge to edge, with its outer corners entirely outside the image. Output a perfectly square full-bleed graphite black application icon: a rich #101719 dark background covering EVERY pixel at all four corners and all edges, centered mint and dark-teal double-screen D emblem, same geometric shape, slight subtle internal lighting, NO outer rounded-square border, NO margin, NO exterior shadow. This is a simple full-bleed dark square with the approved D mark centered and occupying about 65 percent of width and height. NO checkerboard anywhere, NO white or gray exterior, NO transparency simulation, NO typography, no mockup. 1024x1024. Preserve accepted identity.
