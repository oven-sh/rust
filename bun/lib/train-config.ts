// The training workload (bun/train.ts) runs as a child of opt-dist or of LLVM's
// CMake, not of toolchain.ts, so its inputs travel as environment variables.

import { type Options, paths } from "./options.ts";

export interface TrainConfig {
  /** Bun checkout to build. */
  bunDir: string;
  /** Git ref to put that checkout at when toolchain.ts clones it (unset = leave as is). */
  bunRef: string | undefined;
  /** Scratch space for Bun build directories. */
  trainDir: string;
  /** rustc sysroot (bin/rustc, bin/cargo) for the clang phase's cargo step; the rust phase gets its compiler from opt-dist. */
  rustSysroot: string;
  /** LLVM providing clang for the rust phase's C/C++ (Bun's build always configures a C toolchain). */
  hostLlvm: string;
  host: Options["host"];
  jobs: number;
}

export function trainingEnv(o: Options): Record<string, string> {
  const p = paths(o);
  const config: TrainConfig = {
    bunDir: p.bun,
    bunRef: o.bunDir === undefined ? o.bunRef : undefined,
    trainDir: p.train,
    rustSysroot: p.rustSysroot,
    hostLlvm: o.hostLlvm,
    host: o.host,
    jobs: o.jobs,
  };
  return { BUN_TRAIN_CONFIG: JSON.stringify(config) };
}

export function readTrainingEnv(): TrainConfig {
  const raw = process.env.BUN_TRAIN_CONFIG;
  if (raw === undefined) throw new Error("BUN_TRAIN_CONFIG is not set; bun/train.ts is meant to be started by bun/toolchain.ts");
  return JSON.parse(raw) as TrainConfig;
}
