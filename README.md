# dogmerger

Dogmerger is a lightweight tool that uses FFmpeg to combine sets of video and audio files—which share the same duration—into a single video file with audio. For example, by importing an MP3 file and an MP4 file and clicking "merge," you can create a combined video file named "output.mp4."

## 两种形态

同一套 UI，两个外壳：

| | Web 版 | 桌面版（Tauri） |
|---|---|---|
| 浏览器只做界面，ffmpeg 由本地 Express 服务调用 | ✅ | — |
| ffmpeg 由 Rust 直接调用，无 HTTP 层 | — | ✅ |
| 拖入文件 | 弹系统选择框确认后填入路径 | **路径直达，零拷贝、无对话框** |
| 运行方式 | `npm run dev` | `npm run desktop:dev` / 双击 .app |

UI 代码（`web/src`）完全共享，差别只在 `web/src/transport/` 下的两个实现。

## 设计要点

这个工具的核心是**流复制（stream copy）**，不是转码：

```
ffmpeg -i video.mp4 -i audio.mp3 -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 256k out.mp4
```

ffmpeg 只做「读 packet → 写 packet」，不解码画面。实测峰值内存约 **30 MB，且与文件大小无关** —— 无论是 100 MB 还是 100 GB。

| 场景 | 10 GB 耗时 | 峰值内存 |
|---|---|---|
| 流复制合流 | ~30 秒 | ~30 MB |

### 时长不一致时的行为

| 情况 | 默认处理 | 资源开销 |
|---|---|---|
| 视频长于音频 | 音轨自然结束，多出的部分静音 | 零 |
| 音频长于视频 | 不填充。播放器停在最后一帧，声音继续 | 零 |

为什么不做填充：MP4 中一条轨道只能携带一份 `avcC`（SPS/PPS 参数集）。原视频由硬件编码器产生，新编码的黑画面参数集对不上，无法用 `-c copy` 拼接，只能整条重编码 —— 代价是 100 倍耗时。所以本项目只做流复制，不提供填充选项。

## 架构

这是「本地 Web 服务 + 浏览器控制台」：浏览器只负责界面，ffmpeg 直接读写本机文件，**媒体数据从不经过 HTTP**。

```
浏览器 UI (Vite/React)
      │  JSON（只有文件路径和进度）
      ▼
本地服务 (Express, 127.0.0.1:8787)
      │  spawn 子进程
      ▼
ffmpeg ──► 直接读本地文件，直接写本地文件
```

选择文件的三种方式：

- **拖入卡片**：视频拖左栏，音频拖右栏
- **原生对话框**：点击卡片或「浏览…」由服务端弹出系统文件选择框，拿到真实路径，零拷贝
- **手动输入**：直接粘贴绝对路径

### 输出文件命名

输出固定为 `<原视频文件名>_merged.<容器后缀>`，与源视频同目录：

```
~/Movies/My Holiday.mp4  ->  ~/Movies/My Holiday_merged.mp4
```

合并完成后光标会自动落在「完成」卡片的文件名上，并选中不含扩展名的部分（和 Finder 一致），直接输入即可重命名。重命名会真正改动磁盘文件（`POST /api/jobs/:id/rename`），并按回车提交。同名文件已存在时返回 409，不会覆盖。

### 拖入为什么不直接读路径

浏览器安全沙箱不向页面暴露拖入文件的真实路径 —— `File.path` 早已被移除，`FileSystemFileHandle` 也只有名字没有路径。Electron 需要专门的 `webUtils.getPathForFile()`、Tauri 需要专门的 `tauri://drag-drop` 事件，原因就是标准 Web 拿不到。

因此本项目**不做上传、不做临时副本**：拖入只作为一次交互确认，立刻弹出系统文件选择框，用户选中后由服务端拿到真实路径填入输入框。这样拖入手势可用，而数据依旧是零拷贝。

代价是拖入后需要在那一个对话框里再点一次。相比复制 10 GB 文件，这个代价可以忽略。Tauri 桌面版可以去掉这一步 —— `tauri://drag-drop` 直接给路径。

## 桌面版（Tauri）

### 为什么拖入能真正零拷贝

浏览器永远拿不到拖入文件的路径，所以 Web 版只能退而求其次弹选择框。Tauri 不同：系统把拖放的绝对路径直接交给 Rust，`ffmpeg` 就地读取，中间没有任何副本、上传或对话框。

拖放事件是**窗口级**的，所以代码要用坐标做命中测试，判断落在左栏还是右栏：

```ts
const element = document.elementFromPoint(x, y);
const slot = element?.closest('.slot');   // .slot.video / .slot.audio
```

