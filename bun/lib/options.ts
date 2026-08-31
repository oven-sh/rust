// Command line and fixed inputs of the toolchain build.

import { availableParallelism } from "node:os";
import { findVariant, type Variant, variantsFor } from "./variants.ts";
import { join, resolve } from "node:path";

/** Bump when the recipe changes in a way that must not reuse earlier stage outputs. */
export const RECIPE_VERSION = 1;

/**
 * The oven-sh/bun commit the PGO profiles are trained on. Training needs a Bun
 * tree that understands BUN_TOOLCHAIN_LLVM / BUN_TOOLCHAIN_RUST
 * (scripts/build/tools.ts). Bumped deliberately; a stale ref only makes the
 * profile slightly less representative.
 */
export const DEFAULT_BUN_REF = "ed950b88ab2ec6b58bccdfe7d310731b8ca13c4d";

export type Host = "linux-x64" | "linux-aarch64";

/** toolchain.ts sub-commands, in pipeline order. */
export const COMMANDS = {
  "llvm-instrumented": "clang + lld: stage 1 and the PGO-instrumented stage of LLVM's release recipe (once per host)",
  llvm: "clang + lld for --variant: train on its Bun build, final PGO stage, BOLT",
  rust: "rustc + cargo for --variant: rust-lang's dist recipe (PGO rustc, PGO+BOLT libLLVM) trained on its Bun build",
  package: "bun-toolchain-<host>-<variant>-{llvm,rust}.tar.zst from the two installs",
  all: "every step above, in order (default)",
  probe: "print what this machine has (cores, memory, disk, host tools)",
  matrix: "print the {host, variant} build matrix as JSON (for the workflow); --variants=a,b filters",
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
  host: Host;
  triple: string;
  /** The other Linux architecture Bun's CI targets from this host (compiler-rt is built for it too). */
  crossTriple: string;
  /** An existing LLVM install (clang, lld, llvm-profdata, llvm-bolt) used to build everything. */
  hostLlvm: string;
  /** mimalloc override object linked into clang and lld; undefined = keep the libc allocator. */
  mimalloc: string | undefined;
  /** Prefix of a static libxml2 (lib/libxml2.a, include/libxml2) for lld and llvm-mt. */
  libxml2: string;
  /** oven-sh/bun ref to train on, or an existing checkout to use as-is. */
  bunRef: string;
  bunDir: string | undefined;
  jobs: number;
  /** The Bun build the profiles come from (lib/variants.ts): a ci-<lane> or dev. */
  variant: Variant;
  /** `matrix` only: restrict the printed matrix to these variant names. */
  variantFilter: string[] | undefined;
  /** BOLT clang and lld (lib/llvm.ts). */
  llvmBolt: boolean;
  /**
   * BOLT rustc's libLLVM.so and librustc_driver.so (opt-dist stage 3). Off on aarch64 unless
   * --aarch64-rust-bolt: there llvm-bolt 21 instruments, profiles and optimizes both libraries,
   * inserts its long-jump stubs, and then never finishes writing the output (killed after 3.5 h;
   * x64 takes ~150 s). Upstream does not BOLT on aarch64 either ("broken", rust-lang/rust#133807).
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
  const host: Host = `linux-${arch}`;
  const triple = arch === "x64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu";
  const crossTriple = arch === "x64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";

  const options: Options = {
    command,
    checkout,
    llvmProject: resolve(take("llvm-project") ?? join(checkout, "src", "llvm-project")),
    buildDir: resolve(take("build-dir") ?? join(checkout, "obj", "bun-toolchain")),
    host,
    triple,
    crossTriple,
    hostLlvm: resolve(take("host-llvm") ?? "/opt/llvm"),
    mimalloc: (v => (v === "none" ? undefined : resolve(v)))(take("mimalloc") ?? "/opt/mimalloc/mimalloc.o"),
    libxml2: resolve(take("libxml2") ?? "/opt/libxml2"),
    bunRef: take("bun-ref") ?? DEFAULT_BUN_REF,
    bunDir: take("bun-dir"),
    variantFilter: take("variants")?.split(","),
    jobs: Number(take("jobs") ?? availableParallelism()),
    // llvm-instrumented, matrix and probe do not depend on the variant; the default only has to exist.
    variant: findVariant(host, take("variant") ?? variantsFor(host)[0]!.name),
    llvmBolt: take("skip-bolt") === undefined,
    rustBolt: false,
  };
  options.rustBolt = options.llvmBolt && (options.host !== "linux-aarch64" || take("aarch64-rust-bolt") !== undefined);
  if (args.size > 0) {
    console.error(`unknown option(s): ${[...args.keys()].map(k => `--${k}`).join(", ")}`);
    usage();
  }
  if (options.bunDir === undefined && !/^[0-9a-f]{40}$/.test(options.bunRef)) {
    throw new Error(`--bun-ref must be a full 40-character commit sha (it is fetched shallowly by sha), got ${options.bunRef}`);
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
  --bun-ref=SHA        oven-sh/bun commit to train on (default: pinned)
  --bun-dir=DIR        use this Bun checkout instead of cloning --bun-ref
  --jobs=N             parallelism (default: all cores)
  --variant=NAME       which Bun build to train on: ci-<os>-<arch>[-<abi>|-asan] or dev (lib/variants.ts)
  --variants=A,B       (matrix) only these variants
  --skip-bolt          PGO only
  --aarch64-rust-bolt  also BOLT rustc's libraries on aarch64 (experimental; hangs in llvm-bolt 21)`);
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
    llvmInstrumentedTar: join(b, `llvm-instrumented-${o.host}.tar.zst`),
    /** the variant's profiles and its final (PGO) stage build dir */
    llvmFinal: join(b, "llvm-final"),
    /** `install-distribution` of the final stage, then BOLTed: the finished LLVM half */
    llvmInstall: join(b, "llvm-install"),
    /** Bun checkout and build dirs used for training */
    bun: o.bunDir !== undefined ? resolve(o.bunDir) : join(b, "bun"),
    train: join(b, "train"),
    /** final tarball contents */
    out: join(b, "out"),
  };
}
