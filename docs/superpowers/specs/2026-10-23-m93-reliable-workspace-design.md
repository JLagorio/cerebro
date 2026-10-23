# M93 — Reliable workspace design

**Milestone:** M93 · **Phases:** M93.1–M93.11 · **Requirements:** REL-01–REL-13.

[Master roadmap](../plans/2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](2026-10-23-m93-m99-research/README.md).

**Status: DRAFT FOR OWNER REVIEW — recommended design, not implementation approval.**

This package covers CP01, CP02, CP03, CP04, CP11 and CP13 from the [reference strengthening proposal](../plans/2026-10-22-reference-strengthening-plan.md). It makes existing files-first workflows recoverable and their evidence trustworthy. The companion [implementation plan](../plans/2026-10-23-m93-reliable-workspace.md) is a future work proposal. No suites, benchmark, packaged build, native interaction or live CLI acceptance were executed for this design.

## Intent and boundaries

A person must be able to recover a failed save without typing again, distinguish recorded history from an unavailable read, and work through large tables without losing keyboard or assistive access. Unsupported Markdown should have a useful source escape hatch sharing the rich editor's owner. Setup should describe what Cerebro actually observed.

The recommended order is save retention and history correctness, readiness repair, reproducible measurement and native evidence, then measured scale improvements, source presentation and an explicitly gated recovery journal. This package does not replace React, the Markdown grammar, Git or the files-first authority; add a persistent search index; introduce app-held API keys; make crash recovery promises; or change agent compare-before-write and human last-write-wins. CLI remains the default. CORE owns service extraction/storage experiments; CHAT owns live CLI protocol proof; KNOW owns retrieval quality and passage navigation; UX owns shared visual design.

## Current evidence and source drift

Source inspected on 2026-10-23:

- [MarkdownEditor](../../../src/editor/MarkdownEditor.tsx) sets `lastSaved` before `onChange` settles and only emits on flush when a debounce timer existed. [NoteBodyEditor](../../../src/editor/NoteBodyEditor.tsx) catches write rejection and toasts; its `Held` state serves reconciliation, rather than a general acknowledged-draft retry contract. [openPages](../../../src/editor/openPages.ts) returns a nonrejecting void flush. [quit](../../../src/app/quit.ts) compares failure counts since quit began and can unmount before a leave-triggered failure is known. These establish a missing recovery contract, not a reproduced native data-loss incident.
- [AgentRunHistory](../../../src/status/AgentRunHistory.tsx) still reads 200 global rows before client actor filtering; failed detail closes selection and late requests may overwrite it. **Drift correction:** recursive `RunChain` now mounts detail for child hops. That yesterday-reported defect is implemented and needs retention coverage, not a second repair. [RunDetailPanel](../../../src/status/RunDetailPanel.tsx) still reads Knowledge and resolves page links against the active vault. [fleet](../../../src-tauri/src/runtime/fleet.rs) already filters actor/vault before LIMIT and orders by start/run ID.
- [AiPanel](../../../src/agent/AiPanel.tsx) still maps rejected discovery to `installed:false`; [ClaudeCodeRow](../../../src/pages/ClaudeCodeRow.tsx) separates failed discovery. [agent status](../../../src-tauri/src/agent/mod.rs) invokes `--version` through `.output()`; discovery must bound the actual subprocess, not merely the frontend wait.
- [read_note_source and edit_note](../../../src-tauri/src/vault/write.rs) already expose whole source/hash and preserve untouched prefixes for quoted agent edits. `save_note` still reconstructs through `compose_saved`; [parse](../../../src-tauri/src/vault/parse.rs) documents BOM/CRLF/fence caveats. Reuse these mechanisms without claiming rich serialization preserves every byte.
- [TableView](../../../src/views/TableView.tsx) already has editing leases, row keyboard behavior and anchored field errors. The [retained production report](2026-10-17-polish-implementation/data/performance/production-report.md) measured p95 key-to-two-frame 398.8 ms at 1,000×12 and 1,376.2 ms at 1,000×24; 5,000×12 navigation timed out, 5,000×24 was not measured. These are historical shared-machine headless Chromium diagnostics. The retained <100 ms 1,000-row input goal is not new evidence or an achieved native budget.

