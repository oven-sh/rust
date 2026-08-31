// Build the Bun toolchain: rustc/cargo and clang/lld from this repository and its
// src/llvm-project submodule, each built with its upstream release recipe and
// PGO/BOLT-trained on compiling Bun. See bun/README.md.
//
//   node bun/toolchain.ts [command] [--option=value ...]   (commands: lib/options.ts COMMANDS)

import { freemem, totalmem } from "node:os";
import { statfsSync } from "node:fs";
import { buildFinal as buildLlvm, buildInstrumented as buildLlvmInstrumented } from "./lib/llvm.ts";
import { type Command, type Options, parseOptions } from "./lib/options.ts";
import { packageToolchain } from "./lib/package.ts";
import { buildRust } from "./lib/rust.ts";
import { VARIANTS } from "./lib/variants.ts";
import { run } from "./lib/run.ts";
import { mkdir } from "./lib/fs.ts";

const [major] = process.versions.node.split(".").map(Number);
if (major! < 25) throw new Error(`node ${process.versions.node}: need node 25 or newer (runs .ts directly)`);

const options = parseOptions(process.argv.slice(2));
if (options.command === "matrix") {
  // What the workflow runs: `pairs` — one llvm and one rust job per (host, variant); `hosts` —
  // one image and one llvm-instrumented job per host that has a pair; `halves` — which of
  // llvm / rust to build at all. The workflow maps a host to a runner label.
  const pairs = VARIANTS.filter(v => options.variantFilter === undefined || options.variantFilter.includes(v.name)).flatMap(v => v.hosts.map(host => ({ host, variant: v.name })));
  if (pairs.length === 0) throw new Error(`--variants=${options.variantFilter?.join(",")} matches no variant`);
  const hosts = [...new Set(pairs.map(p => p.host))].map(host => ({ host }));
  process.stdout.write(JSON.stringify({ pairs: { include: pairs }, hosts: { include: hosts }, halves: options.halves }) + "\n");
  process.exit(0);
}
mkdir(options.buildDir);
probe(options);

const steps: Record<Command, () => void> = {
  probe: () => {},
  "llvm-instrumented": () => buildLlvmInstrumented(options),
  llvm: () => buildLlvm(options),
  rust: () => buildRust(options),
  package: () => packageToolchain(options),
  matrix: () => {},
  all: () => {
    buildLlvmInstrumented(options);
    buildLlvm(options);
    buildRust(options);
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
  console.log(`variant     ${o.variant.name} (${[`--os=${o.variant.target.os}`, `--arch=${o.variant.target.arch}`, ...o.variant.args].join(" ")})`);
  console.log(`bolt        llvm: ${o.llvmBolt ? "yes" : "no"}, rust: ${o.rustBolt ? "yes" : "no"}`);
  console.log(`mimalloc    ${o.mimalloc ?? "no (libc malloc)"}\n`);
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
