// Command line and fixed inputs of the toolchain build.

import { HOST_CPU } from "./llvm.ts";
import { availableParallelism } from "node:os";
import { builderOf, findVariant, HOSTS, HOST_TRIPLE, type Builder, type Host, type Variant, variantsFor } from "./variants.ts";
import { join, resolve } from "node:path";

/** Bump when the recipe changes in a way that must not reuse earlier stage outputs. */
export const RECIPE_VERSION = 1;

/**
 * The oven-sh/bun commit the PGO profiles are trained on (and whose SDK pins the cross builds
 * use). The only way to change it is this line: a toolchain release is reproducible from the
 * commit it was built from. Training needs a Bun tree that understands BUN_TOOLCHAIN_LLVM /
 * BUN_TOOLCHAIN_RUST (scripts/build/tools.ts) and that builds cleanly with this toolchain, its
 * post-link checks included — until oven-sh/bun's main builds with it, that is the head of the
 * branch that moves it there (main plus what the newer clang/lld need); a stale ref only makes
 * the profile slightly less representative.
 */
export const BUN_REF = "3e2b373cc53e631f970aa897a2ede481c28898b0";

export type { Builder, Host } from "./variants.ts";

/** toolchain.ts sub-commands, in pipeline order. */
export const COMMANDS = {
  "llvm-instrumented": "clang + lld: stage 1 and the PGO-instrumented stage of LLVM's release recipe (once per builder)",
  llvm: "clang + lld for --host/--variant: train on its Bun build, final PGO stage, BOLT (plain variants: one release build, cross-compiled)",
  rust: "rustc + cargo for --host/--variant: rust-lang's dist recipe (PGO rustc, PGO+BOLT libLLVM) trained on its Bun build (plain variants: a plain dist, cross-compiled)",
  package: "bun-toolchain-<host>-<variant>-{llvm,rust}.tar.zst from the two installs",
  all: "every step above, in order (default)",
  probe: "print what this machine has (cores, memory, disk, host tools)",
  matrix: "print the {builder, host, variant} build matrix as JSON (for the workflow); --variants= / --hosts= filter",
} as const;
export type Command = keyof typeof COMMANDS;

export interface Options {
  command: Command;
  /** oven-sh/rust checkout (this repository). */
  checkout: string;
  /** oven-sh/llvm-project checkout; defaults to the src/llvm-project submodule. */
  llvmProject: string;
  /** All build output goes under here. */
  buildDir: string;
  /** The machine this runs on. */
  builder: Builder;
  builderTriple: string;
  /** The machine the toolchain being built runs on (--host; default: the builder). */
  host: Host;
  triple: string;
  /** True when host != builder: the result cannot run here, so it is a plain build (no training, no smoke test). */
  cross: boolean;
  /** The other Linux architecture Bun's CI targets from a Linux host (compiler-rt is built for it too). */
  crossTriple: string;
  /** An existing macOS SDK for darwin hosts; default: fetched as Bun's darwin cross builds do (lib/sdks.ts). */
  macosSdkOverride: string | undefined;
  /** An existing MSVC CRT + Windows SDK (/winsysroot layout) for windows hosts; default: fetched with xwin as Bun does (lib/sdks.ts). */
  winSysrootOverride: string | undefined;
  /** An existing LLVM install (clang, lld, llvm-profdata, llvm-bolt) used to build everything. */
  hostLlvm: string;
  /** mimalloc override object linked into clang and lld; undefined = keep the libc allocator. */
  mimalloc: string | undefined;
  /** Prefix of a static libxml2 (lib/libxml2.a, include/libxml2) for lld and llvm-mt. */
  libxml2: string;
  /** oven-sh/bun ref to train on, or an existing checkout to use as-is. */
  bunRef: string;
  /** The release number (r<N>) this build is published as; recorded in the tarballs' provenance. */
  release: number | undefined;
  bunDir: string | undefined;
  jobs: number;
  /** What is being built (lib/variants.ts): a ci-<lane> or dev, trained or plain. */
  variant: Variant;
  /** No PGO/BOLT/training: the variant has no workload (every cross-host build). */
  plain: boolean;
  /** -mcpu/-Ctarget-cpu for the toolchain's own host binaries (default HOST_CPU[host] in llvm.ts; --host-cpu=none|NAME). */
  hostCpu: string | undefined;
  /** `matrix` only: restrict the printed matrix to these variant names / hosts / halves. */
  variantFilter: string[] | undefined;
  hostFilter: Host[] | undefined;
  halves: ("llvm" | "rust")[];
  /** BOLT clang and lld (lib/llvm.ts). */
  llvmBolt: boolean;
  /**
   * BOLT rustc's libLLVM.so and librustc_driver.so (opt-dist stage 3). Upstream does this on
   * x86_64 only ("broken" on aarch64, rust-lang/rust#133807); here on both: the aarch64 failure
   * was llvm-bolt -update-debug-sections looping forever on ELF-compressed debug sections, fixed in
   * our llvm-project, plus rust.compress-debuginfo=off and no jump tables (lib/rust.ts).
   */
  rustBolt: boolean;
}

