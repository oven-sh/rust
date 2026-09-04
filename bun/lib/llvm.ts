// clang + lld, built the way LLVM's release binaries are built — clang/cmake/caches/Release.cmake:
// stage 1 (host compiler builds clang) → PGO-instrumented stage → final stage (profile use +
// ThinLTO) — with these inputs of ours:
//   - the PGO/BOLT training workload is one Bun build, the toolchain variant's (lib/variants.ts);
//   - BOLT: Release.cmake would BOLT `clang` with clang/utils/perf-training's small built-in
//     suite. We turn that off and, after install, BOLT both `clang` and `lld` with the variant's
//     Bun build (lld matters: Bun's cross-language ThinLTO link runs LLVM's backend inside lld);
//   - only the pieces Bun uses are built and installed (LLVM_DISTRIBUTION_COMPONENTS).
//
// It runs as two steps so the expensive, variant-independent part is shared:
//   buildInstrumented   stage 1 + the instrumented stage, via Release.cmake (ninja target
//                       `stage2-instrumented`). Packs what the next step needs into a tarball.
//   buildFinal          per variant: train with the instrumented clang/lld, merge the profile,
//                       configure and build the final stage exactly as Release.cmake's bootstrap
//                       would (finalStageCache below), install-distribution, BOLT.
//
// Upstream recipe, at src/llvm-project's pinned commit:
//   clang/cmake/caches/Release.cmake          (the cache file; line references below are to it)
//   clang/CMakeLists.txt "if (CLANG_ENABLE_BOOTSTRAP)"  (how a stage configures the next)
//   clang/utils/perf-training/                (profile collection, BOLT post-link step)
//   .github/workflows/release-binaries.yml    (how it is invoked)

import { chmodSync, copyFileSync, cpSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exists, isDone, markDone, mkdir, remove, write } from "./fs.ts";
import { type Options, paths, RECIPE_VERSION, type Host } from "./options.ts";
import { run, runConcurrently } from "./run.ts";
import { trainingEnv } from "./train-config.ts";

/**
 * Install components of the final stage that make up the LLVM half of the toolchain (each is
 * an LLVM install component: a tool, `clang-resource-headers`, or the compiler-rt
 * `builtins`/`runtimes`). clang and lld's symlinks (clang++, clang-cl, ld.lld, ld64.lld,
 * lld-link, wasm-ld) install with them.
 */
export const DISTRIBUTION_COMPONENTS = [
  "clang", "clang-format", "clang-resource-headers", "lld", "builtins", "runtimes",
  "llvm-ar", "llvm-ranlib", "llvm-lib", "llvm-nm", "llvm-objcopy", "llvm-objdump", "llvm-strip",
  "llvm-symbolizer", "llvm-addr2line", "llvm-profdata", "llvm-cov", "llvm-rc", "llvm-mt", "llvm-readobj", "llvm-readelf",
  "llvm-size", "llvm-dwarfdump", "llvm-cxxfilt", "llvm-config", "dsymutil",
];

/**
 * Tools a Bun build invokes next to the clang it is pointed at (scripts/build/tools.ts;
 * llvm-lib/llvm-rc/llvm-mt for the Windows targets, dsymutil for macOS). buildInstrumented
 * checks the instrumented stage built them, since training fails late and obscurely otherwise.
 */
const TRAINING_TOOLS = [
  "lld", "llvm-config", "llvm-ar", "llvm-ranlib", "llvm-lib", "llvm-nm", "llvm-objcopy", "llvm-objdump", "llvm-strip",
  "llvm-readelf", "llvm-symbolizer", "llvm-profdata", "llvm-rc", "llvm-mt", "llvm-cxxfilt", "dsymutil",
];

/**
 * deviation (aarch64): what we BOLT is compiled without jump tables. AArch64 jump tables are
 * addressed through an `adr` inside the function; in a function whose CFG llvm-bolt cannot
 * fully rebuild that `adr` cannot be relaxed and llvm-bolt aborts ("cannot relax ADR in
 * non-simple function"). It is a function attribute, so ThinLTO codegen honors it. The
 * instrumented stage gets it too so its profile matches the final stage's control flow.
 */
/**
 * -mcpu / -Ctarget-cpu for the toolchain's own binaries (clang, lld, rustc's libraries), per host —
 * host code only, never the runtimes/std shipped for targets. None by default: neoverse-v2 (what
 * oven-sh/bun's r8g build agents are) measured within noise of generic on Bun's CI, and generic
 * runs on every agent that touches the images. --host-cpu=NAME to experiment.
 */
