# Table performance diagnostics

The [production diagnostic](production-report.md) has its own real-app harness
and bounded matrix. Four fixtures completed; 1000×12 input p95 was 398.8 ms, with a 403 ms observed warmed long task. The 5000×12 fixture timed out during navigation; 5000×24 was not attempted. The proposed targets remain unmet. The development-only history below remains separate from that production evidence.

The historical files below are Vite development diagnostics on an Apple M1 Pro (10 logical cores,
32GiB), Darwin 24.6, Node 26.3.1 and headless Chromium 149.0.7827.55. They are not
production benchmarks. Other machine load was substantial; the lane coordinated
its own browser/build/test jobs but did not control unrelated processes.

- `baseline-dev-diagnostic.json`: five completed configurations, five samples
  each. The 5000×24 baseline was stopped after 5000×12 reached 12.6–14.0 seconds per
  key input. The absent result is unmeasured, not zero or passing.
- `retained-memo-only-1000x12-dev.json`: 20 samples of the safe retained row-body
  memoization/current-callback mechanism. Input p95 489.3 ms; proposed <100 ms input
  and <50 ms warmed-task budgets remain open. This earlier development run is not the separate production diagnostic linked above.
- `discarded-containment-dev-diagnostic.json`: the six-fixture experiment using
  `content-visibility:auto`. **This mechanism does not ship.** Chromium's enabled
  full accessibility tree lost an offscreen record; forcing normal visibility
  restored it. Final browser correctness uses ordinary full-DOM rendering.
- `concurrency.json`: executable-name-only process/load snapshot; no arguments
  or command environments were captured.
- `measure.mjs`: the historical harness, retained for methodology. It mounts a
  synthetic TableView inside the demo browser in an isolated 1340×740 host; it
  performs no record edits and blocks non-localhost network requests. It measures
  key dispatch to two animation frames, records mount/long-task timing, and
  verifies DOM row count. Columns are 140px text fields plus title, with no result
  limit. A five-sample p95 is the maximum sampled input, not a stable estimate of
  a population percentile.

The harness's `before` mode refers to a temporary `BenchmarkBaseline.tsx` that
was removed from application source after measurement. Its `cv` mode is the
discarded experiment. Neither should be mistaken for an available product mode.
Original baseline source, raw traces/profiles and intermediate failed attempts
remain at `/private/tmp/cerebro-m87-perf`; enormous traces and rejected caches are
deliberately excluded from this small evidence package. See the parent
[data evidence report](../../data-evidence.md) for causal browser evidence,
interpretation and final screenshot provenance.
