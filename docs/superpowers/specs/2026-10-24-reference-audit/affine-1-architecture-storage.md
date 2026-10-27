# AFFiNE architecture, local-first storage, sync and Rust - reference audit 2026-10-24

> **Scope:** slice AFN1. nbstore (storage, sync, frontend, impls, worker, tests), `frontend/native` Rust (nbstore, schema, sqlite_v1, disk_sync, import), mobile-native, infra (DI, LiveData, ObjectPool, op), core modules (workspace, workspace-engine, doc, db, blob-management, backup, storage, feature-flag), Electron main/helper, CI. EE `backend/native` skimmed for ideas only. About 85 files read and 40 more inferred from their names. **`AF/` = `docs/examples/AFFiNE-canary/`.**
> **Licence:** every cited AFFiNE path is MIT (`AF/packages/frontend/**`, `AF/packages/common/{nbstore,infra}`, `AF/blocksuite/**`) except `AF/packages/backend/native/**` and `AF/packages/common/native/**`, which are AFFiNE EE and usable for ideas only. **No verdict below is `adopt`:** each lesson is re-implemented in Cerebro's model, so no code needs porting. `affine_doc_loader`, `y-octo`, `memory-indexer`, `safefetch` and `affine_importer` are crates.io dependencies that are not vendored, so their internals are `[names]` only.
> **Basis:** `[read]` code or tests read · `[names]` inferred from file or directory names · `[docs]` README or comments.
> **Cerebro side:** checked against the M93, M95 and M99 specs and plans, the M99 authority decision and consumer matrix, and the implementation record (2026-10-24). Every "Cerebro today" claim was grepped in `src/` and `src-tauri/src/`.

## Top findings

1. **Freeze the shipped schema text before any `workspace.db` exists in the wild (M99.6).** AFFiNE shipped a whitespace-only edit to migration 3. Every existing database then failed to open with `VersionMismatch(3)`, until AFFiNE added a checksum-repair path and a test. Cerebro's `verify_schema` compares the stored `sqlite_schema.sql` with `include_str!("selected_schema.sql")` byte for byte, and no digest anchor protects that file. One reformat, or one added comment, would make every converted workspace unopenable.
2. **Back up `workspace.db` with `checkpoint` + `VACUUM INTO tmp` + rename (M99.8).** To import, validate the file, copy it into app data, then re-key it to a new ID. This is AFFiNE's whole-workspace export and import. Cerebro already has the stronger validator (`selected.rs::verify_schema`). It has no snapshot mechanism yet: neither `VACUUM INTO` nor the rusqlite backup API appears in `src-tauri`.
3. **Compute "referenced" from a complete scan, and only then (M99.8 + NEW:attachments).** AFFiNE's unused blobs are all blobs minus the blob references aggregated from its local index, computed only after doc sync and indexing have completed. Cerebro's scan records wikilinks but not attachment references. Yet M99.8 makes "referenced attachments" a required backup category.
4. **Key metadata values by a stable field ID (M99.6 schema).** AFFiNE stores each custom value under `custom:<propertyId>` and keeps definitions, with tombstones, in their own table, so a rename changes one row. Cerebro's selected metadata JSON is keyed by field name (`"full_width":{…}`), which carries CV-40's rewrite-every-record rename batch into SQLite. Decide this before activation.
5. **Prove SQLite rollbacks in-process with trigger or rename fault injection (M99.7, M95.3, M98.3).** For each statement, AFFiNE adds a trigger such as `CREATE TRIGGER … BEFORE INSERT ON snapshots … RAISE(ABORT)` and asserts that nothing partial survives. Cerebro's abort-based crash tests are skipped on the owner's Mac, which they wedge (`.husky/pre-push:61-67`). Triggers run anywhere.
6. **Give vault-scoped state one lifetime object (NEW:vault-session).** AFFiNE scopes services per workspace, view, doc and editor, and disposing the scope kills stale async work with it. Cerebro rebuilds this by hand at 35 `useVaultStore.subscribe` sites plus per-action `current()` checks. The M93.3/.4 review still found stale origin and navigation races.
7. **AFFiNE confirms M93's barriers by lacking them.** It has no quit or close save barrier (both are TODOs), and its save queue has no failure state. It copes only because every edit commits to a local SQLite update log at once. Cerebro's whole-file Markdown saves need M93.1/M93.2 as planned. AFFiNE's canary Markdown mirror shows what a Markdown peer needs: a per-doc baseline, a rule never to overwrite bytes that differ, and review candidates.

## Map

