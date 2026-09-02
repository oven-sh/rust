// `toolchain.ts bolt-lab`: run llvm-bolt on a saved BOLT input (opt-dist's opt-artifacts/bolt-inputs:
// a pre-BOLT libLLVM.so / librustc_driver.so and its merged .fdata) with a chosen flag set, per-pass
// timers, a hard timeout and a peak-RSS report — to find out, in minutes rather than a full
// pipeline run, which library / pass / option makes the aarch64 rewrite stall.
//
//   toolchain.ts bolt-lab --bolt-inputs=DIR [--bolt-lib=libLLVM|librustc_driver|all]
//                          [--bolt-flags=opt-dist|minimal|"<flags>"] [--bolt-timeout=45m]

import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "./options.ts";
import { run } from "./run.ts";

const FLAG_SETS: Record<string, string[]> = {
  // src/tools/opt-dist/src/bolt.rs (aarch64: profile2)
  "opt-dist": ["-reorder-blocks=ext-tsp", "-reorder-functions=cdsort", "-split-functions", "-split-strategy=profile2", "-split-all-cold", "-jump-tables=move", "-icf=all", "-update-debug-sections", "-dyno-stats"],
  "no-debug-update": ["-reorder-blocks=ext-tsp", "-reorder-functions=cdsort", "-split-functions", "-split-strategy=profile2", "-split-all-cold", "-jump-tables=move", "-icf=all", "-dyno-stats"],
  "no-split": ["-reorder-blocks=ext-tsp", "-reorder-functions=cdsort", "-jump-tables=move", "-icf=all", "-dyno-stats"],
  lite: ["-lite", "-reorder-blocks=ext-tsp", "-reorder-functions=cdsort", "-split-functions", "-split-all-cold", "-dyno-stats"],
  minimal: ["-reorder-blocks=ext-tsp"],
};

export function boltLab(o: Options, args: Map<string, string>): void {
  const dir = args.get("bolt-inputs");
  if (dir === undefined) throw new Error("--bolt-inputs=DIR (a downloaded opt-artifacts/bolt-inputs) is required");
  const which = args.get("bolt-lib") ?? "all";
  const flagArg = args.get("bolt-flags") ?? "opt-dist";
  const flags = FLAG_SETS[flagArg] ?? flagArg.split(/\s+/);
  const timeout = args.get("bolt-timeout") ?? "45m";
  const libs = readdirSync(dir).filter(f => f.endsWith(".so") || /\.so\.[\d.]+-rust/.test(f)).filter(f => !f.endsWith(".fdata"));
  const measure = "import resource,subprocess,sys,time;t=time.time();r=subprocess.run(sys.argv[1:]);u=resource.getrusage(resource.RUSAGE_CHILDREN);print(f'[bolt-lab] exit={r.returncode} wall={time.time()-t:.0f}s maxrss={u.ru_maxrss//1024}MiB',file=sys.stderr,flush=True);sys.exit(0)";
  for (const lib of libs) {
    if (which !== "all" && !lib.startsWith(which)) continue;
    const fdata = join(dir, `${lib}.fdata`);
    console.log(`\n=== bolt-lab: ${lib}  flags=${flagArg}  timeout=${timeout}`);
    run(["python3", "-c", measure, "timeout", "--verbose", "-k", "60s", timeout, join(o.hostLlvm, "bin", "llvm-bolt"), join(dir, lib), "-data", fdata, "-o", join(dir, `${lib}.bolted`), "-time-rewrite", "-time-opts", ...flags]);
  }
}
