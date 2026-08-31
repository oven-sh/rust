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
| rustc, cargo | `src/ci/docker/host-*/dist-*-linux` + `src/tools/opt-dist` (how rustup's binaries are made: PGO'd LLVM, PGO'd rustc, BOLT on x86_64) | profiles gathered by compiling Bun instead of rustc-perf (`opt-dist --training-command`); like upstream, BOLT on x86_64 only (on aarch64 llvm-bolt hangs writing the optimized libraries; `--aarch64-rust-bolt` to experiment); rustc's LLVM has only the X86 and AArch64 backends; only the components Bun uses are dist'ed; docs, the cranelift backend and the post-dist test run are skipped; the host clang is built from the same LLVM release as the one shipped (upstream: a pinned older clang) against a GCC 13 libstdc++ (upstream: GCC 9) |
| clang, lld | `clang/cmake/caches/Release.cmake` (how LLVM's release tarballs are made: 3-stage PGO + ThinLTO, clang BOLTed on Linux) | the PGO training is a Bun build; clang **and lld** BOLTed with a Bun build instead of the built-in perf-training suite (on aarch64 built without jump tables for that); no compiler-plugin support (lets LTO internalize more); mimalloc as the allocator; only the `clang` and `lld` projects and the `compiler-rt` runtime, and of those only the tools Bun's build uses; only the X86 and AArch64 backends; compiler-rt additionally built for the other Linux architecture when the variant targets it |

The exact upstream arguments and each deviation are spelled out in
[`lib/rust.ts`](lib/rust.ts) and [`lib/llvm.ts`](lib/llvm.ts). The commits on
this branch relative to the upstream nightly:
`https://github.com/oven-sh/rust/compare/nightly-YYYY-MM-DD...nightly-YYYY-MM-DD-bun`.

## Variants

A toolchain is trained on exactly one Bun build configuration, its **variant**
([`lib/variants.ts`](lib/variants.ts)): every PGO and BOLT phase is one clean build of
that configuration.

- `ci-<os>-<arch>[-<abi>|-asan]` — one per oven-sh/bun CI build lane (`buildPlatforms`
  in its `.buildkite/ci.mjs`, with the flags its `getBuildArgs` passes). All of them build
  on the linux-aarch64 host, as Bun's CI does.
- `dev` — `bun bd` (a debug, ASan build for the host), on linux-x64. For developer machines.

## Output

Per host and variant, two tarballs attached to a GitHub release named
`bun-toolchain-<branch>-<commit>` by [the workflow](../.github/workflows/bun-toolchain.yml):

```
bun-toolchain-<host>-<variant>-llvm.tar.zst
  bin/   clang clang++ clang-cl clang-format ld.lld ld64.lld lld-link llvm-ar llvm-objcopy …
  lib/   clang/<ver>/ (headers; compiler-rt)
  licenses/  toolchain-llvm.json
bun-toolchain-<host>-<variant>-rust.tar.zst
  bin/   rustc cargo rustdoc rustfmt cargo-clippy cargo-miri
  lib/   librustc_driver-*.so · libLLVM.so · rustlib/
  licenses/  toolchain-rust.json
```

The two trees do not overlap; extract both into one directory and point Bun's build at it
with `BUN_TOOLCHAIN_LLVM` / `BUN_TOOLCHAIN_RUST` (`scripts/build/tools.ts` in oven-sh/bun).
`toolchain-*.json` records the commits, the variant, and the configure / cmake arguments.

To run it a host needs glibc ≥ 2.31, GCC ≥ 10's libstdc++ and zlib (Ubuntu 20.04 / Debian 11
or newer). rustc's libLLVM.so links libstdc++ and zstd statically; clang and lld link
libstdc++ and zlib dynamically, as the respective upstream release binaries do, and zstd
and libxml2 statically.

## Building it

CI: push to a `nightly-*-bun` branch or run the `bun-toolchain` workflow (its `variants`
input limits a run to some variants).

Locally (Linux, x64 or aarch64; ~3 h and ~80 GB per variant):

```sh
git clone --branch nightly-2026-07-20-bun https://github.com/oven-sh/rust && cd rust
git submodule update --init --depth=1 src/llvm-project
docker build -t bun-toolchain-env bun
docker run --rm -it -v "$PWD:/checkout" -w /checkout bun-toolchain-env node bun/toolchain.ts all --variant=dev
```

or without the container, given what bun/Dockerfile installs — node ≥ 25, cmake,
ninja, python3, bun, rustup, static libxml2/zstd, Bun's build prerequisites and (for the
ci-* variants) its cross sysroots, and an LLVM install with clang, lld, llvm-profdata and
llvm-bolt (BOLT of rustc additionally wants the libstdc++.a it links to be built the way
the Dockerfile builds GCC; pass --skip-bolt otherwise):

```sh
node bun/toolchain.ts probe                                  # what will be used
node bun/toolchain.ts all --variant=dev --host-llvm=/usr/lib/llvm-22   # any LLVM ≥ the one being built
node bun/toolchain.ts llvm-instrumented|llvm|rust|package …   # one step; finished steps are skipped on rerun
node bun/toolchain.ts all --variant=dev --bun-dir=~/code/bun # train on a local Bun checkout
```

Steps and where they write (under `--build-dir`, default `obj/bun-toolchain/`):

1. **llvm-instrumented** → `llvm/` (Release.cmake stage 1 + the instrumented stage), packed
   into `llvm-instrumented-<host>.tar.zst`. Variant-independent.
2. **llvm --variant=V** → `llvm-final/` (profiles, final stage), installed to `llvm-install/`.
   Starts from step 1's build dir or, failing that, unpacks its tarball.
3. **rust --variant=V** → `rust/` (bootstrap build dir, `opt-artifacts/` profiles), installed
   to `rust-install/`.
4. **package --variant=V** → `out/bun-toolchain-<host>-<variant>-{llvm,rust}.tar.zst` for
   whichever of the two installs exist.

2 and 3 are independent (clang's training compiles Bun's Rust with rustup's copy of the
same nightly), so CI runs them in parallel, for every variant at once.

Training builds of Bun live in `train/`; the Bun checkout in `bun/`.

## Files

```
toolchain.ts          entry point
train.ts              the training workload (run by opt-dist and by lib/llvm.ts)
lib/variants.ts       the Bun build configurations a toolchain can be trained on
lib/options.ts        command line, pins, directory layout
lib/rust.ts           rustc/cargo: upstream configure args + opt-dist
lib/llvm.ts           clang/lld: Release.cmake, split into the shared instrumented stage and the per-variant final stage
lib/package.ts        tarball assembly
lib/bun-build.ts      driving Bun's scripts/build.ts
lib/train-config.ts   how toolchain.ts passes settings to train.ts
lib/run.ts, lib/fs.ts small helpers
Dockerfile            build environment (sets the toolchain's minimum glibc)
```

## Updating

When Bun moves to a new nightly: branch `nightly-<date>` from that nightly's
commit (`rustc +nightly-<date> -vV` prints it), branch `nightly-<date>-bun`
from it, cherry-pick this branch's commits, and point `src/llvm-project` at the
matching `rustc/*` branch of oven-sh/llvm-project. When Bun's CI lanes change,
update `lib/variants.ts` to match.
