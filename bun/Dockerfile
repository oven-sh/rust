# Build environment for bun/toolchain.ts. The glibc of this image (Ubuntu 20.04:
# 2.31) is the oldest the resulting toolchain will run on — chosen so it also runs in
# oven-sh/WebKit's ubuntu:20.04 build container; the Bun binaries built *with* the
# toolchain are unaffected by it.
#
# The workflow builds on the previous image's layers: what takes long comes first.
FROM ubuntu:20.04
ENV DEBIAN_FRONTEND=noninteractive
# archive.ubuntu.com drops connections now and then.
RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\n' > /etc/apt/apt.conf.d/80-retries

# The last line: gcc + glibc for the other Linux architecture. The LLVM half has compiler-rt
# (ASan etc.) for both, because Bun's CI builds x64 and arm64 Linux from one host.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg xz-utils zstd unzip python3 pkg-config zlib1g-dev file binutils build-essential \
      libgmp-dev libmpfr-dev libmpc-dev flex \
      $([ "$(dpkg --print-architecture)" = amd64 ] && echo g++-aarch64-linux-gnu || echo g++-x86-64-linux-gnu) \
    && rm -rf /var/lib/apt/lists/*

# CMake: LLVM wants >= 3.20; focal has 3.16.
ARG CMAKE=3.30.5
RUN curl -fsSL --retry 8 --retry-delay 5 \
      https://github.com/Kitware/CMake/releases/download/v${CMAKE}/cmake-${CMAKE}-linux-$(uname -m).tar.gz \
    | tar -xz -C /usr/local --strip-components=1 && cmake --version
ARG NINJA=1.13.2
RUN curl -fsSL --retry 8 --retry-delay 5 https://github.com/ninja-build/ninja/archive/refs/tags/v${NINJA}.tar.gz | tar -xz -C /tmp \
    && (cd /tmp/ninja-${NINJA} && python3 configure.py --bootstrap >/dev/null) \
    && install -m 0755 /tmp/ninja-${NINJA}/ninja /usr/local/bin/ninja && rm -rf /tmp/ninja-${NINJA} \
    && [ "$(ninja --version)" = "${NINJA}" ]

# libxml2 for lld-link's manifest merging and llvm-mt — in the clang/lld we ship and in the host
# toolchain below (it links the Windows-hosted toolchains, whose rustc.exe embeds a manifest).
# Static, so nothing depends on a host libxml2 soname (2.14 renamed it). The version and options
# of LLVM's .github/workflows/release-binaries.yml, without zlib.
ARG LIBXML2=2.15.1
ARG LIBXML2_SHA256=c008bac08fd5c7b4a87f7b8a71f283fa581d80d80ff8d2efd3b26224c39bc54c
RUN curl -fsSL --retry 8 -o /tmp/libxml2.tar.xz https://download.gnome.org/sources/libxml2/${LIBXML2%.*}/libxml2-${LIBXML2}.tar.xz \
    && echo "${LIBXML2_SHA256}  /tmp/libxml2.tar.xz" | sha256sum --check --quiet && tar -xJf /tmp/libxml2.tar.xz -C /tmp \
    && cmake -G Ninja -S /tmp/libxml2-${LIBXML2} -B /tmp/libxml2-build -DCMAKE_BUILD_TYPE=Release \
         -DCMAKE_INSTALL_PREFIX=/opt/libxml2 -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DBUILD_SHARED_LIBS=OFF \
         -DLIBXML2_WITH_ICU=OFF -DLIBXML2_WITH_ICONV=OFF -DLIBXML2_WITH_MODULES=OFF -DLIBXML2_WITH_PROGRAMS=OFF \
         -DLIBXML2_WITH_TESTS=OFF -DLIBXML2_WITH_ZLIB=OFF >/dev/null \
    && cmake --build /tmp/libxml2-build >/dev/null && cmake --install /tmp/libxml2-build --component development >/dev/null \
    && install -Dm644 /tmp/libxml2-${LIBXML2}/Copyright /opt/libxml2/LICENSE \
    && rm -rf /tmp/libxml2* && test -f /opt/libxml2/lib/libxml2.a

# GCC, for the libstdc++.a / libgcc that get statically linked into clang, lld and rustc's
# libLLVM.so and librustc_driver.so.
# - The version of upstream's dist-*-linux images (GCC_VERSION in their Dockerfiles), and it has
#   to be: rust-lang's profile of LLVM describes each function as it looks with these libstdc++
#   headers inlined into it, and clang ignores the counts of a function that looks different.
# - As upstream's src/ci/docker/scripts/build-gcc.sh says, "-fno-reorder-blocks-and-partition is
#   required to enable BOLT optimization of the C++ standard library"; distro archives are built
#   with it on and stripped of the FILE symbols llvm-bolt would need to cope.
# Only the host clang uses this GCC (via the .cfg file below); the clang we ship picks up the
# system libstdc++ like any other clang.
# Unlike upstream: --disable-bootstrap, and apt's gmp/mpfr/mpc.
ARG GCC=9.5.0
ARG GCC_SHA256=27769f64ef1d4cd5e2be8682c0c93f9887983e6cfd1a927ce5a0a2915a95cf8f
RUN { curl -fsSL --retry 3 -o /tmp/gcc.tar.xz https://ci-mirrors.rust-lang.org/rustc/gcc/gcc-${GCC}.tar.xz || curl -fsSL --retry 5 -o /tmp/gcc.tar.xz https://ftp.gnu.org/gnu/gcc/gcc-${GCC}/gcc-${GCC}.tar.xz; } \
    && echo "${GCC_SHA256}  /tmp/gcc.tar.xz" | sha256sum --check --quiet && tar -xJf /tmp/gcc.tar.xz -C /tmp \
    && mkdir /tmp/gcc-build && cd /tmp/gcc-build \
    && /tmp/gcc-${GCC}/configure --prefix=/opt/gcc --enable-languages=c,c++ --disable-multilib --disable-bootstrap --disable-libsanitizer \
         --disable-gnu-unique-object --enable-cxx-flags=-fno-reorder-blocks-and-partition >/dev/null \
    && { make -j"$(nproc)" >/tmp/gcc-build.log 2>&1 || { tail -100 /tmp/gcc-build.log; exit 1; }; } \
    && make install >/dev/null && install -Dm644 -t /opt/gcc/share/licenses /tmp/gcc-${GCC}/COPYING3 /tmp/gcc-${GCC}/COPYING.RUNTIME \
    && cd / && rm -rf /tmp/gcc*

# The host compiler, and llvm-profdata / llvm-bolt / merge-fdata, built the way upstream's
# src/ci/docker/scripts/build-clang.sh builds its host clang (plain Release build with the image's
# GCC; clang, lld, bolt, compiler-rt; no tests). (LLVM's own release binaries need glibc 2.34,
# and apt.llvm.org has no arm64 packages for focal from 22 on.)
# From the commit rust-lang pins src/llvm-project to, so without our patches: a mistake in one
# cannot end up miscompiling the compilers, and a new one does not rebuild the image. The workflow
# records clang's profile from the same commit.
# Unlike build-clang.sh it links with lld by default where upstream's links with GNU ld + LLVMgold.so
# (LLVM_BINUTILS_INCDIR): bootstrap compiles rustc's C dependencies with -flto on x86_64, and
# their configure scripts (jemalloc's) link test programs with no linker named.
ARG HOST_LLVM=0a5579eb649d3634a9c30ac873300cc2944fa070
RUN mkdir /tmp/llvm && curl -fsSL --retry 8 https://github.com/oven-sh/llvm-project/archive/${HOST_LLVM}.tar.gz | tar -xz -C /tmp/llvm --strip-components=1 \
    && cmake -G Ninja -S /tmp/llvm/llvm -B /tmp/llvm/build \
         -DCMAKE_C_COMPILER=/opt/gcc/bin/gcc -DCMAKE_CXX_COMPILER=/opt/gcc/bin/g++ \
         -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/opt/llvm \
         -DLLVM_ENABLE_PROJECTS="clang;lld;bolt" -DLLVM_ENABLE_RUNTIMES=compiler-rt -DCLANG_DEFAULT_LINKER=lld \
         -DLLVM_TARGETS_TO_BUILD="X86;AArch64" \
         -DLLVM_ENABLE_LIBXML2=FORCE_ON -DLLVM_USE_STATIC_LIBXML2=ON -DLIBXML2_INCLUDE_DIR=/opt/libxml2/include/libxml2 \
         -DLIBXML2_LIBRARY=/opt/libxml2/lib/libxml2.a -DLIBXML2_STATIC_LIBRARY=/opt/libxml2/lib/libxml2.a \
         -DLLVM_INCLUDE_TESTS=OFF -DLLVM_INCLUDE_EXAMPLES=OFF -DLLVM_INCLUDE_BENCHMARKS=OFF \
         -DCOMPILER_RT_BUILD_SANITIZERS=OFF -DCOMPILER_RT_BUILD_XRAY=OFF -DCOMPILER_RT_BUILD_MEMPROF=OFF \
         -DCOMPILER_RT_BUILD_CTX_PROFILE=OFF -DCOMPILER_RT_BUILD_LIBFUZZER=OFF >/dev/null \
    && { ninja -C /tmp/llvm/build install >/tmp/llvm-build.log 2>&1 || { tail -200 /tmp/llvm-build.log; exit 1; }; } \
    && cd / && rm -rf /tmp/llvm /tmp/llvm-build.log /opt/llvm/lib/libLLVM*.a /opt/llvm/lib/libclang*.a /opt/llvm/lib/liblld*.a \
    && /opt/llvm/bin/clang --version && /opt/llvm/bin/llvm-bolt --version | head -2
# The host clang compiles for this machine against /opt/gcc's libstdc++.
RUN triple=$(/opt/llvm/bin/clang -print-target-triple) \
    && printf -- '--gcc-install-dir=%s\n' "$(dirname "$(/opt/gcc/bin/gcc -print-libgcc-file-name)")" > /opt/llvm/bin/$triple.cfg \
    && /opt/llvm/bin/clang++ -v -x c++ /dev/null -fsyntax-only 2>&1 | grep "Selected GCC installation: /opt/gcc"
# Unversioned clang/clang++/ld.lld/llvm-* on PATH, as rust's `target.*.linker=clang` expects.
ENV PATH=/opt/llvm/bin:$PATH CC=clang CXX=clang++

# zstd for `llvm.libzstd=true`, built as upstream's src/ci/docker/scripts/build-zstd.sh
# does. (Ubuntu's libzstd.a is GCC-built with hot/cold-split functions and no FILE
# symbols; once linked into libLLVM.so, llvm-bolt refuses to instrument it.)
ARG ZSTD=1.5.6
RUN curl -fsSL --retry 8 --retry-delay 5 https://github.com/facebook/zstd/releases/download/v${ZSTD}/zstd-${ZSTD}.tar.gz | tar -xz -C /tmp \
    && CFLAGS=-fPIC make -C /tmp/zstd-${ZSTD} -j"$(nproc)" >/dev/null && make -C /tmp/zstd-${ZSTD} install >/dev/null \
    && install -Dm644 /tmp/zstd-${ZSTD}/LICENSE /usr/local/share/licenses/zstd/LICENSE \
    && rm -rf /tmp/zstd-${ZSTD} && ldconfig

# mimalloc, linked statically into the clang and lld we ship (bun/lib/llvm.ts) in place of
# glibc malloc. Built as the single override object so that putting it on the link line
# is all it takes.
ARG MIMALLOC=3.4.5
RUN curl -fsSL --retry 8 https://github.com/microsoft/mimalloc/archive/refs/tags/v${MIMALLOC}.tar.gz | tar -xz -C /tmp \
    && cmake -G Ninja -S /tmp/mimalloc-${MIMALLOC} -B /tmp/mimalloc-build -DCMAKE_BUILD_TYPE=Release \
         -DCMAKE_C_COMPILER=clang -DCMAKE_CXX_COMPILER=clang++ -DCMAKE_POSITION_INDEPENDENT_CODE=ON \
         -DMI_OVERRIDE=ON -DMI_BUILD_OBJECT=ON -DMI_BUILD_STATIC=ON -DMI_BUILD_SHARED=OFF -DMI_BUILD_TESTS=OFF >/dev/null \
    && ninja -C /tmp/mimalloc-build >/dev/null \
    && install -Dm644 /tmp/mimalloc-build/mimalloc.o /opt/mimalloc/mimalloc.o \
    && install -Dm644 /tmp/mimalloc-${MIMALLOC}/LICENSE /opt/mimalloc/LICENSE \
    && rm -rf /tmp/mimalloc-${MIMALLOC} /tmp/mimalloc-build

# git: focal's is 2.25; the git-core PPA carries a current one for it.
RUN echo "deb https://ppa.launchpadcontent.net/git-core/ppa/ubuntu focal main" > /etc/apt/sources.list.d/git-core.list \
    && curl -fsSL --retry 8 "https://keyserver.ubuntu.com/pks/lookup?op=get&search=0xE1DD270288B4E6030699E45FA1715D88E1DF1F24" | gpg --dearmor -o /etc/apt/trusted.gpg.d/git-core-ppa.gpg \
    && apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/* \
    && git --version

# node runs bun/*.ts; bun runs the script of oven-sh/bun that fetches the macOS SDK (bun/lib/sdks.ts).
ARG NODE=26.8.1
ARG BUN=1.4.4
RUN arch=$(dpkg --print-architecture | sed 's/amd64/x64/') \
    && curl -fsSL --retry 8 --retry-delay 5 https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-${arch}.tar.xz | tar -xJ -C /usr/local --strip-components=1 \
    && npm install -g bun@${BUN} \
    && node --version && bun --version

WORKDIR /checkout
