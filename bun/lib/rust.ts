// rustc + cargo, built the way rust-lang's own dist-x86_64-linux / dist-aarch64-linux
// builders build the toolchains rustup serves: their configure arguments, their
// opt-dist PGO/BOLT pipeline. What differs is listed in bunDeltas() below; chiefly,
// the profiles are gathered by compiling Bun instead of the rustc-perf benchmark set.
//
// Upstream recipe, at this repository's pinned commit:
//   src/ci/docker/host-x86_64/dist-x86_64-linux/Dockerfile   (RUST_CONFIGURE_ARGS, dist.sh)
//   src/ci/docker/host-aarch64/dist-aarch64-linux/Dockerfile (RUST_CONFIGURE_ARGS, SCRIPT)
//   src/ci/run.sh                                             (arguments every DEPLOY=1 job adds)
//   src/ci/github-actions/jobs.yml                            (CODEGEN_BACKENDS=llvm,cranelift)
//   src/tools/opt-dist                                        (the PGO/BOLT pipeline)

import { chmodSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { exists, isDone, markDone, mkdir, remove, write } from "./fs.ts";
import { NO_JUMP_TABLES } from "./llvm.ts";
import { isDarwin, isWindows, MACOS_DEPLOYMENT_TARGET, wrappers } from "./cross.ts";
import { macosSdk } from "./sdks.ts";
import { type Options, paths, RECIPE_VERSION } from "./options.ts";
import { run } from "./run.ts";
import { trainingEnv } from "./train-config.ts";

/** RUST_CONFIGURE_ARGS from the dist Dockerfile for `host`, verbatim except /rustroot → hostLlvm. */
function dockerfileConfigureArgs(o: Options): string[] {
  const t = o.triple;
  const common = [
    "--enable-full-tools",
    "--enable-sanitizers",
    "--enable-profiler",
    "--enable-compiler-docs",
    `--set target.${t}.linker=clang`,
    `--set target.${t}.ar=${o.hostLlvm}/bin/llvm-ar`,
    `--set target.${t}.ranlib=${o.hostLlvm}/bin/llvm-ranlib`,
    "--set llvm.thin-lto=true",
    "--set llvm.ninja=false",
    "--set llvm.libzstd=true",
    "--set rust.jemalloc",
    "--set rust.bootstrap-override-lld=true",
    "--set rust.lto=thin",
    "--set rust.codegen-units=1",
  ];
  return o.host === "linux-aarch64"
    ? [`--build=${t}`, ...common, "--set llvm.link-shared=true", "--set rust.debug-assertions=false"]
    : common;
}

/** What src/ci/run.sh appends for a DEPLOY=1 (dist, non-alt) nightly job that builds its own LLVM. */
const runShConfigureArgs = [
  "--set build.print-step-timings",
  "--enable-verbose-tests",
  "--set build.metrics",
  "--enable-verbose-configure",
  "--enable-sccache",
  "--disable-manage-submodules",
  "--enable-locked-deps",
  "--enable-cargo-native-static",
  "--set rust.codegen-units-std=1",
  "--set dist.compression-profile=balanced",
  "--dist-compression-formats=xz",
  "--set rust.lld=true",
  "--set build.optimized-compiler-builtins",
  "--release-channel=nightly",
  "--enable-llvm-static-stdcpp",
  "--debuginfo-level-std=1",
  "--set rust.codegen-backends=llvm,cranelift",
];

/**
 * Where this build differs from upstream. "build only" entries change what gets
 * built or how the build runs, not the compiler that comes out; "deviation" entries
 * change the shipped binaries and say how. Beyond this list: the PGO/BOLT training
 * workload (bun/train.ts instead of rustc-perf), no post-dist test run,
 * and the host compilers in bun/Dockerfile (upstream: self-built clang 22.1.0, GCC 9's
 * libstdc++.a; here: apt.llvm.org's clang 21, GCC 13's libstdc++.a).
 */
export function bunDeltas(o: Options): { drop: string[]; add: string[]; env: Record<string, string> } {
  // aarch64 + BOLT: no jump tables in libLLVM.so / librustc_driver.so so llvm-bolt can process
  // them (NO_JUMP_TABLES in llvm.ts; the same is done for clang and lld there).
  const boltable = o.host === "linux-aarch64" && o.rustBolt;
  const triple_ = o.triple.replaceAll("-", "_");
  // Host-only code generation flags: rustc's own crates (RUSTC_RUSTFLAGS, a bootstrap hook of ours,
  // see compile.rs rustc_cargo) and its libLLVM (llvm.cflags). std and everything else that ends up
  // in programs compiled *with* this toolchain stay generic. HOST_CPU in llvm.ts says why that CPU.
  const llvmCFlags = [...(boltable ? [NO_JUMP_TABLES] : []), ...(o.hostCpu ? [`-mcpu=${o.hostCpu}`] : [])].join(" ");
  const rustcFlags = o.hostCpu ? `-Ctarget-cpu=${o.hostCpu}` : undefined;
  return {
    drop: [
      "--enable-sccache", // build only: upstream's S3-backed compiler cache
      "--enable-compiler-docs", // build only: rustc API docs
      "--disable-manage-submodules", // build only: upstream CI pre-clones every submodule; let bootstrap fetch what it needs
      "--set rust.codegen-backends=llvm,cranelift", // build only: cranelift is a separate component we do not ship
      "--set dist.compression-profile=balanced", // build only: see =fast below
    ],
    add: [
      "--disable-docs", // build only
      "--disable-dist-src", // build only (upstream x86_64 also produces the source tarball)
      "--set dist.compression-profile=fast", // build only: the tarballs are unpacked again right away
      `--set build.build-dir=${paths(o).rustBuild}/build`, // build only
      // build only: upstream gets these from the Docker image's environment
      `--set target.${o.triple}.cc=${o.hostLlvm}/bin/clang`,
      `--set target.${o.triple}.cxx=${o.hostLlvm}/bin/clang++`,
      // deviation: only the backends Bun targets (upstream: all of them + experimental).
      // Smaller libLLVM.so to load, LTO and BOLT.
      "--set llvm.targets=AArch64;X86",
      "--set llvm.experimental-targets=",
      // deviation: no -gz / --compress-debug-sections on rustc's LLVM and libraries (the dist
      // profile compresses them; upstream's non-dist CI turns it off too). llvm-bolt
      // -update-debug-sections looped forever on the aarch64 libLLVM.so's compressed .debug_line_str;
      // that is fixed in our llvm-project, and uncompressed input keeps BOLT off that path entirely.
      "--set rust.compress-debuginfo=off",
      ...(llvmCFlags ? [`--set llvm.cflags=${llvmCFlags}`, `--set llvm.cxxflags=${llvmCFlags}`] : []),
    ],
    env: {
      ...(boltable ? { RUSTFLAGS: "-Cjump-tables=no", [`CFLAGS_${triple_}`]: NO_JUMP_TABLES, [`CXXFLAGS_${triple_}`]: NO_JUMP_TABLES } : {}),
      ...(rustcFlags ? { RUSTC_RUSTFLAGS: rustcFlags } : {}),
    },
  };
}

/** argv for ./configure. Entries above are written as upstream writes them ("--set k=v"); the shell splits those. */
export function configureArgs(o: Options): string[] {
  const { drop, add } = bunDeltas(o);
  return [...dockerfileConfigureArgs(o), ...runShConfigureArgs]
    .filter(a => !drop.includes(a))
    .concat(add)
    // "--set key=value" entries become two arguments; a value may contain spaces (llvm.cflags).
    .flatMap(a => (a.startsWith("--set ") ? ["--set", a.slice("--set ".length)] : a.split(" ")));
}

/**
 * `x.py dist` arguments. Upstream (dist.sh / the aarch64 SCRIPT) builds every default
 * dist component plus build-manifest, bootstrap, enzyme, rustc_codegen_gcc, gcc; we
 * build the components Bun uses (rust-toolchain.toml in oven-sh/bun: rust-src,
 * rustfmt, clippy, miri, llvm-tools, on top of rustc/cargo/std). build only.
 */
export const SHIPPED_COMPONENTS = ["rustc", "rust-std", "cargo", "rust-src", "rustfmt", "clippy", "miri", "llvm-tools"];
// BUN_TOOLCHAIN_DIST_ONLY=rustc,rust-std,rust-src: local experiments on hosts that cannot build
// every tool (cargo's vendored OpenSSL wants a working perl, for one); never set in CI.
const components = process.env.BUN_TOOLCHAIN_DIST_ONLY?.split(",") ?? SHIPPED_COMPONENTS;
function distArgs(o: Options): string[] {
  return ["--host", o.triple, "--target", o.triple, ...components];
}

export function buildRust(o: Options): void {
  const p = paths(o);
  const key = `rust-${RECIPE_VERSION}-${run(["git", "rev-parse", "HEAD"], { cwd: o.checkout, capture: true }).trim()}-bolt=${o.rustBolt}-${o.variant.name}`;
  if (isDone(p.rustInstall, key)) {
    console.log(`rust: up to date (${key})`);
    return;
  }

  mkdir(p.rustBuild);
  const env = {
    RUST_BOOTSTRAP_CONFIG: join(p.rustBuild, "bootstrap.toml"),
    ...bunDeltas(o).env,
    // read by bun/train.ts when opt-dist calls it
    ...trainingEnv(o),
  };

  // 1. configure (writes bootstrap.toml into the cwd; refuses to overwrite one)
  remove(env.RUST_BOOTSTRAP_CONFIG);
  run([join(o.checkout, "configure"), ...configureArgs(o)], { cwd: p.rustBuild, env });

  // 2. build opt-dist itself (dist.sh: `x.py build --set rust.debug=true opt-dist`)
  run(["python3", join(o.checkout, "x.py"), "build", "--set", "rust.debug=true", "opt-dist"], { cwd: p.rustBuild, env });

  // Before the hours-long part: make sure the training workload can at least configure
  // Bun here (stage0's rustc/cargo stand in for the compiler that does not exist yet).
  chmodSync(join(o.checkout, "bun", "train.ts"), 0o755);
  run([join(o.checkout, "bun", "train.ts"), "preflight", join(p.rustBuild, "build", o.triple, "stage0")], { env });

  // 3. the PGO/BOLT pipeline, ending in `x.py dist`
  const optDist = join(p.rustBuild, "build", o.triple, "stage1-tools-bin", "opt-dist");
  run(
    [
      optDist,
      "local",
      `--target-triple=${o.triple}`,
      `--checkout-dir=${o.checkout}`,
      `--llvm-dir=${o.hostLlvm}`,
      `--build-dir=${join(p.rustBuild, "build")}`,
      `--artifact-dir=${p.rustArtifacts}`,
      `--training-command=${join(o.checkout, "bun", "train.ts")}`,
      ...(o.rustBolt ? ["--use-bolt"] : []),
      "--",
      "python3",
      join(o.checkout, "x.py"),
      "dist",
      ...distArgs(o),
    ],
    { cwd: p.rustBuild, env },
  );

  // 4. install the dist tarballs; that directory is what `package` ships.
  installDist(o);
  // 5. run what was installed. opt-dist BOLTs the stage2 libraries in place and dist packages
  //    them without executing them again (upstream then runs part of the test suite, which we
  //    skip), so this is the first time the shipped rustc runs: a BOLT rewrite that produced a
  //    broken librustc_driver.so must fail here, not in Bun's CI.
  smokeTest(o);
  markDone(p.rustInstall, key);
}

/**
 * `configure` arguments of a plain (untrained) toolchain cross-compiled for a host this machine
 * cannot run: upstream's dist configuration for that host as far as it applies off-host — same
 * channel, LTO for rustc, rust-lld, vendored native deps — with the compiler built here (build =
 * this machine) for --host/--target = the toolchain's host, C/C++ parts compiled and linked by
 * lib/cross.ts's wrappers (clang --target=<host> + the platform SDK + lld). No PGO (the
 * instrumented compiler could not run here), no BOLT (ELF only), LLVM linked statically.
 * Components: what a developer machine building Bun needs.
 */
export const PLAIN_COMPONENTS = ["rustc", "rust-std", "cargo", "rust-src", "rustfmt", "clippy"];
export function plainConfigureArgs(o: Options): string[] {
  const w = wrappers(o);
  const b = o.builderTriple;
  const t = o.triple;
  return [
    `--build=${b}`,
    `--host=${t}`,
    `--target=${t}`,
    `--set target.${b}.cc=${o.hostLlvm}/bin/clang`,
    `--set target.${b}.cxx=${o.hostLlvm}/bin/clang++`,
    `--set target.${b}.linker=${o.hostLlvm}/bin/clang`,
    `--set target.${b}.ar=${o.hostLlvm}/bin/llvm-ar`,
    `--set target.${b}.ranlib=${o.hostLlvm}/bin/llvm-ranlib`,
    `--set target.${t}.cc=${w.cc}`,
    `--set target.${t}.cxx=${w.cxx}`,
    `--set target.${t}.linker=${w.linker}`,
    `--set target.${t}.ar=${w.ar}`,
    `--set target.${t}.ranlib=${w.ranlib}`,
    ...(isWindows(o) ? [`--set llvm.build-config.CMAKE_ASM_MASM_COMPILER=${join(w.dir, o.host.endsWith("aarch64") ? "armasm64" : "ml64")}`] : []),
    "--release-channel=nightly",
    "--set llvm.download-ci-llvm=false",
    "--set llvm.targets=AArch64;X86",
    "--set llvm.experimental-targets=",
    "--set llvm.link-shared=false",
    "--set llvm.static-libstdcpp=false",
    "--set rust.lld=true",
    // rustc itself shells out to rust-objcopy from its sysroot (stripping, on Apple targets), so
    // the LLVM tools have to be staged even though the llvm-tools component is not shipped.
    "--set rust.llvm-tools=true",
    // as upstream's dist for the host: ThinLTO across rustc_driver on macOS (dist-aarch64-apple),
    // not on Windows (dist-x86_64-msvc; statics behind the DLL boundary do not survive dylib LTO
    // there). Unlike dist-aarch64-apple, no jemalloc yet: cross-compiled from Linux its zone
    // allocator hooks (je_zone_register) do not get built, so rustc uses the system allocator.
    ...(isWindows(o) ? [] : ["--set rust.lto=thin"]),
    "--set rust.codegen-units=1",
    "--set rust.codegen-backends=llvm",
    "--set build.extended=true",
    "--set build.docs=false",
    "--set build.optimized-compiler-builtins",
    "--enable-cargo-native-static",
    "--enable-locked-deps",
    "--set build.print-step-timings",
    "--dist-compression-formats=xz",
  ].flatMap(a => (a.startsWith("--set ") ? ["--set", a.slice("--set ".length)] : [a]));
}

/** rustc + cargo for a host this machine cannot run (lib/variants.ts plain variants): a plain cross dist. */
export function buildRustPlain(o: Options): void {
  const p = paths(o);
  const key = `rust-plain-${RECIPE_VERSION}-${run(["git", "rev-parse", "HEAD"], { cwd: o.checkout, capture: true }).trim()}-${o.host}`;
  if (isDone(p.rustInstall, key)) {
    console.log(`rust: up to date (${key})`);
    return;
  }
  mkdir(p.rustBuild);
  const env: Record<string, string> = {
    RUST_BOOTSTRAP_CONFIG: join(p.rustBuild, "bootstrap.toml"),
    // the host's binutils under their conventional names (lib/cross.ts wrappers), for the CMake
    // and cc-rs invocations bootstrap makes that look tools up by name
    PATH: `${wrappers(o).dir}:${process.env.PATH}`,
    // cc-rs, for the C parts of std/cargo's native deps: where the SDK is (it would ask xcrun).
    ...(isDarwin(o) ? { SDKROOT: macosSdk(o), MACOSX_DEPLOYMENT_TARGET: MACOS_DEPLOYMENT_TARGET } : {}),
    // bootstrap exports CC_<triple> to build scripts for every target but *-msvc (there it expects
    // cc-rs to find Visual Studio on the machine); cc-rs takes the target-scoped variables.
    ...(isWindows(o) ? (t => ({ [`CC_${t}`]: wrappers(o).cc, [`CXX_${t}`]: wrappers(o).cxx, [`AR_${t}`]: wrappers(o).ar }))(o.triple.replaceAll("-", "_")) : {}),
    // rustc_driver/rustc embed a version resource; their build script wants rc.exe (compiler/rustc_windows_rc).
    ...(isWindows(o) ? { RUSTC_WINDOWS_RC: join(wrappers(o).dir, "llvm-rc") } : {}),
    // The host's LLVM only (bootstrap reads LDFLAGS_<triple> per cmake target): CMake's MSVC link
    // step runs mt to embed a manifest unless told not to — the same switch, for the same reason,
    // as LLVM's WinMsvc.cmake: there is no mt here, and CMake before 3.31 does not look for llvm-mt.
    ...(isWindows(o) ? { [`LDFLAGS_${o.triple.replaceAll("-", "_")}`]: "/manifest:no" } : {}),
  };
  remove(env.RUST_BOOTSTRAP_CONFIG!);
  run([join(o.checkout, "configure"), ...plainConfigureArgs(o)], { cwd: p.rustBuild, env });
  run(["python3", join(o.checkout, "x.py"), "dist", "--host", o.triple, "--target", o.triple, ...PLAIN_COMPONENTS], { cwd: p.rustBuild, env });
  installDist(o, PLAIN_COMPONENTS);
  markDone(p.rustInstall, key);
}

/** Compile and run a small program, and build a small cargo project, with the installed toolchain. */
export function smokeTest(o: Options): void {
  const p = paths(o);
  const dir = join(p.train, "smoke");
  remove(dir);
  mkdir(join(dir, "src"));
  const rustc = join(p.rustInstall, "bin", "rustc");
  const cargo = join(p.rustInstall, "bin", "cargo");
  console.log(run([rustc, "-vV"], { capture: true }).trim());
  write(
    join(dir, "hello.rs"),
    `use std::collections::HashMap;
fn main() {
    let mut m: HashMap<String, usize> = HashMap::new();
    for (i, w) in "the installed rustc compiled and ran this program".split(' ').enumerate() { m.insert(w.to_string(), i); }
    let mut v: Vec<_> = m.iter().collect();
    v.sort_by_key(|(_, i)| **i);
    println!("{}", v.iter().map(|(w, _)| w.as_str()).collect::<Vec<_>>().join(" "));
}
`,
  );
  for (const opt of ["0", "3"]) {
    run([rustc, "--edition=2021", `-Copt-level=${opt}`, "-Cdebuginfo=1", "hello.rs", "-o", `hello${opt}`], { cwd: dir });
    const out = run([join(dir, `hello${opt}`)], { capture: true }).trim();
    if (out !== "the installed rustc compiled and ran this program") throw new Error(`smoke test: unexpected output ${JSON.stringify(out)}`);
  }
  write(join(dir, "Cargo.toml"), `[package]\nname = "smoke"\nversion = "0.0.0"\nedition = "2021"\n[profile.release]\nlto = "thin"\ncodegen-units = 4\n`);
  write(join(dir, "src", "main.rs"), `fn main() { println!("{}", (1..=10u64).product::<u64>()); }\n`);
  run([cargo, "build", "--release", "--quiet"], { cwd: dir, env: { RUSTC: rustc, CARGO_TARGET_DIR: join(dir, "target") } });
  const out = run([join(dir, "target", "release", "smoke")], { capture: true }).trim();
  if (out !== "3628800") throw new Error(`smoke test: unexpected cargo build output ${JSON.stringify(out)}`);
  console.log("smoke test: installed rustc and cargo work");
}

export function installDist(o: Options, which: string[] = components): void {
  const p = paths(o);
  const dist = p.rustDist;
  remove(p.rustInstall);
  mkdir(p.rustInstall);
  const tarballs = readdirSync(dist).filter(f => f.endsWith(".tar.xz"));
  for (const component of which) {
    // rust-src-nightly.tar.xz; everything else is <component>-nightly-<triple>.tar.xz
    const tarball = tarballs.find(f => f === `${component}-nightly${component === "rust-src" ? "" : `-${o.triple}`}.tar.xz`);
    if (tarball === undefined) throw new Error(`x.py dist did not produce a ${component} tarball in ${dist}`);
    const unpack = join(p.train, "unpack");
    remove(unpack);
    mkdir(unpack);
    run(["tar", "-xJf", join(dist, tarball), "-C", unpack]);
    const [dir] = readdirSync(unpack);
    // Each dist tarball carries rust-installer's install.sh; --prefix installs the component's files.
    run([join(unpack, dir!, "install.sh"), `--prefix=${p.rustInstall}`, "--disable-ldconfig"], { capture: true });
    remove(unpack);
  }
  if (!exists(join(p.rustInstall, "bin", "rustc")) && !exists(join(p.rustInstall, "bin", "rustc.exe"))) throw new Error("installing the rust dist tarballs produced no bin/rustc");
  // rust-installer's bookkeeping (install.log, manifests, uninstall.sh); not part of the toolchain
  for (const f of readdirSync(join(p.rustInstall, "lib", "rustlib"))) {
    if (!statSync(join(p.rustInstall, "lib", "rustlib", f)).isDirectory()) remove(join(p.rustInstall, "lib", "rustlib", f));
  }
}
