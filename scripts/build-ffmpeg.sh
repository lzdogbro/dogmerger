#!/usr/bin/env bash
# 构建最小化的 ffmpeg / ffprobe，只保留本应用用到的能力：
#   -c copy 合流、AAC 转码、mp4/mkv 输出、常见容器与音频解码
#
# 产物落到 desktop/src-tauri/binaries/，文件名带 Rust target triple 后缀，
# 供 Tauri 的 bundle.externalBin 打包。
#
#   scripts/build-ffmpeg.sh                 # 本机平台
#   scripts/build-ffmpeg.sh --windows       # 在 Linux 上交叉编译 Windows x64
#   FFMPEG_VERSION=7.1.1 scripts/build-ffmpeg.sh
#
# 授权：--disable-gpl --disable-nonfree，因此产物是 LGPL 2.1+。
set -euo pipefail

FFMPEG_VERSION="${FFMPEG_VERSION:-7.1.1}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/desktop/src-tauri/binaries"
WORK="${WORK:-$(mktemp -d)}"

CROSS_WINDOWS=0
for arg in "$@"; do
  case "$arg" in
    --windows) CROSS_WINDOWS=1 ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

# 只保留这些能力：容器、协议、音频编解码、滤镜
COMMON_FLAGS="
  --disable-everything
  --disable-doc --disable-debug --disable-network
  --disable-autodetect --disable-iconv
  --enable-small --disable-gpl --disable-nonfree
  --disable-ffplay
  --enable-ffmpeg --enable-ffprobe
  --enable-avcodec --enable-avformat --enable-avfilter
  --enable-swresample --enable-swscale
  --enable-protocol=file,pipe
  --enable-demuxer=mov,matroska,mp3,wav,aac,flac,ogg,avi,mpegts,mpegps,image2,asf,flv,mp4
  --enable-muxer=mp4,mov,matroska,ipod
  --enable-encoder=aac
  --enable-decoder=aac,mp3,flac,vorbis,opus,alac,ac3,eac3,dca,truehd,mlp,wmav1,wmav2,wmapro,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_u8,pcm_alaw,pcm_mulaw
  --enable-parser=aac,mpegaudio,vorbis,opus,flac,h264,hevc,ac3
  --enable-bsf=aac_adtstoasc,h264_mp4toannexb,hevc_mp4toannexb
  --enable-filter=aresample,anull,copy,format,null,scale
"

fetch_source() {
  if [ ! -d "$WORK/ffmpeg-$FFMPEG_VERSION" ]; then
    echo "==> 下载 ffmpeg $FFMPEG_VERSION"
    curl -fsSL -o "$WORK/ffmpeg.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
    tar -xf "$WORK/ffmpeg.tar.xz" -C "$WORK"
  fi
}

jobs_count() {
  if command -v nproc >/dev/null 2>&1; then nproc; else sysctl -n hw.ncpu; fi
}

build_native() {
  case "$(uname -s)" in
    Darwin) TRIPLE="$( [ "$(uname -m)" = arm64 ] && echo aarch64-apple-darwin || echo x86_64-apple-darwin )" ;;
    Linux)  TRIPLE="$( [ "$(uname -m)" = aarch64 ] && echo aarch64-unknown-linux-gnu || echo x86_64-unknown-linux-gnu )" ;;
    *) echo "不支持的平台: $(uname -s)" >&2; exit 1 ;;
  esac
  # x86 才需要 nasm/yasm；没有就关掉汇编优化
  local extra=""
  case "$(uname -m)" in x86_64|i*86) extra="--disable-x86asm" ;; esac

  echo "==> 编译 $TRIPLE"
  ( cd "$WORK/ffmpeg-$FFMPEG_VERSION" \
    && make distclean >/dev/null 2>&1 || true
    ./configure --prefix="$WORK/out-$TRIPLE" $COMMON_FLAGS $extra > "$WORK/configure-$TRIPLE.log"
    make -j"$(jobs_count)" > "$WORK/make-$TRIPLE.log"
  )
  mkdir -p "$OUT_DIR"
  cp "$WORK/ffmpeg-$FFMPEG_VERSION/ffmpeg"  "$OUT_DIR/ffmpeg-$TRIPLE"
  cp "$WORK/ffmpeg-$FFMPEG_VERSION/ffprobe" "$OUT_DIR/ffprobe-$TRIPLE"
  chmod +x "$OUT_DIR/ffmpeg-$TRIPLE" "$OUT_DIR/ffprobe-$TRIPLE"
  echo "==> 完成: $OUT_DIR/{ffmpeg,ffprobe}-$TRIPLE"
}

build_windows_cross() {
  local triple="x86_64-pc-windows-msvc"
  command -v x86_64-w64-mingw32-gcc >/dev/null || { echo "需要 sudo apt install mingw-w64" >&2; exit 1; }

  echo "==> 交叉编译 $triple"
  ( cd "$WORK/ffmpeg-$FFMPEG_VERSION" \
    && make distclean >/dev/null 2>&1 || true
    ./configure --prefix="$WORK/out-$triple" $COMMON_FLAGS \
      --disable-x86asm \
      --enable-cross-compile --target-os=mingw32 --arch=x86_64 \
      --cross-prefix=x86_64-w64-mingw32- > "$WORK/configure-$triple.log"
    make -j"$(jobs_count)" > "$WORK/make-$triple.log"
  )
  mkdir -p "$OUT_DIR"
  cp "$WORK/ffmpeg-$FFMPEG_VERSION/ffmpeg.exe"  "$OUT_DIR/ffmpeg-$triple.exe"
  cp "$WORK/ffmpeg-$FFMPEG_VERSION/ffprobe.exe" "$OUT_DIR/ffprobe-$triple.exe"
  echo "==> 完成: $OUT_DIR/{ffmpeg,ffprobe}-$triple.exe"
}

fetch_source
if [ "$CROSS_WINDOWS" = "1" ]; then build_windows_cross; else build_native; fi
echo "工作目录: $WORK"
