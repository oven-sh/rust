// Command line and fixed inputs of the toolchain build.

import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";

/** Bump when the recipe changes in a way that must not reuse earlier stage outputs. */
export const RECIPE_VERSION = 1;

/**
 * The oven-sh/bun commit the PGO profiles are trained on. Training needs a Bun
 * tree that understands BUN_TOOLCHAIN_LLVM / BUN_TOOLCHAIN_RUST
 * (scripts/build/tools.ts). Bumped deliberately; a stale ref only makes the
 * profile slightly less representative.
 */
export const DEFAULT_BUN_REF = "7ad2d6e9ff006420ce86aa735d5f8ad975c8bbd2";

export type Host = "linux-x64" | "linux-aarch64";

export interface Options {
  command: "rust" | "llvm" | "package" | "all" | "probe";
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
  /** oven-sh/bun ref to train on, or an existing checkout to use as-is. */
  bunRef: string;
  bunDir: string | undefined;
  jobs: number;
  bolt: boolean;
}

export function parseOptions(argv: string[]): Options {
  const checkout = resolve(import.meta.dirname, "..", "..");
  const args = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (m) args.set(m[1]!, m[2] ?? "true");
    else positional.push(arg);
  }
  const take = (name: string): string | undefined => {
    const v = args.get(name);
    args.delete(name);
    return v;
  };

  const command = (positional[0] ?? "all") as Options["command"];
  if (!["rust", "llvm", "package", "all", "probe"].includes(command) || positional.length > 1) {
    usage();
  }

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
    bunRef: take("bun-ref") ?? DEFAULT_BUN_REF,
    bunDir: take("bun-dir"),
    jobs: Number(take("jobs") ?? availableParallelism()),
    bolt: take("skip-bolt") === undefined,
  };
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
  console.error(`usage: node bun/toolchain.ts [rust|llvm|package|all|probe] [options]

  rust      build rustc + cargo the way rust-lang's dist builders do, PGO/BOLT-trained on Bun
  llvm      build clang + lld the way LLVM's release builds do, PGO/BOLT-trained on Bun
  package   assemble both into bun-toolchain-<host>.tar.zst
  all       rust, llvm, package (default)
  probe     print what this machine has (cores, memory, disk, host tools)

options:
  --build-dir=DIR      output root (default: obj/bun-toolchain)
  --host-llvm=DIR      existing LLVM used to compile everything (default: /opt/llvm)
  --mimalloc=FILE|none mimalloc.o to link into clang/lld (default: /opt/mimalloc/mimalloc.o)
  --llvm-project=DIR   llvm sources (default: src/llvm-project)
  --bun-ref=SHA        oven-sh/bun commit to train on (default: pinned)
  --bun-dir=DIR        use this Bun checkout instead of cloning --bun-ref
  --jobs=N             parallelism (default: all cores)
  --skip-bolt          PGO only`);
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
    /** cmake binary dir of the Release.cmake multi-stage build */
    llvmBuild: join(b, "llvm"),
    /** `install` of the final LLVM stage */
    llvmInstall: join(b, "llvm-install"),
    /** Bun checkout and build dirs used for training */
    bun: o.bunDir !== undefined ? resolve(o.bunDir) : join(b, "bun"),
    train: join(b, "train"),
    /** final tarball contents */
    out: join(b, "out"),
  };
}