Research lineage: MR-01/03/05/06, AP-01/02/07/09, Macro findings 1/5 and Tolaria T1–T8/M93.10. Accent normalization and ranking evaluation remain KNOW work; delegated transcript semantics remain CHAT work.

## Approaches and recommendation

For saves, a Retry button attached to the existing failure counter is insufficient: it has neither a retained payload nor generation identity after unmount. Recommend an in-memory document owner retained above presentation lifetimes. A persistent crash-draft store would add privacy/retention/migration obligations and is deferred.

For scale, start with cached pure derivations and narrower subscriptions. Compare accessible windowing with explicit paging only after profiles identify DOM pressure. Paging is the recommended fallback if bounded rendering cannot preserve find, variable heights and keyboard behavior. No virtualizer is selected by this draft.

For source editing, recommend body-only presentation with exact untouched-prefix replacement under the existing human save guard. Whole-file editing would create another metadata authority and is deferred. A recovery journal is a separate opt-in decision after characterizing Git/checkpoint coverage.

## Requirements and contracts

### Save owner and acknowledged identity

**REL-01.** Each live document has one owner keyed by `{vaultId,path,ownerId}` and a monotonic `generation`. Rich/source presentations, parked panes and quit use that owner. Keep `latestDraft`, `inFlightGeneration`, `acknowledgedGeneration` and optional failure separate. A draft is clean only when its current generation is acknowledged. Serialize writes per owner; coalesce pending generations to the newest. Completion for an old owner/path or generation cannot clear newer dirtiness, failures or selection.

**REL-02.** Add a typed internal save outcome and flush report. Proposed types are:

```ts
type NoteWriteAck =
  { kind: 'file'; contentHash: string } | { kind: 'governed'; projectionHash: string };
type SaveOutcome =
  | { kind: 'acknowledged'; ownerId: string; generation: number; write: NoteWriteAck }
  | { kind: 'failed'; ownerId: string; generation: number; code: string }
  | {
      kind: 'blocked';
      ownerId: string;
      generation: number;
      reason: 'reconcile' | 'choice' | 'deadline';
    };
type FlushReport = { outcomes: SaveOutcome[]; unresolvedOwnerIds: string[] };
```

The file hash identifies bytes acknowledged by the authoritative write door, not a subsequent rescan. Existing `saveNote` returns hash or null for a governed projection; null must not become a fabricated hash. Extend the authoritative result to supply a projection hash only after guarded projection materialization/read confirmation. Human-facing actions still catch, toast and return typed outcomes rather than throwing (CV-03). Refresh failure after an acknowledged write is a refresh error, not failed durability.

**REL-03.** Save, Retry, assistant launch, rename/move, close, vault switch and quit inspect current unresolved owner state, including failures predating the action. Retain exact latest text through repeated failure and presentation unmount. Retry writes latest draft without a keystroke; no automatic repeated retry is proposed. Rename atomically transfers owner identity only after settling or deliberately retaining the old target; deletion leaves a recoverable draft with explicit Copy/Save as choices. Never recreate a deleted file implicitly.

Prepare every owner's leave work while it remains recoverable, then unmount only after acknowledgement or an explicit discard/quit-anyway. Preserve Rust's deadline and the current 30-second second-quit override. A timeout is unresolved, never success. Dock Quit/logout/shutdown currently bypass the webview preparation; do not advertise those as protected. No crash retention is promised.

This barrier includes every existing save participant, not only `NoteBodyEditor`: standalone diagrams (`mermaid/useDiagramFile.ts`), buffered diagram source (`mermaid/CodeOverlay.tsx`, including Auto-Update off), whiteboards (`whiteboard/useCanvasFile.ts`), sheet drafts and focused metadata/property fields. A participant prepares its latest local buffer **without unmounting**, then reports acknowledgement, failure or a held/deadline outcome through the common barrier. Reuse its existing writer and receipt; adapting the barrier does not replace canvas reconciliation or create another body writer. Inventory cleanup-only writes and blur commits as well as registered flushes. A failed field commit must retain its exact value or remain an explicit unresolved participant before a dependent action proceeds.