| Area | Path | What it does |
| --- | --- | --- |
| Storage contract | `AF/packages/common/nbstore/src/storage/doc.ts` | `DocStorage` and `SnapshotDocStorageBase`: snapshot plus update queue, squashed on read |
| Durable doc write | `AF/packages/frontend/native/nbstore/src/doc.rs` | `push_update` (monotonic per-doc clock), `get_doc` (compaction with CAS), `delete_doc` (one tx) |
| DB lifecycle | `AF/packages/frontend/native/nbstore/src/{storage,pool}.rs` | WAL, 4-connection pool, migrator with checksum repair, `checkpoint`, `vacuum_into`, per-universal-id pool with Connecting/Connected states |
| Schema and migrations | `AF/packages/frontend/native/schema/src/{lib,import_validation}.rs`, `nbstore/build.rs` | Ordered migration list, strict import allowlist, compile-time-checked SQL |
| Blobs | `AF/packages/frontend/native/nbstore/src/blob.rs`, `AF/blocksuite/framework/global/src/utils/crypto.ts` | SHA-256 keys, soft delete, `release_blobs` purge |
| Index | `AF/packages/frontend/native/nbstore/src/indexer/{mod,persistence,tests}.rs`, `AF/packages/common/nbstore/src/sync/indexer/index.ts` | In-memory index checkpointed into `idx_snapshots`, per-doc indexed clock plus version, native crawl first |
| Frontend queue | `AF/packages/common/nbstore/src/frontend/doc.ts` | Per-doc load/apply/save jobs, coalesced saves, priorities, state flags, `waitForUpdated` |
| Peer sync | `AF/packages/common/nbstore/src/sync/doc/peer.ts` | Per-(peer, doc) pushed/pulled/remote clocks, doc-scoped errors, 5 s retry loop |
| Markdown peer (canary) | `AF/packages/common/nbstore/src/impls/disk/doc.ts`, `AF/packages/frontend/native/src/disk_sync/**` | Folder of `.md` as a sync remote: checkpoints, 3-way merge, review candidates, pending outbox |
| Legacy migration | `AF/packages/common/nbstore/src/impls/sqlite/v1/doc.ts`, `AF/packages/frontend/core/src/modules/workspace-engine/impls/local.ts` | v1 DB mounted read-only as a remote peer |
| Local-only footprint | `AF/packages/frontend/apps/electron/src/helper/workspace/meta.ts::getSpaceDBPath`, `local.ts` | One `<appData>/workspaces/<peer>/<id>/storage.db` per workspace (docs, clocks, blobs, peer clocks, index); remotes are v1 plus an optional disk folder; no cloud |
| Rust/TS split | `AF/packages/frontend/native/**` vs `AF/packages/common/nbstore/src/**` | Rust: SQLite, CRDT merge/compaction (y-octo), index, crawl, disk sync, import, previews. TS: sync orchestration, queues, priorities, DI, UI |
| Bindings | `AF/packages/frontend/native/{index.d.ts,nbstore/src/lib.rs}`, `AF/packages/frontend/mobile-native/src/lib.rs` | One crate behind napi-rs (desktop helper) and uniffi (mobile) |
| Worker boundary | `AF/packages/common/nbstore/src/worker/{consumer,ops}.ts`, `AF/packages/common/infra/src/op/**` | Typed `{op: [In, Out]}` table; per-key serialized open/close with refcount |
| DI and state | `AF/packages/common/infra/src/framework/**`, `utils/object-pool.ts`, `livedata/**` | Scopes, disposal cascade, ref-counted pools, LiveData through `useSyncExternalStore` |
| Scopes in use | `AF/packages/frontend/core/src/modules/{workspace/services/repo.ts,doc/services/docs.ts,workbench/scopes/view.ts}` | WorkspaceScope, DocScope (pooled per docId), ViewScope, EditorScope |
| Workspace metadata | `AF/packages/frontend/core/src/modules/db/schema/schema.ts`, `doc/stores/doc-properties.ts` | Typed tables over CRDT docs; values keyed by property ID; legacy overlay |
| GC | `AF/packages/frontend/core/src/modules/blob-management/entity/unused-blobs.ts` | Unused-blob list gated on sync plus index |
| Export, import, trash | `AF/packages/frontend/apps/electron/src/helper/{dialog/dialog.ts,workspace/handlers.ts}` | `.affine` export, validated import, trash and recover as a new workspace |
| Process lifecycle | `AF/packages/frontend/apps/electron/src/main/{helper-process,cleanup}.ts`, `windows-manager/main-window.ts` | Utility process holds the DB pool; quit kills it; close is a TODO |
| CI | `AF/.github/workflows/build-test.yml` | Codegen drift gate (gql, i18n, config), clippy, nextest |

## Patterns that work

