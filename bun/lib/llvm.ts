// clang + lld, built the way LLVM's release binaries are built —
// clang/cmake/caches/Release.cmake: stage1 → stage2-instrumented (IR PGO) →
// stage2 (profile-use + ThinLTO), with the clang binary BOLTed on Linux — plus
// one input of ours: the PGO training workload is a Bun build
// (CLANG_PGO_TRAINING_DATA_SOURCE_DIR → bun/train-clang → bun/train.ts clang).
//
// Upstream recipe, at src/llvm-project's pinned commit:
//   clang/cmake/caches/Release.cmake
//   clang/utils/perf-training/          (profile collection, BOLT post-link step)
//   llvm/utils/release/build_llvm_release.bat / .github/workflows/release-binaries.yml (how it is invoked)

import { join } from "node:path";
import { isDone, markDone, mkdir } from "./fs.ts";
import { type Options, paths, RECIPE_VERSION } from "./options.ts";
import { run } from "./run.ts";
import { trainingEnv } from "./train-config.ts";

/**
 * -D settings passed ahead of `-C Release.cmake`. The LLVM_RELEASE_* ones are the
 * cache file's documented inputs; the rest narrow what gets built to what a Bun
 * build uses. None of them change how clang or lld themselves are compiled.
 */
function releaseOverrides(o: Options): Record<string, string> {
  const p = paths(o);
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
    // Upstream builds every backend; Bun targets x86_64 and aarch64 (+ wasm for completeness of
    // rustc's wasm targets is rustc's own LLVM, not this one).
    LLVM_TARGETS_TO_BUILD: "X86;AArch64",
    LLVM_PARALLEL_LINK_JOBS: String(Math.max(1, Math.floor(o.jobs / 8))),

    // compiler-rt (builtins, sanitizers, profile) for both Linux architectures Bun's CI
    // builds from one host, not just the native one. Upstream: native only. The cross
    // one compiles against the image's <triple> cross gcc/libc (bun/Dockerfile).
    BOOTSTRAP_BOOTSTRAP_LLVM_BUILTIN_TARGETS: `default;${o.crossTriple}`,
    BOOTSTRAP_BOOTSTRAP_LLVM_RUNTIME_TARGETS: `default;${o.crossTriple}`,
    [`BOOTSTRAP_BOOTSTRAP_BUILTINS_${o.crossTriple}_CMAKE_SYSTEM_NAME`]: "Linux",
    [`BOOTSTRAP_BOOTSTRAP_RUNTIMES_${o.crossTriple}_CMAKE_SYSTEM_NAME`]: "Linux",
    [`BOOTSTRAP_BOOTSTRAP_RUNTIMES_${o.crossTriple}_LLVM_ENABLE_RUNTIMES`]: "compiler-rt",

    // Stage 1 is built with the host LLVM.
    CMAKE_C_COMPILER: join(o.hostLlvm, "bin", "clang"),
    CMAKE_CXX_COMPILER: join(o.hostLlvm, "bin", "clang++"),
    LLVM_ENABLE_LLD: "ON",

    // The training workload, for the instrumented stage (BOOTSTRAP_ = second stage).
    BOOTSTRAP_CLANG_PGO_TRAINING_DATA_SOURCE_DIR: join(o.checkout, "bun", "train-clang"),
    // Bun's build needs these next to the instrumented clang it is pointed at.
    BOOTSTRAP_CLANG_PGO_TRAINING_DEPS: "lld;llvm-ar;llvm-ranlib;llvm-nm;llvm-objcopy;llvm-strip;llvm-symbolizer;llvm-profdata",

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
  const defines = releaseOverrides(o);
  if (!o.bolt) defines.BOOTSTRAP_BOOTSTRAP_CLANG_BOLT = "OFF";
  run([
    "cmake",
    "-G",
    "Ninja",
    "-S",
    join(o.llvmProject, "llvm"),
    "-B",
    p.llvmBuild,
    ...Object.entries(defines).map(([k, v]) => `-D${k}=${v}`),
    "-C",
    join(o.llvmProject, "clang", "cmake", "caches", "Release.cmake"),
  ]);

  // One target drives all three stages: stage1 → stage2-instrumented (+ generate-profdata,
  // which builds bun/train-clang with the instrumented clang) → stage2 → install.
  run(["ninja", "-C", p.llvmBuild, `-j${o.jobs}`, "stage2-install"], {
    env: { ...trainingEnv(o), NINJA_STATUS: "[%f/%t %es] " },
  });
  markDone(p.llvmInstall, key);
}
