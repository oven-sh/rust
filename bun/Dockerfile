# Build environment for bun/toolchain.ts. The glibc of this image (Ubuntu 20.04:
# 2.31) is the oldest the resulting toolchain will run on — chosen so it also runs in
# oven-sh/WebKit's ubuntu:20.04 build container; the Bun binaries built *with* the
# toolchain are unaffected by it.
FROM ubuntu:20.04
ARG NODE=26.8.1
ARG BUN=1.4.0
ENV DEBIAN_FRONTEND=noninteractive
# archive.ubuntu.com drops connections now and then.
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\n' > /etc/apt/apt.conf.d/80-retries

ARG CMAKE=3.30.5
# First line: what building rustc and LLVM needs. Second line: what building Bun
# (the training workload) additionally needs — the list scripts/bootstrap.sh in
# oven-sh/bun installs on its CI image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git xz-utils zstd unzip ninja-build python3 pkg-config libssl-dev zlib1g-dev file binutils libc6-dev g++-10 libstdc++-10-dev libedit2 libncurses6 \
      build-essential make nasm libtool ruby perl \
      libgmp-dev libmpfr-dev libmpc-dev flex \
    && rm -rf /var/lib/apt/lists/*
# Cross gcc + glibc for the other Linux architecture, so the LLVM build can produce
# compiler-rt (ASAN etc.) for it: Bun's CI builds x64 and arm64 Linux from one host.
RUN apt-get update && apt-get install -y --no-install-recommends \
      $([ "$(dpkg --print-architecture)" = amd64 ] && echo g++-aarch64-linux-gnu || echo g++-x86-64-linux-gnu) \
    && rm -rf /var/lib/apt/lists/*

# The glibc sysroots Bun's linux-gnu builds compile against (/opt/linux-sysroot-glibc,
# /opt/linux-sysroot-glibc-arm64: ubuntu:20.04 libc + gcc-13 libstdc++), made the way
# install_linux_glibc_sysroot() in oven-sh/bun's scripts/bootstrap.sh makes them on the
# CI image. Needed to train on the Linux cross target; used by the host build too.
RUN set -e; for sr_arch in x86_64 aarch64; do \
      case $sr_arch in \
        x86_64)  sysroot=/opt/linux-sysroot-glibc;       deb_arch=amd64; apt_base=http://archive.ubuntu.com/ubuntu ;; \
        aarch64) sysroot=/opt/linux-sysroot-glibc-arm64; deb_arch=arm64; apt_base=http://ports.ubuntu.com/ubuntu-ports ;; \
      esac; \
      tmp=$(mktemp -d); mkdir -p "$sysroot"; \
      curl -fsSL --retry 8 "http://cdimage.ubuntu.com/ubuntu-base/releases/20.04/release/ubuntu-base-20.04.5-base-$deb_arch.tar.gz" | tar -xz -C "$sysroot" 2>/dev/null || true; \
      curl -fsSL --retry 8 "$apt_base/dists/focal-updates/main/binary-$deb_arch/Packages.gz" "$apt_base/dists/focal/main/binary-$deb_arch/Packages.gz" | gzip -dc > "$tmp/Packages"; \
      for pkg in libc6 libc6-dev linux-libc-dev libcrypt1 libcrypt-dev; do \
        path=$(awk -v p=$pkg '$1=="Package:"&&$2==p{f=1} f&&$1=="Filename:"{print $2; exit}' "$tmp/Packages"); \
        curl -fsSL --retry 8 -o "$tmp/pkg.deb" "$apt_base/$path" && dpkg-deb -x "$tmp/pkg.deb" "$sysroot"; \
      done; \
      find "$sysroot" -type l | while read -r l; do t=$(readlink "$l"); case $t in /*) ln -sfn "$sysroot$t" "$l" ;; esac; done; \
      [ -e "$sysroot/lib/$sr_arch-linux-gnu/libc.so.6" ] || { mkdir -p "$sysroot/lib"; ln -sfn "../usr/lib/$sr_arch-linux-gnu" "$sysroot/lib/$sr_arch-linux-gnu"; }; \
      [ $sr_arch != x86_64 ] || [ -e "$sysroot/lib64" ] || ln -sfn usr/lib/x86_64-linux-gnu "$sysroot/lib64"; \
      mkdir "$tmp/gcc13" && curl -fsSL --retry 8 "https://github.com/oven-sh/WebKit/releases/download/gcc-13-focal-debs/gcc-13-focal-$deb_arch.tar.gz" | tar -xz -C "$tmp/gcc13"; \
      for deb in "$tmp"/gcc13/*.deb; do dpkg-deb -x "$deb" "$sysroot"; done; \
      test -f "$sysroot/usr/include/stdio.h" && test -e "$sysroot/lib/$sr_arch-linux-gnu/libc.so.6" && test -d "$sysroot/usr/include/c++/13"; rm -rf "$tmp"; \
    done
# The other sysroots Bun's CI lanes cross-compile against, again as scripts/bootstrap.sh
# makes them (install_linux_musl_sysroot, install_freebsd_sysroot, install_android_ndk) and
# at the paths scripts/build/config.ts looks for them. Versions: bootstrap.sh's
# alpine_sysroot_version / freebsd_version / android_ndk_version.
ARG ALPINE=3.23
ARG FREEBSD=14.3
ARG ANDROID_NDK=r27c
# musl + libstdc++ from Alpine's own packages, installed with apk.static (which can populate
# a root for either architecture).
RUN set -e; cdn=https://dl-cdn.alpinelinux.org/alpine/v${ALPINE}; m=$(uname -m); tmp=$(mktemp -d); \
    apk_ver=$(curl -fsSL --retry 8 "$cdn/main/$m/APKINDEX.tar.gz" | tar -xzO APKINDEX | awk '/^P:apk-tools-static$/{f=1} f&&/^V:/{print substr($0,3); exit}'); \
    curl -fsSL --retry 8 "$cdn/main/$m/apk-tools-static-$apk_ver.apk" | tar -xz -C "$tmp" sbin/apk.static 2>/dev/null; \
    for ml_arch in x86_64 aarch64; do \
      case $ml_arch in x86_64) sysroot=/opt/linux-sysroot-musl ;; aarch64) sysroot=/opt/linux-sysroot-musl-arm64 ;; esac; \
      mkdir -p "$sysroot"; \
      "$tmp/sbin/apk.static" --arch "$ml_arch" --root "$sysroot" --repository "$cdn/main" --allow-untrusted --no-cache \
        add --initdb musl-dev libc-dev linux-headers g++ libstdc++-dev >/dev/null; \
      test -f "$sysroot/usr/lib/libc.so"; \
    done; rm -rf "$tmp"
# FreeBSD base system headers + libraries.
RUN set -e; for fb_arch in amd64 arm64; do \
      case $fb_arch in amd64) sysroot=/opt/freebsd-sysroot ;; arm64) sysroot=/opt/freebsd-sysroot-arm64 ;; esac; \
      mkdir -p "$sysroot"; \
      curl -fsSL --retry 8 "https://download.freebsd.org/releases/$fb_arch/${FREEBSD}-RELEASE/base.txz" | tar -xJ -C "$sysroot" ./usr/include ./usr/lib ./lib; \
      test -f "$sysroot/usr/include/sys/param.h" && test -f "$sysroot/lib/libc.so.7"; \
    done
# Android NDK (sysroot + its compiler-rt builtins/libunwind), trimmed of its own toolchain
# binaries the way bootstrap.sh trims it. Bun's configure symlinks the NDK runtimes into the
# resource directory of whichever clang it is given (it can for the compilers this build
# produces; for the root-owned host LLVM it is done below, once that is installed).
RUN set -e; tmp=$(mktemp -d); \
    curl -fsSL --retry 8 -o "$tmp/ndk.zip" "https://dl.google.com/android/repository/android-ndk-${ANDROID_NDK}-linux.zip"; \
    unzip -q "$tmp/ndk.zip" -d /opt && mv /opt/android-ndk-${ANDROID_NDK} /opt/android-ndk && rm -rf "$tmp"; \
    p=/opt/android-ndk/toolchains/llvm/prebuilt/linux-x86_64; \
    rm -rf "$p/bin" "$p/python3" "$p/lib/liblldb.so" /opt/android-ndk/simpleperf /opt/android-ndk/shader-tools /opt/android-ndk/sources; \
    test -d "$p/sysroot/usr/include" && ls "$p"/lib/clang/*/lib/linux/libclang_rt.builtins-aarch64-android.a >/dev/null
