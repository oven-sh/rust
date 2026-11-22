// The PGO profile clang and lld are optimized with. LLVM does not publish the one of its releases,
// so this is the middle stage of clang/cmake/caches/Release.cmake: an instrumented build, and what
// it records while it compiles part of LLVM.
//
// The workflow records it from upstream's commit and keeps it under a hash of this file and the
// Dockerfile: a patch to LLVM reuses it. A function that a patch changes the control flow of is
// compiled as if there were no profile; the others keep theirs.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isDone, markDone, mkdir, remove, write } from "./fs.ts";
import { type Options, paths, RECIPE_VERSION } from "./options.ts";
import { run, runConcurrently } from "./run.ts";

export type Cache = Record<string, string>;

function cmakeCommand(source: string, buildDir: string, cache: Cache): string[] {
  return [
    "cmake",
    "-G",
    "Ninja",
    "-S",
    source,
    "-B",
    buildDir,
    ...Object.entries(cache).map(([k, v]) => `-D${k}=${v}`),
  ];
}

export function cmakeConfigure(source: string, buildDir: string, cache: Cache, env?: Record<string, string>): void {
  run(cmakeCommand(source, buildDir, cache), { env });
}

export function ninja(o: Options, buildDir: string, targets: string[], env?: Record<string, string>): void {
  run(["ninja", "-C", buildDir, `-j${o.jobs}`, ...targets], { env: { NINJA_STATUS: "[%f/%t %es] ", ...env } });
}

export function llvmCommit(o: Options): string {
  return run(["git", "rev-parse", "HEAD"], { cwd: o.llvmProject, capture: true, quiet: true }).trim();
}

/**
 * What decides how LLVM's sources are compiled, on every host. The build that records a profile
 * and the ones that use it have to agree on it.
 */
export const COMPILE_SETTINGS: Cache = {
  // Release.cmake
  CMAKE_BUILD_TYPE: "Release",
  CMAKE_POSITION_INDEPENDENT_CODE: "ON",
  LLVM_ENABLE_LTO: "Thin",
  // Upstream: every project and backend.
  LLVM_ENABLE_PROJECTS: "clang;lld",
  LLVM_TARGETS_TO_BUILD: "X86;AArch64",
  // As rustc's LLVM is built: reaching an llvm_unreachable traps instead of being undefined behavior.
  LLVM_UNREACHABLE_OPTIMIZE: "OFF",
  // No dlopen'd plugins: nothing has to stay exported from the executables, so ThinLTO can
  // internalize and inline across far more of clang and lld. Upstream: ON.
  CLANG_PLUGIN_SUPPORT: "OFF",
  LLVM_ENABLE_PLUGINS: "OFF",
  // clang and lld are built without exceptions (Chromium's clang build does the same). Upstream: ON.
  LLVM_ENABLE_UNWIND_TABLES: "OFF",
  LLVM_ENABLE_LIBEDIT: "OFF",
  LLVM_INCLUDE_TESTS: "OFF",
  LLVM_INCLUDE_BENCHMARKS: "OFF",
  LLVM_INCLUDE_EXAMPLES: "OFF",
};

/** COMPILE_SETTINGS for the machine this runs on. */
export function nativeCache(o: Options): Cache {
  const bin = (tool: string) => join(o.hostLlvm, "bin", tool);
  return {
    ...COMPILE_SETTINGS,
    CMAKE_C_COMPILER: bin("clang"),
    CMAKE_CXX_COMPILER: bin("clang++"),
    CMAKE_ASM_COMPILER: bin("clang"),
    LLVM_ENABLE_LLD: "ON",
    LLVM_PARALLEL_LINK_JOBS: String(Math.max(1, Math.floor(o.jobs / 8))),
    // Static, so that glibc and zlib are all a machine has to have.
    LLVM_STATIC_LINK_CXX_STDLIB: "ON",
    LLVM_ENABLE_ZLIB: "FORCE_ON",
    LLVM_ENABLE_ZSTD: "FORCE_ON",
    LLVM_USE_STATIC_ZSTD: "ON",
    ...(o.libxml2 === undefined
      ? { LLVM_ENABLE_LIBXML2: "OFF" }
      : {
          LLVM_ENABLE_LIBXML2: "FORCE_ON",
          LLVM_USE_STATIC_LIBXML2: "ON",
          LIBXML2_INCLUDE_DIR: join(o.libxml2, "include", "libxml2"),
          LIBXML2_LIBRARY: join(o.libxml2, "lib", "libxml2.a"),
          LIBXML2_STATIC_LIBRARY: join(o.libxml2, "lib", "libxml2.a"),
        }),
  };
}

interface Workload {
  name: string;
  cache: Cache;
  /** For the sources only, not for CMake's checks: those link. */
  compileOptions?: string;
  target: string;
}

/**
 * The first is upstream's (clang/utils/perf-training/llvm-support/build.test), which it runs for
 * the builder's architecture. It never emits debug info, compiles without optimization or links.
 */
const WORKLOADS: Workload[] = [
  { name: "release", cache: { CMAKE_BUILD_TYPE: "Release" }, target: "LLVMSupport" },
  {
    name: "debug",
    cache: { CMAKE_BUILD_TYPE: "Debug", CMAKE_DISABLE_PRECOMPILE_HEADERS: "ON" },
    compileOptions: "-fsanitize=address -isystem ${CMAKE_SOURCE_DIR}/../compiler-rt/include",
    target: "LLVMSupport",
  },
  { name: "lto", cache: { CMAKE_BUILD_TYPE: "RelWithDebInfo", LLVM_ENABLE_LTO: "Thin" }, target: "llvm-min-tblgen" },
];

