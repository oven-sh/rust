// Cross-compiling the toolchain itself for a host the pipeline cannot run (macOS, Windows) from
// a Linux builder: the CMake toolchain file LLVM is configured with, compiler/linker wrappers for
// rust's bootstrap (which wants plain `cc`-style commands per target), and the host's
// compiler-rt (what clang needs beside it to link ordinary programs on that host).
//
// Everything compiles with the builder's own LLVM (--host-llvm, built from the same
// src/llvm-project): clang --target=<host>, ld64.lld / lld-link, llvm-ar / llvm-lib, against the
// macOS SDK or the MSVC CRT + Windows SDK that Bun's own cross builds use.

import { chmodSync } from "node:fs";
import { join } from "node:path";
import { mkdir, write } from "./fs.ts";
import { type Options, paths } from "./options.ts";
import { run } from "./run.ts";
import { macosSdk, winSysroot } from "./sdks.ts";

export const MACOS_DEPLOYMENT_TARGET = "13.0";

export function isDarwin(o: Options): boolean {
  return o.host.startsWith("darwin-");
}
export function isWindows(o: Options): boolean {
  return o.host.startsWith("windows-");
}

/** clang's spelling of the host: arm64-apple-macos13.0, x86_64-pc-windows-msvc, … */
export function clangTarget(o: Options): string {
  if (isDarwin(o)) return `${o.host.endsWith("aarch64") ? "arm64" : "x86_64"}-apple-macos${MACOS_DEPLOYMENT_TARGET}`;
  return o.triple;
}

function tool(o: Options, name: string): string {
  return join(o.hostLlvm, "bin", name);
}

/** Flags every C/C++ compile and link for the host carries. */
function targetFlags(o: Options): string[] {
  if (isDarwin(o)) return [`--target=${clangTarget(o)}`, "-isysroot", macosSdk(o), `-mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}`];
  if (isWindows(o)) return [`--target=${clangTarget(o)}`, "-fuse-ld=lld", `/winsysroot`, winSysroot(o)];
  throw new Error(`not a cross host: ${o.host}`);
}

/**
 * Directory of wrapper executables named like a native toolchain for the host —
 * <triple>-clang, <triple>-clang++ (and on Windows <triple>-clang-cl, <triple>-lld-link) — for
 * consumers that take a compiler path but not its flags (rust's bootstrap, cc-rs, cmake's
 * compiler probes). Also `lipo`, which clang invokes by that bare name for multi-arch outputs.
 */
export function wrappers(o: Options): { dir: string; cc: string; cxx: string; linker: string; ar: string; ranlib: string } {
  const dir = join(paths(o).cross, "bin");
  mkdir(dir);
  const script = (name: string, argv: string[]) => {
    const file = join(dir, name);
    write(file, `#!/bin/sh\nexec ${argv.map(a => `'${a}'`).join(" ")} "$@"\n`);
    chmodSync(file, 0o755);
    return file;
  };
  script("lipo", [tool(o, "llvm-lipo")]);
  if (isDarwin(o)) {
    // -fuse-ld=lld matters when the wrapper links; on a compile it is unused, which clang would warn about.
    const flags = [...targetFlags(o), "-fuse-ld=lld", "-Wno-unused-command-line-argument"];
    const cc = script(`${o.triple}-clang`, [tool(o, "clang"), ...flags]);
    const cxx = script(`${o.triple}-clang++`, [tool(o, "clang++"), ...flags]);
    // autoconf builds in cargo build scripts (jemalloc's) look tools up as <triple>-<tool> and
    // otherwise fall back to the builder's binutils, which cannot read Mach-O: jemalloc derives
    // its private symbol names (je_zone_register among them) from `nm` over its own objects.
    for (const t of ["nm", "ar", "ranlib", "strip", "otool", "install_name_tool", "libtool"]) {
      script(`${o.triple}-${t}`, [tool(o, t === "libtool" ? "llvm-libtool-darwin" : t === "install_name_tool" ? "llvm-install-name-tool" : `llvm-${t}`)]);
    }
    return {
      dir,
      cc,
      cxx,
      // rustc picks the linker flavor from the file name: a *clang name gets cc-style arguments
      // (which the driver turns into ld64.lld ones); a *ld name would get raw ld64 arguments.
      linker: cc,
      ar: tool(o, "llvm-ar"),
      ranlib: tool(o, "llvm-ranlib"),
    };
  }
  // Windows: clang-cl for C and C++ (MSVC-style flags are what cc-rs and bootstrap pass for
  // *-msvc targets) and lld-link as the linker, both finding the CRT and SDK through /winsysroot.
  // CMake (rust's bootstrap configuring LLVM and LLD for this host) looks for the MSVC-style
  // binutils next to the compiler under their usual names, so they live here too; rustc reads the
  // linker flavor off the name (lld-link → MSVC-style arguments).
  const arch = o.host.endsWith("aarch64") ? "arm64" : "x64";
  const clangCl = script(`${o.triple}-clang-cl`, [tool(o, "clang-cl"), `--target=${clangTarget(o)}`, "/winsysroot", winSysroot(o), "-fuse-ld=lld", "-Wno-unused-command-line-argument"]);
  // LNK4099: the xwin sysroot has no PDBs for the CRT's own objects; links that treat warnings
  // as errors (rustc.exe's, for its manifest) would fail on that alone.
  const lldArgs = [tool(o, "lld-link"), `/winsysroot:${winSysroot(o)}`, `/machine:${arch}`, "/ignore:4099"];
  script("lld-link", lldArgs);
  // rustc's linker: from a name ending in "lld-link" it infers the multiplexed lld driver and
  // prepends `-flavor link`, which lld-link itself rejects; "<triple>-link" reads as a plain
  // MSVC-style linker (the target's default flavor), which is what this is.
  const lldLink = script(`${o.triple}-link`, lldArgs);
  for (const t of ["llvm-lib", "llvm-rc", "llvm-ml", "llvm-mt", "llvm-cvtres", "llvm-ranlib", "llvm-nm"]) script(t, [tool(o, t)]);
  // CMake's MASM support looks for ml64/ml (armasm64 on arm64) by name; llvm-ml is the drop-in.
  script(arch === "x64" ? "ml64" : "armasm64", [tool(o, "llvm-ml"), ...(arch === "x64" ? ["-m64"] : [])]);
  script("clang-cl", [tool(o, "clang-cl"), `--target=${clangTarget(o)}`, "/winsysroot", winSysroot(o), "-fuse-ld=lld", "-Wno-unused-command-line-argument"]);
  return { dir, cc: clangCl, cxx: clangCl, linker: lldLink, ar: join(dir, "llvm-lib"), ranlib: join(dir, "llvm-ranlib") };
}