| ID | Pattern | Mechanism | Why it works | Evidence [basis] | Cerebro today | Verdict | Phase |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AFN1-01 | A shipped schema is immutable | Ordered `(name, up, down)` list becomes a sqlx `Migrator` that checksums each applied SQL. A trailing-space edit to shipped migration 3 failed existing DBs. The fix rewrites the stored checksum only when it equals checksum(legacy text), with a test. Import checks structure via `PRAGMA table_info/index_info`, not text | Cosmetic drift becomes an explicit, tested repair instead of a bricked install | `AF/packages/frontend/native/nbstore/src/storage.rs::migrate`, `try_repair_migration_3_checksum`, test `connect_repairs_whitespace_only_migration_checksum_mismatch`; `AF/packages/frontend/native/schema/src/import_validation.rs::table_columns_match` [read] | `src-tauri/src/workspace_service/selected.rs::verify_schema` requires exact `sql` text equal to `include_str!("selected_schema*.sql")` per table. No digest test for those files (grep). runtime.db validators use `contains` plus `prepare` (`runtime/mod.rs` `validate_v33`/`validate_v34`) | adapt | M99.6, M99.8 |
| AFN1-02 | Live snapshot export; import as a validated clone | Export: connect, `checkpoint` (wal_checkpoint FULL), dialog, refuse same file, `VACUUM INTO <target>.<nanoid>.tmp` from a read-only pool, then `move(tmp, target)`. Import: refuse paths inside app data, `validate()` (required tables) else take the v1 path, `validateImportSchema()` (strict: unknown table/view/trigger refused), `VACUUM INTO` the app-data path, then `setSpaceId(nanoid)` re-keys every row. Workspace trash/recover reuses this import | Consistent compacted copy without stopping writers; the user's file is never opened in place; a clone never shares identity | `AF/packages/frontend/apps/electron/src/helper/dialog/dialog.ts::saveDBFileAs`, `loadDBFile`; `.../helper/workspace/handlers.ts::trashWorkspace`, `recoverBackupWorkspace`; `AF/packages/frontend/native/nbstore/src/storage.rs::vacuum_into` + test `vacuum_into_exports_a_compacted_database`; `doc.rs::set_space_id` [read] | Strict allowlist, `quick_check`, `trusted_schema` off, NOFOLLOW, private permissions (`selected.rs::verify_schema`, `selected_store.rs:95-115`). Prototype backup is a logical export (`workspace_migration/comparison.rs::backup`/`restore`). No `VACUUM INTO` or backup API in src-tauri (grep; rusqlite feature `bundled` only). Earlier research named `VACUUM INTO` from docs (`plans/2026-10-22-ai-expansion-review/rust-and-storage.md:310`) | adapt | M99.8 |
| AFN1-03 | Referenced set from an index; GC only after completeness | Keys are base64url(SHA-256). Delete is soft (`deleted_at`); `release_blobs` purges. Unused = listed minus `aggregate(block, exists blob)`, paged by 1000 with a "pagination did not advance" throw, run only after `doc.waitForSynced()` and `indexer.waitForCompleted()`. Avatar exempt; the person chooses what to delete | A partial index cannot mark a live blob unused; dedup is free | `AF/packages/frontend/core/src/modules/blob-management/entity/unused-blobs.ts::getUnusedBlobs` + spec; `AF/packages/frontend/native/nbstore/src/blob.rs`; `AF/blocksuite/framework/global/src/utils/crypto.ts::sha` [read] | Attachments copy through CV-56 doors with hash reuse (`vault/write.rs`). Scan `Entry` has `outgoing_links` (wikilinks) but no attachment refs (`src-tauri/src/vault/entry.rs`). No unused-attachment review (grep). M99.8 requires "referenced attachments" | adapt | M99.8, NEW:attachments |
| AFN1-04 | Values keyed by stable property ID | Values live in `docProperties` under `custom:<propertyId>`. Definitions live in `docCustomPropertyInfo` (id, name, type, show, string `index` for order, `isDeleted` tombstone kept "for override legacy data"). Filters read `'custom:' + key` | Renaming a property touches one row; values, filters and views are never rewritten | `AF/packages/frontend/core/src/modules/db/schema/schema.ts`; `.../doc/entities/record.ts:41-47`; `.../collection-rules/impls/filters/checkbox.ts:20` [read] | Selected metadata JSON is name-keyed (`src-tauri/src/workspace_service/paired_tests.rs:28`, `"full_width":{"kind":"boolean",…}`). Renames are every-record batches (`src/app/typeActions.ts` `renameFieldOnType`, CV-40) | adapt | M99.6, M99.8 |
| AFN1-05 | Scoped lifetimes instead of reset listeners | `createScope(WorkspaceScope/DocScope/ViewScope/EditorScope)` creates a child provider with its own cache. `scope.dispose()` disposes each cached service/entity (`Symbol.dispose`) and its event bus. `ObjectPool` ref-counts workspaces and docs: GC every 1 s, with an `onDangling` veto. `FrameworkScope` swaps the React provider, so a subtree re-binds. `useLiveData` sits on `useSyncExternalStore` | Vault state and in-flight work share one lifetime; nothing outlives its workspace by accident | `AF/packages/common/infra/src/framework/core/provider.ts::createScope`, `ComponentCachePool.dispose`; `.../infra/src/utils/object-pool.ts`; `AF/packages/frontend/core/src/modules/workspace/services/repo.ts`; `.../doc/services/docs.ts::open`; `.../infra/src/framework/react/index.tsx::FrameworkScope` [read] | 18 Zustand stores; 35 `useVaultStore.subscribe` sites in 34 non-test files (e.g. `src/stores/commentsStore.ts:183`), plus per-action `live`/`current()` guards (`src/app/packActions.ts:14-17`). The implementation record notes M93.3/.4 stale-origin races | adapt (not the DI container) | NEW:vault-session |
| AFN1-06 | In-process fault injection per SQL statement | Tests add `BEFORE INSERT ON snapshots`, `BEFORE DELETE ON updates` or `BEFORE UPDATE ON snapshots` triggers that `RAISE(ABORT)`, or rename/drop a table, then assert the snapshot is absent and the update rows are intact. The index test drops `idx_snapshots` and asserts the index stays dirty and the clock unadvanced | Deterministic, no child process, works on any OS, covers every statement of a multi-statement tx | `AF/packages/frontend/native/nbstore/src/doc.rs` test `failed_compaction_rolls_back_snapshot_and_updates`; `.../indexer/tests.rs::failed_atomic_commit_keeps_index_dirty_and_clock_unadvanced` [read] | Abort crash points spawn child processes (`src-tauri/src/crash.rs`, `vault/testutil.rs::run_crash_scenario`, ~30 call sites) and are skipped on Mac (`.husky/pre-push:61-67`). Clean `stop_point` children plus path hooks cover the paired journal (`workspace_service/paired_tests.rs`). One trigger test exists (`client_access/listener.rs:1358`) | adapt (systematize) | M99.7, M95.3, M98.3 |
| AFN1-07 | Compaction that cannot lose the source (CRDT log itself: Avoid) | `get_doc` reads snapshot plus updates in one read tx, merges them with y-octo, then applies the result to a fresh doc (`has_pending_updates` means `IncompleteDoc`). The write tx does a CAS `UPDATE snapshots … WHERE updated_at=? AND data=?`, re-reads the updates and aborts if any changed, then deletes them; up to 8 tries, then `ConcurrentModification`. `push_update` inserts only if no clock is ≥ ts, adding 1 ms per retry, up to 12 tries | The log is destroyed only after its replacement decodes and nothing raced | `AF/packages/frontend/native/nbstore/src/doc.rs::get_doc`, `push_update`, `try_insert_update_with_timestamp` [read] | Bodies: temp, fsync, rename, then dir fsync (`src-tauri/src/vault/write.rs:110-213`). Selected receipts record previous revision plus before/after hashes (`workspace_service/selected_schema_v3.sql`) | already-have | M99.7 (confirm) |
| AFN1-08 | Derived-index watermark and version, committed atomically | `indexer_sync(doc_id, indexed_clock, indexer_version)`: skip a doc only when its clock and version (`NBSTORE_INDEXER_VERSION`=7) both match. `commit_indexed_clocks` writes index checkpoints and clocks in one tx. A corrupt checkpoint resets the index and deletes the clocks; search returns `IndexNotReady` until rebuilt. Bumping the version reindexes lazily | The watermark never claims more than the persisted index holds; a failure is unavailable, never empty | `AF/packages/frontend/native/nbstore/src/indexer/{mod,persistence}.rs`; `.../indexer/tests.rs::corrupt_checkpoint_requires_rebuild_and_clears_clocks`; `AF/packages/common/nbstore/src/sync/indexer/index.ts:426-437` [read] | The corpus is an in-memory stat cache, "never an index" (`src-tauri/src/vault/corpus.rs`); M93 excludes a persistent index | watch | M93.7 (if a cache persists), M97 |
| AFN1-09 | A Markdown peer with baselines and review candidates | Each doc's checkpoint is {CRDT snapshot, last-agreed markdown, canonical meta hash}. Export never overwrites a file that differs: it creates only (temp plus `hard_link`; `AlreadyExists` fails) or writes `.affine-sync/candidates/<sha3(id\0content)>.md` and raises `DISK_SOURCE_REVIEW_REQUIRED`, which pauses that doc only. Import runs `merge_markdown(baseline, current, before, after)`; a mismatch becomes a candidate. The file is re-read before commit. A new file must round-trip with no delta. A missing file never deletes. Two files claiming one id is an error. Canary-only flag | External editors and the app never silently overwrite each other | `AF/packages/frontend/native/src/disk_sync/session/{source_export,source_import,source_scan}.rs`, `mod.rs::write_candidate`, `utils.rs::write_new_file`; `tests.rs::concurrent_file_and_doc_edits_require_source_reconciliation`, `no_delete_policy_does_not_emit_doc_delete`; flag at `AF/packages/frontend/core/src/modules/feature-flag/constant.ts:299` [read]; merge algorithm in `affine_doc_loader` [names] | Open-page 3-way merge with per-block choices (`src/editor/NoteBodyEditor.tsx` `reconcileOnce`); agents compare (CV-23); M99 reports YAML in a converted body as a format conflict (authority decision) | adapt (bodies already covered; adapt the format-conflict repair) | M99.6, M93.8 |
| AFN1-10 | Acknowledged outbox with restart replay | `stage_source_import` writes checkpoint, binding and merged pending update in one tx. `start_session` replays pending rows before scanning. `acknowledge(doc, local)` deletes a row only if merge(local, pending) == canonical(local) and `bin = ?` still matches | At-least-once and idempotent by content; no "delivered" flag that can lie | `AF/packages/frontend/native/src/disk_sync/state_db.rs::stage_source_import`, `acknowledge_source_update`; `.../session/source_import.rs::replay_pending_updates`; `tests.rs::file_change_after_export_is_imported_into_workspace` (stop before ack replays; stop after ack does not) [read] | Paired journal keeps pending evidence and refuses ack on change (`workspace_service/paired_tests.rs::changed_body_after_sql_commit_preserves_pending_evidence_and_refuses_ack`); M95.3 import verifies readback before clearing | already-have | M95.2/M95.3, M98.3, M99.7 (confirm) |
| AFN1-11 | Session-scoped watermarks for stores others edit | The disk peer sets `syncMetadataScope='connection'`, so DocSyncPeer swaps in a `DummyDocSyncStorage` and recomputes pushed/pulled clocks on every connection | Edits made while the app was closed cannot hide behind a stale watermark | `AF/packages/common/nbstore/src/impls/disk/doc.ts:21`, `sync/doc/peer.ts` constructor; `__tests__/sync.spec.ts` "connection-scoped readonly peers ignore persisted clocks" [read] | Stat keys are in memory only (`vault/corpus.rs`). Selected startup recovers paired state before its scan (`workspace_service/paired_tests.rs::startup_selected_opener_recovers_old_and_new_before_its_actual_scan`), and reads join metadata to exact body bytes (consumer matrix) | already-have | M99.6/M99.7 (confirm) |
| AFN1-12 | Old store untouched and read-only | The v1 DB is a remote peer: read-only, pushes are no-ops, and a constant 2030 timestamp makes it win once. An old/new ID converter maps records; blobs come via `fullDownload('v1')`. The v1 folder is deleted only at workspace trash, "after full sync" | Migration is lazy and repeatable; old bytes are never edited | `AF/packages/common/nbstore/src/impls/sqlite/v1/doc.ts`; `.../workspace-engine/impls/local.ts:440-530`; `.../workspace/entities/engine.ts::start`; `.../helper/workspace/handlers.ts::trashWorkspace` [read] | M99.6: new root, old vault retained as an archive, deliberate registration (spec) | avoid (mechanism needs CRDT merge and LWW clocks; principle confirmed) | M99.6 |
| AFN1-13 | Read-time legacy overlay | `watchDocProperties` returns `{...legacy, ...omitBy(db, isNil)}`: the new store wins unless its value is nil | Upgrade without a migration | `AF/packages/frontend/core/src/modules/doc/stores/doc-properties.ts:43-57` [read] | CORE-08 forbids mixed authority; there is no fallback to conflicting frontmatter (authority decision) | avoid (clearing a value resurrects the legacy one; two authorities forever) | M99.6 (confirm CORE-08) |
| AFN1-14 | Per-doc job queue and flush wait | Jobs are grouped per doc (load, apply, save); saves merge into one `pushDocUpdate`. `AsyncPriorityQueue` uses ref-counted `addPriority`, which returns an undo; the root doc gets priority ∞. `waitForUpdated(docId?)` waits until no job is queued or running. States: loaded, ready, updating, synced, retrying, error, throttled to 1 s | Coalescing plus priority keep the open doc fast | `AF/packages/common/nbstore/src/frontend/doc.ts`; `sync/doc/peer.ts::getJobPriority` [read] | `DocumentOwner` serializes, coalesces, retains failed payloads and returns typed `SaveOutcome`/`FlushReport` (`src/editor/documentOwner.ts`, `openPages.ts:404-492`). Chat flushes before send (`src/agent/useAgentChat.ts:821`) | already-have (stronger) | M93.1/M93.2 (confirm) |
| AFN1-15 | Doc-scoped vs engine-scoped errors | Permission, export and review errors pause one doc (`docErrors`; `schedule` skips it; `retryOnLocalUpdate`). Other errors reset the peer and retry after 5 s. Permission errors stop retrying | One bad doc cannot stall the rest; terminal errors do not loop | `AF/packages/common/nbstore/src/sync/doc/peer.ts::runRemoteDocJob`, `schedule`, `mainLoop`; `sync.spec.ts` "Markdown review pauses only its doc" [read] | Per-file `parse_error` never stops a scan (`src-tauri/src/vault/entry.rs`); wakes end in closed outcomes (`runtime/wakes.rs`); M98.3 has a wait-outcome table | already-have | M98.2/M98.3 |
| AFN1-16 | One Rust core behind feature-gated bindings | `affine_nbstore` builds as a napi addon (desktop helper) or, with `use-as-lib`, under the uniffi mobile crate (`#[cfg_attr(not(feature="use-as-lib"), napi(object))]`). Tests use `:memory:` with plain cargo | Bindings stay thin; logic is tested natively | `AF/packages/frontend/native/nbstore/{Cargo.toml,src/lib.rs}`; `AF/packages/frontend/mobile-native/{Cargo.toml,src/lib.rs}` [read] | One Tauri crate; CORE-03 splits crates only for a real reuse reason | already-have | M99.1 (confirm CORE-03) |
| AFN1-17 | TS generated from Rust declarations | napi-rs emits a committed `index.d.ts` (e.g. `pushUpdate(...): Promise<Date>`). The CI `check-git-status` job regenerates gql, i18n and config, and fails on a diff; it does not regenerate `index.d.ts` | One declaration per wire type | `AF/packages/frontend/native/index.d.ts`; `AF/.github/workflows/build-test.yml:445-475` [read] | Schemars to TS with a `--check` gate (`scripts/contracts/generate.ts`, `src/lib/generated/{workspace,actions}.ts`) | already-have (stronger) | M99.1 |
| AFN1-18 | Compile-time SQL checked against the migration list | `build.rs` runs `get_migrator()` into a fresh DB and sets `DATABASE_URL`, so each `sqlx::query!` is type-checked at build | Query/schema drift fails the build | `AF/packages/frontend/native/nbstore/build.rs` [read] | rusqlite, no sqlx (`src-tauri/Cargo.toml`); runtime validators `prepare` column lists (`runtime/mod.rs`) | watch (cheap twin: a test that prepares every SQL constant on a freshly migrated DB) | M95.3, M98.2, M99.7 |
| AFN1-19 | Pull-based bounded import | `create_import_session(limits{max_docs, max_blobs, max_blob_bytes ≤100 MiB})`, then `next_import_batch`, then `cancel`/`dispose`. A test shows cancel blocks the next batch | Backpressure and cancellation for large sources | `AF/packages/frontend/native/src/import.rs` [read]; importer internals [names] | Import plans one whole batch (`src-tauri/src/import/plan.rs::read_vault`, `plan`) | watch | M99.8 (large restore) |
| AFN1-20 | Flush what the agent will read | The AI request callback awaits `waitForSynced` for the root doc, `db$docProperties` and each referenced doc | The model never reads a stale copy | `AF/packages/frontend/core/src/desktop/pages/workspace/chat/index.tsx:65-73` [read] | `flushOpenPages()` before send (`src/agent/useAgentChat.ts:821`); `saveBeforeAction` (`src/app/leaveGuard.ts:112`) | already-have | M93.2, M95 (confirm) |

