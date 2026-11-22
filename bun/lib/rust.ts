// rustc and its tools.
//
// On Linux, what rust-lang's dist-x86_64-linux / dist-aarch64-linux jobs build for rustup: their
// configuration, optimized with the profiles they recorded (lib/upstream.ts). That is the last
// stage of src/tools/opt-dist, without the instrumented builds and benchmark runs before it.
// For the other hosts, a cross-compiled dist.

import { copyFileSync, cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isDarwin, isWindows, MACOS_DEPLOYMENT_TARGET, wrappers } from "./cross.ts";
import { exists, inputsKey, isDone, markDone, mkdir, read, remove, sha256 } from "./fs.ts";
import { type Options, paths, RECIPE_VERSION } from "./options.ts";
import { run, runConcurrently } from "./run.ts";
import { hostSdk } from "./sdks.ts";
import * as upstream from "./upstream.ts";

/**
 * The components of rust-toolchain.toml in oven-sh/bun, on top of rustc and std (and cargo, which
 * is upstream's). miri is not cross-compiled; llvm-tools are also in the LLVM half.
 */
export function components(o: Options): string[] {
  return ["rustc", "rust-std", "rust-src", "rustfmt", "clippy", ...(o.cross ? [] : ["miri", "llvm-tools"])];
}

/**
 * `build.tools`; unset, it means all of them. rustdoc is the one that depends on psm, whose GAS
 * fallback clang-cl cannot assemble for aarch64-pc-windows-msvc.
 */
function tools(o: Options): string[] {
  return [
    "clippy",
    "rustfmt",
    "rust-analyzer-proc-macro-srv",
    ...(o.host === "windows-aarch64" ? [] : ["rustdoc"]),
    ...(o.cross ? [] : ["miri", "cargo-miri"]),
  ];
}

/** Upstream: x86_64 only ("FIXME: Enable bolt for aarch64 once it's fixed upstream", src/tools/opt-dist/src/main.rs). */
export function boltsRust(o: Options): boolean {
  return o.bolt && o.host === "linux-x64";
}

const set = (settings: Record<string, string>) => Object.entries(settings).flatMap(([k, v]) => ["--set", `${k}=${v}`]);

/** What every host's configuration has. Only the first two change what a binary does. */
function commonSettings(o: Options): Record<string, string> {
  return {
    // Only the backends Bun targets (upstream: all of them).
    "llvm.targets": "AArch64;X86",
    "llvm.experimental-targets": "",
    "llvm.ninja": "true",
    "rust.codegen-backends": "llvm",
    "rust.llvm-bitcode-linker": "false",
    "build.tools": tools(o).join(","),
    "build.docs": "false",
    "build.build-dir": join(paths(o).rustBuild, "build"),
    // The tarballs are unpacked again right away.
    "dist.compression-profile": "fast",
    // Upstream gets these from the Docker image's environment.
    [`target.${o.builderTriple}.cc`]: join(o.hostLlvm, "bin", "clang"),
    [`target.${o.builderTriple}.cxx`]: join(o.hostLlvm, "bin", "clang++"),
    [`target.${o.builderTriple}.linker`]: join(o.hostLlvm, "bin", "clang"),
    [`target.${o.builderTriple}.ar`]: join(o.hostLlvm, "bin", "llvm-ar"),
    [`target.${o.builderTriple}.ranlib`]: join(o.hostLlvm, "bin", "llvm-ranlib"),
  };
}

/**
 * Upstream's arguments with commonSettings() in place of theirs. A setting that reaches cargo as a
 * profile setting or a feature of the compiler's crates cannot be changed here: it is part of
 * every symbol's name, and the profiles would not apply (checkProfileApplies).
 */
function nativeConfigureArgs(o: Options): string[] {
  const ours = commonSettings(o);
  const dropped = [
    "--enable-sccache", // upstream's cache, on S3
    "--enable-compiler-docs",
    "--disable-manage-submodules", // upstream's CI clones all of them first; bootstrap fetches the ones it needs
    "llvm.offload-clang-dir", // for the offload component
  ];
  const theirs = upstream.configureArgs(o, o.triple);
  const kept: string[] = [];
  for (let i = 0; i < theirs.length; i++) {
    const arg = theirs[i] === "--set" ? [theirs[i]!, theirs[++i]!] : [theirs[i]!];
    const key = arg.at(-1)!.split("=")[0]!;
    if (!dropped.includes(key) && !(key in ours)) kept.push(...arg);
  }
  return [...kept, ...set(ours)];
}

