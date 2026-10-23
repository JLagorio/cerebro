# M99 — Rust services and storage

**Milestone:** M99 · **Phases:** M99.1–M99.8 · **Requirements:** CORE-01–CORE-12.

[Master roadmap](2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](../specs/2026-10-23-m93-m99-research/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish Rust-owned service boundaries and compare metadata stores before any selected, recoverable YAML migration.

**Architecture:** Retain React and the current file authority behind adapters. Introduce typed Rust commands and two disposable prototype stores; production cutover is a separately approved gate. M96 owns action execution, M95 conversations, and M93 editor save acknowledgement.

**Tech Stack:** Existing Tauri 2, Rust, rusqlite, React 19 and TypeScript; no new UI framework. DTO generation mechanism is tested before adding a dependency.

**Spec:** [Rust services and workspace authority](../specs/2026-10-23-m99-rust-services-and-storage-design.md).

**Status:** Draft for review, not implementation authorization. Commands and assertions below are future work, not results.

## Global Constraints

- Current authority remains Markdown/YAML plus the guarded knowledge ledger until an explicit cutover.
- First metadata conversion retains governed concept projection YAML/codec and historical attestations; full removal requires a separate versioned ledger design.
- Never place a live WAL database in a cloud-synced vault.
- No second body writer is introduced; editor body saves retain human last-write-wins.
- Policy stays shared data; knowledge verification and historical identities are unchanged.
- Prototype query page size is 100; cursors bind query and snapshot identity.
- No production migration before the owner selects the authority/portability contract.
- Use pinned toolchains, four IPC adapters and existing hook/coverage requirements; never `--no-verify`.

## Review Focus

1. Literal `007`, explicit null, absent keys and large finite decimals survive without coercion — M99.2.
2. Copy/move/duplicate workspace identities never merge unrelated histories — M99.3/M99.6.
3. External edits after dry run invalidate cutover inputs — M99.6.
4. Crash between file rename and metadata commit never exposes mixed authority — M99.7.
5. Rollback after new edits preserves those edits rather than restoring only the old archive — M99.8.

## File map and interfaces

New `src-tauri/src/workspace_service/` owns types, legacy adapter and query facade;
new `workspace_migration/` owns inventory, prototype stores and journaled cutover.
New `shared/workspace/*.json` owns conformance cases, not a second policy engine.
New `src/lib/generated/workspace.ts` is generated wire shape; `src/lib/ipc.ts`
remains the invocation adapter. Existing `vault/`, `runtime/`, `knowledge.rs`,
sheet carriers and editor owners retain authority until their explicit task.

Every task ends with a focused commit after review using the repository's
`type(scope): sentence (M99.<phase>)` convention. The M99.1–M99.8 phase headings below are the canonical execution identifiers.

### M99.1 — Define one typed Rust service boundary

**Files:** Create `src-tauri/src/workspace_service/{mod.rs,types.rs,legacy.rs}`,
`src/lib/generated/workspace.ts`, `scripts/workspace-contract.test.ts`; modify
`src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts` only for the pilot.

**Interfaces:** Consumes existing scoped vault reads. Produces `WorkspaceRef`,
`RecordRef`, `RecordVersion`, `WorkspaceStore::read_record` from the spec, with
`StoreError {code,message,retryable}`. No mutation or storage swap yet.

- [ ] Add a serialized read fixture containing present/absent metadata and an unavailable read. Assert native DTO, generated TS and browser mock agree without converting failure to empty.
- [ ] Run `pnpm test:run scripts/workspace-contract.test.ts` and `cargo test --manifest-path src-tauri/Cargo.toml workspace_service`; record expected failure before implementing the new interface.
- [ ] Implement the legacy read adapter and a deterministic DTO export/check command. Prefer existing build tooling; evaluate a generator dependency only if the pilot requires it. Register literal IPC names/keys through the existing contract mechanism.
- [ ] Run both targeted commands plus `pnpm typecheck` and `pnpm test:run src/lib/ipcContract.test.ts`; require success and deterministic regeneration with no diff.
- [ ] Review the actual consumer and commit the bounded pilot; do not reorganize unrelated crates.

### M99.2 — Pin values and mutation semantics

**Files:** Create `workspace_service/value.rs`, `shared/workspace/values.v1.json`,
`src/engine/workspaceValue.test.ts`; modify `workspace_service/types.rs` and DTO output.

**Interfaces:** Produces `PropertyValue`, `PropertyChange`, `WorkspaceMutation`,
`MutationOutcome`; finite decimal lexemes remain strings inside the decimal tag.
Internal application also consumes the command service's guard-minted receipt or
authorized plan, never a receipt supplied in the client DTO or minted by a store.

- [ ] Add shared cases for `Set(null)`, `Remove`, `"007"`, large decimal, date-looking string, explicit date, unknown map, unresolved relation and nonfinite rejection. Assert no absent/null conflation or JS precision loss.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml workspace_service::value` and `pnpm test:run src/engine/workspaceValue.test.ts`; first require the new assertions to fail for the missing contract.
- [ ] Implement tagged decoding and a legacy patch adapter that keeps existing null-means-remove semantics. Define schema-driven date conversion and finite decimal grammar in the shared artifact; register the semantic twin if both languages enforce it.
- [ ] Replay the cases in both suites and run IPC/type checks. Verify permission and knowledge checks remain before store mutation, with existing guard-minted receipts.
- [ ] Commit values and compatibility behavior as one reviewed unit.

### M99.3 — Inventory original bytes and stable identity

**Files:** Create `src-tauri/src/workspace_migration/{mod.rs,inventory.rs,identity.rs}`,
`shared/workspace/migration-cases.v1.json`; modify module registration only.

**Interfaces:** `inventory_workspace(root, scope) -> Result<MigrationInventory, MigrationError>`;
inventory rows contain old path/hash, original bytes reference, proposed ID, status
and issues. `plan_identities(inventory, existing_manifest) -> IdentityPlan` is
deterministic for the same committed manifest; new IDs are minted only once.

- [ ] Add cases for CRLF/BOM, tags, duplicate keys, anchors, non-string keys, missing relation, moved Agent, import stamps and duplicate workspace manifest. Assert explicit blocked/ambiguous outcomes and unchanged original hashes.
- [ ] Classify governed concept projections and CLI-owned definition frontmatter separately from ordinary page metadata. Pin the current concept YAML projection codec and complete bytes; attestations hash that codec (`ledger/project.rs`, `ledger/reduce.rs`). First conversion retains it, records remaining YAML and never re-verifies. Any full-removal proposal stops at a separate versioned ledger/projection design.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml workspace_migration::inventory`; prove failures before adding the bounded syntax inventory.
- [ ] Implement read-only inventory using a codec capable of identifying unsupported syntax. Do not reuse a lossy parsed map as evidence that no duplicate keys existed. Preserve body title and ledger identities.
- [ ] Run inventory/identity cases; compare all input file hashes. Any changed source file or silently discarded value fails.
- [ ] Commit the report-producing inventory, with no production conversion path.

### M99.4 — Compare two stores on a disposable corpus

**Files:** Create `workspace_migration/{sidecar.rs,sqlite.rs,comparison.rs}`,
`workspace_service/query.rs`, `scripts/workspace-store-report.ts`.

**Interfaces:** Both stores implement `WorkspaceStore` on a temporary root;
`compare_stores(inventory, workloads) -> ComparisonReport` retains raw timings,
semantic diffs, recovery outcomes and unsupported counts. Query cursor binds
scope, query and snapshot; page size 100.

- [ ] Add identical CRUD/query cases for both stores, including two equal sort values, changed schema, stale revision, scope leakage, missing sidecar and copied Markdown body without metadata.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml workspace_migration`; verify expected failures for unimplemented stores.
- [ ] Implement temporary sidecar and SQLite adapters and deterministic query paging. Use existing shared filter/schema semantics; no production registration or watchers.
- [ ] Run equivalence cases and `pnpm exec tsx scripts/workspace-store-report.ts --fixture <disposable-corpus> --out <report-path>`. Require zero unexplained semantic differences; report timeouts/unavailable measurements rather than zero.
- [ ] Produce 1k/5k and adversarial reports with backup/external-edit exercises. Commit prototype/report tooling; retain reports outside golden demo data.

### M99.5 — Record the authority decision and bounded optional experiments

**Files:** Create `docs/superpowers/specs/<execution-date>-workspace-authority-decision.md`;
optional create `src-tauri/crates/workspace-pure/` only after the experiment is selected.

**Interfaces:** Decision record selects `legacy | json_sidecar | sqlite_metadata`,
supported external-edit behavior, portability promise and migration eligibility.
It also records retained governed YAML, the selected-authority consumer cutover
matrix from CORE's spec and the backup categories/operational-history disposition.

- [ ] Present prototype evidence and explain complete-workspace export versus copying Markdown. Obtain the owner's selected authority before M99.6–M99.8 production work.
- [ ] Inventory actual canonical metadata readers/writers: scan/schema/views/query/search; human fields/title/body/batch/rename/delete/undo; agent grants/admission/dispatch/MCP; knowledge guard/materialization/Verify; imports/provenance; mock/export/external-edit paths. Assign each selected-authority adapter or typed unsupported-format refusal. Include direct `vault/write.rs::frontmatter_json` and `knowledge.rs` reads; changing the scan or adding a format marker alone cannot complete this integration.
- [ ] If a WASM pilot is selected, extract only value/query conformance into a pure library with injected inputs; replay exactly the same shared cases in native and browser builds and record bundle/build cost.
- [ ] If a native Rust UI experiment is selected later, write a separate bounded prototype plan covering editor/IME/VoiceOver, large table, panes and chat. No framework or product rewrite is implied here.
- [ ] Record accepted/rejected/deferred alternatives and their evidence. No unmeasured performance claim or new dependency is accepted merely to increase Rust source percentage.
- [ ] Commit the decision record separately. A rejected migration leaves the useful service pilot in place.

### M99.6 — Stage the selected conversion and reject stale cutover

**Files:** Create `workspace_migration/{stage.rs,format_gate.rs}`; modify
`src-tauri/src/vault/scan.rs`, `src-tauri/src/lib.rs`, and agent launch in
`src-tauri/src/agent/mod.rs`. The format guard runs before supported-client
scan/write/dispatch; recheck registration call sites at execution.
Modify the selected-authority adapters identified by M99.5 in `vault/`,
`knowledge.rs`, agent/MCP/import consumers and browser mocks; this is explicit
integration work, not an assumed consequence of the M99.1 read pilot.

**Interfaces:** `stage_conversion(inventory, selected_store) -> StagedConversion`;
`validate_cutover(stage, current_sources) -> Ready | Blocked {issues}`. Refuse
unsupported format before old consumers can treat missing YAML as untyped content.

- [ ] Add tests that modify one source after inventory, duplicate an ID, omit an attachment and launch a supported format-aware client on a newer format. Assert no cutover, no dispatch and original bytes intact. Test a legacy frontmatter edit in a converted body produces a format conflict without changing grants.
- [ ] Implement and check every cutover-matrix row before activation. Test conflicting legacy frontmatter cannot override canonical metadata/grants, and ordinary field/body/import/query operations retain the selected metadata after reopen. Test an armed-ledger verified concept through staging, cutover, reopen, guarded write/Verify and export, with its original projection codec/attestations preserved; conversion itself records no verification.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml workspace_migration::stage` and format-gate tests to observe the required failures.
- [ ] Stage the selected representation and checksum manifest into a new workspace root; compare every source again immediately before cutover. Ship the format-aware compatibility release and record its tested minimum version before enabling migration. Require successful backup/restore rehearsal from M99.8 before exposing the production command.
- [ ] Verify clean conversion and each rejection on disposable copies. Copy-only imports must not reconstruct privileged metadata by inference. Record legacy binaries without the format guard as unsupported; do not claim a new marker prevents their same-user file access. Retain the original vault as an archive and require deliberate new registration.
- [ ] Commit the gated command. Keep user-facing migration disabled until M99.7/M99.8 acceptance completes.

### M99.7 — Coordinate files and metadata through crash recovery

**Files:** Create `workspace_migration/{journal.rs,cutover.rs,recovery.rs}`;
modify selected store command service and startup recovery registration.

**Interfaces:** `commit_workspace_change(scope, planned_change) -> MutationOutcome`;
`recover_workspace(journal) -> RecoveryReport`. Journal includes preimages,
staged body hashes, intended metadata revision and original receipt identity.

- [ ] Inject termination after journal durability, each file rename, metadata commit and publish. Assert reopened readers see only fully recovered acknowledged revisions, or explicit recovery-required state.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml workspace_migration::recovery` before implementation; require missing-boundary failures.
- [ ] Implement the selected backend's commit protocol. Hold path locks, revalidate bytes, publish only an agreed revision and retain evidence on conflict; never use SQLite commit alone as file atomicity proof.
- [ ] Replay each crash point plus changed external bytes during recovery. Require no new verification/grants and no cross-vault mutation.
- [ ] Commit journal and recovery together; document durability/platform assumptions for native verification.

### M99.8 — Complete backup, rollback and remaining YAML carriers

**Files:** Create `workspace_migration/{backup.rs,restore.rs,rollback.rs}`,
`shared/workspace/export.v1.json`; modify selected-store Settings UI through current
IPC adapter. Sheet codec changes, if selected, modify `src-tauri/src/sheet/fence.rs`
and its TS twin with shared carrier fixtures in a separate phase.

**Interfaces:** `backup_workspace(scope, destination) -> BackupReport`;
`restore_workspace(archive, new_root) -> RestoreReport`;
`export_legacy(scope) -> LegacyExportReport {converted,blocked,losses}`.
The export manifest classifies required/optional/excluded selected metadata,
schema/identity, bodies, attachments, comments, complete canonical ledger
store/segments and compatibility state. Caches may be explicitly disposable.
Choose separately scoped operational-history export/restore or honest omission;
do not copy app-global runtime.db as if it belonged to one workspace.

- [ ] Test missing backup body, bad hash, interrupted restore, post-cutover metadata/body edits, unknown values and unavailable secrets. Assert restore never activates incomplete data and rollback retains subsequent edits or blocks explicitly.
- [ ] Add armed verified-concept restore and missing/corrupt ledger-chain/projection, missing attachment/comment and unavailable/omitted runtime-history cases. Assert no re-verification, cross-vault history merge, historical ID rewrite or automatic schedule/approval/effect resumption. Verify original attestations, exact body/metadata and required sidecars after restore.
- [ ] Test traversal/absolute paths, unsafe symlinks, duplicate or colliding names and oversized/over-expanded archives. Bound entry count/per-entry/total materialized bytes before extraction; restored parts remain contained in the inactive new root until all validate.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml workspace_migration` and new UI tests; establish failures for each unimplemented outcome.
- [ ] Implement consistent snapshot/export, restore-to-new-directory and legacy export. Keep the active workspace until restored/exported copies validate. Exclude secrets; require account rebind.
- [ ] Publish the manifest's completeness and operational-history limitations in backup UI/help. Validate the canonical ledger as well as metadata/body hashes; neither Git nor copying Markdown backs up the ignored `.cerebro/ledger` or external runtime facts. Restored managed actions require deliberate rebinding.
- [ ] Inventory remaining YAML carriers. If literal removal is selected, add a versioned sheet-header codec with old-reader import support and no formula/reference loss; replay existing sheet fixtures in Rust and TS.
- [ ] Run focused checks and the repository's full gate on pinned tools before enabling migration. Execute packaged backup/cutover/reopen/rollback journeys and record accepted/failed/unverified outcomes.
- [ ] Commit the accepted release slice and its recovery instructions. Archive deletion remains explicit; multi-device live database sync remains outside scope.

## Self-review and handoff

CORE-01–03 map to M99.1; CORE-04 to M99.2; CORE-05/07 to M99.3;
CORE-06 to M99.4; CORE-12 to M99.5; CORE-08 to M99.6–M99.7; CORE-09–11 to M99.8.
M99.6 prepares cutover; M99.8's backup rehearsal is an enablement gate, not a dependency
cycle requiring production migration to test backup. All future interfaces above
are proposals; execution begins with current-source reconciliation and owner
review. None of these commands was run as part of this documentation task.
