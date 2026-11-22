/** Machines the pipeline builds on (GitHub runner labels are derived from these). */
export type Builder = "linux-x64" | "linux-aarch64";
/** Machines a toolchain runs on. */
export type Host = Builder | "darwin-aarch64" | "windows-x64" | "windows-aarch64";

export const HOSTS: readonly Host[] = [
  "linux-x64",
  "linux-aarch64",
  "darwin-aarch64",
  "windows-x64",
  "windows-aarch64",
];

export const HOST_TRIPLE: Record<Host, string> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-aarch64": "aarch64-unknown-linux-gnu",
  "darwin-aarch64": "aarch64-apple-darwin",
  "windows-x64": "x86_64-pc-windows-msvc",
  "windows-aarch64": "aarch64-pc-windows-msvc",
};

/** Which builder produces a host's toolchain: Linux hosts natively, everything else cross from linux-x64. */
export function builderOf(host: Host): Builder {
  return host === "linux-x64" || host === "linux-aarch64" ? host : "linux-x64";
}

/**
 * The builder whose profile of clang (lib/llvm-profile.ts) a host's clang and lld are optimized
 * with. A profile names functions by their mangled names, so one from Linux says nothing about a
 * Windows build.
 */
export function profileOf(host: Host): Builder | undefined {
  return host.startsWith("windows-") ? undefined : host === "linux-x64" ? "linux-x64" : "linux-aarch64";
}
