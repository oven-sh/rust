// One toolchain variant = one Bun build configuration whose compile the PGO/BOLT profiles are
// gathered from. The ci-* set mirrors `buildPlatforms` in oven-sh/bun .buildkite/ci.mjs and the
// flags its getBuildArgs() passes (all of them build on the linux-aarch64 host); `dev` is what a
// developer machine runs.

export interface BunTarget {
  os: "linux" | "darwin" | "windows" | "freebsd";
  arch: "x64" | "aarch64";
  abi?: "gnu" | "musl" | "android";
}

export interface Variant {
  name: string;
  target: BunTarget;
  /** scripts/build.ts arguments besides --os/--arch/--abi. */
  args: string[];
  /** Toolchain hosts that build this variant. */
  hosts: readonly ("linux-x64" | "linux-aarch64")[];
}

const CI_BUILD_HOST = ["linux-aarch64"] as const;
// .buildkite/ci.mjs getBuildArgs(target, options, "build"), minus the Buildkite artifact upload.
const ciBuild = ["--profile=ci-build", "--buildkite=off"];

function ci(target: BunTarget, extra: string[] = [], suffix = ""): Variant {
  const abi = target.os === "linux" && target.abi !== undefined && target.abi !== "gnu" ? `-${target.abi}` : "";
  return { name: `ci-${target.os}-${target.arch}${abi}${suffix}`, target, args: [...ciBuild, ...extra], hosts: CI_BUILD_HOST };
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
  // `bun bd` (package.json "bd"): debug, ASan, host only.
  { name: "dev", target: { os: "linux", arch: "x64", abi: "gnu" }, args: ["--profile=debug"], hosts: ["linux-x64"] },
  { name: "dev", target: { os: "linux", arch: "aarch64", abi: "gnu" }, args: ["--profile=debug"], hosts: ["linux-aarch64"] },
];

export function variantsFor(host: "linux-x64" | "linux-aarch64"): Variant[] {
  return VARIANTS.filter(v => v.hosts.includes(host));
}

export function findVariant(host: "linux-x64" | "linux-aarch64", name: string): Variant {
  const v = variantsFor(host).find(v => v.name === name);
  if (v === undefined) throw new Error(`no variant ${name} for ${host}; have: ${variantsFor(host).map(v => v.name).join(", ")}`);
  return v;
}

/** The executable a full build of `v` produces, relative to its build directory (for the smoke run). */
export function builtBinary(v: Variant): string {
  const exe = v.target.os === "windows" ? ".exe" : "";
  return v.args.includes("--profile=debug") ? `bun-debug${exe}` : v.args.includes("--asan=on") ? `bun-asan${exe}` : `bun${exe}`;
}
