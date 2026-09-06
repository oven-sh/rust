// Build the Bun toolchain: rustc/cargo and clang/lld from this repository and its
// src/llvm-project submodule, each built with its upstream release recipe and
// PGO/BOLT-trained on compiling Bun. See bun/README.md.
//
//   node bun/toolchain.ts [command] [--option=value ...]   (commands: lib/options.ts COMMANDS)

import { freemem, totalmem, cpus } from "node:os";
import { statfsSync, readFileSync } from "node:fs";
import { buildFinal as buildLlvm, buildInstrumented as buildLlvmInstrumented, buildPlain as buildLlvmPlain } from "./lib/llvm.ts";
import { type Command, type Options, parseOptions } from "./lib/options.ts";
import { packageToolchain } from "./lib/package.ts";
import { buildRust, buildRustPlain } from "./lib/rust.ts";
import { builderOf, VARIANTS } from "./lib/variants.ts";
import { run } from "./lib/run.ts";
import { mkdir } from "./lib/fs.ts";

const [major] = process.versions.node.split(".").map(Number);
if (major! < 25) throw new Error(`node ${process.versions.node}: need node 25 or newer (runs .ts directly)`);

const options = parseOptions(process.argv.slice(2));
if (options.command === "matrix") {
  // What the workflow runs: `pairs` — one llvm and one rust job per (host, variant), each on its
  // builder; `builders` — one image job per builder that has a pair; `trained` — the builders that
  // need the PGO-instrumented LLVM stage (a pair that trains); `halves` — which of llvm / rust to
  // build at all. The workflow maps a builder to a runner label.
  const pairs = VARIANTS.filter(v => (options.variantFilter === undefined || options.variantFilter.includes(v.name)) && (options.hostFilter === undefined || options.hostFilter.includes(v.host)))
    .map(v => ({ builder: builderOf(v.host), host: v.host, variant: v.name, plain: v.train === undefined }));
  if (pairs.length === 0) throw new Error(`--variants=${options.variantFilter?.join(",")} --hosts=${options.hostFilter?.join(",")} matches no variant`);
  const builders = [...new Set(pairs.map(p => p.builder))].map(builder => ({ builder }));
  const trained = [...new Set(pairs.filter(p => !p.plain).map(p => p.builder))].map(builder => ({ builder }));
  // GitHub's `needs` cannot vary per matrix entry, so trained and plain pairs are separate lists
  // (the trained llvm job waits for the instrumented stage; the plain one only for the image).
  const only = (plain: boolean) => ({ include: pairs.filter(p => p.plain === plain) });
  process.stdout.write(JSON.stringify({ pairs: { include: pairs }, trainedPairs: only(false), plainPairs: only(true), builders: { include: builders }, trained: { include: trained }, halves: options.halves }) + "\n");
  process.exit(0);
}
mkdir(options.buildDir);
probe(options);

const steps: Record<Command, () => void | Promise<void>> = {
  probe: () => {},
  "llvm-instrumented": () => buildLlvmInstrumented(options),
  llvm: () => (options.plain ? buildLlvmPlain(options) : buildLlvm(options)),
  rust: () => (options.plain ? buildRustPlain(options) : buildRust(options)),
  package: () => { packageToolchain(options); },
  matrix: () => {},
  all: async () => {
    if (options.plain) {
      buildLlvmPlain(options);
      buildRustPlain(options);
    } else {
      buildLlvmInstrumented(options);
      await buildLlvm(options);
      buildRust(options);
    }
    packageToolchain(options);
  },
};
await steps[options.command]();

function probe(o: Options): void {
  const gib = (n: number) => `${(n / 2 ** 30).toFixed(0)} GiB`;
  const disk = statfsSync(o.buildDir);
  console.log(`builder     ${o.builder} (${o.builderTriple}), ${o.jobs} jobs`);
  console.log(`host        ${o.host} (${o.triple})${o.cross ? ", cross-compiled" : ""}`);
  console.log(`cpu         ${cpuModel()}${o.hostCpu ? ` (toolchain binaries built for -mcpu=${o.hostCpu})` : ""}`);
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
  console.log(`variant     ${o.variant.name} (${o.variant.train ? [`--os=${o.variant.train.target.os}`, `--arch=${o.variant.train.target.arch}`, ...o.variant.train.args].join(" ") : "plain: no training"})`);
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

/** What this machine's CPU is: x86 has a model name; Arm Linux only gives implementer/part numbers. */
function cpuModel(): string {
  const model = cpus()[0]?.model?.trim();
  if (model) return model;
  try {
    const info = readFileSync("/proc/cpuinfo", "utf8");
    const field = (k: string) => new RegExp(`^${k}\\s*: (.+)$`, "m").exec(info)?.[1];
    const part = field("CPU part");
    // Arm Ltd. part numbers of the cores CI runners and build agents use.
    const known: Record<string, string> = { "0xd0c": "Neoverse N1", "0xd40": "Neoverse V1", "0xd49": "Neoverse N2", "0xd4f": "Neoverse V2", "0xd8e": "Neoverse N3", "0xd84": "Neoverse V3" };
    return `implementer ${field("CPU implementer")} part ${part}${part && known[part] ? ` (${known[part]})` : ""}`;
  } catch {
    return "unknown";
  }
}