export function parseOptions(argv: string[]): Options {
  const checkout = resolve(import.meta.dirname, "..", "..");
  const args = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of argv) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(arg);
    if (m) args.set(m[1]!, m[2] ?? "true");
    else positional.push(arg);
  }
  const take = (name: string): string | undefined => {
    const v = args.get(name);
    args.delete(name);
    return v;
  };

  const command = (positional[0] ?? "all") as Command;
  if (!(command in COMMANDS) || positional.length > 1) usage();

  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x64" : undefined;
  if (process.platform !== "linux" || arch === undefined) {
    throw new Error(`unsupported host ${process.platform}/${process.arch}; the toolchain build runs on linux x64/aarch64`);
  }
  const builder: Builder = `linux-${arch}`;
  const hostArg = take("host") ?? builder;
  if (!(HOSTS as readonly string[]).includes(hostArg)) throw new Error(`--host: one of ${HOSTS.join(", ")}; got ${hostArg}`);
  const host = hostArg as Host;
  if (builderOf(host) !== builder && host !== builder) console.error(`note: ${host} toolchains are normally built on ${builderOf(host)}, this is ${builder}`);
  const crossTriple = (host === "linux-aarch64" ? "linux-x64" : "linux-aarch64") === "linux-x64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu";

  const options: Options = {
    command,
    checkout,
    llvmProject: resolve(take("llvm-project") ?? join(checkout, "src", "llvm-project")),
    buildDir: resolve(take("build-dir") ?? join(checkout, "obj", "bun-toolchain")),
    builder,
    builderTriple: HOST_TRIPLE[builder],
    host,
    triple: HOST_TRIPLE[host],
    cross: host !== builder,
    crossTriple,
    macosSdkOverride: (v => (v === undefined ? undefined : resolve(v)))(take("macos-sdk")),
    winSysrootOverride: (v => (v === undefined ? undefined : resolve(v)))(take("win-sysroot")),
    hostLlvm: resolve(take("host-llvm") ?? "/opt/llvm"),
    mimalloc: (v => (v === "none" ? undefined : resolve(v)))(take("mimalloc") ?? "/opt/mimalloc/mimalloc.o"),
    libxml2: resolve(take("libxml2") ?? "/opt/libxml2"),
    bunRef: BUN_REF,
    release: ((v) => (v === undefined ? undefined : Number(v)))(take("release")),
    bunDir: take("bun-dir"),
    variantFilter: take("variants")?.split(","),
    hostFilter: take("hosts")?.split(",") as Host[] | undefined,
    halves: (h => { for (const x of h) if (x !== "llvm" && x !== "rust") throw new Error(`--halves: llvm,rust; got ${x}`); return h as ("llvm" | "rust")[]; })(take("halves")?.split(",") ?? ["llvm", "rust"]),
    jobs: Number(take("jobs") ?? availableParallelism()),
    // llvm-instrumented, matrix and probe do not depend on the variant; the default only has to exist.
    variant: findVariant(host, take("variant") ?? variantsFor(host)[0]!.name),
    plain: false,
    llvmBolt: take("skip-bolt") === undefined,
    rustBolt: false,
    hostCpu: HOST_CPU[host],
  };
  options.plain = options.variant.train === undefined;
  if (options.cross && !options.plain) throw new Error(`${options.variant.name} for ${host} is a trained variant; it has to be built on ${host} itself`);
  if (options.plain) options.llvmBolt = false;
  options.rustBolt = options.llvmBolt;
  const hostCpu = take("host-cpu");
  if (hostCpu !== undefined) options.hostCpu = hostCpu === "none" ? undefined : hostCpu;
  if (args.size > 0) {
    console.error(`unknown option(s): ${[...args.keys()].map(k => `--${k}`).join(", ")}`);
    usage();
  }
  return options;
}

