// The platform SDKs a cross-compiled host toolchain is built against, fetched by the code and at
// the versions oven-sh/bun's own cross builds use:
//   macOS    scripts/build/macos-sdk.ts    MacOSX<version>.sdk from Apple's CDN
//   Windows  scripts/build/winsysroot.ts   MSVC CRT + Windows SDK in /winsysroot layout (xwin)
// --macos-sdk / --win-sysroot point at an existing one instead.

import { cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDone, markDone, mkdir, remove } from "./fs.ts";
import { type Options, paths } from "./options.ts";
import { run } from "./run.ts";

/** The commit of oven-sh/bun those scripts are taken from, and that the workflow builds with the result. */
export const BUN_REF = "90ae36b57f5d4099988cb6f2a0540a03dd5f23b2";

function bunScripts(o: Options): string {
  const dir = join(paths(o).sdks, "bun");
  if (!isDone(dir, BUN_REF)) {
    remove(dir);
    const git = (...args: string[]) => run(["git", ...args], { cwd: mkdir(dir) });
    git("init", "-q");
    git("remote", "add", "origin", "https://github.com/oven-sh/bun.git");
    git("sparse-checkout", "set", "scripts");
    git("fetch", "-q", "--depth=1", "--filter=blob:none", "origin", BUN_REF);
    git("checkout", "-q", "FETCH_HEAD");
    markDone(dir, BUN_REF);
  }
  return join(dir, "scripts", "build");
}

let sdk: string | undefined;

/** Where fetchSdk() put it. */
export function hostSdk(): string {
  if (sdk === undefined) throw new Error("fetchSdk() has not run");
  return sdk;
}

export async function fetchSdk(o: Options): Promise<void> {
  if (!o.cross) return;
  sdk = o.host.startsWith("darwin-")
    ? (o.macosSdkOverride ?? (await fetchMacosSdk(o)))
    : (o.winSysrootOverride ?? (await fetchWinSysroot(o)));
}

async function fetchMacosSdk(o: Options): Promise<string> {
  const { ensureMacosSdk, macosSdkCachePath } = await import(join(bunScripts(o), "macos-sdk.ts"));
  const cacheDir = paths(o).sdks;
  const osxSysroot: string = macosSdkCachePath(cacheDir);
  await ensureMacosSdk({ osxSysroot, cacheDir, darwin: true, bun: "bun", host: { os: "linux" } });
  return osxSysroot;
}

async function fetchWinSysroot(o: Options): Promise<string> {
  const { ensureWindowsSysroot, ucrtServicingLibDir } = await import(join(bunScripts(o), "winsysroot.ts"));
  const arch = o.host.split("-")[1]!;
  const winsysroot = join(paths(o).sdks, `winsysroot-${BUN_REF}`);
  const host = { os: "linux", arch: o.builder.split("-")[1]! };
  const cfg = { windows: true, arch, host, winsysroot, cacheDir: paths(o).sdks, ci: true };
  console.log("the MSVC CRT and the Windows SDK are subject to Microsoft's license terms (xwin --accept-license)");
  await ensureWindowsSysroot(cfg);
  // xwin's UCRT is an old one whose printf is broken on arm64 (UCRT_SERVICING_VERSION in
  // winsysroot.ts). Bun puts the serviced one first on its link line; the links here are CMake's
  // and cargo's, so it goes over the old one.
  const lib = join(winsysroot, "Windows Kits", "10", "Lib");
  for (const version of readdirSync(lib)) {
    cpSync(ucrtServicingLibDir(cfg), join(lib, version, "ucrt", arch === "x64" ? "x64" : "arm64"), { recursive: true });
  }
  return winsysroot;
}
