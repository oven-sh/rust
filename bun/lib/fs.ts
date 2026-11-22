import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "./run.ts";

export function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function read(path: string): string {
  return readFileSync(path, "utf8");
}

export function mkdir(path: string): string {
  mkdirSync(path, { recursive: true });
  return path;
}

export function remove(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

export { existsSync as exists };

/**
 * A stage records completion by writing `<dir>/.done` containing its cache key.
 * Re-running with the same key is a no-op; a different key rebuilds from scratch.
 */
export function isDone(dir: string, key: string): boolean {
  const marker = `${dir}/.done`;
  return existsSync(marker) && readFileSync(marker, "utf8") === key;
}

export function markDone(dir: string, key: string): void {
  write(`${dir}/.done`, key);
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** For a stage's key: the commit of a checkout, what is not committed, these scripts, and `more`. */
export function inputsKey(checkout: string, ...more: unknown[]): string {
  const git = (...args: string[]) => run(["git", ...args], { cwd: checkout, capture: true, quiet: true });
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
  const scripts = readdirSync(import.meta.dirname).map(f => sha256(join(import.meta.dirname, f)));
  return createHash("sha256")
    .update(git("rev-parse", "HEAD"))
    .update(git("diff", "--no-ext-diff", "--binary", "HEAD"))
    .update(JSON.stringify([untracked.map(f => [f, lstatSync(join(checkout, f)).mtimeMs]), scripts, more]))
    .digest("hex")
    .slice(0, 16);
}

/** Fetch `url` to `path`, unless it is there already; the file has to have this sum. */
export function download(url: string, path: string, expectedSha256: string): void {
  if (existsSync(path) && sha256(path) === expectedSha256) return;
  mkdir(dirname(path));
  run(["curl", "-fsSL", "--retry", "8", "--retry-delay", "5", "-o", path, url]);
  const got = sha256(path);
  if (got !== expectedSha256) throw new Error(`${url}: sha256 is ${got}, expected ${expectedSha256}`);
}