ENV ANDROID_NDK_ROOT=/opt/android-ndk
# CMake: LLVM wants >= 3.20, Bun's build >= 3.24; focal has 3.16. Same source as Bun's bootstrap.sh.
RUN curl -fsSL --retry 8 --retry-delay 5 \
      https://github.com/Kitware/CMake/releases/download/v${CMAKE}/cmake-${CMAKE}-linux-$(uname -m).tar.gz \
    | tar -xz -C /usr/local --strip-components=1 && cmake --version

# GCC, for the libstdc++.a / libgcc that get statically linked into rustc's
# libLLVM.so and librustc_driver.so (--enable-llvm-static-stdcpp). As upstream's
# src/ci/docker/scripts/build-gcc.sh says: "-fno-reorder-blocks-and-partition is
# required to enable BOLT optimization of the C++ standard library"; distro
# archives are built with it on and stripped of the FILE symbols llvm-bolt would
# need to cope. Only the host clang uses this GCC (via the .cfg files below); the
# clang we ship picks up the system libstdc++ like any other clang. What the host
# clang builds needs this libstdc++.so.6 at run time, so it goes first in the
# loader's search path (00-: ld.so.conf.d is read in name order).
# Unlike upstream (GCC 9.5, full bootstrap): GCC 13, --disable-bootstrap, apt's
# gmp/mpfr/mpc — only its libstdc++.a/libgcc reach the shipped binaries.
ARG GCC=13.3.0
RUN { curl -fsSL --retry 3 https://ftpmirror.gnu.org/gnu/gcc/gcc-${GCC}/gcc-${GCC}.tar.xz || curl -fsSL --retry 5 https://ftp.gnu.org/gnu/gcc/gcc-${GCC}/gcc-${GCC}.tar.xz; } | tar -xJ -C /tmp \
    && mkdir /tmp/gcc-build && cd /tmp/gcc-build \
    && /tmp/gcc-${GCC}/configure --prefix=/opt/gcc --enable-languages=c,c++ --disable-multilib --disable-bootstrap \
         --disable-gnu-unique-object --enable-cxx-flags=-fno-reorder-blocks-and-partition >/dev/null \
    && make -j"$(nproc)" >/tmp/gcc-build.log 2>&1 || { tail -100 /tmp/gcc-build.log; exit 1; } \
    && make install >/dev/null && install -Dm644 -t /opt/gcc/share/licenses /tmp/gcc-${GCC}/COPYING3 /tmp/gcc-${GCC}/COPYING.RUNTIME \
    && cd / && rm -rf /tmp/gcc-${GCC} /tmp/gcc-build /tmp/gcc-build.log \
    && dirname "$(/opt/gcc/bin/gcc -print-file-name=libstdc++.so.6)" > /etc/ld.so.conf.d/00-opt-gcc.conf && ldconfig \
    && ldconfig -p | grep -m1 'libstdc++.so.6 ' | grep -q /opt/gcc

# Host compiler for stage 1 of both builds, and llvm-profdata / llvm-bolt / merge-fdata for
# the PGO/BOLT steps: built from our src/llvm-project (oven-sh/llvm-project, the commit the
# submodule points at — so its llvm-bolt carries our BOLT fixes), the way upstream's
# src/ci/docker/scripts/build-clang.sh builds its host clang (plain Release build with the
# image's GCC; clang, lld, bolt, compiler-rt; no tests). Same LLVM as the one being built, so
# profiles written by one are readable by the other. (LLVM's own release binaries need glibc
# 2.34, and apt.llvm.org has no arm64 packages for focal from 22 on.)
# Unlike build-clang.sh the sanitizer runtimes are kept: Bun's ASan configurations link them.
# Bump together with the submodule when a host-tool fix lands there.
ARG HOST_LLVM=826de7448756f3a1afc5c56f66ee719c190076fb
RUN mkdir /tmp/llvm && curl -fsSL --retry 8 https://github.com/oven-sh/llvm-project/archive/${HOST_LLVM}.tar.gz | tar -xz -C /tmp/llvm --strip-components=1 \
    && cmake -G Ninja -S /tmp/llvm/llvm -B /tmp/llvm/build \
         -DCMAKE_C_COMPILER=/opt/gcc/bin/gcc -DCMAKE_CXX_COMPILER=/opt/gcc/bin/g++ \
         -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/llvm \
         -DLLVM_ENABLE_PROJECTS="clang;lld;bolt" -DLLVM_ENABLE_RUNTIMES=compiler-rt \
         -DLLVM_TARGETS_TO_BUILD="X86;AArch64" \
         -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF \
         -DCOMPILER_RT_BUILD_XRAY=OFF -DCOMPILER_RT_BUILD_MEMPROF=OFF -DCOMPILER_RT_BUILD_CTX_PROFILE=OFF -DCOMPILER_RT_BUILD_LIBFUZZER=OFF >/dev/null \
    && { ninja -C /tmp/llvm/build install >/tmp/llvm-build.log 2>&1 || { tail -200 /tmp/llvm-build.log; exit 1; }; } \
    && cd / && rm -rf /tmp/llvm /tmp/llvm-build.log \
    && /opt/llvm/bin/clang --version && /opt/llvm/bin/llvm-bolt --version | head -2
# The host clang compiles against /opt/gcc's libstdc++ (the .cfg files), and gets the NDK's
# compiler-rt builtins/libunwind linked into its resource directory for the Android targets
# (what bootstrap.sh install_android_ndk does for the CI image's clang).
RUN printf -- '--gcc-install-dir=%s\n' "$(dirname "$(/opt/gcc/bin/gcc -print-libgcc-file-name)")" | tee /opt/llvm/bin/clang.cfg > /opt/llvm/bin/clang++.cfg \
    && /opt/llvm/bin/clang++ -v -x c++ /dev/null -fsyntax-only 2>&1 | grep "Selected GCC installation: /opt/gcc" \
    && res=$(/opt/llvm/bin/clang -print-resource-dir) && ndk_rt=$(echo /opt/android-ndk/toolchains/llvm/prebuilt/linux-x86_64/lib/clang/*/lib/linux) \
    && for a in aarch64 x86_64; do \
         mkdir -p "$res/lib/linux/$a" "$res/lib/$a-unknown-linux-android28"; \
         ln -sf "$ndk_rt/libclang_rt.builtins-$a-android.a" "$res/lib/linux/"; \
         ln -sf "$ndk_rt/$a/libunwind.a" "$res/lib/linux/$a/"; \
         ln -sf "$ndk_rt/libclang_rt.builtins-$a-android.a" "$res/lib/$a-unknown-linux-android28/libclang_rt.builtins.a"; \
         ln -sf "$ndk_rt/$a/libunwind.a" "$res/lib/$a-unknown-linux-android28/libunwind.a"; \
       done
# Unversioned clang/clang++/ld.lld/llvm-* on PATH, as rust's `target.*.linker=clang` expects.
ENV PATH=/opt/llvm/bin:$PATH CC=clang CXX=clang++

# zstd for `llvm.libzstd=true`, built as upstream's src/ci/docker/scripts/build-zstd.sh
# does. (Ubuntu's libzstd.a is GCC-built with hot/cold-split functions and no FILE
# symbols; once linked into libLLVM.so, llvm-bolt refuses to instrument it.)
ARG ZSTD=1.5.6
RUN curl -fsSL --retry 8 --retry-delay 5 https://github.com/facebook/zstd/releases/download/v${ZSTD}/zstd-${ZSTD}.tar.gz | tar -xz -C /tmp \
    && CFLAGS=-fPIC make -C /tmp/zstd-${ZSTD} -j"$(nproc)" >/dev/null && make -C /tmp/zstd-${ZSTD} install >/dev/null \
    && rm -rf /tmp/zstd-${ZSTD} && ldconfig

# libxml2 for lld (Windows manifest merging) and llvm-mt, static and without ICU/lzma so
# the shipped binaries do not depend on the host's libxml2 soname (2.14 renamed it).
ARG LIBXML2=2.9.14
RUN curl -fsSL --retry 8 https://download.gnome.org/sources/libxml2/${LIBXML2%.*}/libxml2-${LIBXML2}.tar.xz | tar -xJ -C /tmp \
    && cd /tmp/libxml2-${LIBXML2} \
    && CFLAGS="-O2 -fPIC" ./configure --prefix=/opt/libxml2 --enable-static --disable-shared \
         --without-python --without-icu --without-lzma --without-zlib --without-http --without-ftp -q >/dev/null \
    && make -j"$(nproc)" -s >/dev/null && make -s install >/dev/null \
    && cd / && rm -rf /tmp/libxml2-${LIBXML2} && test -f /opt/libxml2/lib/libxml2.a

# mimalloc, linked statically into the clang and lld we ship (bun/lib/llvm.ts) in place of
# glibc malloc. Built as the single override object so that putting it on the link line
# is all it takes. -fno-jump-tables on arm64: it ends up inside binaries llvm-bolt rewrites
# (see NO_JUMP_TABLES in bun/lib/llvm.ts).
ARG MIMALLOC=3.4.5
RUN curl -fsSL --retry 8 https://github.com/microsoft/mimalloc/archive/refs/tags/v${MIMALLOC}.tar.gz | tar -xz -C /tmp \
    && cmake -G Ninja -S /tmp/mimalloc-${MIMALLOC} -B /tmp/mimalloc-build -DCMAKE_BUILD_TYPE=Release \
         -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
         -DCMAKE_C_FLAGS="$([ "$(dpkg --print-architecture)" = arm64 ] && echo -fno-jump-tables)" \
         -DMI_OVERRIDE=ON -DMI_BUILD_OBJECT=ON -DMI_BUILD_STATIC=ON -DMI_BUILD_SHARED=OFF -DMI_BUILD_TESTS=OFF >/dev/null \
    && ninja -C /tmp/mimalloc-build >/dev/null \
    && install -Dm644 /tmp/mimalloc-build/mimalloc.o /opt/mimalloc/mimalloc.o \
    && install -Dm644 /tmp/mimalloc-${MIMALLOC}/LICENSE /opt/mimalloc/LICENSE \
    && rm -rf /tmp/mimalloc-${MIMALLOC} /tmp/mimalloc-build

# rustup, no toolchain: the clang/lld training builds Bun before our rustc exists (the two
# halves build in parallel), so Bun's build installs its pinned nightly through this, as it
# does on a CI machine. RUSTUP_HOME/CARGO_HOME are left to default to $HOME at run time.
RUN curl -fsSL --retry 8 https://sh.rustup.rs \
    | RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/rustup sh -s -- -y --default-toolchain none --no-modify-path >/dev/null \
    && chmod -R a+rX /opt/rustup
ENV PATH=/opt/rustup/bin:$PATH

# node runs bun/*.ts; bun is what Bun's own build uses for its codegen steps.
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
    && curl -fsSL --retry 8 --retry-delay 5 https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-${arch}.tar.xz | tar -xJ -C /usr/local --strip-components=1 \
    && npm install -g bun@${BUN} \
    && node --version && bun --version

WORKDIR /checkout
