// Run a packaged toolchain on the machine it is for, the ways Bun's build does.
//
//   node bun/smoke.ts WORK_DIR bun-toolchain-<host>-llvm.tar.zst bun-toolchain-<host>-rust.tar.zst
//
// With one tarball, what takes only that half.

import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, readdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { exists, mkdir, remove, write } from "./lib/fs.ts";
import { run } from "./lib/run.ts";

const [workArg, ...tarballs] = process.argv.slice(2);
if (workArg === undefined || tarballs.length === 0) throw new Error("usage: smoke.ts WORK_DIR TARBALL...");
const work = resolve(workArg);
const windows = process.platform === "win32";
const darwin = process.platform === "darwin";
const linux = process.platform === "linux";
const exe = windows ? ".exe" : "";

remove(work);
const toolchain = mkdir(join(work, "toolchain"));
for (const tarball of tarballs) {
  // Not every runner has zstd; the GNU tar of Git for Windows reads "C:" as a host name.
  const tar = join(work, "unpacking.tar");
  await pipeline(createReadStream(tarball), createZstdDecompress(), createWriteStream(tar));
  run([windows ? "C:\\Windows\\System32\\tar.exe" : "tar", "-xf", tar, "-C", toolchain, "--strip-components=1"]);
  remove(tar);
}
const bin = (name: string) => join(toolchain, "bin", name + exe);
const llvm = exists(join(toolchain, "toolchain-llvm.json"));
const rust = exists(join(toolchain, "toolchain-rust.json"));
// Rustup's proxies and variables are on some runners.
const env = {
  PATH: join(toolchain, "bin") + delimiter + process.env.PATH,
  RUSTUP_TOOLCHAIN: undefined,
  CARGO_HOME: join(work, "cargo-home"),
  // LLVM's clang does not ask xcrun; Bun's build passes -isysroot.
  ...(darwin ? { SDKROOT: run(["xcrun", "--show-sdk-path"], { capture: true }).trim() } : {}),
};

const failed: string[] = [];
/** `knownBug`: how and why it fails here. It has to, so that a fix comes with removing the excuse. */
function check(
  name: string,
  when: boolean,
  body: (dir: string) => void,
  knownBug?: { failure: RegExp; why: string },
): void {
  if (!when) return;
  console.log(`\n::group::${name}`);
  let failure: string | undefined;
  try {
    body(mkdir(join(work, name.replace(/\W+/g, "-"))));
  } catch (error) {
    failure = (error as Error).message;
  }
  console.log("::endgroup::");
  if (knownBug?.failure.test(failure ?? "")) return console.log(`known bug: ${name}: ${knownBug.why}`);
  if (knownBug !== undefined) failure ??= `passes, and was expected to fail: ${knownBug.why}`;
  if (failure === undefined) return console.log(`ok: ${name}`);
  console.log(`::error::${name}: ${failure}`);
  failed.push(name);
}
const output = (cwd: string, ...argv: string[]) =>
  run(argv, { cwd, env, capture: true }).trim().replaceAll("\r\n", "\n");
const sh = (cwd: string, ...argv: string[]) => void run(argv, { cwd, env });
function expect(got: string, expected: string): void {
  if (got !== expected) throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
}

/** Compile and link C++ for this machine with clang (clang-cl on Windows). */
function link(dir: string, out: string, inputs: string[], flags: string[], linker: "lld" | "default" = "lld"): string {
  const ld = linker === "lld" ? ["-fuse-ld=lld"] : [];
  if (windows)
    sh(
      dir,
      bin("clang-cl"),
      "/std:c++20",
      "/EHsc",
      ...flags.map(f => `/clang:${f}`),
      ...ld,
      ...inputs,
      `/Fe${out}.exe`,
    );
  else sh(dir, bin("clang++"), "-std=c++20", "-pthread", ...flags, ...ld, ...inputs, "-o", out);
  return join(dir, out + exe);
}

check("every program starts", true, dir => {
  const scripts = /^(rust-(gdb|gdbgui|lldb|windbg)|git-clang-format)/;
  // lld wants to be called by one of its other names; llvm-rc and llvm-cvtres take /options
  const noVersion = /^(lld|llvm-(rc|cvtres|mt|lib|dlltool|ml|ml64|lipo|libtool-darwin|windres)|miri|cargo-miri)$/;
  for (const file of readdirSync(join(toolchain, "bin"))) {
    if (windows && !file.endsWith(".exe")) continue;
    const name = file.replace(/\.exe$/, "");
    if (scripts.test(name)) continue;
    const result = spawnSync(bin(name), [noVersion.test(name) ? "--help" : "--version"], {
      cwd: dir,
      encoding: "utf8",
    });
    const said = `${result.stdout}${result.stderr}`.trim();
    console.log(`${name.padEnd(26)}${said.split("\n").find(l => /\d/.test(l)) ?? said.split("\n")[0]}`.slice(0, 160));
    // A loader that cannot find a library or a symbol: 127 (glibc), SIGABRT (dyld), an NTSTATUS
    const started = result.status !== null && result.status < 126 && (result.status === 0 || noVersion.test(name));
    if (!started) throw new Error(`${name}: ${result.error ?? result.signal ?? result.status}\n${said}`);
  }
});

