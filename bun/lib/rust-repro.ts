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

  // 4. the command cargo runs first and that crashed (cargo's target-info probe), verbatim from the
  //    failed job's log minus the lane-specific codegen flags, against the instrumented library.
  const rustc = join(build, o.triple, "stage2", "bin", "rustc");
  write(join(out, "empty.rs"), "");
  const probe = [rustc, "-", "--crate-name", "___", "--print=file-names", "--crate-type", "bin", "--crate-type", "rlib", "--print=sysroot", "--print=split-debuginfo", "--print=crate-name", "--print=cfg"];
  let failures = 0;
  // Run it a number of times: if the defect is in the rewritten code it fails every time; if it
  // only shows under some runtime condition, repetition raises the odds.
  for (let i = 0; i < 20; i++) {
    const r = run(["sh", "-c", `${probe.map(a => `'${a}'`).join(" ")} < ${join(out, "empty.rs")} > ${join(out, `probe-${i}.out`)} 2>&1; echo $?`], { capture: true }).trim();
    if (r !== "0") {
      failures++;
      console.log(`probe ${i}: exit ${r}\n${run(["tail", "-30", join(out, `probe-${i}.out`)], { capture: true })}`);
    }
  }
  write(join(out, "result.txt"), `instrumented ${name}: ${failures}/20 probe runs failed\n`);
  console.log(`rust-repro: instrumented ${name}: ${failures}/20 probe runs failed; libraries in ${out}`);
  // Restore the pre-BOLT library so the build dir stays usable.
  cpSync(join(out, name), driver);
}
