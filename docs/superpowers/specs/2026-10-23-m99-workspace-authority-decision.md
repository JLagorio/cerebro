# M99.5 — Workspace authority decision

Status: **SQLite metadata plus Markdown bodies selected by the owner on
2026-10-23; M99.6–M99.8 implementation authorized.** Existing workspaces still
use Markdown/YAML and the guarded knowledge ledger. This document records no
approval to convert a real vault. Implementation continues on the shared branch.

[Plan](../plans/2026-10-23-m99-rust-services-and-storage.md) ·
[CORE design](2026-10-23-m99-rust-services-and-storage-design.md) ·
[Raw comparison evidence](../plans/2026-10-23-m99-store-comparison/README.md) ·
[Implementation record](../plans/2026-10-23-m93-m99-implementation-record.md).

## Selected direction

Continue moving domain services, admission, durable workflows and storage
coordination into Rust. Keep React and the existing editor for the product UI.
For a future workspace format, prefer **SQLite metadata plus visible Markdown
bodies**, provided the owner accepts that a complete workspace must be exported
or backed up, and cannot be reproduced by copying Markdown alone. This is the
existing CORE recommendation, now accompanied by implemented disposable adapters
and concrete consumer work. It is an architecture recommendation, not a measured
speed claim or approval to activate migration.

The alternative with the strongest ordinary file portability is JSON sidecars.
It still needs a coordinated journal, stable identities and complete-pair backup;
it does not make multi-file updates atomic simply by using text. Keeping current
YAML remains a supported choice and preserves the useful Rust service extraction.

| Choice | What stays visible | Canonical metadata | Product promise and cost |
| --- | --- | --- | --- |
| `legacy` | Existing Markdown files with YAML | Current guarded file writers; knowledge retains its ledger | Existing integrations continue; typed Rust services can improve without a storage migration |
| `json_sidecar` | Markdown bodies and versioned JSON metadata/identity files | Sidecar adapter with coordinated file journal | Complete file sets can be copied/exported; missing pairs, identity collisions and merge conflicts require explicit handling |
| `sqlite_metadata` | Markdown body paths | Dedicated workspace SQLite store, separate from app-global runtime.db | Typed metadata and transactional metadata changes; complete export/restore is mandatory, and file publication still needs a journal |

Owner selection: **SQLite metadata + Markdown bodies (Recommended)**, recorded
from the owner’s explicit answer on 2026-10-23. The question included the backup
exclusions, complete-export requirement, unsupported older clients and deferred
live multi-device metadata sync stated below. This authorizes implementation of
M99.6–M99.8; it does not authorize running conversion against the current vault.
JSON sidecars and retaining YAML as the long-term ordinary-metadata authority
were not selected. Native Rust UI and WASM experiments remain deferred; React
and the existing editor continue.

The proposed complete canonical-workspace backup includes current content, vault
Trash and governed reconciliation backups. It excludes scoped run/action/chat
history, app-private recovery-journal versions, credentials and live operational
state in this first version. These are explicit portability tradeoffs, not claims
that the omitted history is disposable. The category and restore rules below
form part of the choice.

## What has actually been established

The same Rust prototype trait exercises both stores against disposable roots.
The historical 1,000-record sample, corrected adversarial sample and final
5,000-record sample have raw reports. The final 5k run converted all 5,000 records,
preserved original bytes, queried all records in both stores and reported zero
semantic differences. Both stores passed backup/restore after a post-conversion
edit, refused an outside edit without adopting it, and recovered old/old/new
coherent state at the three tested interruption boundaries. Each retained report
declares the exact source inventory and limitations. The 5k artifact hash is
`ff8051588d2c754981ba0104579e84b9ad487e022c094560f73d47dbf6da3040`.

