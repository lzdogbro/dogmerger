用 ffmpeg 流复制把视频和音频合成一个文件，内存占用恒定（~30 MB），与文件大小无关。

## 下载

| 平台 | 文件 |
|---|---|
| macOS (Apple Silicon) | `Dogmerger_*_aarch64.dmg` |
| Windows x64 | `Dogmerger_*_x64-setup.exe`（安装包）、`Dogmerger_*_x64_en-US.msi`、`dogmerger.exe`（免安装） |
| Linux x86_64 | `Dogmerger_*_amd64.deb` |

## 运行前提

需要系统已安装 **ffmpeg** 与 **ffprobe**：

- macOS：`brew install ffmpeg`
- Windows：`winget install Gyan.FFmpeg`，或把 ffmpeg 所在目录加入 `PATH`
- Linux：`sudo apt install ffmpeg`

也可以用环境变量 `FFMPEG_PATH` / `FFPROBE_PATH` 指定可执行文件。

## 说明

- macOS 与 Windows 包未签名。macOS 首次打开需右键 → 打开；Windows 会提示 SmartScreen，选择「更多信息 → 仍要运行」。
- 拖入文件即可合并：桌面版直接读取文件路径，不复制、不上传。