Rust currently exits after five seconds even without a webview answer (`shell/quit.rs`), so retention cannot be guaranteed for a hung webview/process. The responsive-webview path must cancel the native quit with headroom before that deadline whenever any participant remains unresolved. Test native cancellation timing separately from frontend fake-clock behavior. If measurement shows cancellation cannot reliably reach Rust in time, record and separately scope the native gate repair before claiming that quit case protected; preserve the bounded escape and intentional second-quit override. This does not extend protection to Dock Quit or crash recovery.

### History scope and request identity

**REL-04.** Ordinary Agent record history is actor **and originating vault** scoped before LIMIT. Proposed input `RunHistoryScope` is `{kind:'agent',vault:string,actor:string}` or `{kind:'construct',actor:string,vault:'all_registered'}`. `vault` for agents is an app-selected registered path; Rust resolves its runtime vault ID using the registry and never substitutes that path into `vault_id`. Construct cross-vault scope is a visible proposed default requiring owner review. Unknown/removed registry identity is unavailable, not an empty history.

`fleetRunsPage(scope,cursor?,limit?)` returns `{runs,nextCursor,effectiveVaultIds}`. Limit defaults to 50, maximum 200 as today. Cursor is the last `(started_at,run_id)` tuple in descending order; query uses strict lexicographic less-than and fetches one extra row. Fetch lineage independently by root run IDs, returning bounded rows plus explicit truncation; it must not widen the root actor filter or silently drop a child by another actor. Proposed lineage cap is 200 rows per expanded root, with cycle detection, a visited-run set and a truncation label rather than a false complete tree. Every returned descendant retains its own origin identity.

Here “roots” means actor/vault-matching listing anchors, including a matching run whose `parent_run_id` is non-null. Do not add a parentless-only predicate: an Agent that ran only as another actor's hop still has recorded work. Its parent reference remains visible; descendant expansion does not change which anchors are paginated.

**REL-05.** Selection stores `{rowKey,runId,originVaultId,requestGeneration}` independently of its `loading|ready|unavailable` read. Only a response matching every identity field can apply. Close, newer selection, scope change and unmount invalidate pending generations. A failure keeps the selected row open with local Retry. Each subsection distinguishes unavailable, not recorded and measured empty. Preserve recursive child detail already implemented.

**REL-06.** Knowledge reads, subject links and Pages written use the recorded vault ID resolved through the registry. A link opens only within that resolved vault after the normal vault-switch/draft barrier. An unavailable or unregistered origin offers an explanation/switch recovery, never a same-path page in the active vault. Null historical origin remains “origin not recorded”. Older rows remain readable; no attribution is inferred during migration.

### Measured scale and readiness

**REL-07.** Promote the retained production measurement into a disposable-corpus runner. Separate scan, readable corpus/tokenization, derivation, render, first content, editor parse/apply/readiness, input, scroll, filter, save-to-visible and memory observations. Workloads: 100/1,000/5,000 records ×12/24 fields; long/sparse/wrapped values; relations/rollups; long documents/transcripts; 10,000-note scoped search. Record source/build/toolchain, fixture seed/bytes, hardware/load, sample count, p50/p95 and timeouts. Never encode missing measurements as zero.

**REL-08.** Scale changes preserve editing leases, exact rejected drafts, frozen columns, variable row heights, End/Home/range selection, offscreen announcements, find across the logical result set and Back-restored scroll. Browser find may be replaced only by an explicit, keyboard-accessible equivalent searching every logical row, with visible match/count and reveal. The removed `content-visibility:auto` approach must not return without proving offscreen accessibility. The 5,000-row goal is set from the spike and reviewed before enforcement; stable dedicated-runner budgets belong outside unit tests.

Document caches, if profiles justify them, cover closed clean documents only and are bounded by bytes/count/per-entry size with foreground priority, cancellation and vault/path/hash/parser-version keys. Failed reads are evicted. Corpus token caches are per-file; BM25 statistics belong to the effective readable corpus so inaccessible documents cannot affect ranks/counts. Progressive mounting cannot enable edit/autosave/undo until the complete document passes carrier/round-trip validation. No stale startup snapshot participates in grants, triggers, verification or writes.