These are real adapter exercises, not production writes. The prototypes have no
production registration, writer receipts, live permission admission or migration
command. Both currently materialize complete metadata; the SQLite prototype is
not an indexed query implementation. Heavy concurrent machine load and debug
builds make all recorded timings unsuitable for a winner or latency promise.
Quiet repeats and a measured implementation target remain required.

The earlier 5k attempt produced no completed report. Its preserved partial fixture
is not counted. The fresh run used a different directory and passed the repaired
complete-report checker before and after its byte-identical tracked copy.

## Canonical consumer inventory and required cutover

This is a current-source inventory inspected on 2026-10-23. Paths below are
implementation targets, **not claims that selected-authority adapters exist**.
The M99.1 read pilot and cfg(test) prototypes do not satisfy these rows. Every row
must either consume the selected authority or return a typed unsupported-format
refusal before that format can be activated. A missing metadata file cannot be
treated as an ordinary untyped or unprivileged page.

| Consumer and actual current seam | Required disposition before activation | Specific acceptance evidence |
| --- | --- | --- |
| [`vault/scan.rs`](../../../src-tauri/src/vault/scan.rs), `entry_from_read` / `scan_vault`; [`entry.rs`](../../../src-tauri/src/vault/entry.rs), `build_entry` | Build type, properties, relations and stable identity from selected metadata; body title/snippet remain body-derived under the title rules | Reopen converted records; missing/corrupt metadata is unavailable; contradictory YAML never overrides canonical metadata |
| [`vault/corpus.rs`](../../../src-tauri/src/vault/corpus.rs), `CorpusCache::snapshot` | Include metadata/schema revision in invalidation, alongside body identity; retain scoped readable snapshots and changed-file accounting | Metadata-only changes invalidate fields/search/relations; body-only edits do not erase metadata; deletion/revocation clears results |
| [`vault/schema.rs`](../../../src-tauri/src/vault/schema.rs), `VaultSchema::from_entries` / `stored_value`; [`query.rs`](../../../src-tauri/src/vault/query.rs), `check` / `evaluate` | Read Type declarations and field values through the same authority; retain shared field/date/filter semantics | Type changes, exact tagged values, null/removal, relation ordering and cursor snapshot cases replay |
| [`vault/views.rs`](../../../src-tauri/src/vault/views.rs), database resolution and `check`; [`agenda.rs`](../../../src-tauri/src/vault/agenda.rs) | Use canonical collection/view/dated-record data; refuse unsupported predicates explicitly | Saved views, view suggestions and agenda retain the same scope and meaning after reopen |
| [`vault/write.rs`](../../../src-tauri/src/vault/write.rs), `list_collections`, `list_views`, `save_collection`, `save_list`, `save_view`; their frontend adapters | Make an explicit canonical adapter or retained-format/refusal decision for `collection.yml`, `*.list.yml` and legacy root/project `views/*.yml`; the suggestion evaluator is not their persistence owner | Authored collections and saved lists/views survive reopen and complete export; editing never creates parallel YAML/metadata authorities |
| [`search.rs`](../../../src-tauri/src/search.rs), [`source_location.rs`](../../../src-tauri/src/source_location.rs), [`vault/link.rs`](../../../src-tauri/src/vault/link.rs) | Join selected metadata with exact file-backed source locations; keep current target precedence and stable identity | Body byte locators retain complete-file hash; property carriers bind metadata revision; no invented YAML byte range for a sidecar/SQLite property |
| [`vault/write.rs`](../../../src-tauri/src/vault/write.rs), `save_note_with_recovery`, `set_note_title`, `update_frontmatter`, `set_note_fields` | Route ordinary metadata through selected mutation service and coordinate body publication; preserve guard receipts and M93 authoritative acknowledgements | Title/body/field edits preserve the other representation; recovery reports actual coverage; no YAML is silently reconstructed |
| `vault/write.rs::frontmatter_json` and [`mcp.rs`](../../../src-tauri/src/mcp.rs), `set_fields` planning closure | Replace the direct legacy byte read with a canonical metadata read under the same mutation lock/scope, or refuse converted format | An injected legacy frontmatter grant/value cannot change the field plan; stale canonical revision refuses before write |
| [`vault/batch.rs`](../../../src-tauri/src/vault/batch.rs), [`vault/trash.rs`](../../../src-tauri/src/vault/trash.rs), rename/delete in `vault/write.rs` | Journal selected metadata, stable IDs and visible paths together; preserve checked batch/Trash/rename contracts | Mixed batch rollback, rename pointers, deletion, restored identity and pre/post metadata versions remain coherent |
| [`stores/vaultStore.ts`](../../../src/stores/vaultStore.ts), [`undoStore.ts`](../../../src/stores/undoStore.ts), [`engine/batch.ts`](../../../src/engine/batch.ts) | Consume typed mutation and undo data; keep current held-owner and post-acknowledgement semantics | Undo after a body+metadata batch restores both; refresh failure cannot erase an applied mutation; no private frontend writer |
| [`mcp.rs`](../../../src-tauri/src/mcp.rs), `effective_ask_first`, `own_agent_record`, `callee_axes`, `admit_before_dispatch`; [`lib.rs`](../../../src-tauri/src/lib.rs), `run_agent` | Read current canonical Agent capabilities and scope before admission/dispatch; metadata failure fails closed | Conflicting body YAML cannot broaden grants; paused/deleted/missing Agent metadata prevents launch; rechecks survive scope changes |
| [`mcp.rs`](../../../src-tauri/src/mcp.rs), `governed_bytes_refusal` and `governed_bytes_check` | Check canonical Type/Agent identity and writer-owned provenance under the same mutation lock, while retaining body format-conflict checks, or return typed unsupported-format refusal | Converted Type/Agent writes cannot evade their guards by omitting YAML; pre/post checks cannot broaden grants or alter provenance through body text |
| [`mcp.rs`](../../../src-tauri/src/mcp.rs), `write_own_notes`, `notes_bytes`, `own_memory_bytes_refusal` and `notes_landed` | Replace the admitted own-Agent `recent` YAML splice with a canonical own-record/recent-only mutation, or explicitly refuse the selected format | The run updates only its own `recent` field; changed identity, ownership or version refuses; grants and every other field remain unchanged and no YAML is reconstructed |
| [`agent/thread_turn.rs`](../../../src-tauri/src/agent/thread_turn.rs), [`trigger/registry.rs`](../../../src-tauri/src/trigger/registry.rs), trigger/condition runners | Resolve Agent records and inherited work through selected authority, while operational leases/wakes stay runtime-owned | Scheduled/comment/project turns preserve admission and origin; restored data does not resume old approvals or effects automatically |
| [`knowledge.rs`](../../../src-tauri/src/knowledge.rs), including direct YAML reads in `near_duplicates`; [`ledger/project.rs`](../../../src-tauri/src/ledger/project.rs); [`ledger/capture.rs`](../../../src-tauri/src/ledger/capture.rs) | Retain the governed projection codec and canonical ledger; explicitly dispatch this retained format rather than applying ordinary conversion | Original attestations/ledger identities survive; duplicate detection and Verify read governed bytes; conversion never verifies or creates a second authority |
| [`import/plan.rs`](../../../src-tauri/src/import/plan.rs), `read_vault`; [`import/stamps.rs`](../../../src-tauri/src/import/stamps.rs); Notion conversion/door | Read and write source identity and writer-owned stamps through selected metadata, preserving whole-batch planning and edited-copy refusal | Moved imported copies deduplicate by stamped identity; stale/edited copies stay untouched; provenance cannot be overwritten through old YAML |
| [`editor/NoteBodyEditor.tsx`](../../../src/editor/NoteBodyEditor.tsx), [`sourceBodyEdits.ts`](../../../src/editor/sourceBodyEdits.ts), [`library/libraryDraftOwner.ts`](../../../src/library/libraryDraftOwner.ts) | Adapt byte/read/metadata DTOs without changing retained owner identity; metadata and editable body must describe one revision | Rich/source, Library explicit Save, external reconciliation, parked panes and deleted-target recovery preserve exact newer generations |
| [`app/templateActions.ts`](../../../src/app/templateActions.ts), [`applyPageTemplate.ts`](../../../src/app/applyPageTemplate.ts), [`hooks/useDocTasks.ts`](../../../src/hooks/useDocTasks.ts), rename/link rewrite helpers | Replace assumptions that a whole Markdown file owns canonical properties; use checked service reads and the existing batch door | Template body+metadata is coherent; checklist hash cannot stand in for metadata revision; moving/duplicating a body cannot copy hidden grants by inference |
| [`lib/mockIpc.ts`](../../../src/lib/mockIpc.ts), [`mockParse.ts`](../../../src/lib/mockParse.ts), generated workspace contracts and shared cases | Mirror selected authority/refusal semantics from shared contracts; keep mock parsing isolated to its allowed adapter | Browser tests cannot succeed through a legacy fallback that production refuses; native/browser cases replay the same inputs |
| [`vault/watcher.rs`](../../../src-tauri/src/vault/watcher.rs), [`git/restore.rs`](../../../src-tauri/src/git/restore.rs), Git pull/reset consumers | Observe metadata and body identities; outside restore/edit enters a checked reconciliation path | Third-party bytes never silently become acknowledged metadata; Git restoring body text cannot roll back grants without an explicit canonical operation |
| [`sheet/fence.rs`](../../../src-tauri/src/sheet/fence.rs), [`engine/sheet/fence.ts`](../../../src/engine/sheet/fence.ts), JSON Canvas readers | Keep current carrier codecs initially; sheet YAML is a separately versioned codec decision, Canvas already has its own JSON authority | Formula/reference cases remain lossless; no broad serializer replacement changes embedded documents |
| [`agent/cli_agents.rs`](../../../src-tauri/src/agent/cli_agents.rs), CLI-owned definition readers | Preserve the CLI's documented definition format and scope checks as compatibility carriers | A workspace storage migration cannot silently rewrite the person's external CLI files or imply a new sandbox |
| [`shell/file_actions.rs`](../../../src-tauri/src/shell/file_actions.rs), export/backup consumers | Label body-only copies honestly; complete exports use a versioned bounded manifest and native destination choice | A Markdown-only copy carries no hidden relations/grants; complete restore validates all required categories before registration |

