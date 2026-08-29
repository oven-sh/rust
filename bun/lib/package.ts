// Assemble bun-toolchain-<host>/ from the two installs, check that it builds Bun, tar it up.
//
//   bin/       clang, lld (+ ld.lld, ld64.lld, lld-link, wasm-ld), llvm-* tools, rustc, cargo, rustdoc, rustfmt, clippy, miri
//   lib/       clang resource dir (headers, compiler-rt), librustc_driver, libLLVM, rustlib/
//   licenses/  LLVM, Rust and libstdc++ (statically linked into librustc_driver) license texts
//   toolchain.json   what this was built from, trained on, and configured with

import { cpSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type BunBuild, bunBuild, checkoutBun } from "./bun-build.ts";
import { exists, mkdir, read, remove, write } from "./fs.ts";
import { releaseOverrides } from "./llvm.ts";
import { type Options, paths, RECIPE_VERSION } from "./options.ts";
import { configureArgs, SHIPPED_COMPONENTS } from "./rust.ts";
import { run } from "./run.ts";

/** Rust's license texts, from this checkout; LLVM's arrive in llvm-install/licenses (lib/llvm.ts). */
const RUST_LICENSES: Record<string, string> = {
  "rust-COPYRIGHT": "COPYRIGHT",
  "rust-LICENSE-APACHE": "LICENSE-APACHE",
  "rust-LICENSE-MIT": "LICENSE-MIT",
};
// libstdc++/libgcc are statically linked into librustc_driver.so: GPL-3.0 with the GCC
// Runtime Library Exception (which is what permits that). bun/Dockerfile leaves the
// texts here; a host without that GCC build links the system's copies instead.
const GCC_LICENSE_DIR = "/opt/gcc/share/licenses";

export function packageToolchain(o: Options): string {
  const p = paths(o);
  const name = `bun-toolchain-${o.host}`;
  const root = join(p.out, name);
  remove(p.out);
  mkdir(root);

  // Both installs are already laid out as bin/ lib/ (share/, licenses/); they do not overlap.
  for (const install of [p.llvmInstall, p.rustSysroot]) {
    for (const entry of readdirSync(install)) {
      if (entry === ".done" || entry === "llvm-project.rev") continue;
      cpSync(join(install, entry), join(root, entry), { recursive: true, verbatimSymlinks: true });
    }
  }
  for (const [name, src] of Object.entries(RUST_LICENSES)) cpSync(join(o.checkout, src), join(root, "licenses", name));
  if (exists(GCC_LICENSE_DIR)) {
    for (const f of readdirSync(GCC_LICENSE_DIR)) cpSync(join(GCC_LICENSE_DIR, f), join(root, "licenses", `libstdc++-${f}`));
  }

  write(
    join(root, "toolchain.json"),
    JSON.stringify(
      {
        recipe: RECIPE_VERSION,
        host: o.host,
        rust: { commit: rev(o.checkout), configure: configureArgs(o), dist: SHIPPED_COMPONENTS },
        llvm: { commit: read(join(p.llvmInstall, "llvm-project.rev")).trim(), cmake: releaseOverrides(o) },
        trainedOn: { bun: o.bunDir === undefined ? o.bunRef : rev(p.bun) },
        bolt: o.bolt,
        mimalloc: o.mimalloc !== undefined,
        clang: firstLine(run([join(root, "bin", "clang"), "--version"], { capture: true })),
        rustc: firstLine(run([join(root, "bin", "rustc"), "-vV"], { capture: true })),
      },
      null,
      2,
    ) + "\n",
  );

  smoke(o, root);

  const tarball = join(p.out, `${name}.tar.zst`);
  run(["tar", "--zstd", "-cf", tarball, "-C", p.out, name], { env: { ZSTD_CLEVEL: "19", ZSTD_NBTHREADS: String(o.jobs) } });
  console.log(`\n${tarball} (${(statSync(tarball).size / 2 ** 20).toFixed(0)} MiB)`);
  return tarball;
}

/** The check before anything is uploaded: the packaged toolchain builds a Bun that runs. */
function smoke(o: Options, root: string): void {
  const p = paths(o);
  if (o.bunDir === undefined) checkoutBun(p.bun, o.bunRef);
  const b: BunBuild = { bunDir: p.bun, outDir: p.train, jobs: o.jobs };
  const arch = o.host === "linux-x64" ? "x64" : "aarch64";
  const dir = bunBuild(b, "smoke", { os: "linux", arch }, ["--profile=ci-build", "--buildkite=off"], { llvm: root, rust: root }, "bun");
  const version = run([join(dir, "bun"), "--version"], { capture: true }).trim();
  console.log(`smoke: built bun ${version} with ${root}`);
}

const rev = (repo: string) => run(["git", "rev-parse", "HEAD"], { cwd: repo, capture: true, quiet: true }).trim();
const firstLine = (s: string) => s.split("\n")[0]!.trim();
