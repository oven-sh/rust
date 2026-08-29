#!/usr/bin/env node
// The PGO/BOLT training workload: build Bun with the compiler being profiled.
//
//   train.ts            called by opt-dist (--training-command); compiler in OPT_DIST_*
//   train.ts clang      called by LLVM's perf-training (bun/train-clang); compiler in CC/CXX
//
// Everything else it needs comes from BUN_TRAIN_CONFIG (lib/train-config.ts).

import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exists, mkdir, read, remove, write } from "./lib/fs.ts";
import { run } from "./lib/run.ts";
import { readTrainingEnv, type TrainConfig } from "./lib/train-config.ts";

const config = readTrainingEnv();
ensureBunCheckout(config);
if (process.argv[2] === "clang") trainClang(config);
else trainRust(config);

/** What opt-dist asks for: rustc-perf profile names (Check, Debug, Opt, Doc) for the current phase. */
function trainRust(c: TrainConfig): void {
  const rustc = requireEnv("OPT_DIST_RUSTC");
  const cargo = requireEnv("OPT_DIST_CARGO");
  const profiles = requireEnv("OPT_DIST_PROFILES").split(",");
  const toolchain = { BUN_TOOLCHAIN_LLVM: c.hostLlvm, BUN_TOOLCHAIN_RUST: dirname(dirname(rustc)), BUN_TOOLCHAIN_CARGO: cargo };

  if (profiles.includes("Debug")) {
    // A developer's loop: full debug build, then an incremental rebuild after a one-line edit.
    const dir = bunBuild(c, "rust-debug", ["--profile=debug"], toolchain);
    const edited = join(c.bunDir, "src", "runtime", "lib.rs");
    const original = read(edited);
    appendFileSync(edited, "\n// bun toolchain training edit\n");
    try {
      ninja(c, dir, "bun-rust");
    } finally {
      write(edited, original);
    }
  }
  if (profiles.includes("Opt")) {
    // CI's release configuration (cross-language LTO: rustc emits bitcode), and the
    // non-LTO release configuration (rustc runs LLVM codegen itself).
    bunBuild(c, "rust-release-lto", ["--profile=ci-release", "--buildkite=off"], toolchain);
    bunBuild(c, "rust-release", ["--profile=ci-release", "--buildkite=off", "--lto=off"], toolchain);
  }
  if (profiles.includes("Doc")) {
    // opt-dist also optimizes rustdoc; give it something small so the profile is not empty.
    const crate = join(c.trainDir, "rustdoc-sample");
    remove(crate);
    run([cargo, "new", "--lib", "--vcs=none", crate], { capture: true });
    run([cargo, "doc", "--quiet"], { cwd: crate, env: { RUSTC: rustc, RUSTDOC: requireEnv("OPT_DIST_RUSTDOC") } });
  }
  // "Check" (cargo check) is covered by the Debug build's front-end work.
}

/** Called with the instrumented (or BOLT-instrumented) clang as CC/CXX: a full release build and link. */
function trainClang(c: TrainConfig): void {
  const cc = requireEnv("CC");
  const toolchain = { BUN_TOOLCHAIN_LLVM: dirname(dirname(cc)), BUN_TOOLCHAIN_RUST: c.rustSysroot };
  bunBuild(c, "clang-release-lto", ["--profile=ci-release", "--buildkite=off"], toolchain, "bun");
}

/** Configure a Bun build directory and build `target` in it; returns the directory. */
function bunBuild(c: TrainConfig, name: string, args: string[], toolchain: Record<string, string>, target = "bun-rust"): string {
  const dir = join(c.trainDir, name);
  remove(dir);
  const [os, arch] = c.host.split("-") as [string, string];
  run(
    [process.execPath, join(c.bunDir, "scripts", "build.ts"), ...args, `--os=${os}`, `--arch=${arch}`, `--buildDir=${dir}`, "--configure-only"],
    { cwd: c.bunDir, env: toolchain },
  );
  ninja(c, dir, target);
  return dir;
}

function ninja(c: TrainConfig, dir: string, target: string): void {
  run(["ninja", "-C", dir, `-j${c.jobs}`, target], { env: { NINJA_STATUS: "[%f/%t %es] " } });
}

function ensureBunCheckout(c: TrainConfig): void {
  if (c.bunRef === undefined) {
    if (!exists(join(c.bunDir, "scripts", "build.ts"))) throw new Error(`--bun-dir ${c.bunDir} is not a Bun checkout`);
    return;
  }
  // Same shape as Bun's own dep fetcher: a .ref stamp says what is checked out.
  const stamp = join(c.bunDir, ".bun-toolchain-ref");
  if (exists(stamp) && read(stamp) === c.bunRef) return;
  if (!exists(join(c.bunDir, ".git"))) {
    mkdir(c.bunDir);
    run(["git", "init", "-q"], { cwd: c.bunDir });
    run(["git", "remote", "add", "origin", "https://github.com/oven-sh/bun.git"], { cwd: c.bunDir });
  }
  run(["git", "fetch", "-q", "--depth=1", "origin", c.bunRef], { cwd: c.bunDir });
  run(["git", "checkout", "-q", "--force", "FETCH_HEAD"], { cwd: c.bunDir });
  write(stamp, c.bunRef);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined) throw new Error(`${name} is not set`);
  return v;
}
