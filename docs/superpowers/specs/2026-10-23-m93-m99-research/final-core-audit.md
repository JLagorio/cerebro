# Final source-backed audit: M93 and M99

Date: 2026-10-23. Reviewed current working-tree bytes, not merely HEAD 23479518c2827d361c9c970abfac8245f9d84600. Read-only review; no application, reference-repository, index or branch edits; no suites, native app, migration, provider or live CLI execution. This report is not execution evidence. Scope: M93/M99 paired plans/specs and matching program/master boundaries; scoped actual files in Macro, Tolaria, AppFlowy and Cerebro.

## Findings

Post-audit authoring disposition: parent authorized corrections to the four paired
M93/M99 documents only. All findings I1–I4 and clarifications M1–M2 below are now
addressed in those documents; the finding line references describe the reviewed
pre-correction text. No requirement/phase was renumbered. M93 now names all save
participants, prepare-without-unmount adapters and measured native cancellation
headroom, preserving the hung-webview forced-exit limit. M99 now explicitly
retains the first migration's concept projection YAML/codec, requires the full
consumer cutover matrix and guard receipt handoff, and names backup completeness,
operational-history disposition and contained bounded restore tests. Master,
decisions and other plans remain parent-owned.

Verification after authoring: targeted Prettier with --ignore-path /dev/null
checks all four docs (the repository's default .prettierignore excludes docs)
and passes; scoped git diff --check passes. No application suites or native/live
checks were run, because only documentation changed.

### Critical

None established by this source/document review. The Important findings below are production-design/acceptance gaps behind existing migration gates, not assertions that a current production migration has damaged data.

### Important I1 — The promised pre-unmount save barrier omits existing save participants from its concrete inventory

Document: docs/superpowers/plans/2026-10-23-m93-reliable-workspace.md:71 (inventory), :75–78 (leave regressions/preparation), paired spec docs/superpowers/specs/2026-10-23-m93-reliable-workspace-design.md:62–64.
Actual source:

- src/mermaid/useDiagramFile.ts:98–123 privately serializes saves and catches a failure; :230–238 only flushes a pending debounce on unmount. It does not registerFlush/registerHold/holdEditor.
- src/mermaid/CodeOverlay.tsx:87–119 flushes its buffered source through a layout unmount cleanup, including Auto-Update off. Its own comment documents why cleanup ordering previously lost bytes.
- src/whiteboard/useCanvasFile.ts:94–133 has its own serial save/failure lifecycle, :256–275 registers flush/hold then unregisters and finishes cleanup.
- src/sheet/pendingSheets.ts:1–13 has local sheet draft settlement; focused property fields commit on blur (src/app/quit.ts:116–120).

Failure: implementing DocumentOwner for NoteBodyEditor and visiting only matches of flushOpenPages|heldOpenPages|holdEditor leaves standalone diagram drafts invisible before shell unmount; their failed cleanup cannot retain the view/draft as REL-03 promises. Buffered CodeOverlay edits can also be absent from an earlier document flush. Canvas and field writes need a compatible outcome, not accidental success from a void callback.

Correction: inventory registerFlush/registerHold, saveNote/saveCanvasFile, draft-settlement and cleanup-only writers as well as existing call sites. Name diagram/CodeOverlay, canvas, sheets and blur fields as participants/adapters or explicitly narrow the promise and gate remaining cases. Expose prepare-without-unmount for local buffers. Add pending diagram debounce + buffered overlay + failed diagram-before-quit, held/failed canvas, sheet draft and focused field tests, asserting exact retained latest payload and no dependent leave. Preserve native deadline and override limits.

Classification: plan coverage defect. Existing source proves the omitted seam; a fresh native data-loss reproduction has not been run.

### Important I2 — Governed concept YAML requires a separate projection-codec disposition

Document: docs/superpowers/specs/2026-10-23-m99-rust-services-and-storage-design.md:145–152; plan docs/superpowers/plans/2026-10-23-m99-rust-services-and-storage.md:79–93, :125–155, :171.
Actual source:

- src-tauri/src/ledger/project.rs:1–12 explicitly states attested_content_hash pins the byte-stable projected revision; :21–31 renders canonical YAML frontmatter.
- src-tauri/src/ledger/reduce.rs:4255–4276 recomputes project(revision.content,revision.fields) and refuses an attestation whose hash differs.
- src-tauri/src/ledger/shadow.rs:83–89 activates verification/recovery and makes knowledge writers unavailable on refusal.
- src-tauri/src/knowledge.rs:220–237 also directly reads concept YAML title/about.

Failure: a metadata conversion that removes concept YAML while merely preserving ledger IDs/history either makes the on-disk projection disagree with the guarded record or has the next canonical materialization put YAML back. Changing project() globally also changes historical attestation validation. Keeping the title guarded is necessary but does not settle the whole projection format.

Correction: inventory governed concept projections as their own carrier. The minimum viable migration retains their complete current YAML codec/bytes and reports that YAML remains. If their conversion is chosen, block it on an independently accepted, versioned projection/ledger migration preserving old codec replay and historical attestations; conversion never implies re-verification. Add armed-ledger verified-concept stage/cutover/reopen/read/write/verify/export tests. Inventory CLI-owned definition YAML separately when describing a literal “no YAML” claim.

Classification: design omission, not missing execution evidence.

### Important I3 — A format marker and prototype facade do not migrate all metadata consumers

Document: docs/superpowers/plans/2026-10-23-m99-rust-services-and-storage.md:37–44, :49–63, :125–140; spec :104–109, :159–175.
Actual source:

- src-tauri/src/vault/scan.rs:182–185 builds entry metadata directly from file bytes.
- src-tauri/src/vault/write.rs:1307–1323 reads metadata from current frontmatter under the write lock; patch_in at :1282–1304 writes it back through the existing receipt.
- src-tauri/src/knowledge.rs:220–237 reads YAML without the proposed facade.
- src-tauri/src/vault/parse.rs:80–93 implements declared_type from YAML.
- src-tauri/src/mcp.rs has multiple scan_vault consumers (e.g. :3181, :4341, :5512) and a YAML recent-field rewriting path (:3299–3311).

Failure: converting bodies to sidecar/SQLite metadata and enabling a format guard alone leaves existing metadata reads empty/untyped or writes reconstructing frontmatter. Updating scan_vault alone does not fix guards reading bytes under lock. The new store contract must not create parallel metadata authorities.

Correction: before M99.6 can activate anything, produce an exhaustive selected-authority reader/writer matrix (human fields and body/title commands; schema/views/query/search; agent grants/dispatch; knowledge guards; imports/provenance; MCP; mock/browser). Every consumer must be adapted through canonical metadata under the same guard/transaction or explicitly return a typed unsupported-format outcome. Treat this as a real integration task following the authority choice; it cannot be assumed to be completed by the read pilot. Add tests proving conflicting legacy YAML cannot override selected canonical metadata or grants, and ordinary field/body/import operations round-trip after reopen.

Classification: implementation-sequencing/design coverage defect. The prototype remains useful without this production cutover work.

### Important I4 — Backup completeness needs a named manifest and guarded-history restore acceptance

Document: docs/superpowers/specs/2026-10-23-m99-rust-services-and-storage-design.md:76–78, :193–197; plan docs/superpowers/plans/2026-10-23-m99-rust-services-and-storage.md:157–173.
Actual source:

- src-tauri/src/ledger/mod.rs:1–19 and :44–55 places canonical guarded history under .cerebro/ledger, ignored by Git and scanner; a present-but-unreadable ledger is not “absent.”
- src-tauri/src/runtime/mod.rs:15–27 says runtime.db is app-global, outside the vault and NOT reconstructible.
- src-tauri/src/runtime/scope.rs:9–31 separates portable store identity and local path-derived runtime identity.
- src-tauri/src/ledger/shadow.rs:125–155 checks remembered heads and reminted stores rather than silently trusting a copied folder.

Failure: a backup with workspace metadata, Markdown bodies and valid body hashes can still omit ledger anchors/segments, attachments or comment sidecars; it is not a complete recoverable workspace. A vague “operational history backed up separately” promise can also mislead users into expecting prior Runs/approvals to reappear or safely resume from a workspace-only restore.

Correction: define backup-manifest categories and required/optional/excluded parts, including complete canonical ledger store/segments and compatibility data, attachments, comments, selected workspace metadata and body hashes. Explicitly choose runtime-history backup/export/omission and destination identity semantics without replaying scheduling/approvals. Rebind restored credentials/actions; do not awaken archived work automatically. Test armed verified knowledge restore and a missing/corrupt ledger part as well as missing bodies; report any omitted operational history honestly. Restore remains new-root/inactive until all required parts validate. For archive imports also pin path containment, symlink/duplicate-name handling and total/entry-size limits, consistent with vault/write.rs:262–268.

Classification: missing concrete acceptance/format detail; CORE-11's high-level separation is correct.

### Minor M1 — “Roots” needs to mean actor-matching listing rows, not only parentless runs

Document: M93 plan :81–89 and paired spec :68–70 describe paginating “roots.”
Source: src/status/AgentRunHistory.tsx:78–80 lists every actor-matching run, and :99–116 deliberately shows a matching child with a parent label; src-tauri/src/runtime/fleet.rs:85–88 says parent_run_id None is a true root.

Correction: define roots as listing anchors selected by actor/vault scope, including a matching run with parent_run_id != null; lineage expansion is separate. Add “Agent only ever ran as another actor's hop” to pagination cases. Otherwise an implementer may add parent_run_id IS NULL and make that agent's recorded work disappear.

### Minor M2 — Wire guard receipts explicitly through the new mutation boundary

Document: M99 spec :97–105 returns Applied{receiptId} but WorkspaceStore::apply accepts only scope + mutation, while saying the store cannot mint a receipt.
Source: src-tauri/src/vault/write.rs:1256–1304 requires &WriteReceipt<Agent>/&WriteReceipt<D> through the locked writer.

Correction: show an internal authorized plan/guard-minted receipt parameter or command-service wrapper that supplies it to the selected writer. Keep receipt construction outside the store and outside deserializable client DTOs. This closes an API ambiguity; it is not proof an implementer would bypass guards.

## Reference lessons checked against actual source

1. ADOPT Macro snapshot capture before queueing and generation-sensitive acknowledgement. docs/examples/macro-main/apps/web/src/features/email-compose/primitives/draft-autosave.ts:31–52 skips queued older snapshots, serializes through failure and marks saved only for the newest revision. Its test at draft-autosave.test.ts:152–180 asserts writes are first/latest. M93.1 already chooses this principle; retain it.
2. ADOPT Macro explicit retry after local failure. draft-autosave.test.ts:183–203 prevents downstream persistence after disk failure and verifies the next save succeeds. M93 needs the analogous retry-without-edit assertion.
3. DECLINE copying Macro's durable local snapshots into REL by default. draft-autosave.ts:8–9, :101–104 persists on edits. Cerebro explicitly chose in-memory draft retention and separately gated displaced-byte recovery; the example is not authorization for private crash-draft storage.
4. ADOPT Tolaria flush before metadata mutation and recheck identity after await. docs/examples/tolaria-main/src/hooks/useNoteActions.ts:294–301 and :604–610 show both checks. The persistence test :72–83 only asserts flush invocation; Cerebro should strengthen it with failed flush and identity changes, exact persisted values and no mutation.
5. ADOPT Tolaria staging and no-clobber rename mechanics as a comparative example, not an already-proven Cerebro protocol. docs/examples/tolaria-main/src-tauri/src/vault/rename_transaction.rs:32–42 syncs staged content, :95–104 uses persist_noclobber with rollback. Cerebro already has stronger path locking/receipt needs.
6. REJECT Tolaria's existence-only recovery decision. rename_transaction.rs:263–271 deletes backup if old/new merely exists; manifest writes :145–159 do not themselves show journal+directory fsync. This is insufficient evidence of crash durability or of the intended bytes having committed. M99's hash/revision validation and crash-boundary tests are better and should stay.
7. ADOPT AppFlowy workspace-namespaced key migration within the actual KV transaction. docs/examples/AppFlowy-main/frontend/rust-lib/flowy-user/src/migrations/doc_key_with_workspace.rs:48–55 invokes migrate_old_keys with user.workspace_id through with_write_txn. This supports scoping/identity conformance, not copying its CRDT body format.
8. REJECT AppFlowy's migration-record read failure becoming empty. docs/examples/AppFlowy-main/frontend/rust-lib/flowy-user/src/migrations/migration.rs:123–127 unwrap_or_default() can treat unavailable history as no migrations; :78–86 runs a migration then separately records it, :117–120 panics on record failure. Cerebro should keep its existing numbered transactional migrations and typed unavailable/recovery states (runtime/mod.rs:29–36), with repeat/restart tests.
9. ADOPT AppFlowy's actual historical-database open journey. docs/examples/AppFlowy-main/frontend/rust-lib/event-integration-test/tests/user/migration_test/document_test.rs:8–25 opens an archived fixture, enumerates views and opens every document to check its real shape. Add the Cerebro equivalent after acknowledged post-cutover edits, including guarded concepts, instead of only asserting converted row counts.
10. DECLINE language/framework parity inference. The inspected AppFlowy Rust migrations and Macro Solid persistence establish only their concrete patterns; they do not prove Rust UI/Flutter editor, collaboration or performance parity. Keeping React and testing components/native input is appropriate.

## Minimum viable sequence and dependencies

1. Source/build baseline and failure ownership first. Preserve M91/M92 ownership and distinguish baseline failures from regressions. The new M91 implementation record :30–40 reports 11 baseline unit failures and 42 full E2E failures, not an all-green application gate; no fresh execution was done here.
2. M93.1 retained generations/authoritative ack, then M93.2 all-participant prepare/leave barrier. CHAT launch, origin-switch and future FLOW capture consume that result; do not create alternate saves. Explicit native five-second deadline remains a limit (shell/quit.rs:45–50, :112–119), and a hung webview can still lose in-memory drafts.
3. M93.3 scoped listing + independent lineage, then M93.4 selection/origin readers, using the barrier for cross-vault navigation. M93.5 readiness is independent except shared agent/IPC file ownership; native timeout is not authentication proof.
4. M93.6 measurements before M93.7 scale choices. M93.8 source requires the owner/barrier; M93.9 displaced-byte retention requires its own decision and does not block save fixes. Help and native evidence can be prepared alongside, with acceptance only after implemented behaviors exist.
5. M99.1 typed legacy read pilot → M99.2 values → M99.3 byte/identity/carrier inventory → M99.4 two disposable stores. These can run separately from connected beta; they do not authorize production conversion.
6. M99.5 authority decision includes explicit governed-projection disposition and full consumer cutover matrix. If legacy is selected, stop migration and keep useful Rust services.
7. Selected authority adapter integration and format-aware compatibility release, then M99.6 disabled staging; M99.7 journal/recovery and M99.8 backup/restore/post-edit rollback rehearsals on temporary copies. Only enable production after all selected readers/writers, guarded knowledge, compatibility and restore gates pass. No need to activate migration to test backup.
8. Packaged/native/live/provider cases retain distinct results. An unavailable environment is an open acceptance disposition, not a design defect or a pass.

## Declined to judge

I did not run the eight example applications, measure reference performance, infer hosted/paid-edition capabilities, audit their full security, choose SQLite vs sidecars, approve retention/migration, validate actual macOS IME/VoiceOver/quit behavior, verify CLI authentication, rerun the M91 gate or review M94–M98 beyond shared contract boundaries. Macro/Tolaria/AppFlowy evidence here is explicitly file-scoped. I did not judge requested features unsupported merely because a reference lacks them. I did not edit any current implementation or reference source.

## Final integration recheck

The reviewer confirmed recovery/backup before M99 production activation and local artifact saves through M93/existing human writers. It identified one remaining ordering ambiguity: M95.1 appeared to require final M93 native acceptance before the baseline handoff. The coordinator corrected both M95 documents to distinguish an evidence-classifying baseline handoff from final repaired native/live release acceptance. Unrelated daily UI work is not blocked on that final gate.
