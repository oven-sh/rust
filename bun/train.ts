#!/usr/bin/env node
// The PGO/BOLT training workload: build Bun with the compiler being profiled.
//
//   train.ts [rust]      from opt-dist (--training-command): rustc/cargo in OPT_DIST_*, plus
//                        OPT_DIST_PROFILES saying which rustc-perf profiles the phase wants
//   train.ts clang       from LLVM's perf-training (bun/train-clang): the instrumented clang in CC
//   train.ts clang-bolt LLVM_DIR
//                        from lib/llvm.ts with BOLT-instrumented clang/lld installed in LLVM_DIR
//   train.ts preflight [RUST_SYSROOT]
//                        from lib/rust.ts and lib/llvm.ts before the long builds: configure Bun for
//                        the host and every cross target so environment problems surface in minutes
//
// The rust modes compile Bun's C/C++ with the host LLVM; the clang modes compile Bun's Rust
// with rustup's pinned nightly (same rustc commit as this branch, so the same bitcode reaches
// lld). That is what lets the two halves build in parallel.
//
// Everything else comes from BUN_TRAIN_CONFIG (lib/train-config.ts).
//
// What gets built, and why that set:
//   rust   Debug → a debug build then an incremental rebuild after a one-line edit (the local
//                  loop); Opt → CI's release configuration with cross-language LTO (rustc emits
//                  bitcode) for the host and for each target Bun's CI cross-builds from Linux,
//                  and without LTO (rustc runs LLVM codegen itself) for the host; Doc → a tiny
//                  crate, only so rustdoc's profile is not empty. Check is covered by Debug's
//                  front-end work.
//   clang  a full release build + LTO link for the host (clang, lld's LTO backend for both the
//          C++ and the Rust bitcode), then C++-only compiles for the targets Bun's CI
//          cross-builds from Linux: the other Linux arch, macOS arm64, Windows x64.
//   clang-bolt  the host release build + link only (BOLT-instrumented binaries are slow).

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BunBuild, type BunTarget, bunBuild, checkoutBun, ninja, type Toolchain } from "./lib/bun-build.ts";
import { exists, read, remove, write } from "./lib/fs.ts";
import { run } from "./lib/run.ts";
import { readTrainingEnv } from "./lib/train-config.ts";

const config = readTrainingEnv();
const b: BunBuild = { bunDir: config.bunDir, outDir: config.trainDir, jobs: config.jobs };
const host: BunTarget = { os: "linux", arch: config.host === "linux-x64" ? "x64" : "aarch64" };
const otherLinux: BunTarget = { os: "linux", arch: host.arch === "x64" ? "aarch64" : "x64" };
const crossTargets: BunTarget[] = [otherLinux, { os: "darwin", arch: "aarch64" }, { os: "windows", arch: "x64" }];
// The profile Bun's CI pipeline builds with (.buildkite/ci.mjs → getBuildArgs), minus the
// Buildkite artifact uploads. --mode=cpp-only: its C/C++ half only (no cargo, no link).
const release = ["--profile=ci-build", "--buildkite=off"];
const cppOnly = [...release, "--mode=cpp-only"];

if (config.bunRef !== undefined) checkoutBun(config.bunDir, config.bunRef);
else if (!exists(join(config.bunDir, "scripts", "build.ts"))) throw new Error(`--bun-dir ${config.bunDir} is not a Bun checkout`);

const mode = process.argv[2] ?? "rust";
switch (mode) {
  case "rust":
    trainRust();
    break;
  case "clang":
    trainClang({ llvm: dirname(dirname(requireEnv("CC"))) }, true);
    break;
  case "clang-bolt":
    trainClang({ llvm: requireArg(3, "LLVM_DIR") }, false);
    break;
  case "preflight": {
    const toolchain = { llvm: config.hostLlvm, rust: process.argv[3] };
    bunBuild(b, "preflight", host, ["--profile=debug"], toolchain, null);
    for (const target of [host, ...crossTargets]) bunBuild(b, `preflight-${target.os}-${target.arch}`, target, release, toolchain, null);
    break;
  }
  default:
    throw new Error(`usage: train.ts rust|clang|clang-bolt LLVM_DIR|preflight [RUST_SYSROOT] (got ${mode})`);
}

function trainRust(): void {
  const rustc = requireEnv("OPT_DIST_RUSTC");
  const cargo = requireEnv("OPT_DIST_CARGO");
  const profiles = requireEnv("OPT_DIST_PROFILES").split(",");
  const toolchain: Toolchain = { llvm: config.hostLlvm, rust: dirname(dirname(rustc)), cargo };

  if (profiles.includes("Debug")) {
    const dir = bunBuild(b, "rust-debug", host, ["--profile=debug"], toolchain, "bun-rust");
    const edited = join(config.bunDir, "src", "runtime", "lib.rs");
    const original = read(edited);
    appendFileSync(edited, "\n// bun toolchain training edit\n");
    try {
      ninja(b, dir, "bun-rust");
    } finally {
      write(edited, original);
    }
  }
  if (profiles.includes("Opt")) {
    bunBuild(b, "rust-release-lto", host, release, toolchain, "bun-rust");
    bunBuild(b, "rust-release", host, [...release, "--lto=off"], toolchain, "bun-rust");
    for (const target of crossTargets) {
      bunBuild(b, `rust-release-lto-${target.os}-${target.arch}`, target, release, toolchain, "bun-rust");
    }
  }
  if (profiles.includes("Doc")) {
    const crate = join(config.trainDir, "rustdoc-sample");
    remove(crate);
    run([cargo, "new", "--lib", "--vcs=none", crate], { capture: true });
    run([cargo, "doc", "--quiet"], { cwd: crate, env: { RUSTC: rustc, RUSTDOC: requireEnv("OPT_DIST_RUSTDOC") } });
  }
}

function trainClang(toolchain: Toolchain, cross: boolean): void {
  bunBuild(b, "clang-release-lto", host, release, toolchain, "bun");
  if (!cross) return;
  for (const target of crossTargets) {
    // cpp-only: every C/C++ translation unit for that target, archived; no cargo, no link.
    bunBuild(b, `clang-cpp-${target.os}-${target.arch}`, target, cppOnly, toolchain, "default");
  }
}

function requireArg(index: number, name: string): string {
  const v = process.argv[index];
  if (v === undefined) throw new Error(`missing argument ${name}`);
  return v;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined) throw new Error(`${name} is not set`);
  return v;
}
