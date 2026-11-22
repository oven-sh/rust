// What rust-lang published for the nightly this branch is based on, and this build uses as it is:
//   reproducible-artifacts   the PGO and BOLT profiles that nightly was optimized with, and the
//                            configuration it was built with
//   cargo                    src/tools/cargo is not forked, and cargo does not link to rustc

import { join } from "node:path";
import { download, isDone, markDone, mkdir, read, remove } from "./fs.ts";
import { type Options, paths } from "./options.ts";
import { run } from "./run.ts";

export const NIGHTLY = "2026-11-14";
/** channel-rust-nightly.toml.sha256, beside the manifest. The manifest has the sums of everything else. */
const MANIFEST_SHA256 = "9a25616b512f9fb59ab756dafcc7fa9fcaf4bba475024609c4f17fca506d3820";

/** The unpacked tarball of a component of the nightly. */
export function component(o: Options, name: "reproducible-artifacts" | "cargo", triple: string): string {
  const dir = join(paths(o).upstream, `${name}-${triple}`);
  if (isDone(dir, NIGHTLY)) return dir;
  const manifest = join(paths(o).upstream, `channel-rust-nightly-${NIGHTLY}.toml`);
  download(`https://static.rust-lang.org/dist/${NIGHTLY}/channel-rust-nightly.toml`, manifest, MANIFEST_SHA256);
  const section = read(manifest)
    .split("\n\n")
    .find(s => s.startsWith(`[pkg.${name}.target.${triple}]\n`));
  const url = section?.match(/^xz_url = "(.+)"$/m)?.[1];
  const sha256 = section?.match(/^xz_hash = "(.+)"$/m)?.[1];
  if (url === undefined || sha256 === undefined) throw new Error(`nightly-${NIGHTLY} has no ${name} for ${triple}`);
  download(url, `${dir}.tar.xz`, sha256);
  remove(dir);
  run(["tar", "-xJf", `${dir}.tar.xz`, "-C", mkdir(dir), "--strip-components=1"]);
  remove(`${dir}.tar.xz`);
  markDone(dir, NIGHTLY);
  return dir;
}

export type Profile = "rustc-pgo" | "rustdoc-pgo" | "clippy-pgo" | "llvm-pgo" | "rustc-bolt" | "LLVM-bolt";

export function profile(o: Options, triple: string, name: Profile): string {
  return join(component(o, "reproducible-artifacts", triple), "reproducible-artifacts", `${name}.profdata`);
}

/** What the nightly's `rustc -V` prints after "rustc ". */
export function version(o: Options, triple: string): string {
  return read(join(component(o, "reproducible-artifacts", triple), "version")).trim();
}

/** The arguments upstream's dist job for `triple` ran ./configure with, as configure recorded them. */
export function configureArgs(o: Options, triple: string): string[] {
  const config = read(join(component(o, "reproducible-artifacts", triple), "builder-config"));
  const line = config.match(/^configure-args = \[(.+)\]$/m)?.[1];
  if (line === undefined) throw new Error(`no configure-args in the builder-config of ${triple}`);
  return [...line.matchAll(/'([^']*)'/g)].map(m => m[1]!);
}
