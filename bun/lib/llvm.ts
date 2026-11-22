// clang + lld: the final stage of clang/cmake/caches/Release.cmake (PGO + ThinLTO, then BOLT on
// Linux), compiled by the host clang with the profile of lib/llvm-profile.ts. Only the pieces Bun
// uses are built and installed.

import { cpSync, lstatSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildHostCompilerRt, cmakeToolchainFile, isDarwin, isWindows, wrappers } from "./cross.ts";
import { exists, inputsKey, isDone, markDone, mkdir, read, remove, sha256, write } from "./fs.ts";
import { profileOf } from "./hosts.ts";
import {
  type Cache,
  cmakeConfigure,
  COMPILE_SETTINGS,
  configureWorkloads,
  llvmCommit,
  nativeCache,
  ninja,
} from "./llvm-profile.ts";
import { type Options, paths, RECIPE_VERSION } from "./options.ts";
import { run, runConcurrently } from "./run.ts";

/**
 * LLVM install components. clang and lld's other names (clang++, clang-cl, ld.lld, ld64.lld,
 * lld-link, …) install with them.
 */
function components(o: Options): string[] {
  const hasLibxml2 = isDarwin(o) || (!o.cross && o.libxml2 !== undefined);
  return [
    ...["clang", "clang-format", "clang-resource-headers", "lld"],
    // Every binutils-style tool a Bun build (any target, incl. the Mach-O and PE/COFF steps) or a
    // developer inspecting its output reaches for, so nothing falls back to a system LLVM.
    ...["llvm-ar", "llvm-ranlib", "llvm-lib", "llvm-dlltool", "llvm-nm", "llvm-strings", "llvm-size"],
    ...["llvm-objcopy", "llvm-strip", "llvm-install-name-tool", "llvm-bitcode-strip"],
    ...["llvm-objdump", "llvm-otool", "llvm-readobj", "llvm-readelf", "llvm-dwarfdump", "llvm-pdbutil"],
    ...["llvm-cxxfilt", "llvm-undname", "llvm-symbolizer", "llvm-addr2line"],
    ...["llvm-lipo", "llvm-libtool-darwin", "dsymutil"],
    ...["llvm-rc", "llvm-windres", "llvm-ml", "llvm-cvtres", ...(hasLibxml2 ? ["llvm-mt"] : [])],
    ...["llvm-profdata", "llvm-cov", "llvm-config"],
    // libLTO.dylib: what Apple's linker reads bitcode with; clang hands it the one next to itself.
    ...(isDarwin(o) ? ["LTO"] : []),
    // compiler-rt, built by the clang that was just built. Where that cannot run: buildHostCompilerRt.
    ...(o.cross ? [] : ["builtins", "runtimes"]),
  ];
}

export function profileDir(o: Options): string | undefined {
  const builder = profileOf(o.host);
  return builder === undefined ? undefined : paths(o).llvmProfile(builder);
}

/** Upstream: Linux. BOLT only knows ELF. */
export function boltsLlvm(o: Options): boolean {
  return o.bolt && !o.cross;
}

function nativeFinalCache(o: Options): Cache {
  const other = o.otherLinuxTriple;
  return {
    ...nativeCache(o),
    CMAKE_EXE_LINKER_FLAGS: [
      // Release.cmake's RELEASE_LINKER_FLAGS: what BOLT needs from the link.
      "-Wl,--emit-relocs,-znow",
      // Identical code folding (Android's clang: safe; rustc: all). -fuse-ld=lld spelled out because
      // CMake's compiler check links with these flags before LLVM_ENABLE_LLD applies.
      "-fuse-ld=lld -Wl,--icf=safe",
      // mimalloc instead of glibc malloc: a ThinLTO link runs LLVM's optimizer on every core at
      // once. It uses pthread_key_*, which glibc < 2.34 keeps in libpthread.
      ...(o.mimalloc === undefined ? [] : ["-pthread", o.mimalloc]),
    ].join(" "),
    LLVM_ENABLE_RUNTIMES: "compiler-rt",
    // For the other architecture too, against the image's cross gcc and libc. Upstream: native only.
    LLVM_BUILTIN_TARGETS: `default;${other}`,
    LLVM_RUNTIME_TARGETS: `default;${other}`,
    [`BUILTINS_${other}_CMAKE_SYSTEM_NAME`]: "Linux",
    [`RUNTIMES_${other}_CMAKE_SYSTEM_NAME`]: "Linux",
    [`RUNTIMES_${other}_LLVM_ENABLE_RUNTIMES`]: "compiler-rt",
  };
}

