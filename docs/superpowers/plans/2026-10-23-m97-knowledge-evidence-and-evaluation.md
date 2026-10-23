# M97 — Knowledge, evidence and evaluation

**Milestone:** M97 · **Phases:** M97.1–M97.8 · **Requirements:** KNOW-01–KNOW-11.

[Master roadmap](2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](../specs/2026-10-23-m93-m99-research/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect search and answers to precise evidence and establish reproducible product-outcome evaluations.

**Architecture:** Extend existing search, editor navigation, runtime manifests and knowledge inspection. One shared source-location contract serves Quick Open, chat and backlinks; existing assembly and verification remain authoritative.

**Tech Stack:** Existing Rust, TypeScript, React, Tauri IPC, shared JSON fixtures, Vitest/cargo/Playwright and CLI recording kit.

**Spec:** [Knowledge, evidence and evaluation](../specs/2026-10-23-m97-knowledge-evidence-and-evaluation-design.md).

**Status:** Draft for review. All commands below describe future verification.

## Global Constraints

- Body ranges are end-exclusive UTF-8 bytes excluding frontmatter; `sourceHash` hashes the complete raw file.
- Quote cap 240 Unicode scalars; prefix/suffix 80 each; proposed occurrence page size 50, with 500-source/8-MiB per-page query work caps after corpus loading.
- Configuration manifests are capped at 64 KiB encoded and contain no instruction bodies or secrets in v1.
- Proposed manifest retention is 90 days completed, 64 MiB per vault; active manifests are pinned and exhausted active capacity blocks new required capture explicitly.
- Knowledge remains agent-written and human-verified; matching or citing never verifies it.
- No scope leakage or forbidden effect may be overridden by a model/human quality score.
- Use existing four IPC adapters, shared policy/cases, read-only runtime readers and five lab presets.

## Review Focus

1. Emoji, combining marks and displayed wikilinks preserve the selected raw occurrence — M97.1/M97.2.
2. A repeated quote after editing never highlights a guessed first match — M97.1/M97.2.
3. Revoked read access cannot leak an excerpt from stored context or a previous run — M97.3/M97.4.
4. Editing Agent instructions after dispatch cannot rewrite historical configuration — M97.3.
5. An attractive answer or judge score cannot mask a forbidden write or missed negative control — M97.6/M97.7.

## File map

New `shared/knowledge/source-location.v1.json` and shared cases define carriers.
New Rust `src-tauri/src/source_location.rs` resolves raw source; new pure TS
`src/engine/sourceLocation.ts` validates the DTO, and editor mapping stays in
`src/editor/sourceReveal.ts`. New runtime `run_configuration.rs` owns operational
manifest writes/reads through existing writer/read-only capabilities. New outcome
fixtures live under `conformance/outcomes/`; no golden demo or reference app edits.

Each task ends with a focused review/commit using the existing milestone convention
`type(scope): sentence (M97.<phase>)` under its numbered phase. No passing results are implied.

### M97.1 — Preserve and resolve source locations

**Files:** Create `shared/knowledge/{source-location.v1.json,source-location-cases.json}`,
`src-tauri/src/source_location.rs`, `src/engine/sourceLocation.ts` and its test;
modify `src-tauri/src/vault/corpus.rs`, `src-tauri/src/search.rs`,
`src-tauri/src/lib.rs`, `src/lib/ipc.ts`,
`src/lib/mockIpc.ts` including its current `VaultHit` declaration.

**Interfaces:** Produces `SourceLocator`, `ResolveSourceResult` exactly as the spec;
`resolve_source(scope, locator) -> Result<ResolveSourceResult, SourceReadError>`.
`VaultHit` gains optional `location`; absent means legacy/not-recorded, not an
invented offset. Browser mock consumes the same cases.

Extend existing `CorpusText` with spec's optional `SourceSnapshot`, generated
from the same changed-file read as entry/body: lowercase raw full-file SHA-256,
carrier, body start, searched body byte count and cap state. Carry path/snapshot
through `Kept` and preserve original excerpt-window offsets before display
normalization. Failed reads/unsupported carriers never invent Markdown locations.

- [ ] Write shared cases for repeated quote, changed metadata, edited body, emoji, combining marks, CRLF, frontmatter field, projected H1, wikilink alias, revoked scope and unsupported carrier. Assert exact/relocated/changed/unavailable outcomes and valid byte boundaries.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml source_location` and `pnpm test:run src/engine/sourceLocation.test.ts`; require failures for missing contract before implementation.
- [ ] Retain raw ranges in the search producer before excerpt normalization; implement bounded unique-context relocation and scope-first resolution. Register shared-case parity and literal IPC payload keys.
- [ ] Add `search_location_hashes_the_same_read_as_its_range`, `metadata_only_edit_changes_source_snapshot`, `unchanged_search_reuses_source_snapshot`, `capped_body_locator_stays_in_searched_bytes` and `non_markdown_hit_has_no_body_locator`. Hold an outside edit between ranking and DTO construction: the returned path/hash/range must remain from its original snapshot, and later resolution must report changed/relocated. Do not reread merely to hash a result or pair fresh hash bytes with cached excerpts. Replay CRLF/frontmatter/alias offsets across both loaders.
- [ ] Run targeted tests plus `pnpm test:run src/lib/ipcContract.test.ts` and `pnpm typecheck`. Check old results without locations still open their page honestly.
- [ ] Review and commit the contract with its first search producer.

### M97.2 — Reveal once through the existing editor and preserve return paths

**Files:** Create `src/editor/sourceReveal.ts` and tests; modify
`src/app/QuickOpen.tsx`, `src/editor/NoteBodyEditor.tsx`, `src/app/useOpenPath.ts`,
`src/stores/navStore.ts`, `src/app/useEntryState.ts`, `src/detail/DocProperties.tsx`
and `src/detail/RecordPageProperties.tsx`; create `src/app/sourceOpen.ts` and
its test; add `e2e/source-reveal.spec.ts`. Amend the current Quick Open invocation
owner only if needed to consume its one-shot session resume snapshot.

**Interfaces:** `revealSource(request: {requestId:string;locator:SourceLocator}, editorOwner)
-> Promise<'revealed'|'changed'|'unsupported'|'cancelled'>` for body locations;
`revealProperty(key, requestId, propertyOwner)` targets the existing read-only row
anchor for property locations. Navigation stores a
one-shot request per destination visit, not a global selection singleton.

Consume spec's exact `QuickOpenSnapshot`, `SourceReturnOrigin`,
`SourceOpenRequest`, `openSource(request): NavOutcome` and
`returnToSourceOrigin(requestId): 'restored'|'origin_unavailable'`.
The coordinator exports `useSourceNavigation()` returning these two functions,
binding `useOpenPath` at render time rather than invoking a hook during dispatch.
Bind one pending
request/origin per actual live visit or peek owner/generation, including unchanged
or reused outcomes, replacing superseded records and clearing them with that
owner. Quick Open's existing category/level types remain authoritative. Its
snapshot is session-only; Return to results deliberately reopens the palette,
while ordinary Back retains page-visit semantics. No second navigation service.

- [ ] Add tests asserting the second repeated occurrence is selected, source UTF-8 maps to editor UTF-16, title projection does not shift body positions, and stale/unmappable content opens with a useful state rather than wrong selection. Add property-array/relation flattening, missing/renamed key and changed-value cases: focus the exact metadata row or report changed, never select an invented body range/member.
- [ ] Run `pnpm test:run src/editor/sourceReveal.test.ts src/app/QuickOpen.test.ts`; require the new missing-behavior assertions to fail.
- [ ] Map source spans to the installed editor document only after matching source/version readiness. Property reveal asks the existing property owner to reveal its row without entering edit mode or altering saved visibility. Consume each request once; do not steal focus while a person is typing in another pane. Preserve search/query/scroll through Back.
- [ ] Add named regressions `return_to_results_restores_palette_snapshot`, `source_reveal_reuses_existing_holder`, `two_reveals_use_latest_request`, `peek_promotion_transfers_source_origin`, `parked_holder_activates_once` and `missing_origin_leaves_source_usable`. Assert query/category/level/expansion/active-row/list-scroll, held editor in another pane, source deletion/vault-switch cancellation, delayed readiness after typing elsewhere and surviving origin focus. Preserve M92's primary jump in canvas and float-before-secondary source open; conversation origin references its existing draft/scroll owner.
- [ ] Record a supported-construct matrix for raw-source mapping (projected H1, paragraphs/lists, wikilink aliases, code and custom blocks). A missing reliable mapper is visibly unsupported; do not turn passing simple-paragraph tests into an all-Markdown claim.
- [ ] Run targeted tests and `PORT=<free-port> pnpm e2e e2e/source-reveal.spec.ts`, using actual `e2e/boot.ts`. Verify full page, peek and open beside plus narrow pane; run native IME/focus in REL's environment gate.
- [ ] Commit the full search-to-passage journey, with unsupported carriers visibly retained.

### M97.3 — Record immutable configuration at dispatch

**Files:** Create `src-tauri/src/runtime/run_configuration.rs`; modify runtime schema
migration registration and `src-tauri/src/agent/mod.rs` dispatch; extend read DTOs
through `src/agent/agentIpc.ts` and `src/lib/mockIpc.ts` as their current ownership dictates.

**Interfaces:** `RunConfigurationManifestV1` from spec;
`record_configuration(writer, manifest) -> Result<(), ManifestWriteError>`;
`read_configuration(ReadOnly, scope, runId) -> Result<ConfigurationRead, ReadError>`.
`ConfigurationRead = Recorded {manifest} | NotRecorded {reason}` where reason is
legacy, expired, deleted or capture_failed; a read error is unavailable.
`prune_configuration(writer, vaultId, now) -> PruneReport` expires completed
manifests under the proposed 90-day/64-MiB policy; no instruction bytes in v1.

- [ ] Test dispatch then Agent/grant edits, absent CLI observation, oversize manifest, revoked source, secret-bearing input and failed migration. Assert immutable known facts, redacted/omitted secret values and atomic schema rollback. Add 90-day expiry, completed-row quota eviction, pinned active rows, all-active budget exhaustion and explicit deletion with surviving ACT receipts.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml run_configuration`; establish the expected failures.
- [ ] Add a numbered runtime migration, bounded writer, lifecycle pruning and scoped SELECT-only reader; record configuration before process launch. Record expiry/deletion reasons separately without deleting run history. Capacity failure blocks required capture and says why. Existing policy and per-write receipts still determine permission.
- [ ] Run the focused Rust suite and related IPC/mock tests. Include secret-canary fixtures that fail if headers/env credentials or full instruction bodies appear.
- [ ] Commit runtime producer and reader together; old rows stay explicitly not recorded.

### M97.4 — Inspect configuration and actual evidence

**Files:** Create `src/status/RunConfiguration.tsx`, `src/knowledge/EvidenceInspector.tsx`
and their tests; modify `src/status/RunDetailPanel.tsx`,
`src/knowledge/KnowledgePanel.tsx`, `src/agent/elements/decisionsSources.ts` and
`src/editor/citations.ts`, their tests and shared resource-target cases, plus
appropriate `src/lab/sections/` registrations. Any shared Sources
primitive prop change waits for M91/M92 handoff and a reviewed consumer map.

**Interfaces:** Consumes M93 scoped run identity, configuration manifest, existing
`WorkingMemoryManifest` and CHAT context receipt; produces source-open requests
using M97.1. No evidence row can authorize a write.

Consume spec's `EvidenceObservation` envelope around unchanged `EvidenceRef`,
preserving producer run/attempt/tool/turn/assembly identity and multiple roles per
source/version. `supporting` needs a recorded `basisRef`, not inference from the
compact first-`via` display list. Consume `ResourceTarget` classification through
the existing adapter: proven local page, safe external URL, missing local path
and scope descriptor remain distinct. The old `ResourceRow` fallback that marks
all unresolved resources `vault` is replaced; no new Verify/property writer.

- [ ] Add tests for old-run not-recorded, failed read, missing historical bytes, selected versus read versus supporting, accessible contradiction and revoked source. Assert separate configuration/assembly/chat coverage labels.
- [ ] Add `search_fetch_citation_retains_all_roles`, `search_only_is_not_read`, `failed_fetch_is_not_read`, `citation_without_read_has_limited_coverage` and `supporting_requires_recorded_basis`. Drive actual CHAT/assembly receipt fixtures with stable observation IDs; compact M91/M92 rows are display projections only and cannot mint evidence. Preserve legacy limited-coverage states.
- [ ] Add `scope_descriptor_is_plain_text`, `missing_local_source_is_not_openable`, `unsafe_scheme_is_not_a_source_action` and `resolved_vault_source_keeps_citation_number`. Assert descriptor/missing rows do not draw file/open semantics or issue passage requests, while valid local/external sources retain their existing policies and human-only Verify.
- [ ] Run the new component tests and existing knowledge/run detail tests to establish failures for missing presentation.
- [ ] Build readable sections within existing run/page surfaces and one panel slot. Render immutable/current comparison, explicit limits and passage actions; never synthesize a confidence score.
- [ ] Add ready/empty/not-recorded/partial/unavailable lab presets; run targeted tests and state-lab checks, then ask→inspect→source→Back browser journey. Preserve selection/draft/scroll.
- [ ] Commit evidence inspection with all its producer-state distinctions.

### M97.5 — Contextual backlinks and explicit mention discovery

**Files:** Modify `src/engine/links.ts`, `src/detail/DocSidePanel.tsx` and existing
search adapter; create `src/knowledge/MentionResults.tsx` and tests plus bounded
Rust occurrence query/tests in `src-tauri/src/source_location.rs` or a focused
`source_occurrences.rs` sibling, using M97.1's corpus snapshot contract. Extend
the shared occurrence cases, existing IPC/mock adapters and their contracts.

**Interfaces:** Produce spec's `SourceOccurrence` and `OccurrencePage` through
`find_source_occurrences(scope,targetPath,mode,cursor?)` and its `find_mentions`
delegate. Both return `Result<OccurrencePage,SourceReadError>`; page size is 50.
Occurrence identity includes source path/hash plus raw span or property key.
Cursor identity binds target/mode/scope digest/corpus snapshot; changed identity
returns `ChangedSnapshot` and explicit refresh. Existing deduplicated backlinks
remain cheap source summaries and never supply an invented raw occurrence.
Encode the proposed 500-examined-source/8-MiB examined-byte work limits in the
shared artifact; retain the corpus per-body cap. Reaching a work cap returns a
continuation cursor/truncated even for a zero-row page. Corpus loading remains
REL's independently measured responsibility, not covered by this query bound.

- [ ] Test filename/key/title resolution, duplicate titles, relation fragments, cap 50, scope changes, stale source and zero versus failed reads.
- [ ] Run new mention/backlink tests and matching Rust cases; establish failures before adding queries.
- [ ] Add bounded on-demand excerpts and explicit Search mentions. Keep invalidation tied to corpus/schema/scope identity; inserting a chosen link uses the existing human writer and undo.
- [ ] Add `repeated_body_links_have_distinct_occurrences`, `backlink_opens_the_recorded_occurrence`, `relation_fragment_uses_property_row`, `cursor_refuses_changed_corpus`, `cursor_refuses_changed_scope` and `capped_scan_does_not_claim_no_mentions`. Exercise duplicate-title target resolution, edits/deletes between pages and scope revocation; assert deterministic path/carrier/key/range ordering, explicit page-versus-occurrence counts, corpus byte/scan caps and no revoked excerpt retention. Raw Markdown producer, not the deduplicating TS link index or a first-title text search, owns exact ranges.
- [ ] Verify no corpus scan occurs in render, next-page scope stays stable and a revoked source disappears without cached text leakage.
- [ ] Commit list-based discovery. A relationship graph or personal recall surface remains a separately approved extension.

### M97.6 — Establish twelve deterministic outcome fixtures

**Files:** Create `conformance/outcomes/{manifest.v1.json,cases/}`, `scripts/outcomes/{run.ts,assert.ts,report.ts}`,
`scripts/outcomes.test.ts`; extend existing conformance/recording adapters, not an
independent fake permission engine.

**Interfaces:** `OutcomeCase {id,inputs,allowedEffects,forbiddenEffects,expectedSources,expectedArtifacts,injections}`;
`runOutcome(case, adapters) -> OutcomeReport {dimensions,observations,identity}`.
Fixture asserts consume actual recorded writes, source refs and broker outcomes.

- [ ] Encode all twelve scenarios named in the spec and negative controls for source disclosure, forbidden effect, false Verify, stale content, failed-child isolation and unknown-outcome retry.
- [ ] Run `pnpm test:run scripts/outcomes.test.ts`; ensure each deliberately broken control is rejected, not merely snapshot-different.
- [ ] Implement deterministic replay/reporting with injected clocks and disposable state. Reuse production guards/reducers and ACT fake-provider seam; reject unauthorized effects regardless of text quality.
- [ ] Run `pnpm exec tsx scripts/outcomes/run.ts --mode offline --manifest conformance/outcomes/manifest.v1.json --out <report-directory>` plus focused Rust conformance. Require all hard dimensions pass and all negative controls fail for the intended reason.
- [ ] Commit the baseline harness and synthetic corpus. Pending capabilities are marked unavailable, not replaced by expected successful text.

### M97.7 — Label retrieval and record opt-in live baselines

**Files:** Create `conformance/retrieval/{queries.json,labels.json}`, `scripts/outcomes/retrieval.ts`,
`scripts/outcomes/live.ts`; extend `scripts/cli-record/` only at the sanitized report boundary.

**Interfaces:** `evaluateRetrieval(queries, labels, productionRetriever) -> RetrievalReport`;
live runner consumes explicit disposable roots/accounts and current CLI identity,
never the user's ordinary vault by default.

- [ ] Add labels for exact/paraphrase/alias/accent/long/imported/mixed/unanswerable queries and known counterevidence. Record label provenance and disputed cases separately.
- [ ] Test cutoff handling, unavailable corpus, missing cost and contradictory relevance labels; run the harness suite before implementing aggregates.
- [ ] Produce offline per-query recall/support/counterevidence/scope/latency results at the production cap. Approve a quality target only after this reviewed baseline.
- [ ] With explicit live-run authorization at execution, run selected scenarios at least three times using the recording skill, scan/sanitize all retained output and report variability/unknown cost. Mark unexecuted tasks skipped.
- [ ] Commit fixtures and sanitized report tooling; retain native/CLI evidence separately from deterministic CI results.

### M97.8 — Run only justified retrieval extensions

**Files:** Depending on selected experiment, modify `src-tauri/src/search.rs`,
`src-tauri/src/vault/corpus.rs`, `src-tauri/src/files/extract/` and matching shared
source-location fixtures; create a dated experiment report under specs.

**Interfaces:** Existing search result and `SourceLocator` contract remain stable;
new source carriers use a new explicit tag/version and are never coerced to body bytes.

- [ ] Select a documented miss class from M97.7: normalization, repeated tokenization, attachment coverage or semantic retrieval. Record hypothesis, allowed resource cost and unchanged correctness gates.
- [ ] Add a regression case that fails on the actual miss while retaining exact-match priority, original position mapping, revocation and deletion assertions.
- [ ] Implement the smallest bounded experiment, including cache invalidation and extraction caps. Embeddings require separate locality/retention/deletion approval; no automatic cloud upload.
- [ ] Replay the entire labeled corpus and relevant scale workload. Accept only measured benefit without scope/precision/navigation regression; otherwise remove the experiment and retain the report.
- [ ] Commit only the accepted change. Global graph, flashcard recall and automatic semantic relations remain deferred with explicit re-entry criteria.

## Self-review and handoff

KNOW-01/02 map to M97.1; KNOW-03 to M97.2; KNOW-04 to M97.3; KNOW-05/06 to
M97.4; KNOW-07 to M97.5; KNOW-08 to M97.6; KNOW-09 to M97.7; KNOW-10 to M97.8;
KNOW-11 is exercised in M97.1/M97.3/M97.4/M97.6. Shared signatures and cap values match
the spec. This plan proposes future work and reports no passing application tests.