Searches covered owned `src/` and `src-tauri/src/` paths, not vendored examples.
Direct YAML/frontmatter readers were checked in addition to Entry consumers.
The inventory is an implementation checklist; it is not a mechanically proven
absence of every future bypass. M99.6 must add format-boundary tests and an
explicit maintained adapter/refusal inventory before enabling conversion.

## External edits and portability proposal

For either new metadata format, editing the visible Markdown body remains useful.
The app detects external body changes and reconciles them through the same owner
and guarded writer. It does not infer canonical grants, relations or type from
newly pasted YAML. A format conflict has a visible repair/export path. Missing
metadata, duplicate identities and copied unpaired bodies remain explicit states;
they are not silently admitted as equivalent records.

For SQLite, the complete workspace is the selected metadata database plus visible
bodies and the required categories below. A Markdown-only export is deliberately
partial. Sidecars also require the identity/manifest and every required paired
file. Neither choice permits copying an open SQLite file or a changing directory
and calling it a consistent backup.

### Supported clients and synchronization limits

The SQLite proposal stores the live database at
`<app-data>/workspaces/<workspaceId>/workspace.db`, separate from the visible
vault. A live WAL database must never be placed in a cloud-synced vault. Git or
cloud synchronization of Markdown alone does not synchronize canonical metadata.
This scope supports coordinated export/import; live multi-device metadata sync
and concurrent collaboration remain deferred for either proposed new format.