export const HOST_CPU: Partial<Record<Host, string>> = {};

export const NO_JUMP_TABLES = "-fno-jump-tables";

const LLVM_LICENSES: Record<string, string> = {
  "LLVM-LICENSE.TXT": "llvm/LICENSE.TXT",
  "clang-LICENSE.TXT": "clang/LICENSE.TXT",
  "lld-LICENSE.TXT": "lld/LICENSE.TXT",
  "compiler-rt-LICENSE.TXT": "compiler-rt/LICENSE.TXT",
};

/** Where things are inside paths(o).llvmBuild / llvmFinal. */
function layout(o: Options) {
  const p = paths(o);
  const instrumented = join(p.llvmBuild, "tools", "clang", "stage2-instrumented-bins");
  return {
    /** stage 1: compiles the instrumented and the final stage; its llvm-profdata merges profiles */
    stage1Bin: join(p.llvmBuild, "bin"),
    stage1Resource: join(p.llvmBuild, "lib", "clang"),
    instrumentedBin: join(instrumented, "bin"),
    instrumentedResource: join(instrumented, "lib", "clang"),
    /** written when buildInstrumented finished; content = its cache key */
    instrumentedStamp: join(p.llvmBuild, "instrumented.done"),
    profiles: join(p.llvmFinal, "profiles"),
    profdata: join(p.llvmFinal, "clang.profdata"),
    finalBuild: join(p.llvmFinal, "build"),
    boltWork: join(p.llvmFinal, "bolt"),
  };
}

function llvmRev(o: Options): string {
  return run(["git", "rev-parse", "HEAD"], { cwd: o.llvmProject, capture: true }).trim();
}

/**
 * C/C++ flags for the stages stage 1's clang compiles (instrumented and final):
 * - NO_JUMP_TABLES where BOLT needs it (see there);
 * - the GCC installation the host clang uses (bun/Dockerfile writes it into its clang.cfg: the
 *   image's GCC 13, built the way BOLT wants), so the libstdc++ that gets statically linked into
 *   clang and lld is that one rather than whatever the distro's default GCC is;
 * - on the instrumented stage only, more value-profile counters per site: with one Bun build as
 *   the training set the default (1 per site) runs out on the lanes where clang does codegen
 *   ("Unable to track new values"), dropping indirect-call profiles. rust's bootstrap uses 4 for
 *   rustc, ClangBuiltLinux 6, Fedora 8.
 */
function stageCFlags(o: Options, stage: "instrumented" | "final"): string {
  const flags: string[] = [];
  if (o.host === "linux-aarch64" && o.llvmBolt) flags.push(NO_JUMP_TABLES);
  // Host tools only: the runtimes sub-build (compiler-rt) does not inherit CMAKE_C(XX)_FLAGS.
  const cpu = o.hostCpu;
  if (cpu !== undefined) flags.push(`-mcpu=${cpu}`);
  const gcc = hostGccInstallDir(o);
  if (gcc !== undefined) flags.push(`--gcc-install-dir=${gcc}`);
  if (stage === "instrumented") flags.push("-Xclang -mllvm -Xclang -vp-counters-per-site=8");
  return flags.join(" ");
}

/** The `--gcc-install-dir=` the host clang is configured with (bun/Dockerfile), if any. */
function hostGccInstallDir(o: Options): string | undefined {
  const cfg = join(o.hostLlvm, "bin", "clang++.cfg");
  if (!exists(cfg)) return undefined;
  return readFileSync(cfg, "utf8").match(/--gcc-install-dir=(\S+)/)?.[1];
}

/** Cache settings every stage gets. */
function everyStageCache(o: Options): Record<string, string> {
  return {
    // Upstream builds every backend (Release.cmake l.72 makes stage 1 Native-only); Bun targets
    // x86_64 and aarch64.
    LLVM_TARGETS_TO_BUILD: "X86;AArch64",
    // llvm-mt and lld-link's manifest merging need libxml2; fail at configure rather than ship
    // without, and link the image's static build (bun/Dockerfile) so the binaries do not depend
    // on a host libxml2.so — its soname differs between distros.
    LLVM_ENABLE_LIBXML2: "FORCE_ON",
    LIBXML2_LIBRARY: join(o.libxml2, "lib", "libxml2.a"),
    LIBXML2_INCLUDE_DIR: join(o.libxml2, "include", "libxml2"),
    CMAKE_PREFIX_PATH: o.libxml2,
    LLVM_PARALLEL_LINK_JOBS: String(Math.max(1, Math.floor(o.jobs / 8))),
  };
}

