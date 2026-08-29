// clang + lld, built the way LLVM's release binaries are built —
// clang/cmake/caches/Release.cmake: stage1 → stage2-instrumented (IR PGO) →
// stage2 (profile-use + ThinLTO) — with these inputs of ours:
//   - the PGO training workload is a Bun build (CLANG_PGO_TRAINING_DATA_SOURCE_DIR
//     → bun/train-clang → bun/train.ts clang);
//   - BOLT: Release.cmake would BOLT `clang` with clang/utils/perf-training's small
//     built-in lit suite. We turn that off and, after install, BOLT both `clang` and
//     `lld` with a Bun build as the workload (same llvm-bolt flags as
//     clang/utils/perf-training/perf-helper.py bolt-optimize). lld matters to us
//     because Bun's cross-language ThinLTO link runs LLVM's backend inside lld.
//
// Upstream recipe, at src/llvm-project's pinned commit:
//   clang/cmake/caches/Release.cmake
//   clang/utils/perf-training/          (profile collection, BOLT post-link step)
//   .github/workflows/release-binaries.yml (how it is invoked)

import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDone, markDone, mkdir, remove } from "./fs.ts";
import { type Options, paths, RECIPE_VERSION } from "./options.ts";
import { run } from "./run.ts";
import { trainingEnv } from "./train-config.ts";

/**
 * -D settings passed ahead of `-C Release.cmake`. The LLVM_RELEASE_* ones are the
 * cache file's documented inputs. Marked "deviation" where the resulting binaries
 * differ from what upstream's recipe alone would produce.
 */
export function releaseOverrides(o: Options): Record<string, string> {
  const p = paths(o);
  // deviation (x64): upstream targets baseline x86-64; ours needs x86-64-v3 (Haswell, 2013+).
  const march = o.host === "linux-x64" ? "-march=x86-64-v3" : "";
  return {
    // Release.cmake inputs. Upstream: clang;lld;lldb;clang-tools-extra;polly;mlir;flang;bolt and
    // compiler-rt;libcxx;openmp;libcxxabi;libunwind;flang-rt.
    LLVM_RELEASE_ENABLE_PROJECTS: "clang;lld;bolt",
    LLVM_RELEASE_ENABLE_RUNTIMES: "compiler-rt",
    // Upstream: clang;package;check-all;check-llvm;check-clang. We install instead of
    // packaging and leave the test suites to upstream.
    LLVM_RELEASE_FINAL_STAGE_TARGETS: "clang;lld;runtimes;install",

    // Passed through to every stage (see CLANG_BOOTSTRAP_PASSTHROUGH below).
    CMAKE_INSTALL_PREFIX: p.llvmInstall,
    // Upstream builds every backend; Bun targets x86_64 and aarch64.
    LLVM_TARGETS_TO_BUILD: "X86;AArch64",
    LLVM_PARALLEL_LINK_JOBS: String(Math.max(1, Math.floor(o.jobs / 8))),

    // The instrumented and the final stage are compiled for the same -march so the
    // profile's inlining decisions line up.
    BOOTSTRAP_CMAKE_C_FLAGS: march,
    BOOTSTRAP_CMAKE_CXX_FLAGS: march,
    BOOTSTRAP_BOOTSTRAP_CMAKE_C_FLAGS: march,
    BOOTSTRAP_BOOTSTRAP_CMAKE_CXX_FLAGS: march,

    // compiler-rt (builtins, sanitizers, profile) for both Linux architectures Bun's CI
    // builds from one host, not just the native one. Upstream: native only. The cross
    // one compiles against the image's <triple> cross gcc/libc (bun/Dockerfile).
    BOOTSTRAP_BOOTSTRAP_LLVM_BUILTIN_TARGETS: `default;${o.crossTriple}`,
    BOOTSTRAP_BOOTSTRAP_LLVM_RUNTIME_TARGETS: `default;${o.crossTriple}`,
    [`BOOTSTRAP_BOOTSTRAP_BUILTINS_${o.crossTriple}_CMAKE_SYSTEM_NAME`]: "Linux",
    [`BOOTSTRAP_BOOTSTRAP_RUNTIMES_${o.crossTriple}_CMAKE_SYSTEM_NAME`]: "Linux",
    [`BOOTSTRAP_BOOTSTRAP_RUNTIMES_${o.crossTriple}_LLVM_ENABLE_RUNTIMES`]: "compiler-rt",

    // BOLT is applied by boltWithBun() below instead (deviation: workload, and lld too).
    // Release.cmake still links with --emit-relocs,-znow on Linux, which BOLT needs.
    BOOTSTRAP_BOOTSTRAP_CLANG_BOLT: "OFF",

    // Stage 1 is built with the host LLVM.
    CMAKE_C_COMPILER: join(o.hostLlvm, "bin", "clang"),
    CMAKE_CXX_COMPILER: join(o.hostLlvm, "bin", "clang++"),
    LLVM_ENABLE_LLD: "ON",

    // The training workload, for the instrumented stage (BOOTSTRAP_ = second stage).
    BOOTSTRAP_CLANG_PGO_TRAINING_DATA_SOURCE_DIR: join(o.checkout, "bun", "train-clang"),
    // Bun's build needs these next to the instrumented clang it is pointed at.
    BOOTSTRAP_CLANG_PGO_TRAINING_DEPS: "lld;llvm-ar;llvm-ranlib;llvm-nm;llvm-objcopy;llvm-strip;llvm-symbolizer;llvm-profdata;llvm-rc;llvm-mt;dsymutil",

    CLANG_BOOTSTRAP_PASSTHROUGH: "CMAKE_INSTALL_PREFIX;LLVM_TARGETS_TO_BUILD;LLVM_PARALLEL_LINK_JOBS",
  };
}

