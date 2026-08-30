# Bun toolchain

This branch of [oven-sh/rust](https://github.com/oven-sh/rust) builds the
compilers Bun is compiled with: **rustc + cargo** from this repository and
**clang + lld** from its `src/llvm-project` submodule
([oven-sh/llvm-project](https://github.com/oven-sh/llvm-project)).

Both are pinned to what Bun already uses — the branch name is the rustup
nightly it corresponds to, and `src/llvm-project` is the LLVM that nightly was
built against — and both are built with their upstream release recipes:

| | upstream recipe | what we change |
|---|---|---|
| rustc, cargo | `src/ci/docker/host-*/dist-*-linux` + `src/tools/opt-dist` (how rustup's binaries are made: PGO'd LLVM, PGO'd rustc, BOLT on x86_64) | profiles gathered by compiling Bun instead of rustc-perf (`opt-dist --training-command`); like upstream, BOLT on x86_64 only (on aarch64 llvm-bolt hangs writing the optimized libraries; `--aarch64-rust-bolt` to experiment); rustc's LLVM has only the X86 and AArch64 backends; only the components Bun uses are dist'ed; docs, the cranelift backend and the post-dist test run are skipped; host compilers are apt.llvm.org's clang and a GCC 13 libstdc++ rather than upstream's self-built clang and GCC 9 |
| clang, lld | `clang/cmake/caches/Release.cmake` (how LLVM's release tarballs are made: 3-stage PGO + ThinLTO, clang BOLTed on Linux) | the PGO training project is a Bun build (host + the cross targets Bun's CI builds); clang **and lld** BOLTed with a Bun build instead of the built-in perf-training suite (on aarch64 built without jump tables for that); no compiler-plugin support (lets LTO internalize more); mimalloc as the allocator; only the `clang` and `lld` projects and the `compiler-rt` runtime, and of those only the tools Bun's build uses; only the X86 and AArch64 backends; compiler-rt additionally built for the other Linux architecture |

The exact upstream arguments and each deviation are spelled out in
[`lib/rust.ts`](lib/rust.ts) and [`lib/llvm.ts`](lib/llvm.ts). The commits on
this branch relative to the upstream nightly:
`https://github.com/oven-sh/rust/compare/nightly-YYYY-MM-DD...nightly-YYYY-MM-DD-bun`.

## Output

`bun-toolchain-linux-{x64,aarch64}.tar.zst`, attached to a GitHub release named
`bun-toolchain-<branch>-<commit>` by [the workflow](../.github/workflows/bun-toolchain.yml).
Layout:

```
bun-toolchain-linux-x64/
  bin/            clang clang++ clang-cl clang-format ld.lld ld64.lld lld-link llvm-ar llvm-objcopy … rustc cargo rustdoc rustfmt cargo-clippy cargo-miri
  lib/            clang/<ver>/ (headers; compiler-rt for x86_64 and aarch64 linux) · librustc_driver-*.so · libLLVM.so · rustlib/
  licenses/
  toolchain.json  commits it was built from and trained on, and the configure / cmake arguments used
```

The `package` job ends by building Bun with the packaged toolchain and running
`bun --version`; nothing is uploaded if that fails.

To run it a host needs glibc ≥ 2.31, GCC ≥ 10's libstdc++ and zlib (Ubuntu 20.04 / Debian 11
or newer). rustc's libLLVM.so links libstdc++ and zstd statically; clang and lld link
libstdc++ and zlib dynamically, as the respective upstream release binaries do, and zstd
and libxml2 statically.

Bun's build uses it via `BUN_TOOLCHAIN_LLVM` / `BUN_TOOLCHAIN_RUST`
(`scripts/build/tools.ts` in oven-sh/bun).

## Building it

CI: push to a `nightly-*-bun` branch or run the `bun-toolchain` workflow.

Locally (Linux, x64 or aarch64; ~3–5 h, ~80 GB disk):

```sh
git clone --branch nightly-2026-07-20-bun https://github.com/oven-sh/rust && cd rust
git submodule update --init --depth=1 src/llvm-project
docker build -t bun-toolchain-env bun
docker run --rm -it -v "$PWD:/checkout" -w /checkout bun-toolchain-env node bun/toolchain.ts all
```

or without the container, given what bun/Dockerfile installs — node ≥ 25, cmake,
ninja, python3, bun, rustup, libxml2/zlib/zstd dev packages, Bun's build prerequisites
and sysroots, and an LLVM install with clang, lld, llvm-profdata and llvm-bolt (BOLT
of rustc additionally wants the libstdc++.a it links to be built the way the
Dockerfile builds GCC; pass --skip-bolt otherwise):

```sh
node bun/toolchain.ts probe                      # what will be used
node bun/toolchain.ts all --host-llvm=/usr/lib/llvm-22   # any LLVM ≥ the one being built
node bun/toolchain.ts rust|llvm|package          # one stage; finished stages are skipped on rerun
node bun/toolchain.ts all --bun-dir=~/code/bun   # train on a local Bun checkout
```

Stages and where they write (under `--build-dir`, default `obj/bun-toolchain/`):

1. **rust** → `rust/` (bootstrap build dir, `opt-artifacts/` profiles), installed to `rust-install/`
2. **llvm** → `llvm/` (all three CMake stages), installed to `llvm-install/`
3. **package** → `out/bun-toolchain-<host>.tar.zst` (after a smoke build of Bun with it)

1 and 2 are independent (clang's training compiles Bun's Rust with rustup's copy of the
same nightly), so CI runs them in parallel.

Training builds of Bun live in `train/`; the Bun checkout in `bun/`.

## Files

```
toolchain.ts          entry point
train.ts              the training workload (run by opt-dist and by LLVM's perf-training)
train-clang/          CMake project handed to Release.cmake as the PGO training source
lib/options.ts        command line, pins, directory layout
lib/rust.ts           rustc/cargo: upstream configure args + opt-dist
lib/llvm.ts           clang/lld: Release.cmake
lib/package.ts        tarball assembly + smoke build
lib/bun-build.ts      driving Bun's scripts/build.ts (training and smoke)
lib/train-config.ts   how toolchain.ts passes settings to train.ts
lib/run.ts, lib/fs.ts small helpers
Dockerfile            build environment (sets the toolchain's minimum glibc)
```

## Updating

When Bun moves to a new nightly: branch `nightly-<date>` from that nightly's
commit (`rustc +nightly-<date> -vV` prints it), branch `nightly-<date>-bun`
from it, cherry-pick this branch's commits, and point `src/llvm-project` at the
matching `rustc/*` branch of oven-sh/llvm-project.