A tested minimum compatible Cerebro client must ship before activation. Supported
clients refuse unsupported formats before scan, write or dispatch. Already
released legacy clients cannot be forced to honor the new marker: their direct
file access is **unsupported after cutover**, not prevented by an OS boundary.
Migration creates a newly registered root and retains the old vault as an archive;
it does not make simultaneous legacy-client use safe. If that is required,
migration remains blocked until a separate bidirectional compatibility design is
accepted and tested. External body editing remains supported reconciliation;
pasted YAML never becomes authoritative metadata automatically.

## Backup categories and proposed operational-history disposition

| Category | Proposed treatment | Restore rule |
| --- | --- | --- |
| Selected metadata, schema, stable identity and format manifest | Required | Verify versions, identities and all checksums in a new inactive root |
| Visible Markdown, Canvas and other owned source bodies | Required | Verify exact content and matching canonical revisions before activation |
| Referenced attachments and page comment sidecars | Required for a complete-workspace backup | Missing/corrupt required parts block activation; a declared partial export is not a complete backup |
| Canonical `.cerebro/ledger` store, segments and required compatibility state | Required for governed knowledge | Validate chain/projection codec and original attestations; no re-verification or historical ID rewrite |
| Retained legacy/CLI-owned carrier originals | Required where included by inventory | Preserve bytes and dispositions; external CLI files outside scope are not silently copied |
| Vault `.trash/<stamp>/` content, comments and `.trashed.json` manifests | Required recoverable local content | Preserve exact deleted bytes, paths and identity/manifests in Trash; restore must not silently revive them as live records |
| `.cerebro/reconcile-backup/` displaced human/divergent bytes | Required recoverable local content | Preserve exact files and paths independently of the canonical ledger; they cannot be assumed reproducible from current projections |
| App-private `recovery/recovery.sqlite` displaced versions | Explicitly excluded from portable workspace backup in the first version | State that these recovery versions remain on the original installation; never copy the global journal across workspaces. A later optional scoped export must preserve vault identity, privacy, expiry and explicit rebind rules |
| Disposable derived caches/indexes | Explicitly excluded | Rebuild; never use exclusion to discard canonical data |
| App-global `runtime.db`, current sessions/leases/approvals, queued effects, connector credentials | Excluded from workspace-copy restore | Never copy cross-vault runtime facts or resume credentials/approvals/effects automatically |
| Scoped historical run/action/conversation records | Proposed omission from the first canonical-workspace backup, clearly reported | An optional later scoped history export must preserve origin and privacy without granting resumable authority |

