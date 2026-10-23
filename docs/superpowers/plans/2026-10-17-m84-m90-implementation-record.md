# M84–M90 implementation and verification record

The owner authorized implementation of the complete product-polish packet on 2026-10-17.
The baseline is **`2347951`** (`chore(workspace): checkpoint platform changes and polish
specifications (M83.0)`): all 527 previously changed files, including staged changes and the
review packet, were committed after the required lint hook passed. The index and worktree
were clean immediately afterward. No hook was bypassed and nothing was pushed.

All subsequent implementation stays **unstaged and uncommitted on `m53-macro-port`**.
The [implemented review packet](../specs/2026-10-17-polish-implementation/README.md) contains
actual application captures, writing recordings, lane reports and explicit acceptance limits.
The original specifications remain design intent; this record establishes what was verified.

## Implemented behavior

| Milestone | Delivered behavior                                                                                                                                                    | Acceptance disposition                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M84       | Shared typography, readable metadata/UI roles, paired action fill/ink, bounded controls and honest state messages                                                     | Browser contrast/geometry/focus checks passed; owner visual review remains pending.                                                                                     |
| M85       | One real first-H1 title within the existing editor, stable metadata portal, explicit filename adoption, coherent page/peek properties and tabs                        | Twenty title cases across both engines passed. Native IME and nonleading-H1 VoiceOver order remain outstanding.                                                         |
| M86       | Formatting-first selection toolbar, retained selection, Writing actions, table dimensions, carrier-safe block actions/undo and retained comment drafts                | Four complete browser writing sessions plus two 200% cases passed; recordings retained. Native clipboard/drop/quit and AI decision-stage acceptance remain outstanding. |
| M87       | Useful title-column defaults, exact refused drafts, single Enter/blur dispatch, per-editor leases, accessible correction status and distinct display/database actions | Focused units and cross-engine cases passed. The proposed large-table performance target is not met.                                                                    |
| M88       | Responsive list/cards, separate Gantt table/time scrolling and resizable division, consistent chart/dashboard/sheet presentation                                      | All ten layouts have a disposition; existing stored settings/carriers remain authoritative. Browser coverage is enumerated in the data report.                          |
| M89       | Adoption across navigation, workspace pages, agents, assistant, settings, history, work/files, search and creation                                                    | Every adoption-map row has a disposition. Thirty-five focused browser cases passed before the final integrated run.                                                     |
| M90       | Integrated journeys, zoom/keyboard checks, deterministic baselines, durable evidence, whole-project gates and isolated native audit bundle                            | Final automated results are recorded below; native interaction and owner aesthetic acceptance are not closed.                                                           |

The title is a view projection of the first top-level H1, with no node reorder or second writer.
Metadata stays mounted through lazy editor readiness and related-tab changes. Concepts retain
frontmatter title/review guards. No source rewrite occurs just from opening a page or measuring
a view. Shared Rust/policy/schema/demo-vault inputs were not changed by this implementation.

Table-title and scalar-property drafts keep their exact text after refusal, remain associated with the correct
file/field, and commit once across Enter plus blur. Ctrl/Cmd+Enter still submits caller-owned
record-composer drafts after validation; invalid input cannot submit a stale value. Focus returns
only when doing so will not steal a deliberate move to another control. Error announcements have
a persistent accessible status; visual correction bubbles follow the actual zoomed grid viewport.

## Verification environment

Acceptance uses Node 26.3.1, pnpm 10.34.7 and Rust 1.95.0 through a temporary toolchain shim,
without changing the owner's shell. The checkpoint hook used the shell's Node 24/pnpm 9, passed,
and reported its existing toolchain warning. Browser checks use isolated mock/demo data, bundled
fonts, the common pinned clock and UTC. Vite ports 5380–5384 belong to the integration lanes;
port 5173 and the owner's running development session were not taken over.

Coverage reports and browser output are outside the repository, avoiding Vite reloads caused by
report generation. Browser timings are functional-test durations, not performance benchmarks.
The native audit has a unique bundle identifier and no URL-scheme registration. Its initial
restored Demo Vault path, subsequent disposable-vault configuration and inaccessible window are
fully recorded in [native evidence](../specs/2026-10-17-polish-implementation/native-evidence.md).

## Automated results

The final whole-repository unit/coverage gate passed: **728 files, 14,264 tests passed and
15 skipped** (14,279 total). V8 coverage is **91.96% statements/lines, 89.42% branches and
87.92% functions** across 848 source files. Existing thresholds remain 82.87/84.91/77.39,
respectively; none were reduced. All three TypeScript configurations passed after the last
test-only UTF-8 filesystem-read correction. Final lint and formatting checks passed. The complete **687-case browser regression passed in 14.8 minutes**, across 158 test files with two workers, zero retries and no snapshot updates. Chromium runs the complete configured suite; WebKit runs the configured carrier/surface subset, including all new polish suites. The total counts engine/case combinations.