/**
 * -D settings passed ahead of `-C Release.cmake` for stage 1 and the instrumented stage
 * (clang's bootstrap hands `BOOTSTRAP_<X>` to the next stage as `<X>`). The LLVM_RELEASE_*
 * ones are the cache file's documented inputs.
 */
function instrumentedCache(o: Options): Record<string, string> {
  const cache: Record<string, string> = {
    // Release.cmake inputs (l.52-53); they size stage 1 and the instrumented stage. Upstream:
    // clang;lld;lldb;clang-tools-extra;polly;mlir;flang;bolt and compiler-rt;libcxx;openmp;
    // libcxxabi;libunwind;flang-rt.
    LLVM_RELEASE_ENABLE_PROJECTS: "clang;lld",
    LLVM_RELEASE_ENABLE_RUNTIMES: "compiler-rt",
    // Stage 1 is built with the host LLVM.
    CMAKE_C_COMPILER: join(o.hostLlvm, "bin", "clang"),
    CMAKE_CXX_COMPILER: join(o.hostLlvm, "bin", "clang++"),
    LLVM_ENABLE_LLD: "ON",
  };
  for (const [name, value] of Object.entries(everyStageCache(o))) {
    cache[name] = value;
    cache[`BOOTSTRAP_${name}`] = value;
  }
  cache.BOOTSTRAP_CMAKE_C_FLAGS = stageCFlags(o, "instrumented");
  cache.BOOTSTRAP_CMAKE_CXX_FLAGS = stageCFlags(o, "instrumented");
  // The instrumented clang serves every variant on this host, including ones that link a
  // sanitizer runtime for the other Linux architecture (ci-linux-x64-asan on the aarch64 host),
  // so its compiler-rt is built for both — as the final stage's is when the variant needs it.
  Object.assign(cache, prefixed("BOOTSTRAP_", crossCompilerRt(o)));
  return cache;
}

/**
 * compiler-rt (builtins, sanitizers, profile) for the other Linux architecture as well as the
 * native one. Upstream: native only. It compiles against the image's <triple> cross gcc/libc
 * (bun/Dockerfile); Bun's CI gives its host clang the same by other means (bootstrap.sh
 * install_cross_compiler_rt).
 */
function crossCompilerRt(o: Options): Record<string, string> {
  return {
    LLVM_BUILTIN_TARGETS: `default;${o.crossTriple}`,
    LLVM_RUNTIME_TARGETS: `default;${o.crossTriple}`,
    [`BUILTINS_${o.crossTriple}_CMAKE_SYSTEM_NAME`]: "Linux",
    [`RUNTIMES_${o.crossTriple}_CMAKE_SYSTEM_NAME`]: "Linux",
    [`RUNTIMES_${o.crossTriple}_LLVM_ENABLE_RUNTIMES`]: "compiler-rt",
  };
}

function prefixed(prefix: string, cache: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(cache).map(([k, v]) => [prefix + k, v]));
}

/**
 * The final stage's cache, as Release.cmake's bootstrap chain would configure it
 * (set_final_stage_var / set_instrument_and_final_stage_var, and clang/CMakeLists.txt's
 * pass-through of the compiler and profile), with our deviations marked.
 */
