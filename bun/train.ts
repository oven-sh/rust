#!/usr/bin/env node
// The PGO/BOLT training workload: build Bun, in the one configuration this toolchain variant
// is for (lib/variants.ts), with the compiler being profiled.
//
//   train.ts [rust]      from opt-dist (--training-command): rustc/cargo in OPT_DIST_*, plus
//                        OPT_DIST_PROFILES (which rustc-perf profile kinds the step wants) and
//                        OPT_DIST_PHASE (pgo | bolt)
//   train.ts clang       from lib/llvm.ts with the PGO-instrumented clang/lld in CC/CXX
//   train.ts clang-bolt LLVM_DIR
//                        from lib/llvm.ts with BOLT-instrumented clang/lld installed in LLVM_DIR
//   train.ts preflight [RUST_DIR]   (a directory with bin/rustc and bin/cargo; default: rustup's)
//                        before the long builds: configure the variant's Bun build so environment
//                        problems surface in minutes
//
// The rust mode compiles Bun's C/C++ with the host LLVM; the clang modes compile Bun's Rust with
// rustup's pinned nightly (same rustc commit as this branch, so the same bitcode reaches lld).
// That is what lets the two halves build in parallel.
//
// Every phase (rustc PGO, rustc's LLVM PGO, clang PGO, each BOLT pass) is the same thing: one
// clean build of the variant's Bun configuration — `bun` (everything, through the link) for the
// clang modes, `bun-rust` (the cargo half) for the rust mode. Everything else comes from
// BUN_TRAIN_CONFIG (lib/train-config.ts).

import { dirname, join } from "node:path";
import { type BunBuild, bunBuild, checkoutBun, type Toolchain } from "./lib/bun-build.ts";
import { exists, remove } from "./lib/fs.ts";
import { run } from "./lib/run.ts";
import { readTrainingEnv } from "./lib/train-config.ts";

const config = readTrainingEnv();
const v = config.variant;
const b: BunBuild = { bunDir: config.bunDir, outDir: config.trainDir, jobs: config.jobs };

if (config.bunRef !== undefined) checkoutBun(config.bunDir, config.bunRef);
else if (!exists(join(config.bunDir, "scripts", "build.ts"))) throw new Error(`--bun-dir ${config.bunDir} is not a Bun checkout`);

const mode = process.argv[2] ?? "rust";
switch (mode) {
  case "rust":
    trainRust();
    break;
  case "clang":
    build("clang", { llvm: dirname(dirname(requireEnv("CC"))) }, "bun");
    break;
  case "clang-bolt":
    build("clang-bolt", { llvm: requireArg(3, "LLVM_DIR") }, "bun");
    break;
  case "preflight":
    remove(bunBuild(b, `preflight-${v.name}`, v.target, v.args, { llvm: config.hostLlvm, rust: process.argv[3] }, null));
    break;
  default:
    throw new Error(`usage: train.ts rust|clang|clang-bolt LLVM_DIR|preflight [RUST_DIR] (got ${mode})`);
}

function trainRust(): void {
  const rustc = requireEnv("OPT_DIST_RUSTC");
  const cargo = requireEnv("OPT_DIST_CARGO");
  const profiles = requireEnv("OPT_DIST_PROFILES").split(",");
  const toolchain: Toolchain = { llvm: config.hostLlvm, rust: dirname(dirname(rustc)), cargo };
  // opt-dist asks per rustc-perf profile kind (Debug/Opt/...); the variant is one workload, so
  // build it once per phase, on whichever of those comes first.
  if (profiles.includes("Opt") || profiles.includes("Debug")) build(`rust-${requireEnv("OPT_DIST_PHASE")}`, toolchain, "bun-rust");
  if (profiles.includes("Doc")) {
    // Only so rustdoc's profile is not empty; nothing in Bun's build runs rustdoc.
    const crate = join(config.trainDir, "rustdoc-sample");
    remove(crate);
    run([cargo, "new", "--lib", "--vcs=none", crate], { capture: true });
    run([cargo, "doc", "--quiet"], { cwd: crate, env: { RUSTC: rustc, RUSTDOC: requireEnv("OPT_DIST_RUSTDOC") } });
  }
}

function build(name: string, toolchain: Toolchain, ninjaTarget: string): void {
  remove(bunBuild(b, `${name}-${v.name}`, v.target, v.args, toolchain, ninjaTarget));
}

function requireArg(index: number, name: string): string {
  const a = process.argv[index];
  if (a === undefined) throw new Error(`missing argument ${name}`);
  return a;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set`);
  return value;
}