### AFN1-01: schema freeze

- **AFFiNE flow:**
  1. `get_migrator()` turns the ordered `MIGRATIONS` list ("ORDER MATTERS") into `Migration::new(i, name, Simple, up)`.
  2. sqlx stores a checksum per version; a mismatch raises `VersionMismatch(v)`.
  3. `try_repair_migration_3_checksum` repairs only when the descriptions match and the stored checksum equals checksum(`up + " "`). It then runs `UPDATE _sqlx_migrations SET checksum`.
- **Cerebro shape:** before activation, pin a digest per shipped `selected_schema*.sql` (a test or a `.sha256` anchor, as for `shared/policy/`). A changed shape gets a new `user_version` file.
  - Add a test that builds a DB from every shipped file and passes `verify_schema`, plus a reformatted copy that is refused.
  - The exact-text compare also breaks on an added comment line: `split(';')` puts the comment into the next `CREATE TABLE` chunk, so `starts_with("CREATE TABLE ")` fails.

### AFN1-02: backup and restore

- **AFFiNE export (`saveDBFileAs`):** connect, `checkpoint`, save dialog, `isSameFilePath` guard, `tmp=<target>.<6 chars>.tmp`, `vacuumInto(tmp)` from a read-only pool, `fs.move(tmp, target, overwrite)`, reveal in folder.
- **AFFiNE import (`loadDBFile`):** `normalizeImportDBPath` (refuse anything inside app data), `validate()`, `validateImportSchema()`, `vacuumInto(<appData>/workspaces/local/<new id>/storage.db)`, `setSpaceId(new id)`.
- **Cerebro M99.8 export:**
  1. Under the existing workspace lock, run `VACUUM INTO <dest>/metadata.db.tmp` from a read-only connection.
  2. Open the tmp file with `verify_schema` and `quick_check`.
  3. fsync and rename it, then hash it into the manifest beside bodies, attachments, comments and the ledger.
