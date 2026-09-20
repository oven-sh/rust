import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
