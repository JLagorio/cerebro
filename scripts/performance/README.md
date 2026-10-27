# Repeatable performance observations (M93.6)

This runner exercises the **production app bundle** in headless Chromium through
the existing browser mock. It does not import application source into the page,
modify `demo-vault`, run Claude Code, contact providers, or claim native acceptance.
The retained M87 report and `production-measure.mjs` under
`docs/superpowers/specs/2026-10-17-polish-implementation/data/performance/` remain
historical evidence. Its synthetic ArrowDown-to-two-frame metric is retained.

Use the pinned Node and pnpm versions. Build only after other writers/builds have
finished, then select a **new absolute directory beneath system temp** whose parent
already exists:

```sh
pnpm build
pnpm perf:run -- --output /private/tmp/cerebro-perf-preflight --matrix reliability --preflight
pnpm perf:run -- --output /private/tmp/cerebro-perf-timing --matrix reliability
```

On Linux, `/tmp/cerebro-perf-preflight` is suitable. Output admission resolves
symlinks, rejects the repository even when the checkout is under `/tmp`, rejects
the temporary root itself, and refuses every existing destination. There is no
overwrite flag and no recursive deletion of a caller-selected path. The runner
creates `results.json` and `report.md`; it destroys each mutable corpus by closing
its isolated browser context. No corpus is written to a real vault.

The runner serves a frozen snapshot of `dist` on its own ephemeral loopback port.
It never attaches to an existing dev server. Symlinks and development entries in
the build are refused. HTTP requests outside the exact origin, all WebSockets,
and downloads are blocked; service workers are disabled. Build files and runner
source are hashed before and after the run.
A changed bundle is flagged and produces a nonzero exit. A source HEAD identifies
the checkout at run time; it does **not** establish the provenance of an older
bundle. Rebuild in a stable checkout for source-to-build comparisons.

For a bounded smoke or one experiment, repeat `--case`:

```sh
pnpm perf:run -- --output /private/tmp/cerebro-perf-table --preflight --case table-100x12
pnpm perf:run -- --output /private/tmp/cerebro-perf-search --case search-10000 --samples 10
```

The matrix contains 100/1,000/5,000 records at 12/24 declared fields, plus 1,000×12
long, sparse, wrapped and relation/rollup cases; 64/256 KiB documents and a
2,000-block page (`document-2000-blocks`: a title, rotating headings, paragraphs,
bullets, numbered items and tasks, and the end sentinel); a cached 1,000-message
conversation; and 10,000 readable notes with a private control file.
Wrapped cases enable wrapping in the saved view. The relation case evaluates a
rollup over a stored relation and numeric property. The corpus seed, exact file
and conversation byte counts, and SHA-256 fingerprint accompany each attempted
case. Seed defaults to 93 and can be supplied with `--seed`.

Each timing case first runs a **separate correctness context**. Its durations are
discarded. `--preflight` performs only that pass and emits no measured timing
rows. Timed input, scroll, filter and document save loops and typing bursts default
to 20 samples (`--samples 1..50`). Initial readiness, the app's ready marks and
renderer heap are single observations;
their sample counts say so. All samples are retained. Percentiles use nearest
rank. A real zero is valid; an unavailable observation has no samples and null
percentiles. Timeout rows retain only samples completed before the timeout.

The default fixture budget is 45 seconds, including preflight and timing; the
whole matrix budget is 240 seconds. Context allocation, both routing installs,
page allocation and boot all consume that fixture budget. Late allocations are
closed without continuing setup; an independent matrix watchdog can interrupt a
pending case, snapshot its current phase and samples, and shut down the owned
browser. Startup attribution resets to readiness for each new context.
`--fixture-ms` accepts 1,000–120,000 and
`--overall-ms` accepts 1,000–1,800,000. A synthetic input above 2 seconds stops the
case. A failed fixture stops subsequent cases, which remain explicitly
unavailable. Browser context and process cleanup have separate 10-second bounds;
only the process created by this runner can be force-stopped. A failed/timeout
run exits nonzero and keeps its evidence. Large cases on a loaded machine may
require a deliberately longer declared budget; do not change them to hide a
failure after the fact.

