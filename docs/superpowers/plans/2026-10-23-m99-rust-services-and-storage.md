# M99 — Rust services and storage

**Milestone:** M99 · **Phases:** M99.1–M99.8 · **Requirements:** CORE-01–CORE-12.

[Master roadmap](2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](../specs/2026-10-23-m93-m99-research/README.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish Rust-owned service boundaries and compare metadata stores before any selected, recoverable YAML migration.

**Architecture:** Retain React and the current file authority behind adapters. Introduce typed Rust commands and two disposable prototype stores; production cutover is a separately approved gate. M96 owns action execution, M95 conversations, and M93 editor save acknowledgement.

**Tech Stack:** Existing Tauri 2, Rust, rusqlite, React 19 and TypeScript; no new UI framework. DTO generation mechanism is tested before adding a dependency.

**Spec:** [Rust services and workspace authority](../specs/2026-10-23-m99-rust-services-and-storage-design.md).

**Status:** Implementation authorized by the owner on 2026-10-23, on the existing branch alongside Claude's M92 work. The [implementation record](2026-10-23-m93-m99-implementation-record.md) distinguishes verified service/comparison slices from open work. The owner selected SQLite metadata plus visible Markdown bodies on2026-10-23; M99.6–M99.8 implementation can proceed. Production migration remains acceptance-gated and requires deliberate conversion. Commands below are requirements, not results; M99 is not complete.

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
`src/lib/generated/workspace.ts`, `scripts/workspace-contract.test.ts`,
`scripts/contracts/{schemaToTypescript.ts,generate.ts}` and
`shared/workspace/{contracts.v1.json,legacy-source-cases.v1.json}`; modify
`src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `src/lib/mockIpc.ts` only for the pilot.

**Interfaces (execution amendment, 2026-10-23):** The current reader has no
stable-record-ID or metadata-revision producer. This phase therefore produces
explicit `LegacyRecordLocator {path}`, `LegacyRecordSnapshot {content,hash}` and
an internal `StoreError {code,message,retryable}` through a Rust legacy service.
The existing human `read_note_source(vault,path)` command delegates to it and
retains its public success/error shape. `hash` is the complete source hash, never
a renamed body hash. Portable `WorkspaceRef`, `RecordRef`, `RecordVersion` and
the full `WorkspaceStore` API remain proposed until M99.3 supplies the committed
identity manifest and the selected/prototype store supplies real revisions.
No identity is minted by reading; no mutation, authorization or storage swap.

**Contract mechanism:** Schemars 0.8.22, already locked through Tauri, becomes a
dev dependency. Rust declarations derive their schema in tests only. A shared,
strict schema-to-TypeScript exporter rejects unsupported shapes rather than
emitting `any` or coercing 64-bit numbers. Cargo checks declaration/schema drift;
Vitest checks schema/TS drift and browser behavior. M96 reuses this mechanism.

- [ ] Add a serialized read fixture containing present/absent metadata and an unavailable read. Assert native DTO, generated TS and browser mock agree without converting failure to empty.
- [ ] Run `pnpm exec vitest run scripts/workspace-contract.test.ts scripts/contracts --maxWorkers=2` and `cargo test --manifest-path src-tauri/Cargo.toml --lib workspace_service`; record expected failure before implementing the new interface.
- [ ] Implement the legacy read adapter and a deterministic DTO export/check command. Prefer existing build tooling; evaluate a generator dependency only if the pilot requires it. Register literal IPC names/keys through the existing contract mechanism.
- [ ] Run both targeted commands plus `pnpm typecheck`, `pnpm exec vitest run src/lib/ipcContract.test.ts --maxWorkers=2` and `pnpm exec node --import tsx scripts/contracts/generate.ts --check`; require success and deterministic regeneration with no diff.
- [ ] Review the actual consumer and commit the bounded pilot; do not reorganize unrelated crates.

### M99.2 — Pin values and mutation semantics

**Files:** Create `workspace_service/value.rs`, `shared/workspace/values.v1.json`,
`src/engine/workspaceValue.test.ts`; modify `workspace_service/types.rs` and DTO output.

**Execution amendment (2026-10-23):** M99.1 confirmed that stable record IDs and
metadata revision producers do not yet exist. This phase therefore produces
`PropertyValue`, `PropertyChange`, `ValueSchema` and `ValueError`, with bounded
raw-JSON/tagged decoding and a pure `prepare_legacy_patch` compatibility check.
These are `cfg(test)` Rust prototype contracts for M99.3/M99.4, plus generated
schema/TypeScript transport. They are not an active production mutation API or a
completed store application. Promote the module only with its first explicit
prototype/guarded consumer. `WorkspaceMutation` and `MutationOutcome` remain
proposed until actual identity, revision and guard-receipt producers can supply
their fields; never fabricate them from a path, zero or a client assertion.

Raw numbers enter as `serde_json::RawValue` before any numeric conversion. The
shared decimal grammar retains finite JSON-number lexemes as strings (including
`1e400`, which is finite in decimal arithmetic but not representable as JS f64),
with a 256-byte lexical bound. Reject nonfinite tokens and duplicate decoded map
keys. Reuse `shared/calendar/dates.v1.json` for explicitly declared calendar-day
or zoned-instant schemas; plain date-looking strings never convert implicitly.

The pure legacy adapter preserves the current writer's null-means-remove
contract: only `Remove` becomes a top-level JSON null; `Set(null)` refuses. It
accepts canonical safe integers and refuses decimal spelling/precision loss,
typed relations, and duplicate change keys. Nested null values are supported.
This checks proposed values only, not the fidelity of a rewrite of existing YAML;
M99.3 must inventory original bytes and unsupported syntax first. No writer,
receipt minting, identity resolution, authority activation or migration is added.
Relation resolution metadata is carried, never inferred or used as permission.

- [ ] Add shared cases for `Set(null)`, `Remove`, `"007"`, exact large/exponent decimals, date-looking strings, explicit dates/instants, unknown maps, unresolved relations and nonfinite rejection. Assert unchanged input on refusal.
- [ ] Run `cargo test --offline --manifest-path src-tauri/Cargo.toml --lib workspace_service::value -- --test-threads=2` and `pnpm exec vitest run src/engine/workspaceValue.test.ts --maxWorkers=2`; record missing-contract failures before implementation.
- [ ] Implement bounded raw/tagged decoding and the pure legacy converter. Keep production null-means-remove behavior unchanged, and keep the value prototype under `cfg(test)` until its first consumer.
- [ ] Replay actual semantic cases in Rust and compile shared valid/invalid transport cases against generated TypeScript. TS does not enforce these semantic rules, so it does not add an independent semantic twin. Register one under CV-04 only if a later browser consumer implements the same rules.
- [ ] Regenerate/check Rust schema and TypeScript, run focused IPC/type checks, and confirm no production writer or guard/receipt path changed. Freeze for independent review; commit only through the parent's integration sequence.

### M99.3 — Inventory original bytes and stable identity

**Files:** Create `src-tauri/src/workspace_migration/{mod.rs,inventory.rs,identity.rs,syntax.rs}`,
`shared/workspace/migration-cases.v1.json`; modify module registration only.

**Execution amendment (2026-10-23):** This is a `cfg(test)` read-only/tool
prototype. `inventory_workspace(root, InventoryScope { paths })` inventories only
an explicit bounded list of relative source paths. Its coverage records that
list and `whole_vault: false`; it does not discover a full vault or certify a
migration-ready snapshot. Rows retain complete original bytes/hash, carrier,
syntax evidence, issues and an absent proposed ID until identity planning.
Unreadable/out-of-scope/symlinked inputs never become empty successful records.

`syntax.rs` uses the already-locked MIT `unsafe-libyaml = 0.2.11` as a direct dev
dependency: the existing Serde loader discards anchor syntax. The small event
wrapper owns parser/event cleanup, bounds source/events/depth/decoded scalar bytes,
retains decoded duplicate keys and lexical values, and refuses explicit
tags/anchors/aliases and dialect/tag directives rather than resolving them. Event offsets never reconstruct
source bytes. Existing legacy parsing may be used only after syntax inspection
for existing link-resolution behavior, not as proof of value fidelity.

`plan_identities(inventory, existing, explicit_moves, known_bindings)` is a pure
draft. An existing manifest requires a separate trusted workspace/root binding;
a manifest claim alone is not authority. Missing/out-of-scope prior targets,
duplicate IDs/paths and a workspace ID bound to another root block the proposal.
Moves require explicit old/new path, committed record ID and expected source hash;
equal content, names, titles or paths never derive identity. Consuming
`IdentityPlan::into_proposed_manifest(mint_uuid)` allocates new UUIDs once into an
**in-memory proposed manifest**. It publishes nothing and makes no durability
claim. M99.4 must atomically publish a disposable manifest before claiming replay
stability across restart. Existing manifest replay does not call the mint seam.
No metadata revision, guard receipt or historical runtime/ledger ID is invented.

- [ ] Add cases for CRLF/BOM, tags, duplicate keys, anchors, non-string keys, missing relation, moved Agent, import stamps and duplicate workspace manifest. Assert explicit blocked/ambiguous outcomes and unchanged original hashes.
- [ ] Classify governed concept projections and CLI-owned definition frontmatter separately from ordinary page metadata. Pin the current concept YAML projection codec and complete bytes; attestations hash that codec (`ledger/project.rs`, `ledger/reduce.rs`). First conversion retains it, records remaining YAML and never re-verifies. Any full-removal proposal stops at a separate versioned ledger/projection design.
- [ ] Run `cargo test --manifest-path src-tauri/Cargo.toml workspace_migration::inventory`; prove failures before adding the bounded syntax inventory.
- [ ] Implement read-only inventory using a codec capable of identifying unsupported syntax. Do not reuse a lossy parsed map as evidence that no duplicate keys existed. Preserve body title and ledger identities.
- [ ] Run inventory/identity cases; compare all input file hashes. Any changed source file or silently discarded value fails.
- [ ] Commit the report-producing inventory, with no production conversion path.

### M99.4 — Compare two stores on a disposable corpus

**Files:** Create `workspace_migration/{sidecar.rs,sqlite.rs,comparison.rs}`,
`workspace_service/query.rs`, `scripts/workspace-store-report.ts`.

**Interfaces:** Both stores implement `WorkspaceStore` on a temporary root. The
explicit `comparison::tests::write_report` harness consumes the original-byte
inventory and runs one shared workload against both adapters, emitting raw
timings, semantic differences, recovery outcomes and source dispositions. It is
an invoked test tool, not a production comparison service. Query cursors bind
scope, query and snapshot; page size 100.

**Execution amendment (2026-10-23):** The adapters and their shared
`types::prototype` contract remain `cfg(test)` tools, not the proposed production
mutation API. A non-deserializable `PrototypeScope` comes from an explicitly
created disposable owner and exercises read/write/create scope. `PrototypeOutcome`
carries actual persisted metadata/body/schema versions and no receipt ID. No
prototype scope claims to implement production agent/human admission. The same
trait exercises create/read/tagged-property patch/delete/query against both
stores; the existing value decoder, field-kind validation and query evaluator
remain the semantic sources. Unsupported exact-value projections refuse instead
of rounding or silently omitting a requested predicate.

Visible Markdown paths remain authoritative body locations. Sidecar JSON may
use immutable metadata generations with one atomic manifest; SQLite metadata
lives in a separate disposable directory. A bounded durable operation journal
holds old/new affected metadata and visible-body pre/post images. An OS file
lock serializes prototype readers, writes and recovery. Commit publishes matching
visible bytes before atomically changing metadata; clearing the journal is last.
Recovery tests the boundaries after intent, visible installation and metadata
commit, validates both metadata and bytes, then restores old or completes new.
Third-party bytes refuse recovery; external edits are never silently adopted.
These are tested temporary-filesystem guarantees, not production recovery claims.

The initial UUID manifest is atomically published and replayed after reopen;
existing IDs never remint. Copying a body without metadata creates no record or
grants. A scoped metadata/schema/identity/body backup is validated and restored
into another temporary root. This prototype backup does not claim complete
canonical-ledger, attachment, comment or operational-history coverage.

The Node report entry point invokes the actual Rust comparison harness. It
records component timings, failure/unsupported counts and toolchain/load context
for 1k, 5k and adversarial corpora. Current concurrent machine load makes timing
samples non-decision-grade; no winner or production authority is selected.

- [x] Add identical CRUD/query cases for both stores, including two equal sort values, changed schema, stale revision, scope leakage, missing sidecar and copied Markdown body without metadata.
- [x] Run the coordinated native `workspace_migration` filter; verify expected failures for unimplemented stores.
- [x] Implement temporary sidecar and SQLite adapters and deterministic query paging. Use existing shared filter/schema semantics; no production registration or watchers.
- [x] Run equivalence cases and `node --import tsx scripts/workspace-store-report.ts --fixture <disposable-corpus> --out <report-path> --native-binary <built-test-executable>`. Require zero unexplained semantic differences; report timeouts/unavailable measurements rather than zero.
- [x] Produce 1k/5k and adversarial reports with backup/external-edit exercises. Retain prototype/report tooling and raw reports outside golden demo data; the shared-branch owner retains commit responsibility.

Execution evidence and exact measurement limits live in
[M99.4 store comparison](2026-10-23-m99-store-comparison/README.md). The 1k sample
is retained with its historical source digests; final source hardening and the
corrected adversarial fixture are identified separately. Final native verification,
including the malformed-column boundary, passed; the corrected adversarial report
also passed with both unresolved sources retained explicitly. The fresh 5k run
completed with 5,000 converted records, unchanged originals and zero semantic
differences; both stores passed the named backup/external-edit/recovery exercises.
Shared strict all-targets Clippy and independent implementation/checker review
passed. Raw timing samples remain contended, so no performance winner follows.
The retained final report's byte identity and exact source digests were checked
after copying it into the tracked evidence directory.
The current shared-branch execution does not create commits; integration remains
with the coordinating agent.

### M99.5 — Record the authority decision and bounded optional experiments

**Files:** [Concrete authority decision packet](../specs/2026-10-23-m99-workspace-authority-decision.md);
optional create `src-tauri/crates/workspace-pure/` only after the experiment is selected.

**Interfaces:** Decision record selects `legacy | json_sidecar | sqlite_metadata`,
supported external-edit behavior, portability promise and migration eligibility.
It also records retained governed YAML, the selected-authority consumer cutover
matrix from CORE's spec and the backup categories/operational-history disposition.

- [x] Present prototype evidence and explain complete-workspace export versus copying Markdown. Owner selected SQLite metadata + Markdown bodies on2026-10-23 in the concrete decision packet; remaining migration implementation is authorized, current-vault conversion is not.
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

**First execution slice (2026-10-23):** The owner selected SQLite metadata with
visible Markdown bodies. Implement a compiled native staging library, with no
IPC command, active registration or current-vault conversion. `prepare_stage`
captures a bounded full-root file inventory and consumes explicit Rust record
proposals using the existing tagged-value decoder. Every discovered file needs
a converted, verbatim-retained or named excluded disposition. Private exclusions
are recorded without reading/copying their contents; unknown hidden content is
preserved or refused, never silently excluded. Required attachments and retained
ledger/Trash/reconciliation bytes must be accounted for. Full-root path additions,
deletions and moves, not only old file hashes, are rechecked before publication.

`stage_conversion` creates new inactive body and separate SQLite destinations,
preserves exact originals, and publishes a checked manifest only after the
database and every required part validate. An incomplete-format marker precedes
body writes; the completed-stage marker still means inactive. `validate_cutover`
checks staging facts and reports remaining activation blockers rather than
inventing permission to register. The format gate refuses unknown/newer formats,
incomplete stages and legacy access to selected metadata; conflicting body YAML
never changes canonical metadata or grants. These library entry points precede
the actual consumer integrations in the matrix. Production semantic conversion,
the complete consumer matrix, journal/recovery, backup rehearsal and tested
minimum-client release remain activation gates. This slice is not full M99.6.

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

**Current native product design (2026-10-24):** The [backup coordinator specification](../specs/2026-10-24-m99-native-backup-coordinator-design.md) and [causal acceptance matrix](../specs/2026-10-24-m99-native-backup-race-acceptance.md) resolve native choices, save ownership, output/opening races and late outcomes. The inactive-copy ancestor boundary has 28 reproduced failures and ten passing controls; its repair must precede product exposure. These are implementation requirements, not completed UI or migration acceptance.

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