- **Cerebro M99.8 restore:** copy into `<app-data>/workspaces/<new-id>/` first and validate there; never open the archive in place. A clone gets a new workspace ID (already in the spec).
- **Option:** one SQLite container (a `parts(path, sha256, bytes)` table) built the same way. Restore then validates rows before materializing any file, which removes the extraction-path attack class.

### AFN1-03: referenced attachments

- **AFFiNE flow:** `waitForSynced`, then `indexer.waitForCompleted`, then `listManageableBlobs`. Next, `aggregate('block', exists 'blob', 'blob', {limit:1000, skip})` repeats until `!hasMore`, throwing if a page is empty but `hasMore` is set. Finally the used set is filtered out.
- **Cerebro shape:**
  - The scan emits attachment references (root-anchored media lines from bodies, plus Canvas file nodes) beside `outgoing_links`.
  - The referenced set exists only after a complete scan. Any unreadable page makes it `unavailable`, never "unreferenced" (CV-05).
  - M99.8 uses the set for its required category. An optional review list moves the person's selections to vault Trash (CV-37) and never purges.

### AFN1-05: vault session

- **AFFiNE flow:** `repo.open` calls `pool.get(key)`, or `instantiate`, which runs `createScope(WorkspaceScope, opts)` and `engine.start()`. A `release` brings rc to 0; GC then calls `onDelete`, which runs `scope.dispose()`, so services dispose and effects unsubscribe.
- **Cerebro shape:**
  - `VaultSession {vaultId, path, generation, signal: AbortSignal, onDispose(fn)}` is minted by `vaultStore` on open and disposed on a switch, before the next one publishes.
  - Stores register their resets with `onDispose`. Async actions capture the session and check `session.signal.aborted`.
  - Migrate the 35 sites incrementally. A rail test lists the remaining raw `useVaultStore.subscribe` calls, as `keydownRail` does for keydown listeners.