/**
 * Upstream's dist configuration for the host as far as it applies off-host, with the compiler
 * built here (build = this machine) for --host/--target = the toolchain's host, C/C++ parts
 * compiled and linked by lib/cross.ts's wrappers. No PGO: upstream has profiles for
 * x86_64-pc-windows-msvc only, and cargo names the crates of a cross build differently.
 */
function crossConfigureArgs(o: Options): string[] {
  const w = wrappers(o);
  const t = o.triple;
  return [
    `--build=${o.builderTriple}`,
    `--host=${t}`,
    `--target=${t}`,
    "--release-channel=nightly",
    "--enable-locked-deps",
    "--dist-compression-formats=xz",
    ...set({
      ...commonSettings(o),
      [`target.${t}.cc`]: w.cc,
      [`target.${t}.cxx`]: w.cxx,
      [`target.${t}.linker`]: w.linker,
      [`target.${t}.ar`]: w.ar,
      [`target.${t}.ranlib`]: w.ranlib,
      ...(isWindows(o)
        ? { "llvm.build-config.CMAKE_ASM_MASM_COMPILER": join(w.dir, o.host.endsWith("aarch64") ? "armasm64" : "ml64") }
        : // As upstream's dist for the host: ThinLTO across rustc_driver and jemalloc on macOS
          // (dist-aarch64-apple), neither on Windows (dist-x86_64-msvc; statics behind the DLL
          // boundary do not survive dylib LTO there).
          { "rust.lto": "thin", "build.allocator": "jemalloc" }),
      "llvm.download-ci-llvm": "false",
      "llvm.link-shared": "false",
      "llvm.static-libstdcpp": "false",
      "rust.lld": "true",
      // rustc itself shells out to rust-objcopy from its sysroot (stripping, on Apple targets), so
      // the LLVM tools have to be staged even though the llvm-tools component is not shipped.
      "rust.llvm-tools": "true",
      "rust.codegen-units": "1",
      "build.extended": "true",
      "build.optimized-compiler-builtins": "true",
      "build.print-step-timings": "true",
    }),
  ];
}

export function configureArgs(o: Options): string[] {
  return o.cross ? crossConfigureArgs(o) : nativeConfigureArgs(o);
}

function crossEnv(o: Options): Record<string, string> {
  const w = wrappers(o);
  const t = o.triple.replaceAll("-", "_");
  return {
    // The host's binutils under their conventional names, for the CMake and cc-rs invocations
    // bootstrap makes that look tools up by name.
    PATH: `${w.dir}:${process.env.PATH}`,
    // cc-rs: where the SDK is (it would ask xcrun).
    ...(isDarwin(o) ? { SDKROOT: hostSdk(), MACOSX_DEPLOYMENT_TARGET: MACOS_DEPLOYMENT_TARGET } : {}),
    ...(isWindows(o)
      ? {
          // bootstrap exports CC_<triple> to build scripts for every target but *-msvc (there it
          // expects cc-rs to find Visual Studio on the machine).
          [`CC_${t}`]: w.cc,
          [`CXX_${t}`]: w.cxx,
          [`AR_${t}`]: w.ar,
          // rustc_driver/rustc embed a version resource; their build script wants rc.exe (compiler/rustc_windows_rc).
          RUSTC_WINDOWS_RC: join(w.dir, "llvm-rc"),
          // The host's LLVM only (bootstrap reads LDFLAGS_<triple> per cmake target): CMake's MSVC
          // link step runs mt to embed a manifest unless told not to — the same switch, for the
          // same reason, as LLVM's WinMsvc.cmake: there is no mt here, and CMake before 3.31 does
          // not look for llvm-mt.
          [`LDFLAGS_${t}`]: "/manifest:no",
        }
      : {}),
  };
}

