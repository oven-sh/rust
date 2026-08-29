// Build the Bun toolchain: rustc/cargo and clang/lld from this repository and its
// src/llvm-project submodule, each built with its upstream release recipe and
// PGO/BOLT-trained on compiling Bun. See bun/README.md.
//
//   node bun/toolchain.ts [rust|llvm|package|all|probe] [--option=value ...]

import { freemem, totalmem } from "node:os";
import { statfsSync } from "node:fs";
import { buildLlvm } from "./lib/llvm.ts";
import { type Options, parseOptions } from "./lib/options.ts";
import { packageToolchain } from "./lib/package.ts";
import { buildRust } from "./lib/rust.ts";
import { run } from "./lib/run.ts";
import { mkdir } from "./lib/fs.ts";

const [major] = process.versions.node.split(".").map(Number);
if (major! < 25) throw new Error(`node ${process.versions.node}: need node 25 or newer (runs .ts directly)`);

const options = parseOptions(process.argv.slice(2));
mkdir(options.buildDir);
probe(options);

const steps: Record<Options["command"], () => void> = {
  probe: () => {},
  rust: () => buildRust(options),
  llvm: () => buildLlvm(options),
  package: () => packageToolchain(options),
  all: () => {
    buildRust(options); // first: the LLVM stage's training links Bun, which needs this rustc
    buildLlvm(options);
    packageToolchain(options);
  },
};
steps[options.command]();

function probe(o: Options): void {
  const gib = (n: number) => `${(n / 2 ** 30).toFixed(0)} GiB`;
  const disk = statfsSync(o.buildDir);
  console.log(`host        ${o.host} (${o.triple}), ${o.jobs} jobs`);
  console.log(`memory      ${gib(freemem())} free of ${gib(totalmem())}`);
  console.log(`disk        ${gib(disk.bavail * disk.bsize)} free under ${o.buildDir}`);
  console.log(`checkout    ${o.checkout} @ ${git(o.checkout)}`);
  console.log(`llvm        ${o.llvmProject} @ ${git(o.llvmProject)}`);
  console.log(`host llvm   ${version([`${o.hostLlvm}/bin/clang`, "--version"])}`);
  console.log(`            ${version([`${o.hostLlvm}/bin/llvm-bolt`, "--version"]).replace(/\s+/g, " ").slice(0, 60)}`);
  for (const tool of [["cmake", "--version"], ["ninja", "--version"], ["python3", "--version"], ["node", "--version"], ["bun", "--version"]]) {
    console.log(`${tool[0]!.padEnd(12)}${version(tool)}`);
  }
  console.log(`bun ref     ${o.bunDir ?? o.bunRef}`);
  console.log(`bolt        ${o.bolt ? "yes" : "no"}\n`);
}

function git(dir: string): string {
  try {
    return run(["git", "rev-parse", "--short=12", "HEAD"], { cwd: dir, capture: true, quiet: true }).trim();
  } catch {
    return "(not a git checkout)";
  }
}

function version(argv: string[]): string {
  try {
    return run(argv, { capture: true, quiet: true }).split("\n").find(l => l.trim().length > 0)?.trim() ?? "?";
  } catch {
    return "MISSING";
  }
}