check("clang and rustc are the same LLVM", llvm && rust, dir => {
  const clang = output(dir, bin("clang"), "--version").match(/clang version (\d+\.\d+\.\d+)/)![1]!;
  expect(output(dir, bin("rustc"), "-vV").match(/^LLVM version: (.+)$/m)![1]!, clang);
});

const cpp = `#include <algorithm>
#include <cstdio>
#include <map>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
int main() {
  std::map<std::string, int> m;
  std::thread t([&] { for (int i = 0; i < 100; i++) m["k" + std::to_string(i % 7)] += i; });
  t.join();
  std::vector<int> v;
  for (auto& [k, n] : m) v.push_back(n);
  std::sort(v.rbegin(), v.rend());
  try { v.at(7); } catch (const std::out_of_range&) { std::printf("%d %s %.2f\\n", v[0], "caught", v[6] / 4.0); }
}
`;
for (const flags of [["-O0", "-g"], ["-O2"], ["-O3", "-g", "-flto=thin"]]) {
  check(
    `C++ ${flags.join(" ")}`,
    llvm,
    dir => {
      write(join(dir, "a.cpp"), cpp);
      expect(output(dir, link(dir, "a", ["a.cpp"], flags)), "750 caught 166.25");
    },
    darwin && flags.includes("-flto=thin")
      ? {
          failure: /\/a exited with signal SIGABRT/,
          why: "ld64.lld writes a second, empty __unwind_info entry for the first function, for the ltmp0 label of LTO's empty object file at the same address",
        }
      : undefined,
  );
}
check("C++ ThinLTO with Apple's linker", llvm && darwin, dir => {
  write(join(dir, "a.cpp"), cpp);
  expect(output(dir, link(dir, "a", ["a.cpp"], ["-O2", "-flto=thin"], "default")), "750 caught 166.25");
});

check("ASan and UBSan", llvm && !windows, dir => {
  write(
    join(dir, "a.cpp"),
    `#include <cstdlib>
int main(int argc, char**) { int* p = new int[4]; int n = p[argc + 3]; delete[] p; return n; }
`,
  );
  const program = link(dir, "a", ["a.cpp"], ["-g", "-fsanitize=address,undefined"], darwin ? "default" : "lld");
  // On macOS it would prefer atos, which a runner does not let attach.
  const ASAN_SYMBOLIZER_PATH = bin("llvm-symbolizer");
  const { status, stderr } = spawnSync(program, { env: { ...process.env, ASAN_SYMBOLIZER_PATH }, encoding: "utf8" });
  console.log(stderr);
  if (status === 0 || !/heap-buffer-overflow[^]*in main .*a\.cpp:2/.test(stderr))
    throw new Error("no symbolized report");
});

check("ASan: none of malloc(0) is usable", llvm && !windows, dir => {
  write(
    join(dir, "a.cpp"),
    `#include <cstdio>
#include <cstdlib>
#ifdef __APPLE__
#include <malloc/malloc.h>
#define malloc_usable_size malloc_size
#else
#include <malloc.h>
#endif
int main() { void* p = malloc(0); std::printf("%zu\\n", malloc_usable_size(p)); free(p); }
`,
  );
  expect(output(dir, link(dir, "a", ["a.cpp"], ["-fsanitize=address"], darwin ? "default" : "lld")), "0");
});

check("objects for every target", llvm, dir => {
  write(
    join(dir, "a.c"),
    `int f(const int* p, int n) { int s = 0; for (int i = 0; i < n; i++) s += p[i] * 3; return s; }\n`,
  );
  for (const [target, format] of Object.entries({
    "x86_64-unknown-linux-gnu": "elf64-x86-64",
    "aarch64-unknown-linux-gnu": "elf64-littleaarch64",
    "x86_64-apple-macos13": "mach-o 64-bit x86-64",
    "arm64-apple-macos13": "mach-o arm64",
    "x86_64-pc-windows-msvc": "coff-x86-64",
    "aarch64-pc-windows-msvc": "coff-arm64",
  })) {
    sh(dir, bin("clang"), `--target=${target}`, "-O2", "-g", "-c", "a.c", "-o", `${target}.o`);
    expect(output(dir, bin("llvm-objdump"), "-d", `${target}.o`).match(/file format (.+)/)![1]!, format);
    // the same through each port of lld, with the code generated at link time
    sh(
      dir,
      bin("clang"),
      `--target=${target}`,
      "-O2",
      "-g",
      "-flto=thin",
      ...(target.includes("linux") ? ["-fPIC"] : []),
      "-c",
      "a.c",
      "-o",
      `${target}.bc.o`,
    );
    if (target.includes("linux")) sh(dir, bin("ld.lld"), "-shared", `${target}.bc.o`, "-o", `${target}.so`);
    else if (target.includes("windows"))
      sh(
        dir,
        bin("lld-link"),
        "/dll",
        "/noentry",
        "/nodefaultlib",
        "/debug",
        "/export:f",
        `${target}.bc.o`,
        `/out:${target}.dll`,
      );
    else
      sh(
        dir,
        bin("ld64.lld"),
        "-dylib",
        "-arch",
        target.split("-")[0]!,
        "-platform_version",
        "macos",
        "13.0",
        "13.0",
        `${target}.bc.o`,
        "-o",
        `${target}.dylib`,
      );
  }
});