### AFN1-06: trigger injection

- **AFFiNE flow:**
  1. Push an update.
  2. `CREATE TRIGGER fail_compaction BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT,'injected'); END`.
  3. `get_doc` returns an error; assert the snapshot is `None` and the update count is 1.
  4. `DROP TRIGGER`, and `get_doc` succeeds.
  - This repeats for `INSERT snapshots`, `DELETE updates` and `UPDATE snapshots`; a table rename simulates an unavailable table.
- **Cerebro shape:** a `fail_before(conn, "DELETE ON <table>")` helper, run table-driven over every statement of:
  - M95.3 expiry and delete (content, previews and search rows together);
  - M98.3 `claim_resume` and the park transitions;
  - M99.7 metadata commit.
  - Assert the pre-state is byte-identical. Keep stop points and crash points for file renames, which SQLite cannot see.

## Avoid / doesn't transfer

- **CRDT update log as the body store** (`AF/packages/frontend/native/nbstore/src/doc.rs`). It needs a CRDT body. Cerebro's body is Markdown with human last-write-wins (CV-23).
- **A live WAL DB inside a synced folder.** Disk sync keeps `.affine-sync/state.db` (WAL) and its candidates inside the folder the person chose (`AF/packages/frontend/native/src/disk_sync/state_db.rs::open`). This violates M99's "never place a live WAL database in a cloud-synced vault".
- **A lossy frontmatter round trip** (`AF/packages/frontend/native/src/disk_sync/frontmatter.rs`). The parser reads only id, title, tags, favorite and trash, and normalizes CRLF. Candidates come from the same writer, so accepting one drops unknown keys. Cerebro must keep byte-exact prefix and body handling (M93.8 REL-10, M99.3).
- **Polling plus a full rescan every 5 s that reads every file** (`AF/packages/frontend/native/src/disk_sync/session/source_scan.rs::scan_once`). Cerebro is stronger here: a notify watcher with own-write recognition by hash (`src-tauri/src/vault/watcher.rs`), and a stat cache keyed by ctime, inode and a racy window (`vault/corpus.rs`).
- **No save-failure state** (`AF/packages/common/nbstore/src/frontend/doc.ts`). `start()` runs `mainLoop().catch(console.error)`. A thrown save ends the loop with `currentJob` still set, so `waitForUpdated` never resolves, and the job has already left `jobMap`.
- **No quit or close barrier.** The helper process is killed on quit (`AF/packages/frontend/apps/electron/src/main/helper-process.ts`). The close handler reads "TODO … ask user to save unsaved changes" (`windows-manager/main-window.ts:233`), and `canGracefulStop` returns `true` as a TODO (`AF/packages/frontend/core/src/modules/workspace/entities/workspace.ts:130`). This is viable only with per-edit commits.
- **Non-atomic settings JSON writes** (`AF/packages/frontend/apps/electron/src/main/shared-storage/json-file.ts`). A parse failure loads `{}`, with the error only logged.
- **A drop-oldest bounded queue** (`AF/packages/common/nbstore/src/telemetry/queue.ts::enforceLimits`). Right for telemetry, wrong for an archive. M95.3's stop-admission rule stands.
- **Electron topology and relaunch e2e.** AFFiNE puts a utility process between the UI and the DB and talks over MessagePorts, and its packaged e2e relaunches the app (`AF/tests/affine-desktop/e2e/disk-sync.spec.ts`, "imports source edits after app restart"). Tauri has no macOS WebDriver, and Cerebro's Rust is already the host.
- **Server-held AI chat** (`AF/packages/common/graphql/src/graphql/copilot-history-list.gql` [names]). There is no local retention model to borrow for M95.
- **Stale comments.** `dialog.ts` says "symlink the source db file" but the code runs `VACUUM INTO`; `idb/lock.ts` says "lock timeout 3s" but the code uses 30000. CV-11 holds.
- **EE `safe_fetch`/`url_policy`.** These are server URL guards over external crates. Cerebro's Rust has no HTTP client (`src-tauri/Cargo.toml`). Watch only if M96 moves provider HTTP into Rust.

