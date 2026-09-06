// One toolchain variant = (host it runs on, name). A trained variant is PGO/BOLT-profiled on one
// Bun build configuration; a plain one is upstream's release build with no training (for hosts
// the pipeline cannot execute: it cross-compiles them from a Linux builder). The ci-* set
// mirrors `buildPlatforms` in oven-sh/bun .buildkite/ci.mjs and the flags its getBuildArgs()
// passes (all of them build on the linux-aarch64 host); `dev` is what a developer machine runs.

export interface BunTarget {
  os: "linux" | "darwin" | "windows" | "freebsd";
  arch: "x64" | "aarch64";
  abi?: "gnu" | "musl" | "android";
}

/** Machines the pipeline runs on (GitHub runner labels are derived from these). */
export type Builder = "linux-x64" | "linux-aarch64";
/** Machines a toolchain runs on. */
export type Host = Builder | "darwin-aarch64" | "windows-x64" | "windows-aarch64";

export const HOSTS: readonly Host[] = ["linux-x64", "linux-aarch64", "darwin-aarch64", "windows-x64", "windows-aarch64"];

export const HOST_TRIPLE: Record<Host, string> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-aarch64": "aarch64-unknown-linux-gnu",
  "darwin-aarch64": "aarch64-apple-darwin",
  "windows-x64": "x86_64-pc-windows-msvc",
  "windows-aarch64": "aarch64-pc-windows-msvc",
};

/** Which builder produces a host's toolchains: Linux hosts natively, everything else cross from linux-x64. */
export function builderOf(host: Host): Builder {
  return host === "linux-x64" || host === "linux-aarch64" ? host : "linux-x64";
}

export interface Variant {
  name: string;
  host: Host;
  /** The Bun build the PGO/BOLT profiles come from; undefined = plain build, no training. */
  train: { target: BunTarget; /** scripts/build.ts arguments besides --os/--arch/--abi. */ args: string[] } | undefined;
}

// .buildkite/ci.mjs getBuildArgs(target, options, "build"), minus the Buildkite artifact upload.
const ciBuild = ["--profile=ci-build", "--buildkite=off"];

function ci(target: BunTarget, extra: string[] = [], suffix = ""): Variant {
  const abi = target.os === "linux" && target.abi !== undefined && target.abi !== "gnu" ? `-${target.abi}` : "";
  return { name: `ci-${target.os}-${target.arch}${abi}${suffix}`, host: "linux-aarch64", train: { target, args: [...ciBuild, ...extra] } };
}

export const VARIANTS: readonly Variant[] = [
  ci({ os: "darwin", arch: "aarch64" }),
  ci({ os: "darwin", arch: "x64" }),
  ci({ os: "linux", arch: "aarch64", abi: "gnu" }),
  ci({ os: "linux", arch: "x64", abi: "gnu" }),
  ci({ os: "linux", arch: "x64", abi: "gnu" }, ["--asan=on"], "-asan"),
  ci({ os: "linux", arch: "aarch64", abi: "musl" }),
  ci({ os: "linux", arch: "x64", abi: "musl" }),
  ci({ os: "linux", arch: "aarch64", abi: "android" }),
  ci({ os: "linux", arch: "x64", abi: "android" }),
  ci({ os: "freebsd", arch: "x64" }),
  ci({ os: "freebsd", arch: "aarch64" }),
  ci({ os: "windows", arch: "x64" }),
  ci({ os: "windows", arch: "aarch64" }),
  // `bun bd` (package.json "bd"): a debug, ASan build for the machine it runs on. Trained where
  // the pipeline can run the host's binaries; a plain release build elsewhere.
  { name: "dev", host: "linux-x64", train: { target: { os: "linux", arch: "x64", abi: "gnu" }, args: ["--profile=debug"] } },
  { name: "dev", host: "linux-aarch64", train: { target: { os: "linux", arch: "aarch64", abi: "gnu" }, args: ["--profile=debug"] } },
  { name: "dev", host: "darwin-aarch64", train: undefined },
  { name: "dev", host: "windows-x64", train: undefined },
  { name: "dev", host: "windows-aarch64", train: undefined },
];

export function variantsFor(host: Host): Variant[] {
  return VARIANTS.filter(v => v.host === host);
}

export function findVariant(host: Host, name: string): Variant {
  const v = variantsFor(host).find(v => v.name === name);
  if (v === undefined) throw new Error(`no variant ${name} for host ${host}; have: ${variantsFor(host).map(v => v.name).join(", ") || "(none)"}`);
  return v;
}