export async function buildRust(o: Options): Promise<void> {
  const p = paths(o);
  checkCheckout(o);
  const llvm = inputsKey(join(o.checkout, "src", "llvm-project"));
  const key = `rust-${inputsKey(o.checkout, RECIPE_VERSION, llvm, configureArgs(o), boltsRust(o))}`;
  if (isDone(p.rustInstall, key)) {
    console.log(`rust: up to date (${key})`);
    return;
  }

  mkdir(p.rustBuild);
  const env: Record<string, string> = {
    RUST_BOOTSTRAP_CONFIG: join(p.rustBuild, "bootstrap.toml"),
    ...(o.cross ? crossEnv(o) : {}),
  };
  // configure writes bootstrap.toml into the cwd and refuses to overwrite one
  remove(env.RUST_BOOTSTRAP_CONFIG!);
  run([join(o.checkout, "configure"), ...configureArgs(o)], { cwd: p.rustBuild, env });
  const x = (command: string, ...args: string[]) =>
    run(["python3", join(o.checkout, "x.py"), command, "--host", o.triple, "--target", o.triple, ...args], {
      cwd: p.rustBuild,
      env,
    });

  let bolting: ReturnType<typeof bolt> | undefined;
  if (o.cross) {
    x("dist", ...components(o));
  } else {
    checkHostGcc(o);
    // A symbol's name has a hash of the version of the compiler that compiled it, commit included.
    // This is what is hashed in place of that; `rustc -V` and crate metadata keep the real one.
    env.RUSTC_FORCE_RUSTC_VERSION = upstream.version(o, o.triple);
    const pgo = (["rustc", "rustdoc", "clippy", "llvm"] as const).flatMap(what => [
      "--set",
      `pgo.${what}.use="${upstream.profile(o, o.triple, `${what}-pgo`)}"`,
    ]);
    // opt-dist's with_llvm_bolt_ldflags and with_rustc_bolt_ldflags: keep the relocations
    const boltable = boltsRust(o) ? ["--set", "llvm.ldflags=-Wl,-q", "--enable-bolt-settings"] : [];
    x("build", "--stage", "2", "library/std", ...pgo, ...boltable);
    const lib = join(p.rustBuild, "build", o.triple, "stage2", "lib");
    checkProfileApplies(o, find(lib, /^librustc_driver-.*\.so$/));
    // Ten minutes on few cores, as is building the tools.
    if (boltsRust(o)) bolting = bolt(o, lib);
    x("dist", ...components(o), ...pgo, ...boltable, "--keep-stage", "0", "--keep-stage", "1");
  }

  install(o);
  for (const [before, after] of (await bolting) ?? []) {
    const copies = readdirSync(p.rustInstall, { recursive: true, encoding: "utf8" })
      .map(f => join(p.rustInstall, f))
      .filter(f => basename(f) === basename(before));
    if (copies.length === 0 || copies.some(f => sha256(f) !== sha256(before)))
      throw new Error(`dist packaged another ${basename(before)} than the one that was BOLTed`);
    for (const f of copies) writeFileSync(f, readFileSync(after));
  }
  markDone(p.rustInstall, key);
}

function find(dir: string, name: RegExp): string {
  const found = readdirSync(dir).filter(f => name.test(f));
  if (found.length !== 1) throw new Error(`expected one ${name} in ${dir}, found ${found.join(", ") || "none"}`);
  return join(dir, found[0]!);
}

function checkCheckout(o: Options): void {
  if (!o.cross && o.checkout !== "/checkout") {
    throw new Error(
      `upstream's profile of LLVM names file-local functions by their path under /checkout (bun/in-container.sh)`,
    );
  }
  const rev = (cwd: string, name: string) =>
    run(["git", "rev-parse", name], { cwd, capture: true, quiet: true }).trim();
  const [wanted, found] = [
    rev(o.checkout, "HEAD:src/llvm-project"),
    rev(join(o.checkout, "src", "llvm-project"), "HEAD"),
  ];
  if (wanted !== found) {
    throw new Error(
      `src/llvm-project is at ${found}; bootstrap would check out ${wanted}, the commit HEAD points it to`,
    );
  }
}

/** bun/Dockerfile says why the versions have to be the same. */
function checkHostGcc(o: Options): void {
  const arch = o.triple.split("-")[0];
  const dockerfile = join(o.checkout, "src", "ci", "docker", `host-${arch}`, `dist-${arch}-linux`, "Dockerfile");
  const theirs = read(dockerfile).match(/^ENV GCC_VERSION=(\S+)$/m)?.[1];
  const libgcc = run([join(o.hostLlvm, "bin", "clang"), "-print-libgcc-file-name"], { capture: true, quiet: true });
  const ours = libgcc.trim().split("/").at(-2);
  if (ours !== theirs) {
    throw new Error(
      `the host clang uses the libstdc++ of GCC ${ours}, and upstream's profile of LLVM needs ${theirs}'s (ARG GCC in bun/Dockerfile)`,
    );
  }
}

