# Linux 构建环境：cp -R docker 无意义，直接从这里构建镜像。
#
# 用途：在没有 sudo 的 Linux 主机上，用容器内置 root 安装 Tauri 的全部
# 系统依赖，从而产出 .deb / .AppImage。
#
#   docker build --network host -t dogmerger-linux:1 -f desktop/docker/linux.Dockerfile desktop/docker
#   docker run --rm -v "$PWD:/src" -w /src --cpus 2 -e CARGO_BUILD_JOBS=2 \
#     dogmerger-linux:1 bash -lc 'npm ci && cd desktop && npx tauri build --bundles deb'
#
# 镜像源按所在网络环境自行替换；国内直连 Docker Hub 通常不可用。
ARG BASE=docker.m.daocloud.io/library/node:22-bookworm
FROM ${BASE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl wget file pkg-config \
      libssl-dev libgtk-3-dev libwebkit2gtk-4.1-dev \
      libayatana-appindicator3-dev librsvg2-dev patchelf \
      libxdo-dev xz-utils unzip git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Rust 走国内镜像加速；换成官方源时把这三个变量删掉即可。
ENV RUSTUP_DIST_SERVER=https://rsproxy.cn \
    RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup \
    CARGO_NET_GIT_FETCH_WITH_CLI=true
RUN curl -sSf https://rsproxy.cn/rustup-init.sh | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH=/root/.cargo/bin:$PATH
RUN mkdir -p /root/.cargo && printf '[source.crates-io]\nreplace-with = "rsproxy"\n\n[source.rsproxy]\nregistry = "sparse+https://rsproxy.cn/index/"\n\n[net]\ngit-fetch-with-cli = true\n' > /root/.cargo/config.toml

RUN node -v && npm -v && rustc --version && pkg-config --modversion webkit2gtk-4.1
