// Assemble bun-toolchain-<host>/ from the two installs, check that it builds Bun, tar it up.
//
//   bin/       clang, lld (+ ld.lld, ld64.lld, lld-link, wasm-ld), llvm-* tools, rustc, cargo, rustdoc, rustfmt, clippy, miri
//   lib/       clang resource dir (headers, compiler-rt), librustc_driver, rustlib/
//   licenses/  LLVM, Rust and libstdc++ (statically linked into librustc_driver) license texts
//   toolchain.json   what this was built from, trained on, and configured with
//
// The LLVM install and the rust sysroot do not overlap, so the merge is a plain copy.

import { cpSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { type BunBuild, bunBuild, checkoutBun } from "./bun-build.ts";
import { exists, mkdir, remove, write } from "./fs.ts";
import { releaseOverrides } from "./llvm.ts";
import { type Options, paths, RECIPE_VERSION } from "./options.ts";
import { configureArgs, SHIPPED_COMPONENTS } from "./rust.ts";
import { run } from "./run.ts";

/** Files from the LLVM install a Bun build uses; everything else (cmake exports, static libLLVM*.a, bolt) is left out. */
const LLVM_BIN = [
  "clang", "clang++", "clang-cl", "clang-cpp", /^clang-\d+$/,
  "lld", "ld.lld", "ld64.lld", "lld-link", "wasm-ld",
  "llvm-ar", "llvm-ranlib", "llvm-lib", "llvm-nm", "llvm-objcopy", "llvm-objdump", "llvm-strip",
  "llvm-symbolizer", "llvm-addr2line", "llvm-profdata", "llvm-cov", "llvm-rc", "llvm-mt", "llvm-readobj", "llvm-readelf",
  "llvm-size", "llvm-dwarfdump", "llvm-cxxfilt", "llvm-config", "dsymutil",
];

/** License texts shipped in licenses/: from this checkout, and libstdc++'s from the image's GCC build. */
const LICENSES: Record<string, string> = {
  "LLVM-LICENSE.TXT": "src/llvm-project/llvm/LICENSE.TXT",
  "clang-LICENSE.TXT": "src/llvm-project/clang/LICENSE.TXT",
  "lld-LICENSE.TXT": "src/llvm-project/lld/LICENSE.TXT",
  "compiler-rt-LICENSE.TXT": "src/llvm-project/compiler-rt/LICENSE.TXT",
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
  mkdir(join(root, "bin"));

  // LLVM: selected bin/ entries + the clang resource directory.
  for (const entry of readdirSync(join(p.llvmInstall, "bin"))) {
    if (LLVM_BIN.some(m => (typeof m === "string" ? m === entry : m.test(entry)))) {
      cpSync(join(p.llvmInstall, "bin", entry), join(root, "bin", entry), { verbatimSymlinks: true });
    }
  }
  cpSync(join(p.llvmInstall, "lib", "clang"), join(root, "lib", "clang"), { recursive: true, verbatimSymlinks: true });

  // Rust: the whole installed sysroot (rust-installer already laid it out as bin/ lib/ share/).
  for (const entry of readdirSync(p.rustSysroot)) {
    if (entry === ".done") continue;
    cpSync(join(p.rustSysroot, entry), join(root, entry), { recursive: true, verbatimSymlinks: true });
  }

  copyLicenses(o, join(root, "licenses"));

  write(
    join(root, "toolchain.json"),
    JSON.stringify(
      {
        recipe: RECIPE_VERSION,
        host: o.host,
        rust: { commit: rev(o.checkout), configure: configureArgs(o), dist: SHIPPED_COMPONENTS },
        llvm: { commit: rev(o.llvmProject), cmake: releaseOverrides(o) },
        trainedOn: { bun: o.bunDir === undefined ? o.bunRef : rev(p.bun) },
        bolt: o.bolt,
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
  const dir = bunBuild(b, "smoke", { os: "linux", arch }, ["--profile=ci-release", "--buildkite=off"], { llvm: root, rust: root }, "bun");
  const version = run([join(dir, "bun"), "--version"], { capture: true }).trim();
  console.log(`smoke: built bun ${version} with ${root}`);
}

function copyLicenses(o: Options, dir: string): void {
  mkdir(dir);
  for (const [name, src] of Object.entries(LICENSES)) cpSync(join(o.checkout, src), join(dir, name));
  if (exists(GCC_LICENSE_DIR)) {
    for (const f of readdirSync(GCC_LICENSE_DIR)) cpSync(join(GCC_LICENSE_DIR, f), join(dir, `libstdc++-${f}`));
  }
}

const rev = (repo: string) => run(["git", "rev-parse", "HEAD"], { cwd: repo, capture: true, quiet: true }).trim();
const firstLine = (s: string) => s.split("\n")[0]!.trim();