The coverage audit caught a reporting defect: eager `?raw` imports of application source in
three source-contract tests could win V8's query-stripped transform-cache lookup and map a
whole module to one line. Those tests now read the same source files directly from disk.
Their assertions and coverage thresholds are unchanged. The accepted run has real source
mappings (for example, `MarkdownEditor.tsx` has 1,325 measured lines); the earlier collapsed
mapping report is not used as acceptance evidence.

The final isolated macOS application built successfully and passed ad-hoc signature
verification. The [build metadata](../specs/2026-10-17-polish-implementation/native-build.json)
records the executable digest, bundle identifier and retained build log. The app was not
installed over the owner's application, and packaging success does not establish native
interaction acceptance.

Focused evidence already completed:

- Scalar/store tests: 63 passed, covering exact drafts, keyboard focus, flush-before-rename,
  refused flush, reconciliation fencing and vault switches. Record-composer modifier submission
  has additional valid/invalid Ctrl/Cmd regression coverage.
- Integrated record/zoom/keyboard flow: 16/16 passed in 33.6s, and final FieldPopover units: 23/23.
  See the [integration triage](../specs/2026-10-17-polish-implementation/editor-evidence.md#final-root-integration-triage).
- Title: 20 cross-engine cases; final writing/zoom: 6 cross-engine cases, with four durable videos.
  Latest title-owner/selection units: 39 passed; block/detail units: 72 passed.
- Table: 117 latest units after removal of the rejected optimization; the final browser report
  records all 18 data-display case/engine combinations.
- Shared system: 35 focused browser cases, including light/dark contrast, 20 state presets,
  Settings drafts, 200% tooltips/hover previews, Studio, search, CSV import and linked rename.
- Baseline required lint hook: passed. No staging, additional commit or push is authorized for
  the new implementation.

Earlier failed/aborted gate attempts are diagnostic history, not passes. They exposed a real
modified-Enter composer regression, title-slot ownership and block-selection issues, alongside
stale presentation assertions and sandbox restrictions in the CLI harness. Those were addressed
without weakening coverage floors. The final gate below is the acceptance authority.

## Performance disposition

The retained change memoizes row bodies and stabilizes callbacks while keeping all rows in
ordinary DOM/layout. A `content-visibility:auto` experiment was removed after Chromium's actual
accessibility tree omitted an offscreen record; removing containment restored it. The final
400-row proof includes AX presence, keyboard End, browser find, frozen editing cells, exact
refused drafts, offscreen correction behavior and intrinsically wrapped rows in both engines.

The final production diagnostic used the real built application and database navigation after
the owned test/build jobs stopped. Four configurations completed 20 samples each:

| Records × declared fields | Production p95 key-to-two-frame time  |
| ------------------------- | ------------------------------------- |
| 100 × 12                  | 30.4 ms                               |
| 100 × 24                  | 47.6 ms                               |
| 1,000 × 12                | 398.8 ms                              |
| 1,000 × 24                | 1,376.2 ms                            |
| 5,000 × 12                | Navigation timed out; no input result |
| 5,000 × 24                | Unmeasured after the bounded stop     |

The proposed <100 ms input and <50 ms warmed-task budgets remain **unmet at 1,000 rows**.
The 100-row cases produced no observed Long Tasks at the observer's ≥50 ms threshold; that is
not a measured maximum of 0 ms. The production bundle hash remained unchanged, completed
fixtures retained every row and moved the cursor, and no record writes occurred. This is an
unthrottled headless Chromium diagnostic on a shared machine, not native input-to-photon timing.
See the [production method and raw results](../specs/2026-10-17-polish-implementation/data/performance/production-report.md).

The earlier development diagnostic measured p95 489.3 ms for the retained 1,000×12 implementation,
versus a separately measured 935.9 ms baseline. Machine load, build mode and sample counts differ;
these are not a controlled speedup comparison. Discarded containment numbers are labeled as
such in the data report and cannot be used to claim a shipped performance pass.

## Remaining acceptance

Native window/focus, WKWebView input and IME, VoiceOver, clipboard/Finder drop, native dialogs,
external-open policy/CSP, and pending/failed-save quit remain outstanding because the computer-use
tool repeatedly returned `cgWindowNotFound` for the isolated audit app. No native editing pass is
claimed. The build/signature gate establishes packaging only. Owner aesthetic acceptance is
pending review of the actual implementation and evidence. No earlier M53–M83 native/live-service
acceptance is retroactively closed by these browser checks.
