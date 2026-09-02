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
import { exists, isDone, markDone, mkdir, remove } from "./fs.ts";
import { NO_JUMP_TABLES } from "./llvm.ts";
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
function bunDeltas(o: Options): { drop: string[]; add: string[]; env: Record<string, string> } {
  // --aarch64-rust-bolt only (see Options.rustBolt): no jump tables in libLLVM.so /
  // librustc_driver.so so llvm-bolt can process them (NO_JUMP_TABLES in llvm.ts).
  const boltable = o.host === "linux-aarch64" && o.rustBolt;
  const triple_ = o.triple.replaceAll("-", "_");
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
      ...(boltable ? [`--set llvm.cflags=${NO_JUMP_TABLES}`, `--set llvm.cxxflags=${NO_JUMP_TABLES}`] : []),
    ],
    // OPT_DIST_BOLT_SERIAL: opt-dist rewrites libLLVM.so and librustc_driver.so one after the other
    // instead of at once (with both in flight the aarch64 builder stalled: memory).
    env: boltable ? { RUSTFLAGS: "-Cjump-tables=no", [`CFLAGS_${triple_}`]: NO_JUMP_TABLES, [`CXXFLAGS_${triple_}`]: NO_JUMP_TABLES, OPT_DIST_BOLT_SERIAL: "1" } : {},
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
  markDone(p.rustInstall, key);
}

export function installDist(o: Options): void {
  const p = paths(o);
  const dist = p.rustDist;
  remove(p.rustInstall);
  mkdir(p.rustInstall);
  const tarballs = readdirSync(dist).filter(f => f.endsWith(".tar.xz"));
  for (const component of components) {
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
  if (!exists(join(p.rustInstall, "bin", "rustc"))) throw new Error("installing the rust dist tarballs produced no bin/rustc");
  // rust-installer's bookkeeping (install.log, manifests, uninstall.sh); not part of the toolchain
  for (const f of readdirSync(join(p.rustInstall, "lib", "rustlib"))) {
    if (!statSync(join(p.rustInstall, "lib", "rustlib", f)).isDirectory()) remove(join(p.rustInstall, "lib", "rustlib", f));
  }
}
