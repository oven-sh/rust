// Command line and directory layout of the toolchain build.

import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { type Builder, builderOf, type Host, HOST_TRIPLE, HOSTS } from "./hosts.ts";

/** Bump when the recipe changes in a way that must not reuse earlier stage outputs. */
export const RECIPE_VERSION = 2;

/** toolchain.ts sub-commands, in pipeline order. */
export const COMMANDS = {
  "llvm-profile": "the PGO profile clang and lld are optimized with (once per upstream LLVM commit and builder)",
  llvm: "clang + lld for --host",
  rust: "rustc and its tools for --host",
  package: "bun-toolchain-<host>-{llvm,rust}.tar.zst from the two installs",
  all: "every step above, in order (default)",
  probe: "print what this machine has (cores, memory, disk, host tools)",
  matrix: "print the workflow's build matrix as JSON; --hosts= / --halves= filter",
} as const;
export type Command = keyof typeof COMMANDS;

export type Half = "llvm" | "rust";

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
  /** True when host != builder: the result cannot run here. */
  cross: boolean;
  /** The other Linux architecture: a Linux toolchain has compiler-rt for it too. */
  otherLinuxTriple: string;
  /** An existing macOS SDK for darwin hosts; default: fetched as Bun's darwin cross builds do (lib/sdks.ts). */
  macosSdkOverride: string | undefined;
  /** An existing MSVC CRT + Windows SDK (/winsysroot layout) for windows hosts; default: fetched with xwin as Bun does (lib/sdks.ts). */
  winSysrootOverride: string | undefined;
  /** An existing LLVM install (clang, lld, llvm-profdata, llvm-bolt) used to build everything. */
  hostLlvm: string;
  /** mimalloc override object linked into clang and lld; undefined = keep the libc allocator. */
  mimalloc: string | undefined;
  /** Prefix of a static libxml2 (lib/libxml2.a, include/libxml2) for lld and llvm-mt; undefined = build them without. */
  libxml2: string | undefined;
  /** The release number (r<N>) this build is published as; recorded in the tarballs' provenance. */
  release: number | undefined;
  jobs: number;
  /** BOLT what upstream BOLTs. */
  bolt: boolean;
  /** `matrix` only. */
  hosts: readonly Host[];
  halves: readonly Half[];
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
  const path = (name: string): string | undefined => {
    const v = take(name);
    return v === undefined ? undefined : resolve(v);
  };
  const pathOrNone = (name: string, fallback: string): string | undefined => {
    const v = take(name) ?? fallback;
    return v === "none" ? undefined : resolve(v);
  };
  const oneOf = <T extends string>(name: string, allowed: readonly T[], value: string): T => {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new Error(`--${name}: one of ${allowed.join(", ")}; got ${value}`);
    }
    return value as T;
  };
  const someOf = <T extends string>(name: string, allowed: readonly T[]): readonly T[] =>
    take(name)
      ?.split(",")
      .map(v => oneOf(name, allowed, v.trim())) ?? allowed;

  const command = (positional[0] ?? "all") as Command;
  if (!(command in COMMANDS) || positional.length > 1) usage();

  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x64" : undefined;
  if (process.platform !== "linux" || arch === undefined) {
    throw new Error(
      `unsupported host ${process.platform}/${process.arch}; the toolchain build runs on linux x64/aarch64`,
    );
  }
  const builder: Builder = `linux-${arch}`;
  const host = oneOf("host", HOSTS, take("host") ?? builder);
  if (builderOf(host) !== builder)
    throw new Error(`${host} toolchains are built on ${builderOf(host)}, this is ${builder}`);

  const release = take("release");
  const options: Options = {
    command,
    checkout,
    llvmProject: path("llvm-project") ?? join(checkout, "src", "llvm-project"),
    buildDir: path("build-dir") ?? join(checkout, "obj", "bun-toolchain"),
    builder,
    builderTriple: HOST_TRIPLE[builder],
    host,
    triple: HOST_TRIPLE[host],
    cross: host !== builder,
    otherLinuxTriple: HOST_TRIPLE[builder === "linux-x64" ? "linux-aarch64" : "linux-x64"],
    macosSdkOverride: path("macos-sdk"),
    winSysrootOverride: path("win-sysroot"),
    hostLlvm: path("host-llvm") ?? "/opt/llvm",
    mimalloc: pathOrNone("mimalloc", "/opt/mimalloc/mimalloc.o"),
    libxml2: pathOrNone("libxml2", "/opt/libxml2"),
    release: release === undefined ? undefined : Number(release),
    jobs: Number(take("jobs") ?? availableParallelism()),
    bolt: take("skip-bolt") === undefined,
    hosts: someOf("hosts", HOSTS),
    halves: someOf("halves", ["llvm", "rust"]),
  };
  if (args.size > 0) {
    console.error(`unknown option(s): ${[...args.keys()].map(k => `--${k}`).join(", ")}`);
    usage();
  }
  return options;
}

