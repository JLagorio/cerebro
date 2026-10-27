# M93 — Reliable workspace

**Milestone:** M93 · **Phases:** M93.1–M93.11 · **Requirements:** REL-01–REL-13.

[Master roadmap](2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](../specs/2026-10-23-m93-m99-research/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make failed saves recoverable, history correctly scoped, setup truthful and scale/source workflows verifiable.

**Architecture:** Retain one document owner across editor presentations and use typed authoritative acknowledgements. Extend existing SELECT-only runtime history and guarded file writers; choose scale changes from reproducible profiles. Keep native acceptance, live CLI acceptance and browser regression evidence distinct.

**Tech Stack:** Tauri 2/Rust, React 19, TypeScript, Zustand, BlockNote/ProseMirror, SQLite, Vitest and Playwright; existing pinned Node/pnpm/Rust toolchains.

**Spec:** [Reliability design](../specs/2026-10-23-m93-reliable-workspace-design.md).

**Status:** Implementation authorized by the owner on 2026-10-23, on the existing branch alongside Claude's M92 work. The [implementation record](2026-10-23-m93-m99-implementation-record.md) distinguishes verified slices from open work. Commands below are phase requirements, not test results. Conditional owner decisions and native acceptance remain explicit gates; M93 is not complete.

## Global Constraints

- CLI remains the default. Files-first authority, React and current guarded writers remain in place.
- Human saves remain last-write-wins; agent writes compare before writing (CV-23).
- One live editor per file; rich/source presentations share one owner (CV-52).
- Human-facing actions catch, toast and return typed outcomes rather than throwing (CV-03).
- Unavailable, not recorded and measured empty are distinct (CV-05).
- Native minimum is 900×600. Dock Quit/logout/shutdown are outside current webview preparation.
- Preserve Rust's deadline and the current 30-second second-quit override.
- No persistent crash-draft recovery is added. Credentials never enter vault, prompts or fixtures.
- The retained <100 ms 1,000-row input goal is historical and unmet; 5,000-row budgets require measured review.
- New paths in this plan are **proposed**, not claims of existing implementation.
- Follow commit convention `type(scope): sentence (M93.<phase>)` using the M93 phase being implemented. Never bypass hooks.

## Review Focus

1. A save fails before quit starts, then the user presses Save without typing: the latest draft retries and quit cannot misread the old failure as settled (M93.1/M93.2).
2. An older completion arrives after a newer edit, path transfer or scope change: it cannot clear the current dirty generation or replace selected history (M93.1/M93.4).
3. Identical actor/path names occur in two vaults, equal timestamps cross pages, and a child belongs to another actor: each history result/link retains origin and continuation (M93.3/M93.4).
4. A wrapped offscreen row has an active rejected draft and is targeted by End, range selection or find: bounded rendering preserves both access and the exact draft (M93.7).
5. A BOM/CRLF file with unsupported Markdown opens in source, meets an external change and fails saving: untouched prefix and latest draft survive without a second writer (M93.8).

---

## File map and cross-package interfaces

| Responsibility                   | Existing seams / proposed focused unit                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner state and acknowledgements | `src/editor/MarkdownEditor.tsx`, `NoteBodyEditor.tsx`, `openPages.ts`; proposed `documentOwner.ts`/tests; `src/lib/ipc.ts`, `mockIpc.ts`; `src-tauri/src/lib.rs`, `vault/write.rs` |
| Leave and quit barriers          | `src/app/quit.ts`, `src/editor/openPages.ts`, existing rename/vault-switch call sites found in task inventory                                                                      |
| Other save participants          | `src/mermaid/useDiagramFile.ts`, `CodeOverlay.tsx`, `src/whiteboard/useCanvasFile.ts`, `src/sheet/pendingSheets.ts`, focused field owners found in the inventory                   |
| Scoped history                   | `src-tauri/src/runtime/fleet.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `mockIpc.ts`, `status/AgentRunHistory.tsx`, `RunDetailPanel.tsx`                                       |
| CLI discovery                    | `src/agent/AiPanel.tsx`, `src/pages/ClaudeCodeRow.tsx`, `agent/agentIpc.ts`; proposed `agent/readiness.ts`; Rust proposed `agent/readiness.rs`                                     |
| Performance                      | Existing retained `production-measure.mjs`; proposed `scripts/performance/`, `e2e/scale.spec.ts`; `views/TableView.tsx`, `useRowKeyboard.ts`, `app/useEntryState.ts`               |
| Source and recovery              | Proposed `editor/SourceBodyEditor.tsx`; `vault/write.rs`, `vault/parse.rs`; proposed gated `vault/recovery.rs`                                                                     |
| Help and native evidence         | Proposed `shared/help/`, `scripts/build-help.ts`, `src/app/ProductHelp.tsx`; proposed `docs/acceptance/2026-10-23-reliability/`                                                    |

M93.1 produces `SaveOutcome`/`FlushReport` as REL-02 in the spec, including the 2026-10-23 `clean` no-op clarification (resolved, with no write or invented hash); CHAT launch and FLOW capture consume that barrier instead of creating another save path. M93.3 produces stable run identity/origin for CHAT and KNOW. CHAT owns the live CLI case matrix, sanitization and capability proof. ACT reviews a possible help tool through its shared manifest/policy workflow; the human help catalog is independently useful. CORE extraction must preserve these contracts and current file authority. UX owns entry placement and visual consistency, not save/history state semantics.

### M93.1 — Retain document generations and authoritative acknowledgements

**Files:** Create proposed `src/editor/documentOwner.ts`, `documentOwner.test.ts`. Modify `src/editor/MarkdownEditor.tsx`, `NoteBodyEditor.tsx`, `openPages.ts`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `src-tauri/src/lib.rs`, `src-tauri/src/vault/write.rs`. Extend adjacent existing tests.

**Interfaces:** Produces `DocumentOwner` keyed by `{vaultId,path,ownerId}` with `edit(markdown):number`, `flush():Promise<SaveOutcome>`, `retry():Promise<SaveOutcome>`, `snapshot():OwnerSnapshot`; `OwnerSnapshot` contains latest draft/generation, acknowledged generation, in-flight generation and failure. Produces `saveNoteBody({vault,path,body,bodyFormat}):Promise<NoteWriteAck>` through existing `save_note`; compatibility `saveNote` keeps existing callers working until migrated. `bodyFormat` defaults to rich. The source branch lands in M93.8.

- [ ] Add failing tests named `retry_without_edit_uses_latest_draft`, `old_ack_does_not_clean_new_generation`, `writes_are_serial_and_coalesced`, `old_owner_completion_cannot_clean_renamed_owner`, and `refresh_failure_after_ack_is_not_save_failure`. Use controlled promises, two edits and repeated failures; assert exact saved body and acknowledged generation, not just a toast.
- [ ] Run `pnpm exec vitest run src/editor/documentOwner.test.ts src/editor/NoteBodyEditor.test.tsx`; expect new assertions to fail on missing owner/ack semantics.
- [ ] Implement retained owner state and serialize writes. Move acknowledgement bookkeeping out of pre-callback `lastSaved`; preserve complete failed payload until acknowledgement or explicit discard. Expose file content hash from the writer; for the governed path return `projectionHash` only after authoritative materialization/read confirmation, never convert null to a guessed hash. Preserve receipt guards and nonthrowing human action semantics.
- [ ] Add Rust/mock parity tests for ordinary hash, governed confirmation failure, and malformed/deleted target refusal. Run the targeted Vitest files, `cargo test --manifest-path src-tauri/Cargo.toml vault::write`, and `pnpm typecheck`; expect all targeted tests/typechecks to pass.
- [ ] Commit the owner/ack change under its M93 phase; inspect the diff for unrelated files before staging.
- [x] Audit BL-03 (2026-10-27, uncommitted): rich typing no longer serializes per keystroke. `DocumentOwner.touch(materialize)` bumps a generation in O(1) and binds the editor's materializer (`MarkdownEditor`, cached on the ProseMirror doc it read); `snapshot()`, `edit`/`present`/`acceptExternal`, flush/retry, the drain loop, a leave's `prepare`, the debounce (`settle` when nothing new) and unmount (`release`, through `RecoveryCapture.releaseDraft`) materialize exact text. Source mode keeps `edit(markdown)`. Subscribers hear only the clean→dirty transition, read without serializing; a no-op materialization withdraws its bump and reports clean. `unresolvedDocumentOwners(match)` filters by key before any snapshot, so the selected title/task hosts no longer serialize other pages. Tests: `NoteBodyEditor.lazy.test.tsx` (one pass per window on 256 KiB; IME composition, unmount and quit; Retry remount and Retry save; section fault; net-zero window clean), `documentOwner.test.ts` (lazy rich drafts), `documentOwner.selected.test.ts` (`selected_source_change_commits_the_latest_generation_over_unread_rich_typing`).
- [x] Audit BL-196 (2026-10-27, uncommitted): the one 500 ms debounce has `maxWaitMs` 5000, armed at a window's first edit and shared by source edits. Test: `MarkdownEditor.test.tsx` › save cadence under steady typing (a key every 200 ms for 12 s writes at 5.0, 10.0 and 12.5 s; final bytes equal a trailing-only debounce's).
- [x] Audit BL-197 (2026-10-27, uncommitted): `patchFrontmatter`/`setTitle` hold one inline write per path in flight; a patch issued while another waits merges into it (later keys win), a waiting title gives way to a later one, and a title waits for the patch before it. Tests: `vaultStore.test.ts` › first answer held (views A→B ends B on disk and in the store; tick→untick ends unticked), merge, title order.

### M93.2 — Make every leave path inspect unresolved owners

**Files:** Modify `src/editor/openPages.ts`, its existing tests, `src/app/quit.ts`, `src/app/quit.test.ts`; inventory `flushOpenPages|heldOpenPages|holdEditor|registerFlush|registerHold|saveNote|saveCanvasFile|settleSheetDrafts` under `src/`, then inspect save-on-blur and unmount cleanup writers that this search cannot enumerate. Record every participant and dependent caller. Adapt `src/mermaid/useDiagramFile.ts`, `CodeOverlay.tsx`, `src/whiteboard/useCanvasFile.ts`, sheet draft and focused field owners as needed; extend adjacent tests and relevant rename/vault-switch tests. Inspect `src-tauri/src/shell/quit.rs`; native changes require a separately scoped defect task if deadline measurement demands them.

**Interfaces:** Consumes M93.1. Produces `flushOpenPages(budgetMs?):Promise<FlushReport>` and `unresolvedOpenPages():OwnerSnapshot[]`. Report timeout as blocked/deadline. A compatibility wrapper may preserve void callers only when they do not proceed to a dependent action; rename, switch, agent launch and quit must read the report.

Each participant supplies `prepareLeave():Promise<SaveOutcome>` while its view/buffer remains mounted, plus an unresolved snapshot; adapters may retain existing canvas/diagram writers. Preparation settles buffered CodeOverlay text (including Auto-Update off), sheet cells and focused fields before measuring pending generations. A field/board adapter retains its own exact payload and authoritative acknowledgement; it must not fabricate a note hash or report a caught failure as success. This follows the useful capture/serialization pattern in Macro's `features/email-compose/primitives/draft-autosave.ts` without adopting its persistent local draft store.

- [ ] Add regressions for failure before quit, leave-triggered failure, hung write, repeated Retry, parked pane, explicit discard, rename, deletion and vault switch. Assert shell/owner stays recoverable before unmount; second quit within 30 seconds retains existing override semantics. Add a CHAT launch fixture proving an unresolved draft prevents subprocess launch.
- [ ] Include a pending standalone diagram debounce, a failed diagram save predating quit, buffered CodeOverlay text with Auto-Update off, a held/failed canvas, a sheet cell draft and a focused field whose blur commit fails. Assert latest exact bytes/value survive Retry and no dependent leave/launch happens; preparation must not rely on unmount cleanup ordering.
- [ ] Run `pnpm exec vitest run src/app/quit.test.ts src/editor/openPages.test.ts src/editor/NoteBodyEditor.test.tsx`; expect failures for preexisting-failure/leave retention before implementation.
- [ ] Prepare leave work while owners survive; check current unresolved identities rather than deltas in a global failure counter. Add accessible Retry and explicit Copy/Save as/discard choices where a deleted target cannot be retried. Transfer settled rename identity together with existing pointer migration. Keep native deadline bounded.
- [ ] Reserve measured headroom to cancel Rust's current five-second quit timer on the responsive-webview unresolved path; test cancellation near the boundary and delayed IPC separately from fake-clock unit tests. A hung webview still reaches native forced exit. If cancellation cannot reliably beat the deadline, record a scoped native-gate defect and keep that acceptance open until repaired; do not claim universal retained-draft protection.
- [ ] Rerun targeted tests plus affected caller tests; use browser tests for save-before-navigation and failed-save retry. Expect no dependent action after failed/held/timed-out generation, no duplicate recreation of a deleted file, and successful Retry without another edit.
- [ ] Commit the leave barrier separately from owner storage.

### M93.3 — Scope roots before LIMIT and paginate independently of lineage

**Files:** Modify `src-tauri/src/runtime/fleet.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `src/status/AgentRunHistory.tsx`, `src/status/AgentRunHistory.test.tsx`; extend runtime/mock tests.

**Interfaces:** Produces `RunHistoryScope`, `RunCursor={startedAt:string,runId:string}`, `fleetRunsPage(scope,cursor?,limit?):Promise<{runs:FleetRun[],nextCursor:RunCursor|null,effectiveVaultIds:string[]}>`, and `fleetRunLineage(rootRunId):Promise<{runs:FleetRun[],truncated:boolean}>`. Scope is exactly REL-04. Default 50/max 200 roots; proposed cap 200 lineage rows per expanded root. Registry resolution stays Rust-owned/SELECT-only.

- [ ] Seed 250 unrelated newer rows, the same actor in two vaults, equal timestamps across a page boundary, and cross-actor descendants. Assert scoped old run is found, cursor pages have no duplicates/skips, lineage cannot widen roots, capped lineage announces truncation, and cyclic historical links terminate without duplicate rows. Unknown registry identity must return unavailable.
- [ ] Include an Agent whose only matching run is another actor's hop. “Roots” are matching listing anchors, not `parent_run_id IS NULL`; preserve its parent label and paginate it once as an anchor.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml runtime::fleet` and `pnpm exec vitest run src/status/AgentRunHistory.test.tsx src/lib/mockIpc.test.ts`; expect the new pagination/scope cases to fail first.
- [ ] Add parameterized scoped keyset reads and bounded lineage, resolve paths to authoritative runtime IDs, then wire Load more without client filtering a global cap. Make construct cross-vault scope visible; ship only after its owner decision.
- [ ] Rerun the same tests and `pnpm typecheck`; expect parity and no runtime writer connection in the read path. Keep legacy `fleetRuns` unchanged for other consumers until consciously migrated.
- [ ] Commit scoped/paginated history.

### M93.4 — Retain detail selection through failures and origin-aware links

**Files:** Modify `src/status/AgentRunHistory.tsx`, `RunDetailPanel.tsx`, their tests, `src/lib/ipc.ts`, `src/lib/mockIpc.ts`, `src-tauri/src/runtime/fleet.rs`, `src-tauri/src/lib.rs`; add proposed `src/lab/sections/agentRunHistory.tsx` and register it with the existing lab registry discovered at execution.

Review repair file map: `src/app/leaveGuard.ts` and its tests reserve/reuse the
existing navigation intent; `src/stores/vaultStore.ts` accepts its optional
handoff; only `src/stores/navStore.ts`'s reset lines transfer a still-current
accepted intent to the new pane; `src/app/LastPlaceHost.tsx` and its owning tests
defer automatic restoration to that explicit pending destination.

**Interfaces:** Consumes M93.3 and M93.2. Selection is `{rowKey,runId,originVaultId,requestGeneration}`; detail/subsections use loading/ready/unavailable plus explicit not-recorded values inside ready data. Produces origin resolution `{kind:'registered',vault:string}|{kind:'unavailable'}|{kind:'not_recorded'}` for run links.

2026-10-23 implementation review clarification: origin-link activation retains its
own latest-intent generation through origin resolution and the save barrier.
`openVault(path, {stillCurrent?: () => boolean, leaveIntent?: LeaveIntent}?)` remains backward compatible;
the predicate is checked before reserving a switch request and after flushing,
immediately before active-vault mutation. A canceled call cannot supersede a
valid newer request. Once accepted, existing scan/open tickets remain in control.
Only the activation's own accepted vault switch may hand its destination across
source-host retirement; run replacement, explicit close and newer activation
invalidate the old intent. Pending-decision Review links obey this same contract.
The existing leave guard reserves the pane's intent before the first async
origin lookup. Reusing it after saves/scans never gives an old request a new
sequence. Only its own synchronous accepted switch/reset can transfer a still-
current intent to the new pane; a newer ordinary navigation cancels it during
origin lookup, save or scan. Explicit reservations retire on completion/cancel;
historical ordinary tickets cannot suppress automatic last-place restoration.

- [ ] Test rapid A→B with A resolving last, close while pending, same row Retry, scope change, unavailable Knowledge read, missing origin, and matching paths in two vaults. Preserve the current recursive child detail mount with a regression test; do not reimplement it.
- [ ] Run the two status test files; expect stale-selection/origin assertions to fail before repair.
- [ ] Store selection before fetching, guard all responses by identity/generation, render local Retry and use recorded origin for every subsection and link. Route registered origin changes through normal vault-switch/draft barriers; unavailable origin must never navigate to the active vault's matching path.
- [ ] Add all five reading-section lab states and verify via existing state-lab workflow. Rerun targeted tests and `pnpm typecheck`; expect distinct unavailable/not-recorded/empty UI and no late response reopening a dismissed selection.
- [ ] Commit detail correctness and lab coverage.

### M93.5 — Share bounded, retryable CLI discovery

**Files:** Create proposed `src/agent/readiness.ts`, `readiness.test.ts`, `src/agent/AiPanel.readiness.test.tsx`, `src-tauri/src/agent/readiness.rs`. Modify `src/agent/AiPanel.tsx`, `agentIpc.ts`, `src/pages/ClaudeCodeRow.tsx`, `src-tauri/src/agent/mod.rs`, `src-tauri/src/lib.rs`; extend `src/pages/SettingsPage.test.tsx`.

**Interfaces:** `CliReadiness` is `checking|available|missing|unavailable` with observation time/request generation; available includes observed path/version. `refreshCliReadiness():Promise<CliReadiness>` is shared and deduplicates concurrent subscribers. Rust probe returns a bounded discovery result; proposed five-second budget includes spawn/output/reap, with bounded capture.

- [ ] Test rejected IPC, hung version process, executable permission failure, missing binary, changed PATH, retry while open and older response after refresh. Assert timeout never means missing, version never means signed in, and thread/draft survives refresh.
- [ ] Run `pnpm exec vitest run src/agent/readiness.test.ts src/agent/AiPanel.readiness.test.tsx src/pages/SettingsPage.test.tsx`; expect rejected-discovery advice to fail first. Add a toy subprocess Rust test with no actual CLI/account dependency.
- [ ] Implement request identity and explicit Retry/return-from-setup refresh. Bound and reap the native probe; avoid immortal cached login PATH preventing a requested recheck. Preserve runtime authentication error cards and optional setup deferral.
- [ ] Run targeted Vitest, `cargo test --manifest-path src-tauri/Cargo.toml agent::readiness` and `pnpm typecheck`; expect no installation-as-fact on error and no surviving timed-out probe process.
- [ ] Commit readiness repair independently from help content.

### M93.6 — Promote performance evidence into a repeatable runner

**Files:** Create proposed `scripts/performance/corpus.ts`, `measure.ts`, `report.ts`, `corpus.test.ts`, `report.test.ts`, `README.md`; reference retained `docs/superpowers/specs/2026-10-17-polish-implementation/data/performance/production-measure.mjs` without rewriting historical results. Modify `package.json` for proposed `perf:run` script.

**Interfaces:** `BenchmarkCase` includes seed/count/fields/value shape/document bytes; `BenchmarkResult` includes environment, phase, samples, p50/p95 and `measured|timeout|unavailable` status. Runner writes only to an explicitly selected temporary output directory and never `demo-vault`.

- [ ] Test corpus repeatability, destructive-path refusal, missing measurement preservation and report labels distinguishing browser/native. Run `pnpm exec vitest run scripts/performance/corpus.test.ts scripts/performance/report.test.ts`; expect missing runner interfaces to fail first.
- [ ] Port retained measurement semantics and add phase marks/workloads from REL-07, including 10,000-note readable-scope search, editor-open slices and long transcripts. Record hardware/load/source/toolchain and raw samples; separate correctness preflight from timed loops.
- [ ] Future run: `pnpm build`, then `pnpm perf:run -- --output <temporary-directory> --matrix reliability`. Expected: machine-readable complete/timeout/unavailable rows, corpus cleanup and an explicit comparison to historical 1,000-row results. No numerical pass is assumed in advance.
- [ ] Review profile attribution and set a proposed 5,000-row usability budget with the owner before enforcement. Select exactly one next scale experiment; retain results, including failed candidates, as evidence.
- [ ] Commit tooling and report schema; do not hide noisy timings in unit tests.
- [x] Audit BL-02 (2026-10-27, uncommitted): typing workload and app marks. Each document case types ten-character bursts at frame pace and records `keystroke` (real key event to the end of its next frame), `serialize` (serializer ms per change), `serialize-calls` and `writes` per window; `document-2000-blocks` joins the matrix; the app writes `frontend_ready`, `editor_ready` and an `editor_serialize` measure (`src/lib/perfMarks.ts`, read only by the runner) and absent marks are timeout rows. Browser mock, headless Chromium, `--samples 10 --fixture-ms 120000`, load 7–19 (local evidence only). Before = HEAD editor plus the probes; after = BL-03/196/197:

  | Case | Keystroke p50 / p95 ms | Serialize ms per change (p50) | Serializer passes per burst | Writes per window |
  | --- | --- | --- | --- | --- |
  | document-64k | 73.7 / 81.6 → 18.0 / 26.3 | 60.6 → 6.2 | 11 → 1 | 1 → 1 |
  | document-256k | 418.7 / 456.8 → 189.7 / 222.6 | 245.0 → 23.6 | 11 → 1 | 1 → 1 |
  | document-2000-blocks | 134.3 / 148.7 → 52.0 / 63.9 | 90.1 → 8.9 | 11 → 1 | 1 → 1 |

  The 256 KiB page still spends ~190 ms per keystroke outside the serializer (per-transaction editor work, BL-36's decoration and outline costs); editor parse/apply stay unavailable. No native number follows.

### M93.7 — Ship a measured scale improvement with access preserved

**Files:** Modify `src/views/TableView.tsx`, `useRowKeyboard.ts`, `src/app/useEntryState.ts` only where measured; create proposed `src/views/tableWindow.ts`, `tableWindow.test.ts`, `e2e/scale.spec.ts` if bounded rendering is selected. Modify `src-tauri/src/vault/corpus.rs` and `src-tauri/src/search.rs` only if M93.6 identifies tokenization as a material separate cost; keep that optimization in its own reviewable commit.

**Interfaces:** Consumes M93.6. Proposed bounded renderer consumes logical rows, measured heights and pinned editing row identities; it exposes `revealLogicalRow(rowId):Promise<void>` to keyboard/find and retains selection/scroll by row identity. Cached derivations invalidate by vault/entry/schema. Search token cache is per-file; ranking statistics are keyed by effective readable corpus.

- [ ] Add behavioral tests for a wrapped offscreen row with an exact rejected draft, End/Home/range selection, frozen columns, find/reveal, accessible offscreen result count and Back restoration. Assert protected-scope search results/ranks are unchanged when inaccessible files are added.
- [ ] Apply narrower subscriptions/derivation reuse first and remeasure once. If input/DOM costs still miss the reviewed budget, compare bounded rendering against explicit paging; select the candidate passing access tests. Do not add a virtualizer based on a library preference.
- [ ] Run `pnpm exec vitest run src/views/TableView.test.tsx` and `pnpm exec playwright test e2e/scale.spec.ts`; expect exact draft retention, logical navigation and variable heights. Perform VoiceOver/find acceptance because DOM counts cannot prove it.
- [ ] Repeat M93.6 under the same declared environment. Expected: measured improvement and reviewed budget result, with missing/timeout values explicit. Reject the change if speed requires offscreen accessibility loss. Any editor cache/progressive mounting follow-up needs its own measured task amendment covering full-document readiness, cancellation and byte/count caps before implementation.
- [ ] Commit the accepted experiment and retained evidence; remove failed implementation experiments without rewriting their measurements.

### M93.8 — Add body source presentation through the same writer

**Files:** Create proposed `src/editor/SourceBodyEditor.tsx`, `SourceBodyEditor.test.tsx`, `src/editor/sourceBodyEdits.ts`, `sourceBodyEdits.test.ts`; modify `NoteBodyEditor.tsx`, `documentOwner.ts`, `src/lib/ipc.ts`, `mockIpc.ts`, `src-tauri/src/lib.rs`, `vault/write.rs`, `vault/parse.rs`; create proposed `e2e/source-body.spec.ts`.

**Interfaces:** Consumes M93.1/M93.2. Completes `bodyFormat:'source'` on existing `save_note`; Rust `replace_source_body(current:&str,body:&str)->Result<String,NoteWriteError>` derives exact body span and retains prefix. Source view consumes owner draft/edit/flush, never another timer/writer. `applySourceBodyEdit(raw,displayRange:{from:number,to:number},insert:string):string` maps UTF-16 display offsets to raw spans, preserves unchanged newline bytes and uses detected newline style for inserted lines. Read through existing `readNoteSource` whole source/hash.

- [ ] Add fixtures for BOM, CRLF, whitespace on closing fence, leading body newlines, raw HTML, unsupported fences, Unicode and no frontmatter. Assert opening/switching writes nothing; unrelated source edit preserves every prefix byte and unsupported body span. Include external update plus repeated failure and newer draft retry; assert a CRLF edit does not normalize unrelated lines and surrogate-pair offsets do not split Unicode.
- [ ] Run targeted source tests and Rust `vault::write` tests; expect normalized-rich initialization/prefix reconstruction to fail those assertions first.
- [ ] Implement body-span replacement under the current path lock/human guard/receipt, preserving last-write-wins. Source mode must not expose frontmatter editing or unguarded concept writes. Validate before rich transition and retain source if conversion is lossy; explicit rich adoption keeps existing loss warnings.
- [ ] Run targeted Vitest/Rust, `pnpm exec playwright test e2e/source-body.spec.ts` and `pnpm typecheck`; expect one owner, no mode-switch autosave, stable title/metadata portal and exact failed draft retention. Mark governed source eligibility unimplemented unless separately proven.
- [ ] Commit body source support separately from journal retention.

### M93.9 — Decide and optionally implement displaced-byte recovery

**Files:** First create proposed `docs/acceptance/2026-10-23-reliability/recovery-coverage.md`. Only after owner approval create proposed `src-tauri/src/vault/recovery.rs`, `src/history/RecoveryVersions.tsx` and tests; modify `vault/write.rs`, `src/lib/ipc.ts`, `mockIpc.ts`, `src/history/PageHistory.tsx`.

**Interfaces:** Coverage artifact distinguishes Git enabled/disabled, uncommitted outside preimage, excluded mail, quota and interrupted write. Conditional API: `listRecovery(vault,path)` and `restoreRecovery(vault,path,recoveryId)`; restore goes through the existing human owner/barrier. Retention/failure contract is REL-11, not a default hidden inside implementation.

- [ ] Characterize current checkpoints with synthetic fixtures; record exactly what remains unrecoverable. Present opt-in seven-day/100-MiB-global/10-MiB-entry proposal and protected-save failure policy for explicit owner decision. Stop this task at a completed decision artifact if declined; other tasks continue.
- [ ] If approved, add failing tests for exact preimage, privacy exclusion, quota, journal storage failure, crash between preimage and file write, startup cleanup, retention expiry, deletion and restore conflict. Expect no silently missing recovery entry on a protected successful save.
- [ ] Capture preimage under the file lock before mutation, outside the vault, with write identity; implement sweep/clear/export and honest unknown attribution. Unexpected storage failure blocks the protected save until Retry or explicit save-without-copy. Privacy/quota exclusion says why bytes were not retained.
- [ ] Run Rust recovery/write tests and adjacent PageHistory tests; expect bounded retention, no mail bytes in journal and guarded restore receipts. Record that this does not add crash-draft recovery or change human winner semantics.
- [ ] Commit decision evidence; commit conditional implementation separately only if approved.

### M93.10 — Publish one versioned product help source

**Files:** Create proposed `shared/help/{knowledge,reviewed-work,imports,schedules,recovery}.md`, `catalog.v1.json`, `scripts/build-help.ts`, `scripts/help.test.ts`, `src/app/ProductHelp.tsx`; modify the existing help/navigation entry selected with UX. ACT owns any new MCP help registration and policy artifacts.

**Interfaces:** `HelpTopic={id,title,appVersion,contentHash,body}`; generated catalog reads only shipped local help and exposes one-topic retrieval capped at the proposed 16 KiB per topic. Product brief remains the authoritative product description. No private vault text or automatic memory ingestion.

- [ ] Write the five task guides using current shipped paths/tools and explicit human verification/approval steps. Generate app-version/hash provenance from package metadata and the human-facing source.
- [ ] Add tests rejecting unknown tool references, retired vocabulary where applicable, missing version/hash, duplicate IDs and over-limit retrieval. Run `pnpm exec vitest run scripts/help.test.ts` and `pnpm typecheck`; expect all examples to match the shipped manifest.
- [ ] Implement on-demand human retrieval and keyboard navigation using existing DS primitives. Coordinate ACT for a separately reviewed read-only tool if desired; do not add raw filesystem access or enlarge every prompt.
- [ ] Run two guided disposable-vault journeys: one guarded knowledge task and one reviewed agent task. Record completion/failure evidence; browser fixtures alone do not prove live CLI readiness.
- [ ] Commit human help/catalog; keep optional ACT capability registration in its owning package.

### M93.11 — Close native evidence and state release limits explicitly

**Files:** Create proposed `docs/acceptance/2026-10-23-reliability/{matrix.md,environment.json,results.json}` and sanitized evidence children. Modify application files only through a separately reviewed defect task linked from a failing case; this evidence task does not authorize unrelated fixes.

**Interfaces:** `AcceptanceEvidence={caseId,sourceIdentity,buildIdentity,toolchain,environment,expected,observed,result:'pass'|'defect'|'environment_blocked',artifacts:string[]}`. CHAT returns separate live CLI evidence in this shape or an agreed adapter; never combine browser/native/CLI pass counts.

- [ ] Record packaged/source identity, native access method, minimum 900×600 and larger window, disposable vault seed, input devices/IME/VoiceOver versions. Resolve automation inspection failure or label it environment_blocked and use separately attributed manual observation.
- [ ] Execute REL-13 matrix after owner approval of implementation: preexisting/during-quit failed save, external reconciliation, nonleading H1 and stable metadata, native composition/direction/selection, keyboard/VoiceOver, Finder/clipboard, dialog cancel, external file/link policy. Retain expected/observed and sanitized artifacts for each case.
- [ ] Import CHAT's live matrix references for allow/deny/edited/invalid/stale approvals, Stop, repeated click, missing hook, restart waiting and vault switch. A missing CLI case stays unresolved even when corresponding browser test passes.
- [ ] Run the appropriate final code gates once after implementation: `pnpm test:run`, `pnpm lint`, `pnpm typecheck`, `pnpm format:check`, relevant E2E, and Rust test/fmt/clippy when Rust changed. Expected: successful gate output recorded, plus distinct native/live evidence; passing suites never overwrite an unresolved acceptance case.
- [ ] Review every defect/environment limitation as a release decision. Commit evidence after sanitization; do not claim packaging, performance or native acceptance beyond the measured cases.

### M93.12 — Contain render faults

Added 2026-10-27 from the reference audit (`docs/superpowers/specs/2026-10-24-reference-audit/backlog.md` BL-01, BL-27, BL-195; seven of ten reference apps contain render faults, Cerebro had no boundary).

**Files:** `src/components/ui/SectionBoundary.tsx` (presentation only, CV-64 style: reads no store, the owner injects `onCatch`); `src/app/Contained.tsx` (`Contained`, `RootBoundary`, `keepOpenPages`); `src/main.tsx` (root `onCaughtError`); `src/lib/diagnostics.ts` (`reportCaughtError`); wiring in `src/app/PaneRow.tsx`, `src/App.tsx`, `src/pages/DocPage.tsx`; the storage rule in `eslint.config.js`.

**Interfaces:** `SectionBoundary{label, resetKey?, onCatch?, onBack?, compact?, fallbackClassName?, whileFailed?}`. A fault draws `StateMessage unavailable` ("<label> stopped drawing") with Retry (a keyed remount; it writes nothing) and an owner-supplied Back. `Contained` injects `keepOpenPages`: `prepareOpenPages()` then `flushOpenPages()`, as a leave does. `RootBoundary` wraps App; its fallback mounts the quit host, so ⌘Q, the close button and ⌘W still save and quit while the window is down. No fallback reloads or clears browser storage.

- [x] BL-01 core: root `onCaughtError` reaches the diagnostic log under its bounds; boundaries on each pane body (reset by the place it shows, Back through the pane's history), the record peek and the page editor; `RootBoundary` around App. Tests: `SectionBoundary.test.tsx`, `Contained.test.tsx` (prepare then flush; quit host only while down), `PaneRow.test.tsx` (a throwing pane leaves the other pane's editor mounted with its typed text), `diagnostics.test.ts`.
- [x] Storage rule: `no-restricted-properties` refuses `localStorage.clear`, `sessionStorage.clear` and `indexedDB.deleteDatabase` outside tests (`scripts/lint-rails.test.ts`).
- [x] BL-27, the assistant and shared surfaces: the assistant root (`Contained`, reset by vault), each turn (`Message`), each step renderer (`StepItem` → `StepBody`), each rail card (in `ConversationRail.tsx`, never inside `components/ai/`), each Home lane, the page side panel, every Dialog body and HoverCard content. A second fault stays unavailable until the reset key changes. Tests: `SectionBoundary.test.tsx`, `toolRenderers.boundary.test.tsx`.
- [x] BL-27, the rest: every Settings section (`SettingsPage` `panel()`, which holds the M94.8 utility sections and the conversation archive's retention view) and every lab section. An archive turn the adapter cannot read faults inside the assistant root or its own turn. Retry is a remount, which CV-30 already proves re-attaches a running turn (`useAgentChat.test.tsx::closing the panel mid-turn detaches and never stops the run`, `e2e/agent-detach.spec.ts`). No fallback offers Reload; if one ever does, only while `unresolvedOpenPages()` and every draft are empty.
- [x] BL-195: `src/lib/retryableOnce.ts` (shared start, a rejection or `expire()` is forgotten) for the pdf.js engine (a dead worker expires it), the Shiki highlighter, the formula catalog and the mermaid highlighter. Tests: `retryableOnce.test.ts`.
- [ ] Native: a root throw in the packaged app still answers ⌘Q within Rust's deadline (M93.11 evidence).

## Coverage and self-review

| Spec requirement | Tasks                         |
| ---------------- | ----------------------------- |
| REL-01/02        | M93.1                         |
| REL-03           | M93.2, M93.8                  |
| REL-04           | M93.3                         |
| REL-05/06        | M93.4                         |
| REL-07           | M93.6                         |
| REL-08           | M93.7                         |
| REL-09           | M93.5                         |
| REL-10           | M93.8                         |
| REL-11           | M93.9, conditional owner gate |
| REL-12           | M93.10                        |
| REL-13           | M93.11 with CHAT evidence     |
| Render faults    | M93.12 (audit BL-01/27/195)   |

Author self-review completed against the draft spec: ownership, save/result types, cursor ordering and history origin match; all five Review Focus classes have named assertions. Conditional journal/cache decisions are explicit bounded gates, not invented current capabilities. Child detail mounting is retained as implemented. No test outcomes, benchmark improvement or native/live acceptance are claimed by this plan. Main unresolved owner choices are construct scope, accessible scale candidate, recovery retention and source eligibility for governed pages.
