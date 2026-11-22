// Build the Bun toolchain: rustc from this repository and clang/lld from its src/llvm-project
// submodule, each with its upstream release recipe. See bun/README.md.
//
//   node bun/toolchain.ts [command] [--option=value ...]   (commands: lib/options.ts COMMANDS)

import { readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { join } from "node:path";
import { exists, mkdir } from "./lib/fs.ts";
import { builderOf, profileOf } from "./lib/hosts.ts";
import { recordProfile } from "./lib/llvm-profile.ts";
import { boltsLlvm, buildLlvm } from "./lib/llvm.ts";
import { type Options, parseOptions, paths } from "./lib/options.ts";
import { packageToolchain } from "./lib/package.ts";
import { run } from "./lib/run.ts";
import { boltsRust, buildRust } from "./lib/rust.ts";
import { BUN_REF, fetchSdk } from "./lib/sdks.ts";
import { NIGHTLY } from "./lib/upstream.ts";

const [major] = process.versions.node.split(".").map(Number);
if (major! < 24) throw new Error(`node ${process.versions.node}: need node 24 or newer (runs .ts directly)`);

const options = parseOptions(process.argv.slice(2));
const { command } = options;
if (command === "matrix") {
  // One llvm, one rust and one smoke job per host; a profile job per builder whose profile a host
  // uses; an image job per builder that runs any of those; a build of Bun per Linux host.
  const hosts = options.hosts.map(host => ({ host, builder: builderOf(host), profile: profileOf(host) ?? "" }));
  const profiles = options.halves.includes("llvm") ? [...new Set(hosts.map(h => h.profile))].filter(p => p !== "") : [];
  const builders = [...new Set([...hosts.map(h => h.builder), ...profiles])];
  const bun = { ref: BUN_REF, hosts: hosts.filter(h => h.host === h.builder).map(h => h.host) };
  console.log(JSON.stringify({ hosts, profiles, builders, halves: options.halves, bun, nightly: NIGHTLY }));
  process.exit(0);
}
mkdir(options.buildDir);
probe(options);

if (command !== "probe" && command !== "llvm-profile") await fetchSdk(options);
// A patch to LLVM is built with the profile there is, as in the workflow.
const hasProfile = exists(join(paths(options).llvmProfile(options.builder), "clang-profile.json"));
if (command === "llvm-profile" || (command === "all" && !options.cross && !hasProfile)) await recordProfile(options);
if (command === "llvm" || command === "all") await buildLlvm(options);
if (command === "rust" || command === "all") await buildRust(options);
if (command === "package" || command === "all") packageToolchain(options);

function probe(o: Options): void {
  const gib = (n: number) => `${(n / 2 ** 30).toFixed(0)} GiB`;
  const disk = statfsSync(o.buildDir);
  console.log(`builder     ${o.builder} (${o.builderTriple}), ${o.jobs} jobs`);
  console.log(`host        ${o.host} (${o.triple})${o.cross ? ", cross-compiled" : ""}`);
  console.log(`cpu         ${cpuModel()}`);
  console.log(`memory      ${gib(freemem())} free of ${gib(totalmem())}`);
  console.log(`disk        ${gib(disk.bavail * disk.bsize)} free under ${o.buildDir}`);
  console.log(`checkout    ${o.checkout} @ ${git(o.checkout)}`);
  console.log(`llvm        ${o.llvmProject} @ ${git(o.llvmProject)}`);
  console.log(`host llvm   ${version([`${o.hostLlvm}/bin/clang`, "--version"])}`);
  console.log(
    `            ${version([`${o.hostLlvm}/bin/llvm-bolt`, "--version"])
      .replace(/\s+/g, " ")
      .slice(0, 60)}`,
  );
  for (const tool of [
    ["cmake", "--version"],
    ["ninja", "--version"],
    ["python3", "--version"],
    ["node", "--version"],
    ["bun", "--version"],
  ]) {
    console.log(`${tool[0]!.padEnd(12)}${version(tool)}`);
  }
  console.log(`nightly     ${NIGHTLY}`);
  console.log(`bolt        llvm: ${boltsLlvm(o) ? "yes" : "no"}, rust: ${boltsRust(o) ? "yes" : "no"}`);
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
    return (
      run(argv, { capture: true, quiet: true })
        .split("\n")
        .find(l => l.trim().length > 0)
        ?.trim() ?? "?"
    );
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
    const known: Record<string, string> = {
      "0xd0c": "Neoverse N1",
      "0xd40": "Neoverse V1",
      "0xd49": "Neoverse N2",
      "0xd4f": "Neoverse V2",
      "0xd8e": "Neoverse N3",
      "0xd84": "Neoverse V3",
    };
    return `implementer ${field("CPU implementer")} part ${part}${part && known[part] ? ` (${known[part]})` : ""}`;
  } catch {
    return "unknown";
  }
}