The operational-history and app-private recovery-version omissions are proposed
owner-visible tradeoffs, not approved silent losses. A complete canonical-workspace
backup therefore does not include every operational or recovery-history category. The app must say which history will not move. Secrets stay
in their selected OS store; restored connectors require deliberate rebind. The
existing Git ignore policy excludes `.cerebro/`, so a Git checkout alone does not
establish a complete canonical-ledger backup.

## Remaining gates

1. Independent review of this actual consumer inventory and the retained 5k
   report: passed after the recorded documentation repairs. The owner has now
   selected the SQLite/external-edit/portability contract above.
2. Quiet-machine repeats and an explicit latency/memory target. Do not ship the
   prototypes' whole-metadata materialization as a proven scale improvement.
3. Implement each consumer adapter/refusal, supported-client format guard and
   stale inventory cutover rejection. Retain the original vault and register a
   new root only after deliberate migration.
4. Complete journal, backup, restore, rollback and export acceptance from
   M99.6–M99.8, including real governed knowledge and required non-Markdown parts.
5. Packaged native backup/cutover/reopen/rollback and the shared full release gate
   before exposing migration. No real vault has been converted by this work.

A native Rust UI and WASM query extraction remain separately bounded experiments.
Neither is selected by this storage packet; adding Rust source alone is not an
acceptance result.