/** rustc says nothing when no function of a crate is in the profile it was given. */
function checkProfileApplies(o: Options, librustcDriver: string): void {
  const bin = (tool: string) => join(o.hostLlvm, "bin", tool);
  // Not the rustc_* crates of crates.io: the profile is cargo's too, which has its own builds of them.
  const inTree = new Set(readdirSync(join(o.checkout, "compiler")));
  const compilerCrates = (symbols: string) => {
    const crates = new Set<string>();
    // v0 mangling: C s<hash>_ <length> <name>
    for (const [, prefix, length, rest] of symbols.matchAll(/(Cs[0-9A-Za-z]+_(\d+))(rustc_\w+)/g)) {
      const name = rest!.slice(0, Number(length));
      if (inTree.has(name)) crates.add(prefix! + name);
    }
    return crates;
  };
  const hot = run([bin("llvm-profdata"), "show", "--topn=2000", upstream.profile(o, o.triple, "rustc-pgo")], {
    capture: true,
    quiet: true,
  });
  const profiled = compilerCrates(hot);
  const built = compilerCrates(run([bin("llvm-nm"), librustcDriver], { capture: true, quiet: true }));
  const missing = [...profiled].filter(c => !built.has(c));
  if (profiled.size === 0 || missing.length > 0) {
    throw new Error(
      `upstream's profile of rustc does not apply to this build: ${missing.length} of the ${profiled.size} crates it names are named differently here (${missing.slice(0, 3).join(", ")}). ` +
        `Is NIGHTLY (bun/lib/upstream.ts) the nightly this branch is based on? A change to a crate's dependencies or features renames it and everything that depends on it.`,
    );
  }
  console.log(`upstream's profile of rustc applies: all ${profiled.size} crates are named alike`);
}

/** opt-dist's bolt_optimize. Returns [a copy of the library as it was, the optimized library]. */
async function bolt(o: Options, lib: string): Promise<[string, string][]> {
  const dir = join(paths(o).rustBuild, "bolt");
  remove(dir);
  const inputs = (
    [
      [find(lib, /^libLLVM\.so\./), "LLVM-bolt"],
      [find(lib, /^librustc_driver-.*\.so$/), "rustc-bolt"],
    ] as const
  ).map(([file, profile]) => {
    const before = join(mkdir(dir), basename(file));
    copyFileSync(file, before);
    return { before, after: `${before}.bolt`, profile: upstream.profile(o, o.triple, profile) };
  });
  await runConcurrently(
    inputs.map(({ before, after, profile }) => [
      join(o.hostLlvm, "bin", "llvm-bolt"),
      ...[before, "-data", profile, "-o", after],
      "-reorder-blocks=ext-tsp",
      "-reorder-functions=cdsort",
      "-split-functions",
      "-split-strategy=cdsplit",
      "-split-all-cold",
      "-jump-tables=move",
      "-icf=all",
      "-update-debug-sections",
      "-dyno-stats",
    ]),
  );
  return inputs.map(({ before, after }) => [before, after]);
}

function install(o: Options): void {
  const p = paths(o);
  const dist = join(p.rustBuild, "build", "dist");
  remove(p.rustInstall);
  mkdir(p.rustInstall);
  // What the tarball's install.sh does, a process or three per file: most of a minute for rust-src.
  const installFrom = (dir: string) => {
    for (const component of read(join(dir, "components")).trim().split("\n")) {
      cpSync(join(dir, component), p.rustInstall, {
        recursive: true,
        verbatimSymlinks: true,
        filter: f => f !== join(dir, component, "manifest.in"),
      });
    }
  };
  const unpacked = join(p.rustBuild, "unpacked");
  for (const component of components(o)) {
    const tarball = join(dist, `${component}-nightly${component === "rust-src" ? "" : `-${o.triple}`}.tar.xz`);
    if (!exists(tarball)) throw new Error(`x.py dist did not produce ${tarball}`);
    remove(unpacked);
    run(["tar", "-xJf", tarball, "-C", mkdir(unpacked), "--strip-components=1"]);
    installFrom(unpacked);
  }
  remove(unpacked);
  installFrom(upstream.component(o, "cargo", o.triple));
}