**REL-09.** One shared discovery state serves chat and Settings: `checking|available|missing|unavailable`, observation time and request generation. Available means executable observed, not authenticated. Missing requires completed discovery; error/timeout is unavailable. Retry and return-from-setup refresh preserve thread/draft. Bound native process duration, capture and kill/reap; a frontend timeout alone is insufficient. Proposed probe budget is five seconds, superseded only through reviewed measurement. CLI-owned login/runtime account failures remain separate.

### Source, recovery, guidance and acceptance

**REL-10.** Source presentation reads exact body from whole source/hash, including leading newlines, and writes nothing on open/switch. Extend the existing human `save_note` command with `bodyFormat:'rich'|'source'` (default rich for compatibility); source replaces only the exact current body span under the same lock/guards/receipt. Preserve untouched prefix and body bytes, BOM, fence endings/whitespace, unsupported body syntax and Unicode. Keep raw source in the owner; a browser text control must not normalize the entire draft through its value setter. Map edits from displayed UTF-16 offsets onto raw source spans, retain unchanged newline bytes and use the detected newline style for inserted lines (LF when absent). No human expected-hash requirement is added; current human last-write-wins remains deliberate. Concepts retain guarded projection ownership; source mode is unavailable there until its governed byte contract is independently demonstrated. Returning to rich mode validates the complete draft and remains source/read-only when lossy, unless the person explicitly adopts rich loss.

**REL-11.** First measure which displaced outside bytes existing Git/checkpoints preserve. A proposed journal, if approved, stores exact preimage bytes before a human save displaces them, locally outside the vault and separately from epistemic history. Proposed defaults: opt-in, seven days, 100 MiB global, 10 MiB per entry, mail/digest exclusions from shared policy, clear/delete/export controls. Entries identify vault/path/write hash/time and “outside, unattributed” unless recorded evidence supports attribution. Quota/privacy exclusion reports “recovery copy not retained”; unexpected write/storage failure blocks the protected save until retry or explicit save-without-copy. Restore is a guarded human write through the same owner. Atomic preimage capture and write share the file lock; startup sweeps uncommitted journal rows by recorded write identity. Nothing ships behind unspecified retention.

**REL-12.** Ship concise, app-versioned help for knowledge capture/verify, reviewed agent work, edited-copy imports, schedules and CLI/connector recovery. One human-facing source generates a bounded local catalog (proposed maximum 16 KiB per topic and one topic per retrieval); product brief stays authoritative. Help is not vault knowledge or agent memory. Agent retrieval is on demand through an ACT-reviewed read-only manifest/policy entry, never added wholesale to each prompt. Examples must name shipped capabilities; credentials and private paths never enter documentation fixtures.

**REL-13.** Native acceptance uses a disposable vault and isolated packaged identity at current minimum **900×600** and representative larger windows. Cover failed save before/during quit, reconcile/title/metadata stability, Korean/Japanese/Chinese composition, mixed Arabic/Hebrew direction and selection, keyboard/VoiceOver, Finder attachments, clipboard, native dialog cancel, and external file/link policy. Each case records expected/observed, build/toolchain and `pass|defect|environment_blocked`, with sanitized artifacts. Resolve or explicitly retain `cgWindowNotFound` as an automation limitation; a manual pass has its own evidence. Browser tests do not close native acceptance; packaged launch does not close editing acceptance. CHAT supplies separately identified live CLI evidence. Unresolved cases remain release decision gates.

## Privacy, compatibility and owner gates

In-memory retention ends at explicit discard or process exit; it adds no persistent draft recovery. Benchmark corpora and native evidence are synthetic and disposable. History remains SELECT-only through `runtime::ReadOnly`; pagination needs no run rewrite. Existing callers keep default rich serialization until migrated, and legacy null/unknown rows remain honestly unknown.

Owner review must choose construct scope, the renderer/find fallback after measurement, source eligibility for governed pages, journal opt-in/quotas/failure policy and help entry placement with UX. Implementation may start only after program approval. Independent save/history/readiness fixes do not wait for journal or storage migration decisions. Acceptance evidence and thresholds must carry their environment rather than becoming broad reliability claims.
