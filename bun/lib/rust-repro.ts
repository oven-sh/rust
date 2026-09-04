// `toolchain.ts rust-repro --pgo-dir=DIR`: rebuild the stage2 rustc that a previous CI run built —
// same source, same configure arguments, and *that run's* PGO profiles (its uploaded
// rustc-pgo.profdata / rustdoc-pgo.profdata / llvm-pgo.profdata in DIR) instead of freshly
// gathered ones — then BOLT-instrument its librustc_driver.so the way opt-dist does and run the
// rustc command that crashed in that run. For chasing a failure that depends on the exact code
// layout a particular profile produced. Writes the pre-BOLT and instrumented libraries plus the
// outcome under <build-dir>/out/rust-repro/.

import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdir, remove, write } from "./fs.ts";
import { type Options, paths } from "./options.ts";
import { bunDeltas, configureArgs } from "./rust.ts";
import { run } from "./run.ts";

export function rustRepro(o: Options, args: Map<string, string>): void {
  const pgoDir = args.get("pgo-dir");
  if (pgoDir === undefined) throw new Error("--pgo-dir=DIR (a downloaded profiles-<host>-<variant>-rust artifact) is required");
  for (const f of ["rustc-pgo.profdata", "rustdoc-pgo.profdata", "llvm-pgo.profdata"]) {
    if (!existsSync(join(pgoDir, f))) throw new Error(`${join(pgoDir, f)} is missing`);
  }
  const p = paths(o);
  const build = join(p.rustBuild, "build");
  const out = join(p.out, "rust-repro");
  mkdir(p.rustBuild);
  mkdir(out);
  const env = { RUST_BOOTSTRAP_CONFIG: join(p.rustBuild, "bootstrap.toml"), ...bunDeltas(o).env };

  // 1. configure, as buildRust does
  remove(env.RUST_BOOTSTRAP_CONFIG);
  run([join(o.checkout, "configure"), ...configureArgs(o)], { cwd: p.rustBuild, env });

  // 2. what opt-dist's "Build PGO optimized rustc" + "Build PGO optimized LLVM" (BOLT stage) amount
  //    to, in one bootstrap invocation: stage2 compiler + std with the given profiles, rustc's
  //    libraries linked with -Wl,-q (--enable-bolt-settings / llvm.ldflags) so BOLT can rewrite them.
  run(
    [
      "python3", join(o.checkout, "x.py"), "build",
      "--target", o.triple, "--host", o.triple, "--stage", "2", "library/std", "rustdoc",
      "--set", `pgo.rustc.use=${join(pgoDir, "rustc-pgo.profdata")}`,
      "--set", `pgo.rustdoc.use=${join(pgoDir, "rustdoc-pgo.profdata")}`,
      "--set", `pgo.llvm.use=${join(pgoDir, "llvm-pgo.profdata")}`,
      "--enable-bolt-settings",
      "--set", "llvm.ldflags=-Wl,-q",
    ],
    { cwd: p.rustBuild, env: { ...env, RUST_BACKTRACE: "full" } },
  );

  // 3. instrument librustc_driver.so as opt-dist's with_bolt_instrumented does, keep both copies
  const libdir = join(build, o.triple, "stage2", "lib");
  const driver = run(["sh", "-c", `ls ${libdir}/librustc_driver-*.so`], { capture: true }).trim();
  const name = driver.split("/").pop()!;
  cpSync(driver, join(out, name));
  const profileDir = join(out, "prof");
  mkdir(profileDir);
  run([
    join(o.hostLlvm, "bin", "llvm-bolt"), "-instrument", driver,
    `--instrumentation-file=${join(profileDir, "prof.fdata")}`, "--instrumentation-file-append-pid",
    "-o", join(out, `${name}.instrumented`),
  ]);
  cpSync(join(out, `${name}.instrumented`), driver);

  // 4. the command that crashed: cargo's target-info probe as Bun's build invokes it (verbatim from
  //    the failed jobs' logs). The --check-cfg arguments matter: CheckCfg::fill_well_known, where
  //    both crashes were, returns immediately unless check-cfg is enabled.
  const rustc = join(build, o.triple, "stage2", "bin", "rustc");
  write(join(out, "empty.rs"), "");
  const t = o.variant.target;
  const targetTriple = ({ "linux-x64": "x86_64-unknown-linux-gnu", "linux-x64-musl": "x86_64-unknown-linux-musl", "linux-aarch64": "aarch64-unknown-linux-gnu", "linux-aarch64-musl": "aarch64-unknown-linux-musl", "linux-x64-android": "x86_64-linux-android", "linux-aarch64-android": "aarch64-linux-android", "darwin-x64": "x86_64-apple-darwin", "darwin-aarch64": "aarch64-apple-darwin", "windows-x64": "x86_64-pc-windows-msvc", "windows-aarch64": "aarch64-pc-windows-msvc", "freebsd-x64": "x86_64-unknown-freebsd", "freebsd-aarch64": "aarch64-unknown-freebsd" } as Record<string, string>)[`${t.os}-${t.arch}${t.abi ? `-${t.abi}` : ""}`] ?? o.triple;
  const cpuFlags = t.arch === "x64" ? ["-Ctarget-cpu=nehalem"] : ["-Ctarget-cpu=generic", "-Ctarget-feature=+crc", "-Ztune-cpu=ampere1"];
  const probe = [rustc, "-", "--crate-name", "___", "--print=file-names", "-Crelocation-model=static", "-Cforce-frame-pointers=yes", "-Cllvm-args=-addrsig", "-Zshare-generics=y", ...cpuFlags, "--check-cfg=cfg(bun_asan)", "--check-cfg=cfg(bun_debug)", "--check-cfg=cfg(bun_codegen_embed)", "--cfg=bun_codegen_embed", "--check-cfg=cfg(socket_fault_injection)", "-Zlocation-detail=none", "-Clink-arg=-fuse-ld=lld", "-Clink-arg=-Qunused-arguments", "-Alinker_messages", "-Clinker-plugin-lto", "-Cembed-bitcode=yes", "-Cforce-unwind-tables=no", "--target", targetTriple, "--crate-type", "bin", "--crate-type", "rlib", "--crate-type", "dylib", "--crate-type", "cdylib", "--crate-type", "staticlib", "--crate-type", "proc-macro", "--print=sysroot", "--print=split-debuginfo", "--print=crate-name", "--print=cfg"];
  write(join(out, "probe.sh"), `#!/bin/sh\n# the crashing command; $1 = path to stage2\nexec "$1/bin/rustc" ${probe.slice(1).map(a => `'${a}'`).join(" ")} < /dev/null\n`);
  let failures = 0;
  for (const [i, lib] of [[0, "pre-BOLT"], ...Array.from({ length: 20 }, (_, k) => [k + 1, "instrumented"])] as [number, string][]) {
    cpSync(join(out, lib === "pre-BOLT" ? name : `${name}.instrumented`), driver);
    const r = run(["sh", "-c", `${probe.map(a => `'${a}'`).join(" ")} < ${join(out, "empty.rs")} > ${join(out, `probe-${i}.out`)} 2>&1; echo $?`], { capture: true }).trim();
    console.log(`probe ${i} (${lib}): exit ${r}`);
    if (r !== "0") {
      if (lib === "instrumented") failures++;
      console.log(run(["tail", "-40", join(out, `probe-${i}.out`)], { capture: true }));
    }
  }
  write(join(out, "result.txt"), `instrumented ${name}: ${failures}/20 probe runs failed (probe.sh has the command)\n`);
  console.log(`rust-repro: instrumented ${name}: ${failures}/20 probe runs failed; libraries in ${out}`);
  // Keep the whole stage2 (bin/rustc + lib/, pre-BOLT libraries) so later experiments on an arm64
  // machine can rerun probes against differently rewritten libraries without rebuilding.
  cpSync(join(out, name), driver);
  run(["tar", "-I", `zstd -10 -T${o.jobs}`, "-cf", join(out, "stage2.tar.zst"), "-C", join(build, o.triple), "stage2"]);
}