function finalStageCache(o: Options): Record<string, string> {
  const p = paths(o);
  const l = layout(o);
  const crossLinux = o.variant.target.os === "linux" && `linux-${o.variant.target.arch}` !== o.host;
  // Release.cmake l.181-191: RELEASE_LINKER_FLAGS on Linux (what BOLT needs from the link).
  const releaseLinkerFlags = "-Wl,--emit-relocs,-znow";
  const cache: Record<string, string> = {
    // clang/CMakeLists.txt: a PGO final stage is compiled by the compilers that built the
    // instrumented stage (stage 1's), with the merged profile.
    CMAKE_C_COMPILER: join(l.stage1Bin, "clang"),
    CMAKE_CXX_COMPILER: join(l.stage1Bin, "clang++"),
    CMAKE_ASM_COMPILER: join(l.stage1Bin, "clang"),
    CMAKE_ASM_COMPILER_ID: "Clang",
    LLVM_PROFDATA_FILE: l.profdata,
    // Release.cmake l.69, passed through every stage.
    CMAKE_BUILD_TYPE: "Release",
    // l.165-169 set_instrument_and_final_stage_var
    CMAKE_POSITION_INDEPENDENT_CODE: "ON",
    LLVM_ENABLE_LTO: "Thin",
    LLVM_ENABLE_LLD: "ON",
    // l.187-191
    CMAKE_SHARED_LINKER_FLAGS: releaseLinkerFlags,
    CMAKE_MODULE_LINKER_FLAGS: releaseLinkerFlags,
    // deviation: clang, lld (every final-stage executable) allocate with mimalloc instead of
    // glibc malloc — the ThinLTO link runs LLVM's optimizer on every core at once. -pthread:
    // mimalloc uses pthread_key_*, which glibc < 2.34 keeps in libpthread.
    // deviation: identical code folding at link time (Android's clang: --icf=safe; rustc:
    // --icf=all) — less text for the same code. -fuse-ld=lld spelled out because CMake's compiler
    // check links with these flags before LLVM_ENABLE_LLD applies, and --icf is lld's.
    CMAKE_EXE_LINKER_FLAGS: [releaseLinkerFlags, "-fuse-ld=lld -Wl,--icf=safe", ...(o.mimalloc !== undefined ? ["-pthread", o.mimalloc] : [])].join(" "),
    // deviation: libstdc++ linked into the executables (Chromium's and Android's clang builds do
    // the same; rustc does for libLLVM): its code becomes part of what LTO optimizes and BOLT lays
    // out, and the toolchain no longer needs a particular libstdc++.so.6 on the host.
    LLVM_STATIC_LINK_CXX_STDLIB: "ON",
    // deviation: no .eh_frame unwind tables (Chromium's clang build): clang and lld are built
    // without exceptions; smaller binaries, less for BOLT to keep consistent.
    LLVM_ENABLE_UNWIND_TABLES: "OFF",
    // l.194-195 set_final_stage_var
    LLVM_ENABLE_PROJECTS: "clang;lld",
    LLVM_ENABLE_RUNTIMES: "compiler-rt",
    // l.196-198: CLANG_BOLT=INSTRUMENT upstream; ours is boltWithBun() (deviation: workload, and
    // lld too).
    CLANG_BOLT: "OFF",
    // l.202-205
    LLVM_USE_STATIC_ZSTD: "ON",
    LLVM_ENABLE_FATLTO: "ON",
    ...everyStageCache(o),
    // We install a distribution (the files of the LLVM install a Bun build uses) where upstream
    // runs `package` over everything (l.68 LLVM_RELEASE_FINAL_STAGE_TARGETS).
    LLVM_DISTRIBUTION_COMPONENTS: DISTRIBUTION_COMPONENTS.join(";"),
    CMAKE_INSTALL_PREFIX: p.llvmInstall,
    // deviation: no dlopen'd plugin support in clang / LLVM passes. Nothing then has to stay
    // exported from the executables, so ThinLTO can internalize and inline across far more of
    // clang and lld. Bun's build loads no compiler plugins. Upstream: ON (general-purpose).
    CLANG_PLUGIN_SUPPORT: "OFF",
    LLVM_ENABLE_PLUGINS: "OFF",
  };
  cache.CMAKE_C_FLAGS = stageCFlags(o, "final");
  cache.CMAKE_CXX_FLAGS = stageCFlags(o, "final");
  // The shipped compiler-rt covers the other Linux architecture only when the variant targets it.
  if (crossLinux) Object.assign(cache, crossCompilerRt(o));
  return cache;
}

function cmakeConfigure(source: string, buildDir: string, cache: Record<string, string>, extra: string[] = []): void {
  run(["cmake", "-G", "Ninja", "-S", source, "-B", buildDir, ...Object.entries(cache).map(([k, v]) => `-D${k}=${v}`), ...extra]);
}