function crossFinalCache(o: Options): Cache {
  const bin = (tool: string) => join(o.hostLlvm, "bin", tool);
  return {
    ...COMPILE_SETTINGS,
    CMAKE_TOOLCHAIN_FILE: cmakeToolchainFile(o),
    LLVM_HOST_TRIPLE: o.triple,
    LLVM_DEFAULT_TARGET_TRIPLE: o.triple,
    LLVM_PARALLEL_LINK_JOBS: String(Math.max(1, Math.floor(o.jobs / 8))),
    // llvm-tblgen and clang-tblgen run during the build. They are built from this tree for the
    // builder: the host LLVM's would not have our patches.
    CROSS_TOOLCHAIN_FLAGS_NATIVE: `-DCMAKE_C_COMPILER=${bin("clang")};-DCMAKE_CXX_COMPILER=${bin("clang++")};-DCMAKE_ASM_COMPILER=${bin("clang")}`,
    // zlib and libxml2 are system libraries on macOS, in the SDK; Windows has neither.
    LLVM_ENABLE_ZLIB: isWindows(o) ? "OFF" : "FORCE_ON",
    LLVM_ENABLE_ZSTD: "OFF",
    LLVM_ENABLE_LIBXML2: isWindows(o) ? "OFF" : "FORCE_ON",
    // What clang takes Apple's linker to support; a native build asks the one it finds. Unset,
    // clang does not hand it libLTO.dylib. Xcode 15.0's.
    ...(isDarwin(o) ? { HOST_LINK_VERSION: "1015.7" } : {}),
    // What LLVM's own Windows release does: real copies rather than symlinks for
    // clang++/clang-cl/lld-link/… (lib/package.ts hardlinks the identical files), and the static
    // MSVC runtime so nothing depends on the VC++ redistributable.
    ...(isWindows(o) ? { LLVM_USE_SYMLINKS: "OFF", CMAKE_MSVC_RUNTIME_LIBRARY: "MultiThreaded" } : {}),
  };
}

export function finalCache(o: Options): Cache {
  const profile = profileDir(o);
  return {
    ...(o.cross ? crossFinalCache(o) : nativeFinalCache(o)),
    ...(profile === undefined ? {} : { LLVM_PROFDATA_FILE: join(profile, "clang.profdata") }),
    LLVM_DISTRIBUTION_COMPONENTS: components(o).join(";"),
    CMAKE_INSTALL_PREFIX: paths(o).llvmInstall,
  };
}

export async function buildLlvm(o: Options): Promise<void> {
  const p = paths(o);
  const cache = finalCache(o);
  const profdata = cache.LLVM_PROFDATA_FILE;
  // CMake only warns
  if (profdata !== undefined && !exists(profdata)) {
    throw new Error(`${profdata} does not exist: \`toolchain.ts llvm-profile\` on ${profileOf(o.host)} records it`);
  }
  if (profdata !== undefined) {
    const { source } = JSON.parse(read(join(dirname(profdata), "clang-profile.json")));
    if (source !== o.llvmProject) {
      throw new Error(`${profdata} names file-local functions by their path under ${source}, not ${o.llvmProject}`);
    }
  }
  if (!o.cross && o.mimalloc !== undefined && !exists(o.mimalloc)) {
    throw new Error(
      `${o.mimalloc} does not exist (bun/Dockerfile builds it; --mimalloc=none keeps the libc allocator)`,
    );
  }
  const settings = JSON.stringify([RECIPE_VERSION, cache, profdata && sha256(profdata)]);
  const key = `llvm-${inputsKey(o.llvmProject, settings, boltsLlvm(o))}`;
  if (isDone(p.llvmInstall, key)) {
    console.log(`llvm: up to date (${key})`);
    return;
  }

  remove(p.llvmInstall);
  const build = join(p.llvmBuild, "build");
  // ninja does not see the profile change, and CMake remembers a setting that is no longer given.
  if (!isDone(p.llvmBuild, settings)) remove(p.llvmBuild);
  markDone(p.llvmBuild, settings);
  const env = o.cross ? { PATH: `${wrappers(o).dir}:${process.env.PATH}` } : undefined;
  cmakeConfigure(join(o.llvmProject, "llvm"), build, cache, env);
  ninja(o, build, ["install-distribution"], env);
  if (o.cross) buildHostCompilerRt(o, build);
  if (boltsLlvm(o)) await bolt(o);
  if (!o.cross) strip(o);

  const licenses: Record<string, string | undefined> = {
    "LLVM-LICENSE.TXT": join(o.llvmProject, "llvm", "LICENSE.TXT"),
    "clang-LICENSE.TXT": join(o.llvmProject, "clang", "LICENSE.TXT"),
    "lld-LICENSE.TXT": join(o.llvmProject, "lld", "LICENSE.TXT"),
    "compiler-rt-LICENSE.TXT": join(o.llvmProject, "compiler-rt", "LICENSE.TXT"),
    // where bun/Dockerfile puts them
    "mimalloc-LICENSE": o.cross ? undefined : o.mimalloc && join(dirname(o.mimalloc), "LICENSE"),
    "libxml2-LICENSE": o.cross ? undefined : o.libxml2 && join(o.libxml2, "LICENSE"),
  };
  for (const [name, src] of Object.entries(licenses)) {
    if (src !== undefined && exists(src)) cpSync(src, join(p.llvmInstall, "licenses", name));
  }
  write(join(p.llvmInstall, "llvm-project.rev"), llvmCommit(o) + "\n");
  markDone(p.llvmInstall, key);
}