坐标单位有个坑：wry 在 macOS/Linux 上返回的是**窗口点**（`NSDraggingInfo.draggingLocation`、GTK 控件坐标），
在 Windows 上返回的却是**物理像素**（DPI-aware 的 `ScreenToClient`），而 Tauri 的 JS 层一律把它包成
`PhysicalPosition`。如果无脑除以 `devicePixelRatio`，Retina 屏幕上坐标会被缩放两次，落点永远偏到左栏。
所以 `toCssPoint()` 按平台区分处理，只在 Windows 上做换算。

### 运行

```bash
npm install
npm run desktop:dev      # 启动 Vite + 编译 Rust + 打开窗口
```

开发模式下窗口加载 Vite 的页面，改前端会热更新；改 Rust 需要重新编译。

### 打包

```bash
npm run desktop:build
# 产物: desktop/src-tauri/target/release/bundle/dmg/*.dmg
#       desktop/src-tauri/target/release/bundle/macos/Dogmerger.app
```

打包版把前端资源内嵌进可执行文件，不需要 Vite，也不需要 Node。

### 内置 ffmpeg 的构建

`desktop/src-tauri/binaries/` 下按 target triple 命名的二进制由脚本生成：

```bash
scripts/build-ffmpeg.sh                 # 本机平台
scripts/build-ffmpeg.sh --windows       # 在 Linux 上交叉编译 Windows x64（需 mingw-w64）
```

脚本从 ffmpeg.org 取指定版本源码，以 `--disable-everything` 起底、只开启需要的
demuxer/muxer/解码器/AAC 编码器，产出约 3 MB 的静态可执行文件。授权信息见
`desktop/src-tauri/THIRD-PARTY.md`。

### 平台与 Windows 构建

`bundle.targets` 设为 `"all"`，由宿主系统决定产物：macOS 出 `.app` + `.dmg`，Windows 出 `.msi` + NSIS `.exe`。

Tauri 官方只支持在目标系统上构建 —— 从 macOS 交叉编译 Windows 属于「最后手段」（只能出 NSIS，且测试不充分），MSI 必须在 Windows 上打。所以 也可以从 Linux 交叉编译 **NSIS 安装包**（`.msi` 仍然只能在 Windows 上打）：

```bash
cargo install --locked cargo-xwin
rustup target add x86_64-pc-windows-msvc
cd desktop && npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

两个已知坑：
- Tauri CLI 下载 `nsis_tauri_utils.dll` 和 NSIS 发行版时用的 rustls 在国内网络容易 `TLS close_notify` 失败，可先在宿主机用 `curl` 下好放进 `~/.cache/tauri/`
- Debian bookworm 的 NSIS 3.08 缺 `Include/Win/RestartManager.nsh`，需要从 Ubuntu 24.04 的 `nsis-common` 包里补上

正因如此，Windows 版仍推荐用 CI 构建（`.github/workflows/build.yml`）：

- push 到 `main`、打 `v*` tag、或手动 `workflow_dispatch` 时触发
- 矩阵包含 `macos-latest` 与 `windows-latest`
- 产物在该次 run 的 **Artifacts** 里下载（`dogmerger-windows-latest`）

Linux 版（`.deb` / `.AppImage`）可在任意 Linux 主机上用 `desktop/docker/linux.Dockerfile` 构建 —— 镜像里装好了 webkit2gtk-4.1 等全部系统依赖，宿主机无 sudo 也能用：

```bash
docker build --network host -t dogmerger-linux:1 -f desktop/docker/linux.Dockerfile desktop/docker
docker run --rm -v "$PWD:/src" -w /src --cpus 2 -e CARGO_BUILD_JOBS=2 \
  dogmerger-linux:1 bash -lc 'npm ci && cd desktop && npx tauri build --bundles deb'
