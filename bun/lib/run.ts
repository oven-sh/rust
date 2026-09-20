// Process execution. Every external command the toolchain build runs goes through
// `run`, which prints the command line, streams its output, times it, and throws
// on a non-zero exit.

import { spawn, spawnSync, type SpawnSyncOptions } from "node:child_process";

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
    // `undefined` in opts.env removes the variable
    env: opts.env ? (Object.fromEntries(Object.entries({ ...process.env, ...opts.env }).filter(([, v]) => v !== undefined)) as Record<string, string>) : process.env,
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

/** Run several commands at once (output interleaved), wait for all, throw if any failed. */
export async function runConcurrently(argvs: string[][]): Promise<void> {
  const results = await Promise.all(
    argvs.map(
      argv =>
        new Promise<string | undefined>(resolve => {
          console.log(`\n$ ${argv.map(shellQuote).join(" ")} &`);
          const started = Date.now();
          const child = spawn(argv[0]!, argv.slice(1), { stdio: "inherit" });
          child.on("error", e => resolve(`${argv[0]}: ${e.message}`));
          child.on("exit", (code, signal) => {
            console.log(`  (${argv[0]} ${argv[1] ?? ""}: ${((Date.now() - started) / 1000).toFixed(0)}s)`);
            resolve(code === 0 ? undefined : `${argv[0]} exited with ${code ?? `signal ${signal}`}`);
          });
        }),
    ),
  );
  const failed = results.filter(r => r !== undefined);
  if (failed.length > 0) throw new Error(failed.join("; "));
}

function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}