## Implications for M93-M99

**M93**

- **Confirm** M93.1/M93.2: whole-file saves need typed outcomes and the leave/quit barrier. AFFiNE lacks both and leans on per-edit commits (AFN1-14, Avoid).
- **Confirm** M93.9: `src-tauri/src/vault/recovery.rs` (FULL sync, `secure_delete`, policy-as-data limits) goes beyond anything in AFFiNE.
- **Amend** M93.7 (conditional): a persisted derived cache commits {key, source hash or clock, cache version} atomically with the cache; a corrupt cache reads as unavailable and rebuilds (AFN1-08).
- M93.6 has nothing to borrow: the only benchmark is `AF/packages/common/nbstore/src/__tests__/base64.bench.ts`.

**M95**

- **Confirm** M95.3's stop-admission budget and its readback-before-clear import (AFN1-10, Avoid).
- **Amend** M95.3 acceptance:
  - a trigger-injected failure on each statement of expiry or delete leaves content, preview and search rows identical (AFN1-06);
  - after delete plus cleanup, a `VACUUM INTO` copy holds no deleted bytes (the AFFiNE vacuum test).
- **Add** a prepare-every-statement test for the new runtime tables (AFN1-18).

**M98**

- **Amend** M98.3: trigger injection for `claim_resume` and the park transitions (AFN1-06). The error classes already match AFN1-15.

