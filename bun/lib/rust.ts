// rustc + cargo, built the way rust-lang's own dist-x86_64-linux / dist-aarch64-linux
// builders build the toolchains rustup serves, with one difference: the PGO/BOLT
// profiles are gathered by compiling Bun instead of the rustc-perf benchmark set.
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
 * BOLT (x86_64 upstream; off on aarch64 upstream): currently OFF here on both.
 * llvm-bolt refuses libLLVM.so because the libstdc++.a/libgcc_eh.a it statically
 * links from the Ubuntu image contain GCC hot/cold-split `.cold` fragments with no
 * STT_FILE symbols to pair them by; upstream's image builds its own GCC, whose
 * archives keep them. To turn it back on: build GCC in bun/Dockerfile the way
 * src/ci/docker/scripts/build-gcc.sh does, then pass `--use-bolt` below.
 */
const RUST_BOLT = false;

/**
 * Where this build deliberately differs from upstream. Each entry replaces or
 * removes an upstream argument; nothing here changes how rustc or std are compiled.
 */
function bunDeltas(o: Options): { drop: string[]; add: string[] } {
  return {
    drop: [
      "--enable-sccache", // upstream's S3-backed compiler cache; not available here
      "--enable-compiler-docs", // rustc API docs: build time only, not shipped by us
      "--disable-manage-submodules", // upstream CI pre-clones every submodule; let bootstrap fetch the ones it needs
    ],
    add: [
      "--disable-docs",
      `--set build.build-dir=${paths(o).rustBuild}/build`,
      // upstream gets these from the Docker image's environment
      `--set target.${o.triple}.cc=${o.hostLlvm}/bin/clang`,
      `--set target.${o.triple}.cxx=${o.hostLlvm}/bin/clang++`,
    ],
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
 * `x.py dist` arguments from dist.sh / the aarch64 SCRIPT, minus components Bun
 * does not use (enzyme, rustc_codegen_gcc, gcc).
 */
function distArgs(o: Options): string[] {
  return ["--host", o.triple, "--target", o.triple, "--include-default-paths", "build-manifest", "bootstrap"];
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
      ...(o.bolt && RUST_BOLT ? ["--use-bolt"] : []),
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

/** Components of `x.py dist` output that go into the Bun toolchain. */
const SHIPPED_COMPONENTS = ["rustc", "rust-std", "cargo", "rust-src", "rustfmt", "clippy", "llvm-tools"];

export function installDist(o: Options): void {
  const p = paths(o);
  const dist = join(p.rustBuild, "build", "dist");
  remove(p.rustSysroot);
  mkdir(p.rustSysroot);
  const tarballs = readdirSync(dist).filter(f => f.endsWith(".tar.xz"));
  for (const component of SHIPPED_COMPONENTS) {
    const tarball = tarballs.find(f => f.startsWith(`${component}-nightly-`) && (component === "rust-src" || f.includes(o.triple)));
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
