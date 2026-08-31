// Turn a finished install into a release asset. Each half ships on its own:
//
//   bun-toolchain-<host>-<variant>-llvm.tar.zst   clang, lld (+ ld.lld, ld64.lld, lld-link, wasm-ld),
//                                                llvm-* tools; lib/clang (headers, compiler-rt)
//   bun-toolchain-<host>-<variant>-rust.tar.zst   rustc, cargo, rustdoc, rustfmt, clippy, miri;
//                                                librustc_driver, libLLVM, lib/rustlib/
//
// Both unpack to bin/ lib/ licenses/ toolchain-{llvm,rust}.json and do not overlap, so a
// consumer extracts the pair into one directory and points BUN_TOOLCHAIN_LLVM and
// BUN_TOOLCHAIN_RUST at it (or keeps them apart). No smoke build here: the BOLT training pass
// that produced each half already built the variant's Bun with the finished compilers.

import { cpSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { exists, mkdir, read, remove, write } from "./fs.ts";
import { llvmProvenance } from "./llvm.ts";
import { type Options, paths, RECIPE_VERSION } from "./options.ts";
import { configureArgs, SHIPPED_COMPONENTS } from "./rust.ts";
import { run } from "./run.ts";

export type Half = "llvm" | "rust";

/** Rust's license texts, from this checkout; LLVM's arrive in llvm-install/licenses (lib/llvm.ts). */
const RUST_LICENSES: Record<string, string> = {
  "rust-COPYRIGHT": "COPYRIGHT",
  "rust-LICENSE-APACHE": "LICENSE-APACHE",
  "rust-LICENSE-MIT": "LICENSE-MIT",
};
// libstdc++/libgcc are statically linked into librustc_driver.so: GPL-3.0 with the GCC Runtime
// Library Exception (which is what permits that). bun/Dockerfile leaves the texts here; a host
// without that GCC build links the system's copies instead.
const GCC_LICENSE_DIR = "/opt/gcc/share/licenses";

export function assetName(o: Options, half: Half): string {
  return `bun-toolchain-${o.host}-${o.variant.name}-${half}`;
}

/** Package whichever halves have a finished install under --build-dir; returns the tarballs. */
export function packageToolchain(o: Options): string[] {
  const p = paths(o);
  const halves = (["llvm", "rust"] as const).filter(h => exists(join(h === "llvm" ? p.llvmInstall : p.rustInstall, ".done")));
  if (halves.length === 0) throw new Error(`nothing to package: neither ${p.llvmInstall} nor ${p.rustInstall} is finished`);
  remove(p.out);
  return halves.map(h => packageHalf(o, h));
}

function packageHalf(o: Options, half: Half): string {
  const p = paths(o);
  const install = half === "llvm" ? p.llvmInstall : p.rustInstall;
  const name = assetName(o, half);
  const root = join(p.out, name);
  mkdir(root);
  for (const entry of readdirSync(install)) {
    if (entry === ".done" || entry === "llvm-project.rev") continue;
    cpSync(join(install, entry), join(root, entry), { recursive: true, verbatimSymlinks: true });
  }

  const common = {
    recipe: RECIPE_VERSION,
    host: o.host,
    variant: { name: o.variant.name, target: o.variant.target, args: o.variant.args },
    trainedOn: { bun: o.bunDir === undefined ? o.bunRef : rev(p.bun) },
  };
  if (half === "llvm") {
    write(join(root, "toolchain-llvm.json"), json({
      ...common,
      llvm: { commit: read(join(install, "llvm-project.rev")).trim(), cmake: llvmProvenance(o) },
      bolt: o.llvmBolt,
      mimalloc: o.mimalloc !== undefined,
      clang: firstLine(run([join(root, "bin", "clang"), "--version"], { capture: true })),
    }));
  } else {
    for (const [file, src] of Object.entries(RUST_LICENSES)) cpSync(join(o.checkout, src), join(root, "licenses", file));
    if (exists(GCC_LICENSE_DIR)) {
      for (const f of readdirSync(GCC_LICENSE_DIR)) cpSync(join(GCC_LICENSE_DIR, f), join(root, "licenses", `libstdc++-${f}`));
    }
    write(join(root, "toolchain-rust.json"), json({
      ...common,
      rust: { commit: rev(o.checkout), configure: configureArgs(o), dist: SHIPPED_COMPONENTS },
      bolt: o.rustBolt,
      rustc: firstLine(run([join(root, "bin", "rustc"), "-vV"], { capture: true })),
    }));
  }

  const tarball = join(p.out, `${name}.tar.zst`);
  run(["tar", "-I", `zstd -19 -T${o.jobs}`, "-cf", tarball, "-C", p.out, name]);
  console.log(`${tarball} (${(statSync(tarball).size / 2 ** 20).toFixed(0)} MiB)`);
  return tarball;
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const rev = (repo: string) => run(["git", "rev-parse", "HEAD"], { cwd: repo, capture: true, quiet: true }).trim();
const firstLine = (s: string) => s.split("\n")[0]!.trim();