**M99**

- **Amend** M99.6, as an activation gate: digest-freeze the shipped `selected_schema*.sql`, test DBs built from every shipped file, and compare anything unfrozen structurally (AFN1-01).
- **Amend** the M99.6 schema: key values by stable field ID with a field-definition table that keeps tombstones. Views and filters store IDs, and `export_legacy` maps IDs to names (AFN1-04).
- **Amend** M99.7: test SQLite boundaries with trigger or rename injection (which runs on Mac) and keep stop points for renames. CAS on the exact prior bytes, and re-read inside the write tx before deleting journal rows (AFN1-06, AFN1-07).
- **Amend** M99.8: snapshot with `VACUUM INTO` tmp under the lock, then `verify_schema`, fsync and rename, then hash. Restore copies into app data before validating; a clone re-keys its identity. A single SQLite backup container is optional (AFN1-02).
- **Add** NEW:attachments (feeds M99.8): attachment references in the scan, a referenced set built only from a complete scan, and an optional reviewed "unused → Trash" (AFN1-03).
- **Confirm:**
  - CORE-08, no mixed authority (AFN1-13);
  - the old vault stays untouched and read-only (AFN1-12);
  - bodies are rechecked at each open (AFN1-11);
  - CORE-03, one crate (AFN1-16);
  - M99.1 generated DTOs (AFN1-17);
  - no live WAL DB in a synced folder (Avoid).

**NEW:vault-session (frontend)**

- **Add** a `VaultSession` lifetime (generation, `AbortSignal`, disposers) that owns vault-scoped resets and async liveness. Migrate the 35 `useVaultStore.subscribe` sites, with a rail test listing the remainder (AFN1-05). This is the structural follow-up to M93.4's race repairs.

**M96, M97**

- M97 is affected only through AFN1-08, if a persisted retrieval index lands. M96 has no storage impact; the EE `safe_fetch` stays a watch item.

## Owner questions

1. **Crash drafts.** AFFiNE is durable because it commits every edit to a local log at once. Cerebro keeps unsaved drafts in memory only, by M93 decision (REL-03 and its privacy section). Do you keep that loss window? Or should the opt-in recovery journal (M93.9) also hold the latest unsaved generation of each open page, under the same retention and privacy limits?
2. **Unused attachments.** Once the scan records attachment references (M99.8 needs them), should Cerebro offer a reviewed "unused attachments → Trash" list, or use the references for backup completeness only?
