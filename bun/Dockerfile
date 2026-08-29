# Build environment for bun/toolchain.ts. The glibc of this image (Ubuntu 22.04:
# 2.35) is the oldest the resulting toolchain will run on; the Bun binaries built
# *with* the toolchain are unaffected by it.
FROM ubuntu:22.04
ARG LLVM=21.1.8
ARG NODE=26.8.1
ENV DEBIAN_FRONTEND=noninteractive
# archive.ubuntu.com drops connections now and then.
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\n' > /etc/apt/apt.conf.d/80-retries

ARG CMAKE=3.30.5
# First line: what building rustc and LLVM needs. Second line: what building Bun
# (the training workload) additionally needs — the list scripts/bootstrap.sh in
# oven-sh/bun installs on its CI image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git xz-utils zstd unzip ninja-build python3 pkg-config libssl-dev zlib1g-dev file binutils libc6-dev libstdc++-12-dev libxml2 libedit2 libncurses6 \
      build-essential make nasm libtool ruby perl golang-go \
      libgmp-dev libmpfr-dev libmpc-dev flex \
    && rm -rf /var/lib/apt/lists/*
# CMake: LLVM wants >= 3.20, Bun's build >= 3.24; jammy has 3.22. Same source as Bun's bootstrap.sh.
RUN curl -fsSL --retry 8 --retry-all-errors --retry-delay 5 \
      https://github.com/Kitware/CMake/releases/download/v${CMAKE}/cmake-${CMAKE}-linux-$(uname -m).tar.gz \
    | tar -xz -C /usr/local --strip-components=1 && cmake --version

# Host compiler for stage 1 of both builds, and llvm-profdata / llvm-bolt /
# merge-fdata for the rust pipeline: LLVM's official release binaries (upstream's
# dist image likewise builds against a released clang in /rustroot).
RUN arch=$(dpkg --print-architecture | sed 's/amd64/X64/; s/arm64/ARM64/') \
    && curl -fsSL --retry 8 --retry-all-errors --retry-delay 5 \
         https://github.com/llvm/llvm-project/releases/download/llvmorg-${LLVM}/LLVM-${LLVM}-Linux-${arch}.tar.xz \
       | tar -xJ -C /opt && mv /opt/LLVM-${LLVM}-Linux-${arch} /opt/llvm \
    && /opt/llvm/bin/clang --version
# Unversioned clang/clang++/ld.lld/llvm-* on PATH, as rust's `target.*.linker=clang` expects.
ENV PATH=/opt/llvm/bin:$PATH CC=clang CXX=clang++

# GCC, for the libstdc++.a / libgcc that get statically linked into rustc's
# libLLVM.so and librustc_driver.so (--enable-llvm-static-stdcpp). As upstream's
# src/ci/docker/scripts/build-gcc.sh says: "-fno-reorder-blocks-and-partition is
# required to enable BOLT optimization of the C++ standard library"; distro
# archives are built with it on and stripped of the FILE symbols llvm-bolt would
# need to cope. Only the host clang uses this GCC (via the .cfg files below); the
# clang we ship picks up the system libstdc++ like any other clang.
# Not shipped, so unlike upstream: a current GCC, --disable-bootstrap, apt's gmp/mpfr/mpc.
ARG GCC=13.3.0
RUN curl -fsSL --retry 8 --retry-all-errors --retry-delay 5 https://ftp.gnu.org/gnu/gcc/gcc-${GCC}/gcc-${GCC}.tar.xz | tar -xJ -C /tmp \
    && mkdir /tmp/gcc-build && cd /tmp/gcc-build \
    && /tmp/gcc-${GCC}/configure --prefix=/opt/gcc --enable-languages=c,c++ --disable-multilib --disable-bootstrap \
         --disable-gnu-unique-object --enable-cxx-flags=-fno-reorder-blocks-and-partition >/dev/null \
    && make -j"$(nproc)" >/tmp/gcc-build.log 2>&1 || { tail -100 /tmp/gcc-build.log; exit 1; } \
    && make install >/dev/null && cd / && rm -rf /tmp/gcc-${GCC} /tmp/gcc-build /tmp/gcc-build.log \
    && echo /opt/gcc/lib64 > /etc/ld.so.conf.d/opt-gcc.conf && ldconfig \
    && printf -- '--gcc-install-dir=%s\n' "$(dirname "$(/opt/gcc/bin/gcc -print-libgcc-file-name)")" | tee /opt/llvm/bin/clang.cfg > /opt/llvm/bin/clang++.cfg \
    && /opt/llvm/bin/clang++ -v -x c++ /dev/null -fsyntax-only 2>&1 | grep "Selected GCC installation: /opt/gcc"

# zstd for `llvm.libzstd=true`, built as upstream's src/ci/docker/scripts/build-zstd.sh
# does. (Ubuntu's libzstd.a is GCC-built with hot/cold-split functions and no FILE
# symbols; once linked into libLLVM.so, llvm-bolt refuses to instrument it.)
ARG ZSTD=1.5.6
RUN curl -fsSL --retry 8 --retry-all-errors --retry-delay 5 https://github.com/facebook/zstd/releases/download/v${ZSTD}/zstd-${ZSTD}.tar.gz | tar -xz -C /tmp \
    && CFLAGS=-fPIC make -C /tmp/zstd-${ZSTD} -j"$(nproc)" >/dev/null && make -C /tmp/zstd-${ZSTD} install >/dev/null \
    && rm -rf /tmp/zstd-${ZSTD} && ldconfig

# node runs bun/*.ts; bun is what Bun's own build uses for its codegen steps.
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
    && curl -fsSL --retry 8 --retry-all-errors --retry-delay 5 https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-${arch}.tar.xz | tar -xJ -C /usr/local --strip-components=1 \
    && npm install -g bun \
    && node --version && bun --version

WORKDIR /checkout
