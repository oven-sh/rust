// Turn a finished install into a release asset. Each half ships on its own:
//
//   bun-toolchain-<host>-llvm.tar.zst   clang, lld, llvm-* tools; lib/clang (headers, compiler-rt)
//   bun-toolchain-<host>-rust.tar.zst   rustc, cargo and their tools; librustc_driver, libLLVM, lib/rustlib
//
// Both unpack to bin/ lib/ licenses/ toolchain-{llvm,rust}.json and do not overlap, so a
// consumer extracts the pair into one directory and points BUN_TOOLCHAIN_LLVM and
// BUN_TOOLCHAIN_RUST at it (or keeps them apart).

import { cpSync, linkSync, lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { exists, mkdir, read, remove, sha256, write } from "./fs.ts";
import { boltsLlvm, finalCache, profileDir } from "./llvm.ts";
import { type Half, type Options, paths, RECIPE_VERSION } from "./options.ts";
import { run } from "./run.ts";
import { boltsRust, components, configureArgs } from "./rust.ts";
import { BUN_REF } from "./sdks.ts";
import { NIGHTLY } from "./upstream.ts";

/**
 * Of what both halves link statically on Linux, where bun/Dockerfile leaves them. libstdc++ and
 * libgcc: GPL-3.0 with the GCC Runtime Library Exception (which is what permits that).
 */
const STATIC_LIBRARY_LICENSES: Record<string, string> = {
  "libstdc++": "/opt/gcc/share/licenses",
  zstd: "/usr/local/share/licenses/zstd",
};

/** Package whichever halves have a finished install under --build-dir. */
export function packageToolchain(o: Options): void {
  const p = paths(o);
  const installs = { llvm: p.llvmInstall, rust: p.rustInstall };
  const halves = (["llvm", "rust"] as const).filter(h => exists(join(installs[h], ".done")));
  if (halves.length === 0)
    throw new Error(`nothing to package: neither ${p.llvmInstall} nor ${p.rustInstall} is finished`);
  for (const half of halves) packageHalf(o, half, installs[half]);
}

function packageHalf(o: Options, half: Half, install: string): void {
  const p = paths(o);
  const name = `bun-toolchain-${o.host}-${half}`;
  const root = join(p.out, name);
  remove(root);
  mkdir(join(root, "licenses"));
  for (const entry of readdirSync(install)) {
    if (entry === ".done" || entry === "llvm-project.rev") continue;
    cpSync(join(install, entry), join(root, entry), { recursive: true, verbatimSymlinks: true });
  }

  // The halves share licenses/, so each names its copy.
  for (const [library, dir] of o.cross ? [] : Object.entries(STATIC_LIBRARY_LICENSES)) {
    for (const f of exists(dir) ? readdirSync(dir) : [])
      cpSync(join(dir, f), join(root, "licenses", `${half}-${library}-${f}`));
  }

  const common = {
    release: o.release === undefined ? null : `r${o.release}`,
    recipe: RECIPE_VERSION,
    host: o.host,
    nightly: NIGHTLY,
    commit: rev(o.checkout),
    sdkFrom: o.cross ? { bun: BUN_REF } : null,
  };
  if (half === "llvm") {
    const profile = profileDir(o);
    write(
      join(root, "toolchain-llvm.json"),
      json({
        ...common,
        llvm: { commit: read(join(install, "llvm-project.rev")).trim(), cmake: finalCache(o) },
        pgo: profile === undefined ? null : JSON.parse(read(join(profile, "clang-profile.json"))),
        bolt: boltsLlvm(o),
      }),
    );
  } else {
    for (const f of ["COPYRIGHT", "LICENSE-APACHE", "LICENSE-MIT"])
      cpSync(join(o.checkout, f), join(root, "licenses", `rust-${f}`));
    write(
      join(root, "toolchain-rust.json"),
      json({
        ...common,
        llvm: { commit: rev(join(o.checkout, "src", "llvm-project")) },
        rust: { configure: configureArgs(o), dist: components(o) },
        pgo: !o.cross,
        bolt: boltsRust(o),
      }),
    );
  }

  // Identical files (clang-cl.exe = clang.exe, lld-link.exe = lld.exe, … on hosts where LLVM
  // installs copies instead of symlinks; the libLLVM.so of rustc and of llvm-tools) become
  // hardlinks: tar stores each once, and extraction recreates them as links or copies, whichever
  // the filesystem supports.
  hardlinkDuplicates(root);
  const tarball = join(p.out, `${name}.tar.zst`);
  // 19 takes up to two minutes
  const level = o.release === undefined ? 6 : 19;
  run(["tar", "-I", `zstd -${level} -T${o.jobs}`, "-cf", tarball, "-C", p.out, name]);
  console.log(`${tarball} (${(statSync(tarball).size / 2 ** 20).toFixed(0)} MiB)`);
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const rev = (repo: string) => run(["git", "rev-parse", "HEAD"], { cwd: repo, capture: true, quiet: true }).trim();

function hardlinkDuplicates(dir: string): void {
  const bySize = new Map<number, string[]>();
  for (const f of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
    const st = lstatSync(join(dir, f));
    if (!st.isFile() || st.size < 1 << 20) continue;
    bySize.set(st.size, [...(bySize.get(st.size) ?? []), f]);
  }
  for (const files of bySize.values()) {
    if (files.length < 2) continue;
    const first = new Map<string, string>();
    for (const f of files) {
      const d = sha256(join(dir, f));
      const orig = first.get(d);
      if (orig === undefined) first.set(d, f);
      else {
        rmSync(join(dir, f));
        linkSync(join(dir, orig), join(dir, f));
      }
    }
  }
}
