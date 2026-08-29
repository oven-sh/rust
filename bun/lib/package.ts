// Assemble bun-toolchain-<host>/ from the two installs and tar it up.
//
//   bin/      clang, lld (+ ld.lld, ld64.lld, lld-link, wasm-ld), llvm-* tools, rustc, cargo, rustdoc, rustfmt, clippy
//   lib/      clang resource dir (headers, compiler-rt), librustc_driver, libLLVM (rustc's), rustlib/
//   toolchain.json   what this was built from
//
// The LLVM install and the rust sysroot do not overlap (rustc's own libLLVM is
// versioned as libLLVM.so.<N>-rust-<ver>), so the merge is a plain copy.

import { cpSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { mkdir, remove, write } from "./fs.ts";
import { type Options, paths, RECIPE_VERSION } from "./options.ts";
import { run } from "./run.ts";

/** Files from the LLVM install a Bun build uses; everything else (cmake exports, static libLLVM*.a, bolt) is left out. */
const LLVM_BIN = [
  "clang", "clang++", "clang-cl", "clang-cpp", /^clang-\d+$/,
  "lld", "ld.lld", "ld64.lld", "lld-link", "wasm-ld",
  "llvm-ar", "llvm-ranlib", "llvm-lib", "llvm-nm", "llvm-objcopy", "llvm-objdump", "llvm-strip",
  "llvm-symbolizer", "llvm-addr2line", "llvm-profdata", "llvm-cov", "llvm-rc", "llvm-mt", "llvm-readobj", "llvm-readelf",
  "llvm-size", "llvm-dwarfdump", "llvm-cxxfilt", "llvm-config", "dsymutil",
];

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

  write(
    join(root, "toolchain.json"),
    JSON.stringify(
      {
        recipe: RECIPE_VERSION,
        host: o.host,
        rust: rev(o.checkout),
        llvm: rev(o.llvmProject),
        trainedOn: { bun: o.bunDir === undefined ? o.bunRef : rev(p.bun) },
        bolt: o.bolt,
        clang: firstLine(run([join(root, "bin", "clang"), "--version"], { capture: true })),
        rustc: firstLine(run([join(root, "bin", "rustc"), "-vV"], { capture: true })),
      },
      null,
      2,
    ) + "\n",
  );

  const tarball = join(p.out, `${name}.tar.zst`);
  run(["tar", "--zstd", "-cf", tarball, "-C", p.out, name], { env: { ZSTD_CLEVEL: "19", ZSTD_NBTHREADS: String(o.jobs) } });
  console.log(`\n${tarball} (${(statSync(tarball).size / 2 ** 20).toFixed(0)} MiB)`);
  return tarball;
}

const rev = (repo: string) => run(["git", "rev-parse", "HEAD"], { cwd: repo, capture: true }).trim();
const firstLine = (s: string) => s.split("\n")[0]!.trim();
