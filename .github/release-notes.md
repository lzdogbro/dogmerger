用 ffmpeg 流复制把视频和音频合成一个文件，内存占用恒定（~30 MB），与文件大小无关。

## 下载

| 平台 | 文件 |
|---|---|
| macOS (Apple Silicon) | `Dogmerger_*_aarch64.dmg` |
| Windows x64 | `Dogmerger_*_x64-setup.exe`（安装包）、`Dogmerger_*_x64_en-US.msi`、`dogmerger.exe`（免安装） |
| Linux x86_64 | `Dogmerger_*_amd64.deb` |

## 运行前提

**无需安装 ffmpeg** —— 安装包已内置最小化的 FFmpeg 7.1.1（LGPL 2.1+）。

如果系统里已有更完整的 ffmpeg，可在应用右上角「依赖状态」里指定使用它，
或设置环境变量 `FFMPEG_PATH` / `FFPROBE_PATH`。

## 说明

- macOS 与 Windows 包未签名。macOS 首次打开需右键 → 打开；Windows 会提示 SmartScreen，选择「更多信息 → 仍要运行」。
- 拖入文件即可合并：桌面版直接读取文件路径，不复制、不上传。