/**
 * Configure each workload, for both architectures, to be built by the clang and lld in `bin`.
 * Returns what builds them. Two steps, so that CMake's checks can be kept out of a profile.
 */
export async function configureWorkloads(
  o: Options,
  bin: string,
  dir: string,
): Promise<(env: Record<string, string>) => Promise<void>> {
  remove(dir);
  const builds = [o.builderTriple, o.otherLinuxTriple].flatMap(triple =>
    WORKLOADS.map(w => {
      const name = `${w.name}-${triple.split("-")[0]}`;
      const options = join(dir, `${name}.cmake`);
      write(options, w.compileOptions === undefined ? "" : `add_compile_options(${w.compileOptions})\n`);
      const configure = cmakeCommand(join(o.llvmProject, "llvm"), join(dir, name), {
        ...w.cache,
        CMAKE_MESSAGE_LOG_LEVEL: "WARNING",
        CMAKE_PROJECT_INCLUDE: options,
        CMAKE_C_COMPILER: join(bin, "clang"),
        CMAKE_CXX_COMPILER: join(bin, "clang++"),
        CMAKE_AR: join(o.hostLlvm, "bin", "llvm-ar"),
        CMAKE_RANLIB: join(o.hostLlvm, "bin", "llvm-ranlib"),
        LLVM_USE_LINKER: "lld",
        LLVM_TARGETS_TO_BUILD: "",
        LLVM_INCLUDE_TESTS: "OFF",
        LLVM_INCLUDE_BENCHMARKS: "OFF",
        ...(triple === o.builderTriple
          ? {}
          : {
              CMAKE_SYSTEM_NAME: "Linux",
              CMAKE_SYSTEM_PROCESSOR: triple.split("-")[0]!,
              CMAKE_C_COMPILER_TARGET: triple,
              CMAKE_CXX_COMPILER_TARGET: triple,
              CMAKE_ASM_COMPILER_TARGET: triple,
              LLVM_HOST_TRIPLE: triple,
              LLVM_NATIVE_TOOL_DIR: join(o.hostLlvm, "bin"),
              LLVM_ENABLE_ZLIB: "OFF",
              LLVM_ENABLE_ZSTD: "OFF",
            }),
      });
      // None of them can keep all cores busy to the end.
      const build = ["ninja", "-C", join(dir, name), `-j${Math.ceil(o.jobs / 3)}`, "--quiet", w.target];
      return { configure, build };
    }),
  );
  await runConcurrently(
    builds.map(b => b.configure),
    { LLVM_PROFILE_FILE: "/dev/null" },
  );
  return env =>
    runConcurrently(
      builds.map(b => b.build),
      // lld returns from main instead of calling _exit, which would skip writing the profile.
      { ...env, LLD_IN_TEST: "1" },
    );
}

export async function recordProfile(o: Options): Promise<void> {
  const p = paths(o);
  const out = p.llvmProfile(o.builder);
  const key = `llvm-profile-${RECIPE_VERSION}-${llvmCommit(o)}`;
  if (isDone(out, key)) {
    console.log(`llvm profile: up to date (${key})`);
    return;
  }
  const build = join(p.llvmInstrumented, "build");
  const recorded = join(p.llvmInstrumented, "recorded");
  // The default of 1 runs out ("Unable to track new values"), which drops indirect call targets.
  const moreValueCounters = "-Xclang -mllvm -Xclang -vp-counters-per-site=8";
  const cache = {
    ...nativeCache(o),
    LLVM_BUILD_INSTRUMENTED: "IR",
    // Where what runs during the build (llvm-tblgen) writes; not part of the profile.
    LLVM_PROFILE_DATA_DIR: join(p.llvmInstrumented, "discarded"),
    CMAKE_C_FLAGS: moreValueCounters,
    CMAKE_CXX_FLAGS: moreValueCounters,
  };
  cmakeConfigure(join(o.llvmProject, "llvm"), build, cache);
  ninja(o, build, ["clang", "lld"]);

  const buildWorkloads = await configureWorkloads(o, join(build, "bin"), join(p.llvmInstrumented, "workloads"));
  remove(recorded);
  // a pool of that many files per binary, which processes merge into
  await buildWorkloads({ LLVM_PROFILE_FILE: join(recorded, "%9m.profraw") });

  remove(out);
  mkdir(out);
  run([
    join(o.hostLlvm, "bin", "llvm-profdata"),
    ...["merge", "-o", join(out, "clang.profdata")],
    // Leaves out the functions that never ran, which PGO would optimize for size: other code than
    // LLVM's does run them. Not upstream's; 2-3% off the time it takes to compile Bun's C++.
    "--sparse",
    ...readdirSync(recorded).map(f => join(recorded, f)),
  ]);
  write(
    join(out, "clang-profile.json"),
    JSON.stringify(
      { builder: o.builder, llvm: llvmCommit(o), source: o.llvmProject, cmake: cache, workloads: WORKLOADS },
      null,
      2,
    ) + "\n",
  );
  markDone(out, key);
}