check("compiler-rt for both Linux architectures", llvm && linux, dir => {
  const resources = output(dir, bin("clang"), "-print-resource-dir");
  for (const triple of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]) {
    for (const lib of ["builtins", "asan", "ubsan_standalone", "profile"]) {
      if (!exists(join(resources, "lib", triple, `libclang_rt.${lib}.a`))) throw new Error(`no ${lib} for ${triple}`);
    }
  }
});

check("lld-link merges manifests", llvm && !windows, dir => {
  write(join(dir, "a.c"), "int mainCRTStartup(void) { return 0; }\n");
  write(
    join(dir, "a.manifest"),
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0"/>\n`,
  );
  sh(dir, bin("clang"), "--target=x86_64-pc-windows-msvc", "-c", "a.c", "-o", "a.obj");
  sh(
    dir,
    bin("lld-link"),
    "/nodefaultlib",
    "/subsystem:console",
    "/manifest:embed",
    "/manifestinput:a.manifest",
    "a.obj",
    "/out:a.exe",
  );
});

const host = rust ? output(work, bin("rustc"), "-vV").match(/^host: (.+)$/m)![1]! : "";

function cargoProject(dir: string): void {
  write(
    join(dir, "Cargo.toml"),
    `[workspace]
members = ["derive"]
[package]
name = "smoke"
edition = "2024"
[lib]
crate-type = ["staticlib", "rlib"]
[dependencies]
derive = { path = "derive" }
[profile.release]
panic = "abort"
`,
  );
  write(join(dir, "build.rs"), `fn main() {\n    println!("cargo::rustc-env=FROM_BUILD_RS=7");\n}\n`);
  write(join(dir, "derive", "Cargo.toml"), `[package]\nname = "derive"\nedition = "2024"\n[lib]\nproc-macro = true\n`);
  write(
    join(dir, "derive", "src", "lib.rs"),
    `use proc_macro::TokenStream;

#[proc_macro]
pub fn six(_: TokenStream) -> TokenStream {
    "6u64".parse().unwrap()
}
`,
  );
  write(
    join(dir, "src", "lib.rs"),
    `use std::collections::HashMap;

/// \`\`\`
/// assert_eq!(smoke::answer(1), 42);
/// \`\`\`
#[unsafe(no_mangle)]
pub extern "C" fn answer(n: u64) -> u64 {
    let m: HashMap<u64, u64> = (0..=n).map(|i| (i, i * derive::six!())).collect();
    m[&n] * env!("FROM_BUILD_RS").parse::<u64>().unwrap()
}

#[test]
fn unit() {
    assert_eq!(answer(2), 84);
}
`,
  );
  write(join(dir, "src", "main.rs"), `fn main() {\n    println!("{}", smoke::answer(1));\n}\n`);
}

check("cargo build, test, clippy, fmt", rust, dir => {
  cargoProject(dir);
  expect(output(dir, bin("cargo"), "run", "-q"), "42");
  expect(output(dir, bin("cargo"), "run", "-q", "--release"), "42");
  sh(dir, bin("cargo"), "test", ...(exists(bin("rustdoc")) ? [] : ["--lib"]));
  sh(dir, bin("cargo"), "clippy", "--workspace", "--", "-Dwarnings");
  sh(dir, bin("cargo"), "fmt", "--all", "--check");
});

check("cargo miri", rust && exists(bin("miri")), dir => {
  cargoProject(dir);
  sh(dir, bin("cargo"), "miri", "test", "--lib");
});

check("cross-language ThinLTO with -Zbuild-std", llvm && rust, dir => {
  cargoProject(dir);
  run(
    [
      bin("cargo"),
      "build",
      "--lib",
      "--release",
      "--target",
      host,
      "-Zbuild-std=core,alloc,std,proc_macro,panic_abort",
    ],
    {
      cwd: dir,
      env: { ...env, RUSTFLAGS: `-Clinker-plugin-lto${windows ? " -Ctarget-feature=+crt-static" : ""}` },
    },
  );
  write(
    join(dir, "main.cpp"),
    `#include <cstdint>\n#include <cstdio>\nextern "C" uint64_t answer(uint64_t);\nint main(int argc, char**) { std::printf("%d\\n", (int)answer(argc)); }\n`,
  );
  const lib = join(dir, "target", host, "release", windows ? "smoke.lib" : "libsmoke.a");
  const system = windows
    ? ["ntdll.lib", "userenv.lib", "ws2_32.lib", "dbghelp.lib", "synchronization.lib"]
    : linux
      ? ["-ldl", "-lpthread"]
      : [];
  expect(output(dir, link(dir, "main", ["main.cpp", lib, ...system], ["-O2", "-flto=thin"])), "42");
});

if (failed.length > 0) {
  console.log(`\nfailed: ${failed.join("; ")}`);
  process.exit(1);
}
console.log("\nall checks passed");
