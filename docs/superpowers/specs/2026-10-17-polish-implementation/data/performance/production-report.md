# Production table diagnostic

Four fixtures completed 20 samples each. At 1000×12, input p95 was **398.8 ms** and the maximum observed warmed long task was **403 ms**: the proposed <100 ms / <50 ms targets remain **unmet**. The 5000×12 fixture timed out during page navigation; 5000×24 was not attempted. The bounded run ended there, without another optimization or profiling attempt.

The retained implementation uses memoized row bodies with current callbacks and ordinary complete DOM/layout/paint. It does not use the discarded containment experiment or a row-element cache.

## Results

| Records × properties | Samples |    Input p95 | Observed warmed long task | Disposition                                |
| -------------------- | ------: | -----------: | ------------------------- | ------------------------------------------ |
| 100×12               |      20 |      30.4 ms | No ≥50 ms task observed   | Complete                                   |
| 100×24               |      20 |      47.6 ms | No ≥50 ms task observed   | Complete                                   |
| 1000×12              |      20 |     398.8 ms | 403 ms maximum            | Complete; target missed                    |
| 1000×24              |      20 |    1376.2 ms | 1367 ms maximum           | Complete; target missed                    |
| 5000×12              |    None | Not measured | Not measured              | Navigation timed out before input sampling |
| 5000×24              |    None | Not measured | Not measured              | Not attempted after preceding timeout      |

The run took approximately 63.3 seconds, including the failed fixture. The 5000×12 sidebar click was dispatched, but Playwright exceeded its 15-second action timeout while waiting for navigation to finish. No ready-table/input result was recorded. An absent sample is not a zero or a pass.

The Long Tasks observer emits only tasks at or above 50 ms. Raw JSON retains its original numeric zero sentinel for an empty observed list; the table describes that as “No ≥50 ms task observed,” not a measured 0 ms maximum.

All completed fixtures retained every supplied row, the expected 14/26 grid columns, ordinary visible rendering, distinct keyboard cursor movement and zero mock writes. Actual pane geometry stayed 1146×747. Shared browser/test/build lanes had finished before this run; machine one-minute load declined from 7.13 to 5.62. This remains a shared-machine diagnostic, not controlled laboratory evidence. No controlled speedup over the development baseline is claimed.

The production bundle fingerprint was unchanged before and after: `930a44e2eb4a6d60db313f2f3e28a2e633de80bb8e0d9deca51d058a30e70cbc`. [Raw results](production-retained.json) preserve each input, observed task, fixture disposition, hashes and concurrency/load snapshots; the [run log](production-retained.log) preserves terminal results. The discarded containment figures remain separate and are not shipping-performance claims.

## Method and limits

`production-measure.mjs` runs from the repository root against an already-built Vite preview on isolated port 5392. It imports no application source and creates no benchmark entry in the shipping bundle. The existing browser mock publishes its filesystem map during module initialization; a test-side setter seeds valid Type/record markdown synchronously before App’s automatic vault scan. Navigation then uses the actual Databases rail and Benchmark sidebar row.

The real shell stays visible at 1440×900. Fixtures declare 12 or 24 text properties of 140 px, plus title and gutter, with 100, 1000 or 5000 records. Every completed fixture verifies full DOM row count, `aria-colcount`, ordinary visible layout, distinct moved `aria-activedescendant` values, and zero writes. No result limit or record editing is involved.

Each completed timing fixture takes 20 synthetic ArrowDown-to-two-animation-frame samples after focusing the real grid. Navigation-to-ready, input samples, p95 and observed warmed long tasks are recorded separately. The 1000×12 fixture runs first. Playwright actions have a 15-second timeout. A 45-second fixture limit is additionally bounded by the remaining 240-second overall budget; a single input above 2000 ms ends the diagnostic. Teardown has a separate 10-second bound. Partial, failed and unmeasured fixtures retain those labels.

The JSON records hardware, browser version, pane geometry, external-network blocking, machine load, executable names without arguments, and SHA-256 hashes of production HTML/JS/CSS before and after. A changed bundle invalidates timing. This unthrottled headless Chromium diagnostic does not establish packaged WKWebView or trusted native input-to-photon performance. Its real-app host differs from the earlier development-only isolated-host runs.

## Correctness preflight

One 100×12 production preflight passed with all 100 rows, 14 grid columns, visible layout, a moved keyboard cursor and zero writes. Its screenshot was inspected. It ran while other gates were active and carries **no timing claim**. Retained artifacts: [preflight JSON](production-correctness-preflight.json) and [screenshot](production-correctness-preflight.png). Original paths are under `/private/tmp/cerebro-m87-perf/`.

## Reproduction

Run only after the build and shared browser/test lanes are quiet, without rebuilding during measurement:

```sh
CEREBRO_BENCH_URL=http://127.0.0.1:5392 node docs/superpowers/specs/2026-10-17-polish-implementation/data/performance/production-measure.mjs all
```

`CEREBRO_BENCH_OUTPUT` chooses the JSON destination; `CEREBRO_BENCH_REPO` overrides the repository root. `CEREBRO_BENCH_PREFLIGHT=1` enables the single-key correctness-only mode and leaves p95 unset.
