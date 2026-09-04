# Bun CI build-time measurements

Each directory is one interleaved A/B series on oven-sh/bun's Buildkite CI (branch
`claude/toolchain-trial`): alternating commits toggle `BUN_TOOLCHAIN_LLVM/RUST` in
`.buildkite/ci.mjs` between the image's stock compilers (apt.llvm.org clang + rustup nightly)
and `/opt/bun-toolchain/ci-<lane>` from the named bun-toolchain release, with the CI images
pinned so no run rebakes. `bench.ts` is the driver; `run-NN-{ours,stock}.json` holds, per
build-bun lane, the `[timing]` phases printed by Bun's `scripts/build/timings.ts` (seconds of
ninja wall time per phase, from `.ninja_log`), the toolchain line, and the Buildkite job wall
time. Absolute seconds are only comparable within a series (the Bun source differs between them).

- `2026-09-02-ab1-stock-vs-1f48523a` — 20/20. Toolchain `bun-toolchain-nightly-2026-07-20-bun-1f48523a`:
  clang+lld PGO+BOLT, rustc PGO (+BOLT on the x86_64 host only; every CI lane builds on aarch64,
  so rustc without BOLT). Images from Bun build #108896.
- `2026-09-04-ab2-stock-vs-d98dac36` — 20/20. Toolchain `…-d98dac36`: as above plus rustc's
  librustc_driver/libLLVM BOLTed on the aarch64 host, and the clang/lld build tightening from
  `a9f0c28a`. Images from Bun build #109813 (also `single-run-build-109813.json`). Bun source is
  ab1's plus a merge of main (115 commits).