```

Windows 上运行时需要机器已安装 ffmpeg 并在 `PATH` 中，或设置 `FFMPEG_PATH` / `FFPROBE_PATH` 环境变量 —— 目前没有把 ffmpeg 作为 sidecar 打进安装包。

### 依赖检测

右上角的状态标签显示 ffmpeg 版本；缺依赖时变成「缺少 ffmpeg、ffprobe」，点击可展开「依赖状态」面板。

**应用内置 ffmpeg**，开箱即用，无需用户自行安装。

检测顺序（前一个命中即停）：

1. 应用内设置（面板里「选择位置…」选的路径，存于平台配置目录的 `settings.json`）
2. 环境变量 `FFMPEG_PATH` / `FFPROBE_PATH`
3. 内置 sidecar（与主程序同目录的 `ffmpeg` / `ffprobe`）
4. `PATH` 与 `/opt/homebrew/bin`、`/usr/local/bin` 等常见目录

内置的是**最小化构建**（7.1.1，LGPL 2.1+）：只保留 `-c copy` 合流、AAC 转码和常见容器/音频解码，
每个平台约 5.5 MB（ffmpeg + ffprobe），安装包因此增大约 4.7 MB。不含 x264/x265 等 GPL 组件 —— 
本应用从不编码视频，用不到。

面板里：

- 分别显示 ffmpeg 与 ffprobe 的状态、版本、路径、来源（自定义 / 环境变量 / 内置 / PATH）
- 缺哪个就列哪个，附**按平台给出的安装命令**和一键复制
- 「重新检测」无需重启应用
- 桌面版可「选择位置…」直接指定二进制；设置过但路径失效时会提示并自动回退

### 仅桌面版有的行为

- 关闭窗口即退出，并杀掉仍在运行的 ffmpeg 子进程
- ffmpeg 从 `/opt/homebrew/bin`、`/usr/local/bin` 等常见路径查找 —— GUI 应用拿不到终端的 `PATH`

## 开发

```bash
npm install
npm run dev          # 服务端 8787 + 前端 5173
```

打开 http://127.0.0.1:5173

生产模式：

```bash
npm run build        # 构建前端到 web/dist
npm start            # 服务端同时托管静态文件 → http://127.0.0.1:8787
```

### 环境要求

- Node.js ≥ 20
- ffmpeg / ffprobe 在 PATH 中，或通过 `FFMPEG_PATH` / `FFPROBE_PATH` 指定

```bash
brew install ffmpeg
```

## 校验规则

- 第一个文件必须含视频流，第二个必须含音频流
- 输出路径不能与任一输入相同
- 输出目录剩余空间不足时直接拒绝启动（避免 10 GB 任务跑到 99% 才失败）
- 已存在的输出文件不会被覆盖，自动递增为 `output-1.mp4`
- 视频编码不在 MP4 白名单（h264/hevc/av1/vp9/mpeg4）时，自动改用 MKV 容器

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | ffmpeg 可用性、平台、选择框支持情况 |
| POST | `/api/pick` | 弹出原生对话框，返回路径（取消返回 `null`） |
| POST | `/api/probe` | 探测单个文件的时长/编码/分辨率 |
| POST | `/api/plan` | 只做校验和预览，不执行 |
| POST | `/api/jobs` | 创建合并任务，立即返回 job |
| GET | `/api/jobs/:id` | 查询进度 |
| POST | `/api/jobs/:id/cancel` | 取消并删除残留输出 |
| POST | `/api/jobs/:id/rename` | 重命名已完成的输出文件 |
| GET | `/api/jobs/:id/download` | 下载结果 |
| POST | `/api/reveal` / `/api/open` | 在文件管理器中定位 / 打开播放 |

## 目录结构

```
dogmerger/
├── server/src/
│   ├── index.ts      HTTP 路由
│   ├── ffprobe.ts    媒体探测
│   ├── plan.ts       合并策略（纯函数，可单测）
│   ├── ffmpeg.ts     argv 构建 + 进度解析 + 子进程管理
│   ├── jobs.ts       任务注册表、磁盘空间检查、输出命名
│   ├── picker.ts     跨平台原生文件对话框
│   └── binaries.ts   ffmpeg 探测
├── web/src/
│   ├── App.tsx       左右双栏 UI + 拖放
│   ├── api.ts        传输层门面（自动选择 HTTP / Tauri）
│   ├── types.ts      共享类型契约
│   └── transport/
│       ├── http.ts   浏览器：localhost HTTP
│       └── tauri.ts  桌面：invoke 直连 Rust
└── desktop/src-tauri/
    ├── src/lib.rs    Tauri 命令注册
    ├── src/media.rs  ffprobe 探测
    ├── src/plan.rs   合并策略（含单元测试）
    ├── src/jobs.rs   ffmpeg 子进程、进度解析、退出处理
    └── src/ffmpeg.rs 可执行文件定位
```

## 后续

- Tauri 桌面版迁移：`server/` 的逻辑基本可以原样搬进 Rust sidecar 或继续以 Node 子进程运行，`picker.ts` 换成 Tauri 的 dialog API，拖放改用 `tauri://drag-drop` 事件拿真实路径（拖入即可零拷贝，无需再弹对话框）
- 多文件拼接（concat demuxer，同样是流复制，开销恒定）