function usage(): never {
  const width = Math.max(...Object.keys(COMMANDS).map(c => c.length));
  console.error(`usage: node bun/toolchain.ts [${Object.keys(COMMANDS).join("|")}] [options]

${Object.entries(COMMANDS).map(([c, d]) => `  ${c.padEnd(width)}  ${d}`).join("\n")}

options:
  --build-dir=DIR      output root (default: obj/bun-toolchain)
  --host-llvm=DIR      existing LLVM used to compile everything (default: /opt/llvm)
  --mimalloc=FILE|none mimalloc.o to link into clang/lld (default: /opt/mimalloc/mimalloc.o)
  --libxml2=DIR        static libxml2 prefix for lld/llvm-mt (default: /opt/libxml2)
  --llvm-project=DIR   llvm sources (default: src/llvm-project)
  --release=N          release number this build is published as (recorded in toolchain-*.json)
  --bun-dir=DIR        use this Bun checkout instead of cloning BUN_REF (local experiments)
  --jobs=N             parallelism (default: all cores)
  --host=HOST          machine the toolchain runs on (default: this one): linux-x64|linux-aarch64|darwin-aarch64|windows-x64|windows-aarch64
  --variant=NAME       ci-<os>-<arch>[-<abi>|-asan] or dev (lib/variants.ts); a variant with no training workload is a plain build
  --macos-sdk=DIR      an existing macOS SDK for darwin hosts (default: fetched the way Bun's build does)
  --win-sysroot=DIR    an existing MSVC CRT + Windows SDK (/winsysroot layout) for windows hosts (default: fetched with xwin)
  --variants=A,B       (matrix) only these variants
  --halves=llvm,rust   (matrix) only these halves
  --skip-bolt          PGO only
  --host-cpu=NAME|none -mcpu/-Ctarget-cpu for the toolchain's own binaries (default: per host, lib/llvm.ts)`);
  process.exit(2);
}

/** Fixed layout under --build-dir. */
export function paths(o: Options) {
  const b = o.buildDir;
  return {
    /** bootstrap's build dir for the rust pipeline */
    rustBuild: join(b, "rust"),
    /** opt-dist's PGO/BOLT profiles and logs */
    rustArtifacts: join(b, "rust", "opt-artifacts"),
    /** dist tarballs produced by `x.py dist` */
    rustDist: join(b, "rust", "build", "dist"),
    /** the `x.py dist` tarballs installed with their install.sh: the finished Rust half (what package ships) */
    rustInstall: join(b, "rust-install"),
    /**
     * Release.cmake's build dir: stage 1 at the top, the PGO-instrumented stage under
     * tools/clang/stage2-instrumented-bins. Variant-independent; `llvm-instrumented` makes it
     * and packs the parts later steps need into llvmInstrumentedTar.
     */
    llvmBuild: join(b, "llvm"),
    llvmInstrumentedTar: join(b, `llvm-instrumented-${o.builder}.tar.zst`),
    /** the variant's profiles and its final (PGO) stage build dir */
    llvmFinal: join(b, "llvm-final"),
    /** `install-distribution` of the final stage, then BOLTed: the finished LLVM half */
    llvmInstall: join(b, "llvm-install"),
    /** toolchain file, compiler wrappers and compiler-rt build for a cross-compiled host (lib/cross.ts) */
    cross: join(b, `cross-${o.host}`),
    /** platform SDKs fetched for cross-compiled hosts (lib/sdks.ts) */
    sdks: join(b, "sdks"),
    /** Bun checkout and build dirs used for training */
    bun: o.bunDir !== undefined ? resolve(o.bunDir) : join(b, "bun"),
    train: join(b, "train"),
    /** final tarball contents */
    out: join(b, "out"),
  };
}
