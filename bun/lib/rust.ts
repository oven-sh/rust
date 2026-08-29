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

import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { exists, isDone, markDone, mkdir, remove } from "./fs.ts";
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
  "--disable-dist-src", // DIST_SRC is set only on x86_64; source tarballs are irrelevant here either way
  "--release-channel=nightly",
  "--enable-llvm-static-stdcpp",
  "--debuginfo-level-std=1",
  "--set rust.codegen-backends=llvm,cranelift",
];

/**
 * BOLT. Upstream: libLLVM.so + librustc_driver.so, x86_64 only (aarch64 has a FIXME:
 * "Enable bolt for aarch64 once it's fixed upstream. Broken as of December 2024",
 * opt-dist main.rs). Here: both hosts, and since LLVM is linked into
 * librustc_driver.so statically (below) that one library is what gets BOLTed.
 * --skip-bolt turns it off.
 */
const rustBolt = (o: Options): boolean => o.bolt;

/**
 * Where this build differs from upstream. "build only" entries change what gets
 * built or how the build runs, not the compiler that comes out; "deviation" entries
 * do change the shipped binaries and say how.
 */
function bunDeltas(o: Options): { drop: string[]; add: string[]; env: Record<string, string> } {
  // deviation (x64): upstream targets baseline x86-64; ours needs x86-64-v3 (Haswell,
  // 2013+), for rustc, its LLVM, cargo and the host std alike.
  const march = o.host === "linux-x64" ? "x86-64-v3" : undefined;
  return {
    drop: [
      "--enable-sccache", // build only: upstream's S3-backed compiler cache
      "--enable-compiler-docs", // build only: rustc API docs
      "--disable-manage-submodules", // build only: upstream CI pre-clones every submodule; let bootstrap fetch what it needs
      "--set llvm.link-shared=true", // deviation: see link-shared=false below
    ],
    add: [
      "--disable-docs", // build only
      `--set build.build-dir=${paths(o).rustBuild}/build`, // build only
      // build only: upstream gets these from the Docker image's environment
      `--set target.${o.triple}.cc=${o.hostLlvm}/bin/clang`,
      `--set target.${o.triple}.cxx=${o.hostLlvm}/bin/clang++`,
      // deviation: LLVM linked into librustc_driver.so statically rather than as
      // libLLVM.so (upstream: shared, "to avoid re-doing ThinLTO with each stage").
      // One fewer DSO boundary on every rustc→LLVM call; costs build time here.
      "--set llvm.link-shared=false",
      ...(march ? [`--set llvm.cflags=-march=${march}`, `--set llvm.cxxflags=-march=${march}`] : []),
    ],
    // deviation (x64): -Ctarget-cpu for everything bootstrap compiles with rustc.
    env: march ? { RUSTFLAGS: `-Ctarget-cpu=${march}` } : {},
  };
}

/** argv for ./configure. Entries above are written as upstream writes them ("--set k=v"); the shell splits those. */
export function configureArgs(o: Options): string[] {
  const { drop, add } = bunDeltas(o);
  return [...dockerfileConfigureArgs(o), ...runShConfigureArgs]
    .filter(a => !drop.includes(a))
    .concat(add)
    .flatMap(a => a.split(" "));
}

/**
 * `x.py dist` arguments. Upstream (dist.sh / the aarch64 SCRIPT) builds every default
 * dist component plus build-manifest, bootstrap, enzyme, rustc_codegen_gcc, gcc; we
 * build the components Bun uses (rust-toolchain.toml in oven-sh/bun: rust-src,
 * rustfmt, clippy, miri, llvm-tools, on top of rustc/cargo/std). build only.
 */
export const SHIPPED_COMPONENTS = ["rustc", "rust-std", "cargo", "rust-src", "rustfmt", "clippy", "miri", "llvm-tools"];
function distArgs(o: Options): string[] {
  return ["--host", o.triple, "--target", o.triple, ...SHIPPED_COMPONENTS];
}

export function buildRust(o: Options): void {
  const p = paths(o);
  const key = `rust-${RECIPE_VERSION}-${run(["git", "rev-parse", "HEAD"], { cwd: o.checkout, capture: true }).trim()}`;
  if (isDone(p.rustSysroot, key)) {
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
      "--llvm-shared=false",
      ...(rustBolt(o) ? ["--use-bolt"] : []),
      "--",
      "python3",
      join(o.checkout, "x.py"),
      "dist",
      ...distArgs(o),
    ],
    { cwd: p.rustBuild, env },
  );

  // 4. install the dist tarballs into one sysroot: that directory is both what
  //    the LLVM stage trains against and what `package` ships.
  installDist(o);
  markDone(p.rustSysroot, key);
}

export function installDist(o: Options): void {
  const p = paths(o);
  const dist = p.rustDist;
  remove(p.rustSysroot);
  mkdir(p.rustSysroot);
  const tarballs = readdirSync(dist).filter(f => f.endsWith(".tar.xz"));
  for (const component of SHIPPED_COMPONENTS) {
    // rust-src-nightly.tar.xz; everything else is <component>-nightly-<triple>.tar.xz
    const tarball = tarballs.find(f => f === `${component}-nightly${component === "rust-src" ? "" : `-${o.triple}`}.tar.xz`);
    if (tarball === undefined) throw new Error(`x.py dist did not produce a ${component} tarball in ${dist}`);
    const unpack = join(p.train, "unpack");
    remove(unpack);
    mkdir(unpack);
    run(["tar", "-xJf", join(dist, tarball), "-C", unpack]);
    const [dir] = readdirSync(unpack);
    // Each dist tarball carries rust-installer's install.sh; --prefix installs the component's files.
    run([join(unpack, dir!, "install.sh"), `--prefix=${p.rustSysroot}`, "--disable-ldconfig"], { capture: true });
  }
  if (!exists(join(p.rustSysroot, "bin", "rustc"))) throw new Error("rust sysroot install produced no bin/rustc");
}