function usage(): never {
  const width = Math.max(...Object.keys(COMMANDS).map(c => c.length));
  console.error(`usage: node bun/toolchain.ts [${Object.keys(COMMANDS).join("|")}] [options]

${Object.entries(COMMANDS)
  .map(([c, d]) => `  ${c.padEnd(width)}  ${d}`)
  .join("\n")}

options:
  --host=HOST          machine the toolchain runs on (default: this one): ${HOSTS.join("|")}
  --build-dir=DIR      output root (default: obj/bun-toolchain)
  --host-llvm=DIR      existing LLVM used to compile everything (default: /opt/llvm)
  --llvm-project=DIR   llvm sources (default: src/llvm-project)
  --mimalloc=FILE|none mimalloc.o to link into clang/lld (default: /opt/mimalloc/mimalloc.o)
  --libxml2=DIR|none   static libxml2 prefix for lld/llvm-mt (default: /opt/libxml2)
  --macos-sdk=DIR      an existing macOS SDK for darwin hosts (default: fetched the way Bun's build does)
  --win-sysroot=DIR    an existing MSVC CRT + Windows SDK (/winsysroot layout) for windows hosts (default: fetched with xwin)
  --release=N          release number this build is published as (recorded in toolchain-*.json)
  --jobs=N             parallelism (default: all cores)
  --skip-bolt          PGO only
  --hosts=A,B          (matrix) only these hosts
  --halves=llvm,rust   (matrix) only these halves`);
  process.exit(2);
}

/** Fixed layout under --build-dir. */
export function paths(o: Options) {
  const b = o.buildDir;
  return {
    /** what rust-lang published for the nightly (lib/upstream.ts) */
    upstream: join(b, "upstream"),
    /** the instrumented clang/lld and what they recorded */
    llvmInstrumented: join(b, "llvm-instrumented"),
    /** clang.profdata + clang-profile.json, of the builder that recorded them */
    llvmProfile: (builder: Builder) => join(b, `llvm-profile-${builder}`),
    llvmBuild: join(b, `llvm-${o.host}`),
    /** `install-distribution` of llvmBuild, then BOLTed: the finished LLVM half */
    llvmInstall: join(b, `llvm-install-${o.host}`),
    /** bootstrap.toml and bootstrap's build directory */
    rustBuild: join(b, `rust-${o.host}`),
    /** the contents of the dist tarballs: the finished Rust half */
    rustInstall: join(b, `rust-install-${o.host}`),
    /** toolchain file, compiler wrappers and compiler-rt build for a cross-compiled host (lib/cross.ts) */
    cross: join(b, `cross-${o.host}`),
    /** platform SDKs fetched for cross-compiled hosts (lib/sdks.ts) */
    sdks: join(b, "sdks"),
    /** final tarball contents */
    out: join(b, "out"),
  };
}