export function buildLlvm(o: Options): void {
  const p = paths(o);
  const llvmRev = run(["git", "rev-parse", "HEAD"], { cwd: o.llvmProject, capture: true }).trim();
  const key = `llvm-${RECIPE_VERSION}-${llvmRev}-bolt=${o.bolt}`;
  if (isDone(p.llvmInstall, key)) {
    console.log(`llvm: up to date (${key})`);
    return;
  }

  mkdir(p.llvmBuild);
  run([
    "cmake",
    "-G",
    "Ninja",
    "-S",
    join(o.llvmProject, "llvm"),
    "-B",
    p.llvmBuild,
    ...Object.entries(releaseOverrides(o)).filter(([, v]) => v !== "").map(([k, v]) => `-D${k}=${v}`),
    "-C",
    join(o.llvmProject, "clang", "cmake", "caches", "Release.cmake"),
  ]);

  // One target drives all three stages: stage1 → stage2-instrumented (+ generate-profdata,
  // which builds bun/train-clang with the instrumented clang) → stage2 → install.
  run(["ninja", "-C", p.llvmBuild, `-j${o.jobs}`, "stage2-install"], {
    env: { ...trainingEnv(o), NINJA_STATUS: "[%f/%t %es] " },
  });

  if (o.bolt) boltWithBun(o);
  markDone(p.llvmInstall, key);
}

/** Binaries in the install's bin/ that get BOLTed: the clang driver binary and lld. */
function boltTargets(installBin: string): string[] {
  const clang = readdirSync(installBin).find(f => /^clang-\d+$/.test(f));
  if (clang === undefined) throw new Error(`no clang-<major> binary in ${installBin}`);
  return [clang, "lld"];
}

/**
 * BOLT clang and lld in the install tree: instrument both in place, build Bun with
 * them (bun/train.ts clang-bolt), then optimize the originals with the collected
 * profile. llvm-bolt / merge-fdata are the ones just built and installed alongside
 * (the `bolt` project; package.ts leaves them out of the tarball).
 */
function boltWithBun(o: Options): void {
  const p = paths(o);
  const bin = join(p.llvmInstall, "bin");
  const llvmBolt = join(bin, "llvm-bolt");
  const mergeFdata = join(bin, "merge-fdata");
  const work = join(p.llvmBuild, "bun-bolt");
  remove(work);
  mkdir(work);

  const targets = boltTargets(bin);
  for (const name of targets) {
    copyFileSync(join(bin, name), join(work, `${name}.prebolt`));
    run([llvmBolt, join(work, `${name}.prebolt`), "-o", join(bin, name), "-instrument", "--instrumentation-file-append-pid", `--instrumentation-file=${join(work, name)}.fdata`]);
  }

  run([join(o.checkout, "bun", "train.ts"), "clang-bolt", p.llvmInstall], { env: trainingEnv(o) });

  for (const name of targets) {
    const profiles = readdirSync(work).filter(f => f.startsWith(`${name}.fdata`)).map(f => join(work, f));
    if (profiles.length === 0) throw new Error(`BOLT: no profile was written for ${name}`);
    run([mergeFdata, ...profiles, "-o", join(work, `${name}.merged.fdata`)], { capture: true });
    // Flags: clang/utils/perf-training/perf-helper.py bolt_optimize().
    run([
      llvmBolt, join(work, `${name}.prebolt`), "-o", join(bin, name), "-data", join(work, `${name}.merged.fdata`),
      "-reorder-blocks=ext-tsp", "-reorder-functions=cdsort", "-split-functions", "-split-all-cold", "-split-eh", "-dyno-stats", "-use-gnu-stack", "-update-debug-sections",
    ]);
  }
}