/** The CMake toolchain file LLVM and compiler-rt are configured with for the host. */
export function cmakeToolchainFile(o: Options): string {
  const p = paths(o);
  mkdir(p.cross);
  const file = join(p.cross, `${o.host}.cmake`);
  const set = (k: string, v: string, cache = "") => `set(${k} "${v}"${cache})`;
  const lines: string[] = [];
  if (isDarwin(o)) {
    lines.push(
      set("CMAKE_SYSTEM_NAME", "Darwin"),
      set("CMAKE_SYSTEM_PROCESSOR", o.host.endsWith("aarch64") ? "arm64" : "x86_64"),
      set("CMAKE_OSX_SYSROOT", macosSdk(o)),
      // find_package/find_library look in the SDK, never at the builder's /usr (libxml2, zlib are
      // .tbd stubs of macOS system libraries there); the builder's pkg-config is kept out of it.
      set("CMAKE_FIND_ROOT_PATH", macosSdk(o)),
      `set(ENV{PKG_CONFIG_LIBDIR} "${join(macosSdk(o), "usr", "lib", "pkgconfig")}")`,
      set("CMAKE_OSX_ARCHITECTURES", o.host.endsWith("aarch64") ? "arm64" : "x86_64"),
      set("CMAKE_OSX_DEPLOYMENT_TARGET", MACOS_DEPLOYMENT_TARGET),
      set("CMAKE_C_COMPILER", tool(o, "clang")),
      set("CMAKE_CXX_COMPILER", tool(o, "clang++")),
      set("CMAKE_ASM_COMPILER", tool(o, "clang")),
      ...["C", "CXX", "ASM"].map(l => set(`CMAKE_${l}_COMPILER_TARGET`, clangTarget(o))),
      set("CMAKE_LINKER", tool(o, "ld64.lld")),
      ...["EXE", "SHARED", "MODULE"].map(k => set(`CMAKE_${k}_LINKER_FLAGS_INIT`, "-fuse-ld=lld")),
      set("CMAKE_LIBTOOL", tool(o, "llvm-libtool-darwin"), " CACHE FILEPATH \"\""),
      set("CMAKE_INSTALL_NAME_TOOL", tool(o, "llvm-install-name-tool"), " CACHE FILEPATH \"\""),
      set("CMAKE_LIPO", tool(o, "llvm-lipo"), " CACHE FILEPATH \"\""),
    );
  } else if (isWindows(o)) {
    // llvm/cmake/platforms/WinMsvc.cmake is LLVM's own recipe for exactly this (clang-cl +
    // lld-link + a /winsysroot-style MSVC/SDK tree on a non-Windows build machine).
    lines.push(
      set("LLVM_NATIVE_TOOLCHAIN", o.hostLlvm),
      set("LLVM_WINSYSROOT", winSysroot(o)),
      set("HOST_ARCH", o.host.endsWith("aarch64") ? "aarch64" : "x86_64"),
      `include("${join(o.llvmProject, "llvm", "cmake", "platforms", "WinMsvc.cmake")}")`,
    );
  } else {
    throw new Error(`not a cross host: ${o.host}`);
  }
  lines.push(
    ...(isWindows(o) ? [] : [set("CMAKE_AR", tool(o, "llvm-ar"), " CACHE FILEPATH \"\"")]), // WinMsvc.cmake sets llvm-lib
    set("CMAKE_RANLIB", tool(o, "llvm-ranlib"), " CACHE FILEPATH \"\""),
    set("CMAKE_STRIP", tool(o, "llvm-strip"), " CACHE FILEPATH \"\""),
    "set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)",
    "set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)",
    "set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)",
    "set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)",
  );
  write(file, lines.join("\n") + "\n");
  return file;
}

