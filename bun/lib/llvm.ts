// clang + lld, built the way LLVM's release binaries are built —
// clang/cmake/caches/Release.cmake: stage1 → stage2-instrumented (IR PGO) →
// stage2 (profile-use + ThinLTO) — with these inputs of ours:
//   - the PGO training workload is a Bun build (CLANG_PGO_TRAINING_DATA_SOURCE_DIR
//     → bun/train-clang → bun/train.ts clang);
//   - BOLT: Release.cmake would BOLT `clang` with clang/utils/perf-training's small
//     built-in lit suite. We turn that off and, after install, BOLT both `clang` and
//     `lld` with a Bun build as the workload (host llvm-bolt; same flags as
//     clang/utils/perf-training/perf-helper.py bolt-optimize). lld matters to us
//     because Bun's cross-language ThinLTO link runs LLVM's backend inside lld.
//   - only the pieces Bun uses are built and installed (LLVM_DISTRIBUTION_COMPONENTS).
//
// Upstream recipe, at src/llvm-project's pinned commit:
//   clang/cmake/caches/Release.cmake
//   clang/utils/perf-training/          (profile collection, BOLT post-link step)
//   .github/workflows/release-binaries.yml (how it is invoked)

import { chmodSync, copyFileSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { exists, isDone, markDone, mkdir, remove, write } from "./fs.ts";
import { type Options, paths, RECIPE_VERSION } from "./options.ts";
import { run } from "./run.ts";
import { trainingEnv } from "./train-config.ts";

/**
 * Install components of the final stage that make up the LLVM half of the toolchain
 * (each is an LLVM install component: a tool, `clang-resource-headers`, or the
 * compiler-rt `builtins`/`runtimes`). clang and lld's symlinks (clang++, clang-cl,
 * ld.lld, ld64.lld, lld-link, wasm-ld) install with them.
 */
export const DISTRIBUTION_COMPONENTS = [
  "clang", "clang-format", "clang-resource-headers", "lld", "builtins", "runtimes",
  "llvm-ar", "llvm-ranlib", "llvm-lib", "llvm-nm", "llvm-objcopy", "llvm-objdump", "llvm-strip",
  "llvm-symbolizer", "llvm-addr2line", "llvm-profdata", "llvm-cov", "llvm-rc", "llvm-mt", "llvm-readobj", "llvm-readelf",
  "llvm-size", "llvm-dwarfdump", "llvm-cxxfilt", "llvm-config", "dsymutil",
];

/**
 * -D settings passed ahead of `-C Release.cmake`. The LLVM_RELEASE_* ones are the
 * cache file's documented inputs. Marked "deviation" where the resulting binaries
 * differ from what upstream's recipe alone would produce.
 */
/**
 * deviation (aarch64): what we BOLT is compiled without jump tables. AArch64 jump tables
 * are addressed through an `adr` inside the function; in a function whose CFG llvm-bolt
 * cannot fully rebuild that `adr` cannot be relaxed and llvm-bolt aborts ("cannot relax
 * ADR in non-simple function"). It is a function attribute, so ThinLTO codegen honors it.
 */
export const NO_JUMP_TABLES = "-fno-jump-tables";

export function releaseOverrides(o: Options): Record<string, string> {
  const p = paths(o);
  const boltable = o.host === "linux-aarch64" && o.llvmBolt ? NO_JUMP_TABLES : "";
  // clang's bootstrap hands `BOOTSTRAP_<X>` to the next stage as `<X>`, so a setting for
  // all three stages is spelled three times.
  const everyStage = (name: string, value: string) => ({ [name]: value, [`BOOTSTRAP_${name}`]: value, [`BOOTSTRAP_BOOTSTRAP_${name}`]: value });
  return {
    // Release.cmake inputs. Upstream: clang;lld;lldb;clang-tools-extra;polly;mlir;flang;bolt and
    // compiler-rt;libcxx;openmp;libcxxabi;libunwind;flang-rt.
    LLVM_RELEASE_ENABLE_PROJECTS: "clang;lld",
    LLVM_RELEASE_ENABLE_RUNTIMES: "compiler-rt",
    // Upstream: clang;package;check-all;check-llvm;check-clang (what `ninja stage2-<x>` can
    // reach in the final stage). We install a distribution instead of packaging, and leave
    // the test suites to upstream.
    LLVM_RELEASE_FINAL_STAGE_TARGETS: "install-distribution",
    // What that distribution is: the files of the LLVM install a Bun build uses.
    BOOTSTRAP_BOOTSTRAP_LLVM_DISTRIBUTION_COMPONENTS: DISTRIBUTION_COMPONENTS.join(";"),

    CMAKE_INSTALL_PREFIX: p.llvmInstall, // the bootstrap forwards this one itself
    // Upstream builds every backend; Bun targets x86_64 and aarch64.
    ...everyStage("LLVM_TARGETS_TO_BUILD", "X86;AArch64"),
    // llvm-mt and lld-link's manifest merging need libxml2; fail at configure rather than ship
    // without, and link the image's static build (bun/Dockerfile) so the binaries do not
    // depend on a host libxml2.so — its soname differs between distros.
    ...everyStage("LLVM_ENABLE_LIBXML2", "FORCE_ON"),
    ...everyStage("LIBXML2_LIBRARY", join(o.libxml2, "lib", "libxml2.a")),
    ...everyStage("LIBXML2_INCLUDE_DIR", join(o.libxml2, "include", "libxml2")),
    ...everyStage("CMAKE_PREFIX_PATH", o.libxml2),
    ...everyStage("LLVM_PARALLEL_LINK_JOBS", String(Math.max(1, Math.floor(o.jobs / 8)))),

    // compiler-rt (builtins, sanitizers, profile) for the other Linux architecture too when the
    // variant targets it (CI builds every lane from one host). Upstream: native only. It compiles
    // against the image's <triple> cross gcc/libc (bun/Dockerfile).
    ...(o.variant.target.os === "linux" && `linux-${o.variant.target.arch}` !== o.host
      ? {
          BOOTSTRAP_BOOTSTRAP_LLVM_BUILTIN_TARGETS: `default;${o.crossTriple}`,
          BOOTSTRAP_BOOTSTRAP_LLVM_RUNTIME_TARGETS: `default;${o.crossTriple}`,
          [`BOOTSTRAP_BOOTSTRAP_BUILTINS_${o.crossTriple}_CMAKE_SYSTEM_NAME`]: "Linux",
          [`BOOTSTRAP_BOOTSTRAP_RUNTIMES_${o.crossTriple}_CMAKE_SYSTEM_NAME`]: "Linux",
          [`BOOTSTRAP_BOOTSTRAP_RUNTIMES_${o.crossTriple}_LLVM_ENABLE_RUNTIMES`]: "compiler-rt",
        }
      : {}),

    // deviation: clang, lld (every final-stage executable) allocate with mimalloc instead
    // of glibc malloc — the ThinLTO link runs LLVM's optimizer on every core at once.
    // Release.cmake's own final-stage linker flags (--emit-relocs for BOLT, -znow) are
    // repeated here because setting the variable pre-empts its set(). -pthread: mimalloc
    // uses pthread_key_*, which glibc < 2.34 keeps in libpthread.
    ...(o.mimalloc ? { BOOTSTRAP_BOOTSTRAP_CMAKE_EXE_LINKER_FLAGS: `-Wl,--emit-relocs,-znow -pthread ${o.mimalloc}` } : {}),
    // Instrumented stage too, so its profile matches the final stage's control flow.
    ...(boltable ? { BOOTSTRAP_CMAKE_C_FLAGS: boltable, BOOTSTRAP_CMAKE_CXX_FLAGS: boltable, BOOTSTRAP_BOOTSTRAP_CMAKE_C_FLAGS: boltable, BOOTSTRAP_BOOTSTRAP_CMAKE_CXX_FLAGS: boltable } : {}),

    // deviation: no dlopen'd plugin support in clang / LLVM passes. Nothing then has to stay
    // exported from the executables, so ThinLTO can internalize and inline across far more
    // of clang and lld. Bun's build loads no compiler plugins. Upstream: ON (general-purpose).
    BOOTSTRAP_BOOTSTRAP_CLANG_PLUGIN_SUPPORT: "OFF",
    BOOTSTRAP_BOOTSTRAP_LLVM_ENABLE_PLUGINS: "OFF",

    // BOLT is applied by boltWithBun() below instead (deviation: workload, and lld too).
    // Release.cmake still links with --emit-relocs,-znow on Linux, which BOLT needs.
    BOOTSTRAP_BOOTSTRAP_CLANG_BOLT: "OFF",

    // Stage 1 is built with the host LLVM.
    CMAKE_C_COMPILER: join(o.hostLlvm, "bin", "clang"),
    CMAKE_CXX_COMPILER: join(o.hostLlvm, "bin", "clang++"),
    LLVM_ENABLE_LLD: "ON",

    // The training workload, for the instrumented stage (BOOTSTRAP_ = second stage).
    BOOTSTRAP_CLANG_PGO_TRAINING_DATA_SOURCE_DIR: join(o.checkout, "bun", "train-clang"),
    // Everything Bun's build looks for next to the instrumented clang it is pointed at
    // (scripts/build/tools.ts; llvm-lib/llvm-rc/llvm-mt for the Windows target, dsymutil for
    // macOS). Listed in full: the outer ninja must have built them before the training
    // command starts its own nested build in the same tree.
    // `runtimes` (compiler-rt): the training build may link a sanitizer or builtins from the
    // instrumented clang's resource directory (debug and asan variants do).
    BOOTSTRAP_CLANG_PGO_TRAINING_DEPS: "lld;llvm-config;llvm-ar;llvm-ranlib;llvm-lib;llvm-nm;llvm-objcopy;llvm-objdump;llvm-strip;llvm-readelf;llvm-symbolizer;llvm-profdata;llvm-rc;llvm-mt;dsymutil;runtimes",
  };
}

export function buildLlvm(o: Options): void {
  const p = paths(o);
  const llvmRev = run(["git", "rev-parse", "HEAD"], { cwd: o.llvmProject, capture: true }).trim();
  const key = `llvm-${RECIPE_VERSION}-${llvmRev}-bolt=${o.llvmBolt}-mimalloc=${o.mimalloc !== undefined}-${o.variant.name}`;
  if (isDone(p.llvmInstall, key)) {
    console.log(`llvm: up to date (${key})`);
    return;
  }

  if (o.mimalloc !== undefined && !exists(o.mimalloc)) {
    throw new Error(`--mimalloc: ${o.mimalloc} does not exist (bun/Dockerfile builds it; pass --mimalloc=none to use the libc allocator)`);
  }
  mkdir(p.llvmBuild);
  // Before the hours-long part: make sure the training workload configures here.
  chmodSync(join(o.checkout, "bun", "train.ts"), 0o755);
  run([join(o.checkout, "bun", "train.ts"), "preflight"], { env: trainingEnv(o) });

  run([
    "cmake",
    "-G",
    "Ninja",
    "-S",
    join(o.llvmProject, "llvm"),
    "-B",
    p.llvmBuild,
    ...Object.entries(releaseOverrides(o)).map(([k, v]) => `-D${k}=${v}`),
    "-C",
    join(o.llvmProject, "clang", "cmake", "caches", "Release.cmake"),
  ]);

  // One target drives all three stages: stage1 → stage2-instrumented (+ generate-profdata,
  // which builds bun/train-clang with the instrumented clang) → stage2 → install-distribution.
  remove(p.llvmInstall);
  run(["ninja", "-C", p.llvmBuild, `-j${o.jobs}`, "stage2-install-distribution"], {
    env: { ...trainingEnv(o), NINJA_STATUS: "[%f/%t %es] " },
  });

  if (o.llvmBolt) boltWithBun(o);
  // For package.ts, so that job needs no llvm-project checkout.
  for (const [name, src] of Object.entries(LLVM_LICENSES)) cpSync(join(o.llvmProject, src), join(p.llvmInstall, "licenses", name));
  const mimallocLicense = o.mimalloc && join(o.mimalloc, "..", "LICENSE"); // where bun/Dockerfile puts it
  if (mimallocLicense && exists(mimallocLicense)) cpSync(mimallocLicense, join(p.llvmInstall, "licenses", "mimalloc-LICENSE"));
  write(join(p.llvmInstall, "llvm-project.rev"), llvmRev + "\n");
  markDone(p.llvmInstall, key);
}

const LLVM_LICENSES: Record<string, string> = {
  "LLVM-LICENSE.TXT": "llvm/LICENSE.TXT",
  "clang-LICENSE.TXT": "clang/LICENSE.TXT",
  "lld-LICENSE.TXT": "lld/LICENSE.TXT",
  "compiler-rt-LICENSE.TXT": "compiler-rt/LICENSE.TXT",
};

/** Binaries in the install's bin/ that get BOLTed: the clang driver binary and lld. */
function boltTargets(installBin: string): string[] {
  const clang = readdirSync(installBin).find(f => /^clang-\d+$/.test(f));
  if (clang === undefined) throw new Error(`no clang-<major> binary in ${installBin}`);
  return [clang, "lld"];
}

/**
 * BOLT clang and lld in the install tree: instrument both in place, build Bun with
 * them (bun/train.ts clang-bolt), then optimize the originals with the collected
 * profile. llvm-bolt / merge-fdata are the host LLVM's, as on the rust side.
 */
function boltWithBun(o: Options): void {
  const p = paths(o);
  const bin = join(p.llvmInstall, "bin");
  const llvmBolt = join(o.hostLlvm, "bin", "llvm-bolt");
  const mergeFdata = join(o.hostLlvm, "bin", "merge-fdata");
  const work = join(p.llvmBuild, "bun-bolt");
  remove(work);
  mkdir(work);

  const targets = boltTargets(bin);
  for (const name of targets) {
    copyFileSync(join(bin, name), join(work, `${name}.prebolt`));
    run([llvmBolt, join(work, `${name}.prebolt`), "-o", join(bin, name), "-instrument", "--instrumentation-file-append-pid", `--instrumentation-file=${join(work, name)}.fdata`]);
  }

  // LLD_IN_TEST=1 as in train-clang/CMakeLists.txt: lld must return from main for
  // BOLT's runtime to write its profile at exit.
  run([join(o.checkout, "bun", "train.ts"), "clang-bolt", p.llvmInstall], { env: { ...trainingEnv(o), LLD_IN_TEST: "1" } });

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