| Observation     | What it means here                                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First content   | Navigation/open to first visible row/editor/chat node, observed by a MutationObserver.                                                                                            |
| Readiness       | Table has every expected row, document has an editable end sentinel, or conversation has every cached message, followed by two frames. Composite, not isolated parse/render time. |
| Input           | Synthetic bubbling ArrowDown at the focused real grid to two frames. Cursor advancement is checked.                                                                               |
| Scroll          | Actual scroll container moves between extremes, then two frames. Not native wheel input.                                                                                          |
| Filter          | View search to one result, or 10,000-note mock body search to its known positive result, then two frames. Includes debounce and automation delivery.                              |
| Save-to-visible | Real document edit through the editor to mock file acknowledgement and visible text. Includes autosave debounce; excludes disk I/O.                                               |
| Frontend ready  | Navigation start to the app's `frontend_ready` mark (first shell commit for an open vault, including the vault chooser click). Absent after 5 s: a timeout row.                   |
| Editor ready    | Document open click to the app's `editor_ready` mark (document loaded, save listener attached). Absent after 15 s: a timeout row, and the case goes on.                           |
| Keystroke       | Typing workload: a real key event (CDP) per character at the document end, from the event's timestamp to the end of its next frame. Ten characters per burst, at frame pace.      |
| Serialize       | Serializer milliseconds per typed change: the burst's `editor_serialize` measures, from its first key until its save landed, divided by its characters.                           |
| Serialize calls | Serializer passes per ten-character burst. One per save window when serialization is lazy; one per keystroke plus the save when it is not.                                        |
| Writes          | Body writes per ten-character save window, counted from the mock write log.                                                                                                       |
| Memory          | CDP `JSHeapUsedSize` at workload end. Excludes native, GPU and total resident memory.                                                                                             |

**App probes.** `src/lib/perfMarks.ts` writes `frontend_ready` and `editor_ready`
marks and an `editor_serialize` measure around every serializer pass to the
browser's own performance timeline. The product never reads them; a serializer
measure is cleared as it is made, and the runner collects it with a
`PerformanceObserver`. The 256 KiB typing case can need `--fixture-ms 120000`.

**Attribution gaps stay explicit.** Native scan, readable-corpus construction,
tokenization and agent-grant-scoped BM25 are unavailable in this browser driver.
The 10,000-note case measures the human browser search experience; it does not
stand in for native scope/ranking correctness. Isolated derivation, render,
editor parse and editor apply have no production phase marks and are also
unavailable; editor readiness is the `editor_ready` mark above. The cached conversation case makes no live-model or CLI transcript
read claim. These gaps need native/instrumented follow-up before REL-07 is fully
accepted; this tooling does not close M93.6's measurement and owner-budget gates.

The report compares the two retained 1,000-row input p95 values (398.8 ms and
1,376.2 ms) without claiming equivalent hardware/load or a regression verdict.
The historical 5,000×12 navigation timeout and unmeasured 5,000×24 case remain
missing numbers. Hardware, load before/after, toolchain, source state, browser
version, served bundle and runner fingerprints, source diff hash, options and raw
samples live in JSON. Timed cases also retain up to 1,000 observed browser long
tasks, explicitly marked when truncated; unsupported or failed reads remain null.
Review attribution and the proposed 5,000-row usability budget before enforcing
any threshold. Unit tests contain no application performance threshold.

```sh
pnpm exec vitest run scripts/performance/corpus.test.ts scripts/performance/report.test.ts scripts/performance/measure.test.ts scripts/performance/browser.test.ts --maxWorkers=2
pnpm exec tsc --noEmit -p tsconfig.tools.json
```
