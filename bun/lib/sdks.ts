// The platform SDKs a cross-compiled host toolchain is built against, fetched the way oven-sh/bun's
// own build fetches them for its cross targets (same tools, same pinned versions, read from the
// Bun checkout this build trains on) so the toolchain and the Bun builds it serves agree:
//   macOS    scripts/build/macos-sdk.ts + xmac.mjs → MacOSX<version>.sdk from Apple's CDN
//   Windows  scripts/build/winsysroot.ts (xwin)     → MSVC CRT + Windows SDK in /winsysroot layout
// --macos-sdk / --win-sysroot point at an existing one instead.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { checkoutBun } from "./bun-build.ts";
import { mkdir, remove } from "./fs.ts";
import { type Options, paths } from "./options.ts";
import { run } from "./run.ts";

function bunCheckout(o: Options): string {
  const p = paths(o);
  if (o.bunDir === undefined) checkoutBun(p.bun, o.bunRef);
  return p.bun;
}

/** Read exported string constants from one of Bun's build scripts. */
function bunPins(o: Options, module: string, names: string[]): Record<string, string> {
  const bun = bunCheckout(o);
  const src = `import * as m from "./${module}"; console.log(JSON.stringify({ ${names.map(n => `${n}: m.${n}`).join(", ")} }))`;
  const out = run(["bun", "-e", src], { cwd: join(bun, "scripts", "build"), capture: true, quiet: true });
  return JSON.parse(out.trim().split("\n").pop()!);
}

export function macosSdk(o: Options): string {
  if (o.macosSdkOverride !== undefined) return o.macosSdkOverride;
  const { MACOS_SDK_VERSION, MACOS_SDK_CLT_RELEASE } = bunPins(o, "macos-sdk.ts", ["MACOS_SDK_VERSION", "MACOS_SDK_CLT_RELEASE"]);
  const dir = join(paths(o).sdks, `MacOSX${MACOS_SDK_VERSION}.sdk`);
  if (!existsSync(join(dir, "SDKSettings.json"))) {
    console.log(`fetching MacOSX${MACOS_SDK_VERSION}.sdk (Command Line Tools ${MACOS_SDK_CLT_RELEASE}) from Apple's software-update CDN, as oven-sh/bun's darwin cross builds do; subject to Apple's SDK license terms`);
    const staging = `${dir}.staging`;
    remove(staging);
    mkdir(paths(o).sdks);
    run(["bun", join(bunCheckout(o), "scripts", "build", "xmac.mjs"), "splat", "--accept-license", "--sdk-only", "--release", MACOS_SDK_CLT_RELEASE!, "--sdk", MACOS_SDK_VERSION!, "--output", staging, "--cache-dir", join(paths(o).sdks, "xmac")]);
    // xmac lays the package out as <staging>/SDKs/MacOSX<version>.sdk (macos-sdk.ts moves that into place the same way).
    const inner = join(staging, "SDKs", `MacOSX${MACOS_SDK_VERSION}.sdk`);
    if (!existsSync(join(inner, "SDKSettings.json"))) throw new Error(`xmac did not produce ${inner}`);
    run(["mv", inner, dir]);
    remove(staging);
  }
  return dir;
}

export function winSysroot(o: Options): string {
  if (o.winSysrootOverride !== undefined) return o.winSysrootOverride;
  const { XWIN_VERSION, WINDOWS_SDK_VERSION, MSVC_CRT_VERSION } = bunPins(o, "winsysroot.ts", ["XWIN_VERSION", "WINDOWS_SDK_VERSION", "MSVC_CRT_VERSION"]);
  const s = paths(o).sdks;
  const dir = join(s, `winsysroot-${WINDOWS_SDK_VERSION}-${MSVC_CRT_VERSION}`);
  if (!existsSync(join(dir, "Windows Kits")) || !existsSync(join(dir, "VC"))) {
    mkdir(s);
    const triple = `${o.builder === "linux-aarch64" ? "aarch64" : "x86_64"}-unknown-linux-musl`;
    const xwin = join(s, `xwin-${XWIN_VERSION}`, `xwin-${XWIN_VERSION}-${triple}`, "xwin");
    if (!existsSync(xwin)) {
      mkdir(join(s, `xwin-${XWIN_VERSION}`));
      run(["sh", "-c", `curl -fsSL --retry 5 https://github.com/Jake-Shadle/xwin/releases/download/${XWIN_VERSION}/xwin-${XWIN_VERSION}-${triple}.tar.gz | tar -xz -C '${join(s, `xwin-${XWIN_VERSION}`)}'`]);
    }
    console.log(`fetching the MSVC CRT ${MSVC_CRT_VERSION} + Windows SDK ${WINDOWS_SDK_VERSION} with xwin ${XWIN_VERSION}, as oven-sh/bun's windows cross builds do; subject to Microsoft's license terms (xwin --accept-license)`);
    remove(dir);
    run([xwin, "--accept-license", "--arch", "x86_64,aarch64", "--sdk-version", WINDOWS_SDK_VERSION!, "--crt-version", MSVC_CRT_VERSION!, "--include-atl", "--cache-dir", join(s, "xwin-dl"), "splat", "--use-winsysroot-style", "--preserve-ms-arch-notation", "--include-debug-libs", "--output", dir]);
  }
  return dir;
}
