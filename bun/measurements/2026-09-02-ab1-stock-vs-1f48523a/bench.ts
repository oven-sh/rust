// A/B: 20 Bun CI builds with the per-lane bun-toolchain vs 20 with stock apt clang + rustup,
// interleaved. For each: toggle .buildkite/ci.mjs, commit, push, wait for the 13 build-bun jobs,
// save their [timing] lines, cancel the rest of the build, next.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const REPO = `${process.env.HOME}/code/bun-toolchain-trial`;
const OUT = `${process.env.HOME}/.cache/bun-toolchain-test/ab`;
const RUNS = Number(process.argv[2] ?? 40);
const TOKEN = readFileSync(`${process.env.HOME}/.bashrc`, "utf8").match(/BUILDKITE_API_TOKEN=["']?([^"'\n]+)/)![1]!;
const API = "https://api.buildkite.com/v2/organizations/bun/pipelines/bun";
const ON = [
  "      BUN_TOOLCHAIN_LLVM: `/opt/bun-toolchain/ci-${getTargetKey(platform)}`,",
  "      BUN_TOOLCHAIN_RUST: `/opt/bun-toolchain/ci-${getTargetKey(platform)}`,",
].join("\n");
const OFF = ON.split("\n").map(l => l.replace("      BUN_", "      // BUN_")).join("\n");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (s: string) => { const line = `${new Date().toISOString().slice(11, 19)} ${s}`; console.log(line); writeFileSync(join(OUT, "bench.log"), line + "\n", { flag: "a" }); };
const git = (...a: string[]) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" }).trim();
async function bk(path: string, init?: RequestInit): Promise<any> {
  for (;;) {
    const r = await fetch(path.startsWith("http") ? path : `${API}${path}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) } });
    if (r.status === 429) { await sleep(40_000); continue; }
    if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
    return (r.headers.get("content-type") ?? "").includes("json") ? r.json() : r.text();
  }
}

function setToolchain(on: boolean): void {
  const p = join(REPO, ".buildkite/ci.mjs");
  let s = readFileSync(p, "utf8");
  if (on && s.includes(OFF)) s = s.replace(OFF, ON);
  else if (!on && s.includes(ON)) s = s.replace(ON, OFF);
  if (!s.includes(on ? ON : OFF)) throw new Error("ci.mjs: toolchain lines not found");
  writeFileSync(p, s);
}

mkdirSync(OUT, { recursive: true });
const done = () => (existsSync(join(OUT, "runs.json")) ? JSON.parse(readFileSync(join(OUT, "runs.json"), "utf8")) : []) as any[];

for (let i = done().length; i < RUNS; i++) {
  const arm = i % 2 === 0 ? "ours" : "stock";
  git("pull", "-q", "--ff-only", "origin", "claude/toolchain-trial");
  setToolchain(arm === "ours");
  git("add", ".buildkite/ci.mjs");
  git("commit", "-q", "--allow-empty", "-m", `ci (trial): toolchain A/B run ${i + 1}/${RUNS} — ${arm}`);
  git("push", "-q", "origin", "claude/toolchain-trial");
  const sha = git("rev-parse", "HEAD");
  log(`run ${i + 1}/${RUNS} ${arm}: pushed ${sha.slice(0, 8)}`);

  let build: any;
  for (;;) {
    await sleep(60_000);
    const list = await bk(`/builds?branch=claude/toolchain-trial&commit=${sha}&per_page=1`);
    if (!Array.isArray(list) || list.length === 0) continue;
    build = list[0];
    const jobs = build.jobs.filter((j: any) => j.type === "script" && / - build-bun$/.test(j.name));
    const pending = jobs.filter((j: any) => !["passed", "failed", "broken", "canceled", "timed_out"].includes(j.state));
    if (jobs.length >= 13 && pending.length === 0) break;
    if (["canceled", "failed"].includes(build.state) && pending.length > 0 && jobs.every((j: any) => j.state !== "running" && j.state !== "scheduled" && j.state !== "assigned" && j.state !== "accepted")) break;
  }
  const jobs = build.jobs.filter((j: any) => j.type === "script" && / - build-bun$/.test(j.name));
  const result: any = { run: i + 1, arm, sha, build: build.number, lanes: {} };
  for (const j of jobs) {
    const lane = j.name.replace(/^:([a-z0-9_-]+): (.*) - build-bun$/, "$1 $2");
    if (j.state !== "passed") { result.lanes[lane] = { state: j.state }; continue; }
    const raw: string = await bk(`${API}/builds/${build.number}/jobs/${j.id}/log.txt`, { headers: { Accept: "text/plain" } });
    await sleep(1500);
    const text = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b_bk;t=\d+\x07/g, "");
    const phases: Record<string, number> = {};
    for (const line of text.split("\n")) {
      if (!line.startsWith("[timing]") || line.includes("phase") || line.includes("toolchain")) continue;
      const f = line.trim().split(/\s+/);
      const secs = (s: string) => { const m = s.match(/^(?:(\d+)m)?([\d.]+)s$/); return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : NaN; };
      if (line.includes("total (ninja)")) phases.total = secs(f[f.length - 1]!);
      else phases[f.slice(1, -5).join(" ")] = secs(f[f.length - 3]!);
    }
    const tc = text.match(/\[timing\] toolchain: (.*)/)?.[1];
    result.lanes[lane] = { state: j.state, ...phases, toolchain: tc, wall: (Date.parse(j.finished_at) - Date.parse(j.started_at)) / 1000 };
  }
  writeFileSync(join(OUT, `run-${String(i + 1).padStart(2, "0")}-${arm}.json`), JSON.stringify(result, null, 2));
  writeFileSync(join(OUT, "runs.json"), JSON.stringify([...done(), { run: i + 1, arm, sha, build: build.number }], null, 2));
  log(`run ${i + 1} ${arm}: build #${build.number}, ${Object.keys(result.lanes).length} lanes saved`);
  // The tests of this build are of no interest; free the agents for the next one.
  try { await bk(`${API}/builds/${build.number}/cancel`, { method: "PUT" }); } catch (e) { log(`cancel #${build.number}: ${(e as Error).message}`); }
}
log("all runs done");