/**
 * compiler-rt for the host, installed into <install>/lib/clang/<version>: the builtins archive
 * clang links into every program (libclang_rt.osx.a / clang_rt.builtins-<arch>.lib) and the
 * profile runtime (-fprofile-instr-generate, coverage). A standalone compiler-rt configure, as
 * LLVM's runtimes build would do natively; on macOS both architectures go into one universal
 * archive, the way Apple's and Homebrew's clang ship it.
 */
export function buildHostCompilerRt(o: Options, llvmBuildDir: string, install: string): void {
  const p = paths(o);
  const buildDir = join(p.cross, "compiler-rt");
  const clangVersion = run([tool(o, "llvm-config"), "--version"], { capture: true }).trim().split(".")[0]!;
  const resourceDir = join(install, "lib", "clang", clangVersion);
  const cache: Record<string, string> = {
    CMAKE_TOOLCHAIN_FILE: cmakeToolchainFile(o),
    CMAKE_BUILD_TYPE: "Release",
    COMPILER_RT_STANDALONE_BUILD: "ON",
    LLVM_CMAKE_DIR: join(llvmBuildDir, "lib", "cmake", "llvm"),
    CMAKE_C_COMPILER_WORKS: "ON",
    CMAKE_CXX_COMPILER_WORKS: "ON",
    COMPILER_RT_BUILD_BUILTINS: "ON",
    COMPILER_RT_BUILD_PROFILE: "ON",
    COMPILER_RT_BUILD_SANITIZERS: "OFF",
    COMPILER_RT_BUILD_XRAY: "OFF",
    COMPILER_RT_BUILD_LIBFUZZER: "OFF",
    COMPILER_RT_BUILD_MEMPROF: "OFF",
    COMPILER_RT_BUILD_ORC: "OFF",
    COMPILER_RT_BUILD_GWP_ASAN: "OFF",
    COMPILER_RT_BUILD_CTX_PROFILE: "OFF",
    COMPILER_RT_INSTALL_PATH: resourceDir,
    // One target, stated (as LLVM's runtimes build configures it): compiler-rt then skips its
    // multi-arch probing, whose GCC-style -march= test flags clang-cl does not take for assembly.
    ...(isWindows(o)
      ? { CMAKE_MSVC_RUNTIME_LIBRARY: "MultiThreaded", COMPILER_RT_DEFAULT_TARGET_ONLY: "ON", CMAKE_C_COMPILER_TARGET: clangTarget(o), CMAKE_CXX_COMPILER_TARGET: clangTarget(o), CMAKE_ASM_COMPILER_TARGET: clangTarget(o) }
      : {}),
  };
  if (isDarwin(o)) {
    // compiler-rt's Darwin CMake asks xcrun/xcodebuild for SDKs and their versions; answer for it.
    const sdkVersion = /MacOSX([0-9.]+)\.sdk/.exec(macosSdk(o))?.[1] ?? "";
    Object.assign(cache, {
      COMPILER_RT_ENABLE_IOS: "OFF",
      COMPILER_RT_ENABLE_WATCHOS: "OFF",
      COMPILER_RT_ENABLE_TVOS: "OFF",
      COMPILER_RT_ENABLE_XROS: "OFF",
      COMPILER_RT_ENABLE_MACCATALYST: "OFF",
      DARWIN_osx_ARCHS: "arm64;x86_64",
      DARWIN_osx_BUILTIN_ARCHS: "arm64;x86_64",
      DARWIN_osx_SYSROOT: macosSdk(o),
      DARWIN_macosx_CACHED_SYSROOT: macosSdk(o),
      DARWIN_macosx_OVERRIDE_SDK_VERSION: sdkVersion,
    });
  }
  run(["cmake", "-G", "Ninja", "-S", join(o.llvmProject, "compiler-rt"), "-B", buildDir, ...Object.entries(cache).map(([k, v]) => `-D${k}=${v}`)], {
    env: { PATH: `${wrappers(o).dir}:${process.env.PATH}` },
  });
  run(["ninja", "-C", buildDir, `-j${o.jobs}`, "install"], { env: { PATH: `${wrappers(o).dir}:${process.env.PATH}` } });
}
