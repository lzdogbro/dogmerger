# 第三方组件

## FFmpeg 7.1.1（LGPL 2.1 或更高版本）

本应用内置 `ffmpeg` 与 `ffprobe` 两个可执行文件（`binaries/`），以**独立进程**方式调用，
不与本应用链接。

- 来源：<https://ffmpeg.org/download.html>
- 许可证全文：`licenses/COPYING.LGPLv2.1`
- 构建配置：`--disable-gpl --disable-nonfree`，因此为 **LGPL 2.1+**，不含 x264/x265 等 GPL 组件
- 构建脚本：仓库根目录 `scripts/build-ffmpeg.sh`，可从源码完全复现

如需替换为自己构建的 FFmpeg：用同版本源码、以任意配置编译，将产物放到
`desktop/src-tauri/binaries/<name>-<target-triple>` 后重新打包即可（LGPL 允许替换）。
也可以在应用内「依赖状态 → 选择位置」指向自定义的 ffmpeg。