/** The files behind all of clang's and lld's names. */
function clangAndLld(bin: string): string[] {
  const clang = readdirSync(bin).find(f => /^clang-\d+$/.test(f));
  if (clang === undefined) throw new Error(`no clang-<major> binary in ${bin}`);
  return [clang, "lld"];
}

/**
 * clang/utils/perf-training/perf-helper.py bolt-optimize --method INSTRUMENT, which Release.cmake
 * runs on clang. Unlike a PGO profile, BOLT's describes one binary, so it is recorded every time.
 */
async function bolt(o: Options): Promise<void> {
  const bin = join(paths(o).llvmInstall, "bin");
  const work = join(paths(o).llvmBuild, "bolt");
  const llvmBolt = join(o.hostLlvm, "bin", "llvm-bolt");
  const targets = clangAndLld(bin);
  remove(work);
  const buildWorkloads = await configureWorkloads(o, bin, join(work, "workloads"));

  const before = (name: string) => join(work, `${name}.prebolt`);
  for (const name of targets) renameSync(join(bin, name), before(name));
  await runConcurrently(
    targets.map(name => [
      ...[llvmBolt, before(name), "-o", join(bin, name)],
      "-instrument",
      "--instrumentation-file-append-pid",
      `--instrumentation-file=${join(mkdir(join(work, name)), "prof.fdata")}`,
    ]),
  );
  await buildWorkloads({});

  const merged = (name: string) => join(work, `${name}.fdata`);
  await runConcurrently(
    targets.map(name => {
      const recorded = readdirSync(join(work, name)).map(f => join(work, name, f));
      if (recorded.length === 0) throw new Error(`BOLT: ${name} recorded nothing`);
      return [join(o.hostLlvm, "bin", "merge-fdata"), ...recorded, "-o", merged(name)];
    }),
  );
  await runConcurrently(
    targets.map(name => [
      ...[llvmBolt, before(name), "-o", join(bin, name), "-data", merged(name)],
      "-reorder-blocks=ext-tsp",
      "-reorder-functions=cdsort",
      "-split-functions",
      "-split-all-cold",
      "-split-eh",
      "-dyno-stats",
      "-use-gnu-stack",
      "-update-debug-sections",
    ]),
  );
  for (const name of targets) remove(join(work, name));
}

/** clang and lld keep their symbols, for the backtrace of a crash. */
function strip(o: Options): void {
  const bin = join(paths(o).llvmInstall, "bin");
  const keep = [...clangAndLld(bin), "git-clang-format"]; // the last is a script
  const files = readdirSync(bin).filter(f => !keep.includes(f) && lstatSync(join(bin, f)).isFile());
  run([join(o.hostLlvm, "bin", "llvm-strip"), ...files], { cwd: bin });
}