/** Stage 1 + the PGO-instrumented clang/lld (variant-independent), packed into llvmInstrumentedTar. */
export function buildInstrumented(o: Options): void {
  const p = paths(o);
  const l = layout(o);
  const key = `llvm-instrumented-${RECIPE_VERSION}-${llvmRev(o)}-${stageCFlags(o, "instrumented")}-crossrt`;
  if (exists(l.instrumentedStamp) && isDone(p.llvmBuild, key)) {
    console.log(`llvm instrumented stage: up to date (${key})`);
  } else {
    mkdir(p.llvmBuild);
    cmakeConfigure(join(o.llvmProject, "llvm"), p.llvmBuild, instrumentedCache(o), ["-C", join(o.llvmProject, "clang", "cmake", "caches", "Release.cmake")]);
    // `stage2-instrumented`: stage 1's clang/lld/compiler-rt, then the instrumented stage's
    // configure and its `all` (clang, lld, compiler-rt, the llvm tools). Profile collection is a
    // separate target there (generate-profdata) that we do not build: buildFinal trains.
    run(["ninja", "-C", p.llvmBuild, `-j${o.jobs}`, "stage2-instrumented"], { env: { NINJA_STATUS: "[%f/%t %es] " } });
    for (const tool of ["clang", ...TRAINING_TOOLS]) {
      if (!exists(join(l.instrumentedBin, tool))) throw new Error(`the instrumented stage did not build bin/${tool}`);
    }
    write(l.instrumentedStamp, key + "\n");
    markDone(p.llvmBuild, key);
  }
  // What buildFinal needs, at the same relative paths: stage 1's compiler + resource dir (it
  // compiles the final stage and merges profiles) and the instrumented compiler, tools and
  // resource dir (they compile Bun during training).
  const rel = (abs: string) => abs.slice(p.llvmBuild.length + 1);
  run(["tar", "-C", p.llvmBuild, "-I", `zstd -T${o.jobs} -10`, "-cf", p.llvmInstrumentedTar,
    rel(l.instrumentedStamp), rel(l.stage1Bin), rel(l.stage1Resource), rel(l.instrumentedBin), rel(l.instrumentedResource)]);
  console.log(`llvm instrumented stage: packed ${p.llvmInstrumentedTar}`);
}

/** The variant's clang/lld: train, build the final stage with the profile, install, BOLT. */
export async function buildFinal(o: Options): Promise<void> {
  const p = paths(o);
  const l = layout(o);
  if (!exists(l.instrumentedStamp)) {
    if (!exists(p.llvmInstrumentedTar)) throw new Error(`no instrumented LLVM: run \`toolchain.ts llvm-instrumented\` first, or put its tarball at ${p.llvmInstrumentedTar}`);
    mkdir(p.llvmBuild);
    run(["tar", "-C", p.llvmBuild, "-I", "zstd", "-xf", p.llvmInstrumentedTar]);
  }
  const key = `llvm-${RECIPE_VERSION}-${llvmRev(o)}-${o.variant.name}-bolt=${o.llvmBolt}-mimalloc=${o.mimalloc !== undefined}`;
  if (isDone(p.llvmInstall, key)) {
    console.log(`llvm: up to date (${key})`);
    return;
  }
  if (o.mimalloc !== undefined && !exists(o.mimalloc)) {
    throw new Error(`--mimalloc: ${o.mimalloc} does not exist (bun/Dockerfile builds it; pass --mimalloc=none to use the libc allocator)`);
  }
  chmodSync(join(o.checkout, "bun", "train.ts"), 0o755);
  remove(p.llvmFinal);
  remove(p.llvmInstall);

  // 1. Profile: build the variant's Bun with the instrumented clang and lld. One .profraw per
  //    4-way merge pool rather than one file every process locks (perf-training's lit config
  //    does the same); LLD_IN_TEST=1 makes lld return from main instead of _exit-ing, so its
  //    atexit profile writer runs — without it the links contribute nothing.
  mkdir(l.profiles);
  run([join(o.checkout, "bun", "train.ts"), "clang"], {
    env: {
      ...trainingEnv(o),
      CC: join(l.instrumentedBin, "clang"),
      CXX: join(l.instrumentedBin, "clang++"),
      LLVM_PROFILE_FILE: join(l.profiles, "bun-%4m.profraw"),
      LLD_IN_TEST: "1",
    },
  });
  const profraw = readdirSync(l.profiles).filter(f => f.endsWith(".profraw"));
  if (profraw.length === 0) throw new Error(`training wrote no profiles to ${l.profiles}`);
  run([join(l.stage1Bin, "llvm-profdata"), "merge", "-o", l.profdata, ...profraw.map(f => join(l.profiles, f))]);

  // 2. The final stage.
  cmakeConfigure(join(o.llvmProject, "llvm"), l.finalBuild, finalStageCache(o));
  run(["ninja", "-C", l.finalBuild, `-j${o.jobs}`, "install-distribution"], { env: { NINJA_STATUS: "[%f/%t %es] " } });

  // 3. BOLT, licenses, provenance.
  if (o.llvmBolt) await boltWithBun(o);
  for (const [name, src] of Object.entries(LLVM_LICENSES)) cpSync(join(o.llvmProject, src), join(p.llvmInstall, "licenses", name));
  const mimallocLicense = o.mimalloc && join(o.mimalloc, "..", "LICENSE"); // where bun/Dockerfile puts it
  if (mimallocLicense && exists(mimallocLicense)) cpSync(mimallocLicense, join(p.llvmInstall, "licenses", "mimalloc-LICENSE"));
  write(join(p.llvmInstall, "llvm-project.rev"), llvmRev(o) + "\n");
  markDone(p.llvmInstall, key);
}

