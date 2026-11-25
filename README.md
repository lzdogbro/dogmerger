# dogmerger

Dogmerger is a lightweight tool that uses FFmpeg to combine sets of video and audio files—which share the same duration—into a single video file with audio. For example, by importing an MP3 file and an MP4 file and clicking "merge," you can create a combined video file named "output.mp4."

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
└── web/src/
    ├── App.tsx       左右双栏 UI + 拖放
    └── api.ts        类型化客户端
```

## 后续

- Tauri 桌面版迁移：`server/` 的逻辑基本可以原样搬进 Rust sidecar 或继续以 Node 子进程运行，`picker.ts` 换成 Tauri 的 dialog API，拖放改用 `tauri://drag-drop` 事件拿真实路径（拖入即可零拷贝，无需再弹对话框）
- 多文件拼接（concat demuxer，同样是流复制，开销恒定）
