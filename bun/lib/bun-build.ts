// Driving Bun's own build system (scripts/build.ts + ninja) with a given toolchain.
// Used by the training workload and by the smoke test of the packaged toolchain.

import { join } from "node:path";
import { exists, mkdir, read, remove, write } from "./fs.ts";
import { run } from "./run.ts";

export interface BunTarget {
  os: "linux" | "darwin" | "windows";
  arch: "x64" | "aarch64";
}

export interface BunBuild {
  /** Bun checkout */
  bunDir: string;
  /** where build directories go */
  outDir: string;
  jobs: number;
}

/** BUN_TOOLCHAIN_* as scripts/build/tools.ts in oven-sh/bun reads them; unset = Bun's default (rustup's pinned nightly). */
export interface Toolchain {
  llvm: string;
  rust?: string;
  cargo?: string;
}

/**
 * Configure a Bun build directory `name` for `target` with scripts/build.ts `args`,
 * then build `ninjaTarget` in it ("default": what `bun run build` would; null:
 * configure only). Returns the directory.
 */
export function bunBuild(b: BunBuild, name: string, target: BunTarget, args: string[], toolchain: Toolchain, ninjaTarget: string | null): string {
  const dir = join(b.outDir, name);
  remove(dir);
  // Only the toolchain selection reaches Bun's build; flags meant for building the
  // toolchain itself (x.py's RUSTFLAGS, C(XX)FLAGS) do not.
  const env: Record<string, string | undefined> = {
    BUN_TOOLCHAIN_LLVM: toolchain.llvm,
    BUN_TOOLCHAIN_RUST: toolchain.rust,
    BUN_TOOLCHAIN_CARGO: toolchain.cargo,
    RUSTFLAGS: undefined,
    CARGO_ENCODED_RUSTFLAGS: undefined,
    CFLAGS: undefined,
    CXXFLAGS: undefined,
    LDFLAGS: undefined,
  };
  run(
    [process.execPath, join(b.bunDir, "scripts", "build.ts"), ...args, `--os=${target.os}`, `--arch=${target.arch}`, `--buildDir=${dir}`, "--configure-only"],
    { cwd: b.bunDir, env },
  );
  if (ninjaTarget !== null) ninja(b, dir, ninjaTarget);
  return dir;
}

export function ninja(b: BunBuild, dir: string, target: string): void {
  run(["ninja", "-C", dir, `-j${b.jobs}`, ...(target === "default" ? [] : [target])], { env: { NINJA_STATUS: "[%f/%t %es] " } });
}

/** Make `bunDir` a checkout of oven-sh/bun at `ref` (a .ref stamp records what is there, like Bun's own dep fetcher). */
export function checkoutBun(bunDir: string, ref: string): void {
  const stamp = join(bunDir, ".bun-toolchain-ref");
  if (exists(stamp) && read(stamp) === ref) return;
  if (!exists(join(bunDir, ".git"))) {
    mkdir(bunDir);
    run(["git", "init", "-q"], { cwd: bunDir });
    run(["git", "remote", "add", "origin", "https://github.com/oven-sh/bun.git"], { cwd: bunDir });
  }
  run(["git", "fetch", "-q", "--depth=1", "origin", ref], { cwd: bunDir });
  run(["git", "checkout", "-q", "--force", "FETCH_HEAD"], { cwd: bunDir });
  write(stamp, ref);
}