/** What toolchain.json records for the LLVM half: both configures. */
export function llvmProvenance(o: Options): Record<string, unknown> {
  return { instrumented: instrumentedCache(o), final: finalStageCache(o) };
}

/** Binaries in the install's bin/ that get BOLTed: the clang driver binary and lld. */
function boltTargets(installBin: string): string[] {
  const clang = readdirSync(installBin).find(f => /^clang-\d+$/.test(f));
  if (clang === undefined) throw new Error(`no clang-<major> binary in ${installBin}`);
  return [clang, "lld"];
}

/**
 * BOLT clang and lld in the install tree: instrument both, build the variant's Bun with them
 * (bun/train.ts clang-bolt), then optimize the originals with the collected profile. llvm-bolt /
 * merge-fdata are the host LLVM's, as on the rust side. The two binaries are processed
 * concurrently (each llvm-bolt run is minutes on a binary this size).
 *
 * Optimization flags: rust's src/tools/opt-dist set (a superset of clang/utils/perf-training's:
 * adds -jump-tables=move, -icf=all, and three-way -split-strategy=cdsplit on x86_64 — profile2 on
 * aarch64 where cdsplit is broken), plus perf-training's -split-eh and -use-gnu-stack. (Not
 * -hugify: on kernels >= 5.10 its runtime only madvise()s the file-backed text, which for a
 * process that lives seconds never becomes huge pages — measured: THPeligible 0.)
 */
async function boltWithBun(o: Options): Promise<void> {
  const p = paths(o);
  const l = layout(o);
  const bin = join(p.llvmInstall, "bin");
  const llvmBolt = join(o.hostLlvm, "bin", "llvm-bolt");
  const mergeFdata = join(o.hostLlvm, "bin", "merge-fdata");
  remove(l.boltWork);
  mkdir(l.boltWork);

  const targets = boltTargets(bin);
  for (const name of targets) copyFileSync(join(bin, name), join(l.boltWork, `${name}.prebolt`));
  await runConcurrently(
    targets.map(name => [llvmBolt, join(l.boltWork, `${name}.prebolt`), "-o", join(bin, name), "-instrument", "--instrumentation-file-append-pid", `--instrumentation-file=${join(l.boltWork, name)}.fdata`]),
  );

  // LLD_IN_TEST=1 as during PGO training: lld must return from main for BOLT's runtime to
  // write its profile at exit.
  run([join(o.checkout, "bun", "train.ts"), "clang-bolt", p.llvmInstall], { env: { ...trainingEnv(o), LLD_IN_TEST: "1" } });

  for (const name of targets) {
    const profiles = readdirSync(l.boltWork).filter(f => f.startsWith(`${name}.fdata`)).map(f => join(l.boltWork, f));
    if (profiles.length === 0) throw new Error(`BOLT: no profile was written for ${name}`);
    run([mergeFdata, ...profiles, "-o", join(l.boltWork, `${name}.merged.fdata`)], { capture: true });
  }
  const splitStrategy = o.host === "linux-aarch64" ? "profile2" : "cdsplit";
  await runConcurrently(
    targets.map(name => [
      llvmBolt, join(l.boltWork, `${name}.prebolt`), "-o", join(bin, name), "-data", join(l.boltWork, `${name}.merged.fdata`),
      "-reorder-blocks=ext-tsp", "-reorder-functions=cdsort", "-split-functions", `-split-strategy=${splitStrategy}`, "-split-all-cold", "-split-eh",
      "-jump-tables=move", "-icf=all", "-use-gnu-stack", "-update-debug-sections", "-dyno-stats",
    ]),
  );
}
