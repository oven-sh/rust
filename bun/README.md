# Bun toolchain

This branch of [oven-sh/rust](https://github.com/oven-sh/rust) builds the compilers Bun is compiled
with: **rustc** from this repository, and **clang + lld** from its `src/llvm-project` submodule
([oven-sh/llvm-project](https://github.com/oven-sh/llvm-project)), which is also rustc's LLVM.

It is based on the rustup nightly that Bun pins (`NIGHTLY` in [`lib/upstream.ts`](lib/upstream.ts)),
and the submodule on the LLVM commit that nightly was built with.

## How it is optimized

As upstream's releases are, without repeating the training on every build:

| | PGO | BOLT |
| --- | --- | --- |
| rustc, rustdoc, clippy, rustc's `libLLVM.so` | the profiles rust-lang publishes with each nightly (`reproducible-artifacts`) | rust-lang's profiles; linux-x64 only, as upstream |
| clang, lld | LLVM does not publish its profile: recorded from LLVM's own sources, once per upstream commit, and kept in GHCR ([`lib/llvm-profile.ts`](lib/llvm-profile.ts)) | recorded in every build (it describes one binary); Linux |
| cargo | upstream's binary | |

A profile finds a function by its name and a hash of its control flow. A function that one of our
patches changes is compiled as if it had no profile; the rest keep theirs. For the names and hashes
to be upstream's, the build has upstream's source path (`/checkout`), libstdc++ version,
configuration and compiler version string. The build checks those and fails when they are not.

Every difference from upstream's recipes has a comment where it is made:
[`lib/rust.ts`](lib/rust.ts), [`lib/llvm-profile.ts`](lib/llvm-profile.ts),
[`lib/llvm.ts`](lib/llvm.ts), [`Dockerfile`](Dockerfile).

## Hosts

| host | built on | PGO | BOLT | runs on |
| --- | --- | --- | --- | --- |
| linux-x64 | linux-x64 | rust, llvm | rust, llvm | glibc ≥ 2.31, zlib |
| linux-aarch64 | linux-aarch64 | rust, llvm | llvm | glibc ≥ 2.31, zlib |
| darwin-aarch64 | linux-x64 | llvm | | macOS ≥ 13 |
| windows-x64 | linux-x64 | | | Windows 10 |
| windows-aarch64 | linux-x64 | | | Windows 11 |

Each compiles for x86-64 and AArch64, on any OS. The last three are cross-compiled against the SDKs
Bun's own cross builds use ([`lib/cross.ts`](lib/cross.ts), [`lib/sdks.ts`](lib/sdks.ts)).

## Output

```
bun-toolchain-<host>-llvm.tar.zst
  bin/   clang clang++ clang-cl clang-format ld.lld ld64.lld lld-link llvm-ar llvm-objcopy …
  lib/   clang/<version>/ (headers, compiler-rt)
  licenses/  toolchain-llvm.json
bun-toolchain-<host>-rust.tar.zst
  bin/   rustc cargo rustdoc rustfmt cargo-clippy (Linux: miri)
  lib/   librustc_driver libLLVM rustlib/ (std for the host, rust-src)
  licenses/  toolchain-rust.json
```

The two do not overlap: extract both into one directory, and point Bun's build at it with
`BUN_TOOLCHAIN_LLVM` and `BUN_TOOLCHAIN_RUST` (`scripts/build/tools.ts` in oven-sh/bun).
`toolchain-*.json` records the commits and the configure / CMake arguments.

## CI

[The workflow](../.github/workflows/bun-toolchain.yml) builds every host on a push to a
`nightly-*-bun` or `claude/*` branch, runs [`smoke.ts`](smoke.ts) on a machine of each kind, and on
Linux builds Bun (at `BUN_REF`) and runs some of its tests. The tarballs are artifacts of the run.
To build less, dispatch it with `hosts`, `halves` or `--skip-bolt`.

A push to `nightly-*-bun` that passes is also a release, `bun-toolchain-<branch>-<commit>-r<N>`,
numbered r1, r2, … per branch; `[skip ci]` in the commit message is for one that should not be. A
release is never replaced, and a dispatch with inputs makes none.

## Patching

- **rustc**: commit to this branch.
- **LLVM**: commit to oven-sh/llvm-project, then point `src/llvm-project` at the commit.

A bug that an ordinary program shows gets a check in `smoke.ts`, as a `knownBug` until it is fixed.

A change to the dependencies or features of a compiler crate renames its symbols and those of
everything that depends on it, so upstream's profile stops applying, and the build says so.

## Building locally

On Linux, x64 or aarch64:

```sh
git submodule update --init --depth=1 src/llvm-project
docker build -t bun-toolchain-env - < bun/Dockerfile
bun/in-container.sh bun-toolchain-env all
node bun/smoke.ts /tmp/smoke obj/bun-toolchain/out/*.tar.zst
```

`all` is `llvm-profile` (unless there is a profile), `llvm`, `rust` and `package`; each can be run on
its own, and is skipped when its inputs have not changed. `--host=` picks a cross-compiled host; darwin-aarch64 wants the profile of
linux-aarch64 in `obj/bun-toolchain/llvm-profile-linux-aarch64`. An unknown option prints the rest.

## Moving to a new nightly

1. oven-sh/llvm-project: branch `nightly-<date>-bun` from the commit that the nightly's
   `src/llvm-project` points to, and cherry-pick our commits.
2. oven-sh/rust: branch from the nightly's commit (`rustc +nightly-<date> -vV`), cherry-pick this
   branch's commits, and point `src/llvm-project` at the branch from step 1.
3. Update the pins:

   | pin | to |
   | --- | --- |
   | `NIGHTLY`, `MANIFEST_SHA256` in `lib/upstream.ts` | the date; `https://static.rust-lang.org/dist/<date>/channel-rust-nightly.toml.sha256` |
   | `HOST_LLVM` in `Dockerfile` | the LLVM commit of step 1, without our commits |
   | `GCC`, `GCC_SHA256` in `Dockerfile` | `GCC_VERSION` of `src/ci/docker/host-*/dist-*-linux/Dockerfile`, if it changed |
   | `BUN_REF` in `lib/sdks.ts` | a commit of oven-sh/bun that pins this nightly |
   | `branch` of `src/llvm-project` in `.gitmodules` | the branch of step 1 |

4. Iterate on a `claude/*` branch, and push it as `nightly-<date>-bun` when it passes.

The first run rebuilds the image and records clang's profile; later ones reuse both.
