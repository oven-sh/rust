// Process execution. Every external command the toolchain build runs goes through
// `run`, which prints the command line, streams its output, times it, and throws
// on a non-zero exit.

import { spawnSync, type SpawnSyncOptions } from "node:child_process";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Capture and return stdout instead of streaming it. */
  capture?: boolean;
  /** Don't echo the command line (for version probes). */
  quiet?: boolean;
}

export function run(argv: string[], opts: RunOptions = {}): string {
  const [cmd, ...args] = argv;
  if (cmd === undefined) throw new Error("run: empty argv");
  if (!opts.quiet) console.log(`\n$ ${argv.map(shellQuote).join(" ")}${opts.cwd ? `   (in ${opts.cwd})` : ""}`);
  const started = Date.now();
  const spawnOpts: SpawnSyncOptions = {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdio: opts.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    maxBuffer: 1 << 30,
  };
  const result = spawnSync(cmd, args, spawnOpts);
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with ${result.status ?? `signal ${result.signal}`} after ${seconds}s`);
  }
  if (!opts.quiet && Number(seconds) >= 5) console.log(`  (${seconds}s)`);
  return typeof result.stdout === "string" ? result.stdout : "";
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}
