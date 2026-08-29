# Build environment for bun/toolchain.ts. The glibc of this image (Ubuntu 22.04:
# 2.35) is the oldest the resulting toolchain will run on; the Bun binaries built
# *with* the toolchain are unaffected by it.
FROM ubuntu:22.04
ARG LLVM=21
ARG NODE=26.8.1
ENV DEBIAN_FRONTEND=noninteractive
# apt.llvm.org and archive.ubuntu.com both drop connections now and then.
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\n' > /etc/apt/apt.conf.d/80-retries

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git xz-utils zstd unzip make ninja-build cmake \
      python3 pkg-config libssl-dev zlib1g-dev libzstd-dev file \
    && rm -rf /var/lib/apt/lists/*

# Host compiler for stage 1 of both builds, and llvm-profdata / llvm-bolt for the
# rust pipeline: apt.llvm.org, the same packages Bun's CI installs today.
RUN curl -fsSL --retry 8 --retry-all-errors --retry-delay 5 https://apt.llvm.org/llvm-snapshot.gpg.key -o /etc/apt/trusted.gpg.d/apt.llvm.org.asc \
    && echo "deb http://apt.llvm.org/jammy/ llvm-toolchain-jammy-${LLVM} main" > /etc/apt/sources.list.d/llvm.list \
    && apt-get update && apt-get install -y --no-install-recommends \
      clang-${LLVM} lld-${LLVM} llvm-${LLVM} bolt-${LLVM} libclang-rt-${LLVM}-dev \
    && rm -rf /var/lib/apt/lists/*
# Unversioned clang/clang++/ld.lld/llvm-* on PATH, as upstream's dist image has (/rustroot/bin)
# and as rust's `target.*.linker=clang` expects.
ENV PATH=/usr/lib/llvm-${LLVM}/bin:$PATH CC=clang CXX=clang++

# node runs bun/*.ts; bun is what Bun's own build uses for its codegen steps.
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
    && curl -fsSL --retry 8 --retry-all-errors --retry-delay 5 https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-${arch}.tar.xz | tar -xJ -C /usr/local --strip-components=1 \
    && npm install -g bun \
    && node --version && bun --version

# CMake >= 3.20 is required by LLVM; jammy ships 3.22.
WORKDIR /checkout
