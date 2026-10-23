# M99 — Rust services and storage design

**Milestone:** M99 · **Phases:** M99.1–M99.8 · **Requirements:** CORE-01–CORE-12.

[Master roadmap](../plans/2026-10-23-m93-m99-master-roadmap.md) · [Research and traceability](2026-10-23-m93-m99-research/README.md).

**Draft for owner review · 2026-10-23 · M99 / CORE.** This specifies the Rust and
YAML direction from AX01, AX09 and AX10. Recommendations are proposed decisions,
not permission to migrate a vault. Read the [implementation plan](../plans/2026-10-23-m99-rust-services-and-storage.md)
and [original alternatives study](../plans/2026-10-22-ai-expansion-review/rust-and-storage.md).

## Intent and constraints

Make durable workspace decisions, queries and execution available through Rust
services, while keeping the rich React editor and immediate presentation state.
Give the owner a measured choice about metadata authority. A different serializer
alone does not improve transactions, identity or automation.

Current authority remains Markdown/YAML plus the guarded knowledge ledger until
an explicit cutover. [parse.rs](../../../src-tauri/src/vault/parse.rs) bounds
frontmatter at 64 KiB and normalizes some fence/BOM details; it is not a lossless
migration parser. [runtime.db](../../../src-tauri/src/runtime/mod.rs) is app-global,
outside the vault and not reconstructible. It must not become the workspace's
metadata database by accident. [Scope](../../../src-tauri/src/runtime/scope.rs)
distinguishes portable `store_uuid` from path-derived `vault_id`; moving a vault
does not authorize rewriting historical identities.

Keep CV04 shared policy, CV07 knowledge guards, CV18 four IPC adapters, CV21 one
writer, CV23 concurrency, CV24 editor carriers and CV64 presentation boundaries.
No API key enters the existing CLI path. Rust does not create an OS security
boundary against another same-user process. No cutover may rely on that claim.

## Approaches and recommendation

| Approach                                   | Benefit                                             | Cost / decision                                                                      |
| ------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Current files with improved forms          | Immediate usability; current Git/external editing   | Keeps YAML and file transaction limits; retained bridge                              |
| Markdown plus stable-ID JSON sidecars      | Portable structured metadata with readable merges   | Multi-file journaling, missing pairs and identity reconciliation                     |
| SQLite-owned metadata plus Markdown bodies | Transactional typed metadata, relations and queries | Whole workspace is no longer the Markdown folder; coordinated backup/export required |
| Database/CRDT bodies or Rust-native UI     | Different collaboration/rendering possibilities     | Separate editor and product rewrite; deferred experiment                             |

**Recommended proposal:** Rust services now; compare sidecars and SQLite on the
same disposable corpus; prefer SQLite if the owner accepts export/backup-based
portability. Retain React. A pure Rust/WASM semantic pilot is optional and must
justify its extra build target. No production format choice is presumed approved.

## Requirements and ownership

- **CORE-01:** Meaningful commands, not keystrokes, cross IPC. Rust owns admission,
  durable mutations and queries. React owns caret, drafts, menus, drag previews
  and optimistic presentation whose acknowledgement is explicit.
- **CORE-02:** New DTOs have one Rust declaration and a mechanically checked TS
  projection. Existing adapters remain the only Tauri callers. Shared semantic
  cases remain necessary even when wire types are generated.
- **CORE-03:** Service extraction follows useful consumers. Start inside the
  existing crate; split crates only after a dependency/build/reuse reason exists.
- **CORE-04:** A tagged value model preserves absent versus null, strings,
  finite decimal values, booleans, arrays, string-keyed maps, schema-declared dates
  and relations. Unknown values cannot disappear silently.
- **CORE-05:** Assign stable workspace/record IDs once in a committed conversion
  manifest. Preserve old paths, slugs, aliases, content hashes, import identities
  and historical ledger/runtime identities.
- **CORE-06:** Both prototype stores implement the same query/mutation contract
  and replay the same corpus. Neither writes to the real vault.
- **CORE-07:** A migration dry run reports every converted, blocked, ambiguous,
  unchanged and unsupported record, plus byte/semantic losses. Originals remain
  byte-identical in an archive with checksums.
- **CORE-08:** A production cutover is explicitly selected and resumable. Supported
  clients reject unsupported formats; legacy clients without a format guard are
  not claimed safe. The new service never exposes mixed-authority state.
- **CORE-09:** Backup, import/export, external-edit reconciliation and post-cutover
  rollback are product features, with tested failure paths before migration ships.
- **CORE-10:** Removing page YAML and removing sheet-fence YAML are separate
  codec changes. Old formats remain importable; the app cannot claim “no YAML”
  while newly authored supported carriers still require it.
- **CORE-11:** Canonical state, disposable caches and operational history remain
  separately named and backed up. Knowledge verification never follows from a
  metadata conversion, search match or schema inference.
- **CORE-12:** A fully Rust UI is outside this implementation path. Any later
  experiment compares the real editor, IME, VoiceOver, tables, panes and chat,
  rather than using a fast list as evidence of full product parity.

The connected-action service owns its catalog and invocation contract in
[M96](2026-10-23-m96-connectors-mcp-and-actions-design.md). Conversation ownership is
[M95](2026-10-23-m95-chat-and-supervised-agents-design.md). CORE provides typed boundaries and
workspace authority; it does not define a second action ledger or thread store.

## Proposed contract

The names below are new proposed interfaces, not existing APIs:

```text
WorkspaceRef { workspaceId: string, vaultId: string, formatVersion: u32 }
RecordRef { workspaceId: string, recordId: string }
RecordVersion { metadataRevision: u64, bodyHash: string }
PropertyChange = Set { key: string, value: PropertyValue } | Remove { key: string }
WorkspaceMutation { target: RecordRef, expected: RecordVersion, changes: PropertyChange[] }
MutationOutcome = Applied { version, receiptId } | Rejected { code, expected, actual }
WorkspaceStore::read_record(scope, RecordRef) -> Result<RecordSnapshot, StoreError>
WorkspaceStore::apply(scope, WorkspaceMutation) -> Result<MutationOutcome, StoreError>
WorkspaceStore::query(scope, QueryRequest) -> Result<QueryPage, StoreError>
```

`scope` is an authenticated Rust capability context, never a client claim of
permission. A store cannot mint a guard receipt. The command service checks the
current record/type/knowledge boundary before calling the store. Body saving
retains the current human editor last-write-wins rule; `expected` above applies
to metadata/non-editor commands. An explicit body-save API consumes the existing
editor acknowledgement contract from M93; no second body writer is introduced.

The pseudocode omits an internal authorization parameter: mutation application
must receive a guard-minted receipt or authorized plan from that command service,
following the existing typed `WriteReceipt<D>` writer boundary. It is never a
deserializable client field, and a store cannot manufacture the `receiptId` it
returns. Checks and the actual selected-authority mutation share the required
lock/transaction; a prior UI read is not authorization.

`PropertyValue` is a tagged union: `null`, `string`, `boolean`, `decimal`, `array`,
`object`, `date`, `instant`, `relation`. Decimal retains a finite JSON-number
lexeme as text, avoiding JS safe-integer loss; reject nonfinite values. Strings
such as `007` stay strings. Date/instant conversion requires a schema declaration.
Relations retain target ID when resolved, original spelling and optional fragment;
unresolved/ambiguous links retain text and a resolution status. An absent key is
not a value. The legacy patch adapter preserves its null-means-remove behavior
until all callers explicitly migrate to `Set(null)` versus `Remove`.

`QueryRequest` uses existing shared view vocabulary, a declared scope, filter,
sort and opaque cursor. The pilot supports a fixed page size of 100; return a
cursor tied to query/snapshot identity and reject reuse under a different query.
Do not move schema interpretation into arbitrary SQL generated by the renderer.
Queries are bounded by readable scope before ranking/filtering/pagination.

### Proposed storage placement

SQLite variant: a dedicated `<app-data>/workspaces/<workspaceId>/workspace.db`;
Markdown bodies/attachments in the registered vault. JSON variant: canonical
`.cerebro/records/<recordId>.json` plus a portable workspace manifest; any database
is disposable. Never place a live WAL database in a cloud-synced vault. The
SQLite export format contains metadata, body hashes, identities and versioned
schema; copying only Markdown intentionally yields plain documents without grants
or hidden relations. State that limitation in the product brief, backup UI and
CLI guidance before a format switch.

A workspace clone gets a new workspace registration and ID mapping through an
explicit clone/import operation. A move retains portable workspace identity while
re-binding local path registration; previous runtime history keeps its original
vault ID. A copied manifest discovered at two live roots is a collision to resolve,
not permission to merge their mutable databases.

## Conversion and recovery

Inventory all YAML carriers: page/Type/Agent/Skill metadata, views, imported
provenance and sheet fences. Preserve the first-H1 title in the body; concepts
keep their guarded title source. A duplicate-key/tag/alias/non-string-key YAML
mapping needs an explicit codec/report disposition; the permissive production
reader cannot silently decide migration fidelity. Unsupported or ambiguous
records block automatic conversion. Preserve original bytes even for supported
semantic conversion; comments/quoting are archival information, not falsely
claimed to survive in typed metadata.

**First metadata conversion retains governed concept projection YAML in full.**
`ledger/project.rs` defines canonical YAML bytes and `ledger/reduce.rs` validates
historical attestations by hashing that projection. Concept metadata is not an
ordinary sidecar/SQLite conversion: retain its existing guarded codec, bytes,
ledger identities and materialization authority, and report this remaining YAML.
Never rewrite old attestations or silently re-verify a concept during conversion.
Removing this carrier requires a separately accepted versioned projection/ledger
design that can replay historical attestations with their original codec.
CLI-owned definition frontmatter is another compatibility carrier to identify
separately; “no YAML” must name the actual workspace formats covered.

Before activating a selected authority, record this reader/writer cutover matrix
with actual call sites and an implemented or typed-refused disposition:

| Consumer                                                   | Required selected-authority behavior                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Scan, schema, views, queries and search                    | Build metadata/relations from the selected store; body text remains file-owned; no fallback to conflicting frontmatter |
| Human field/title/body, batch, rename/delete and undo      | Preserve guard receipts, M93 acknowledgements and coordinated metadata/file changes; no accidental YAML reconstruction |
| Agent grants, admission, dispatch and MCP read/write tools | Read current canonical capabilities and metadata under the Rust scope; no byte-parsed legacy override                  |
| Knowledge read/guard/materialization/Verify                | Keep the retained governed projection/ledger authority; no second metadata writer or inferred verification             |
| Imports and writer-owned provenance                        | Preserve identity/stamp guards through the same selected-authority mutation                                            |
| Browser mocks, exports and external-edit handling          | Replay the same authority and refusal semantics; never make missing metadata into permission                           |

The format guard alone does not implement this matrix. Existing direct readers
include `vault/write.rs::frontmatter_json` and `knowledge.rs`'s YAML reads, beyond
`vault/scan.rs`. All supported consumers must use the selected authority or
explicitly refuse before cutover; the read pilot is not evidence of this adoption.

The prototype writes only to an explicitly created sibling copy outside the real
vault's registration. It compares read/write/query costs, file edits, rename,
copy, broken pairs, unknown fields, restored backups and conflicting imports.
Reports distinguish measured outcomes from design judgments.

Production phases are `inventoried → staged → validated → cutover_pending →
active`, with `blocked` and `rollback_required` outcomes. Pausing Cerebro writers
does not stop external editors: compare source hashes again before cutover and
abort changed inputs. Ship a format-aware compatibility release before enabling
migration and publish the tested minimum client version. Supported clients reject
newer formats before scan/write/dispatch. Already-released binaries cannot be
made to honor a new marker: they are unsupported after cutover, and their direct
file access cannot be prevented by this application-level gate.

First production migrations create a newly registered workspace root and retain
the old vault as an archival copy, removing its automatic registration only after
successful validation. This reduces accidental old-client reuse; it is not an OS
access boundary. External body changes remain ordinary file changes to reconcile.
Legacy frontmatter written into a converted body is reported as a format conflict,
never imported automatically as authoritative metadata or grants. If simultaneous
legacy-client use is required, production migration stays blocked until a separate
bidirectional compatibility design is accepted and tested.

For file-plus-SQL changes, a durable journal holds preimages, staged file hashes,
intended metadata changes and receipt identity. Publish the new workspace revision
only after file installation and metadata commit agree. Recovery validates actual
bytes and completes or restores the recorded operation; it does not infer success
from the presence of one file. Readers refuse affected records during incomplete
recovery. Test interruption at every durable boundary. SQLite transactionality
does not extend to file renames, remote services or hostile external writers.

Before-cutover rollback restores the original byte archive and untouched identity
map. After-cutover rollback creates a new legacy-compatible export including all
subsequent acknowledged edits, with blocked/loss reports for values legacy YAML
cannot express faithfully; it must never replace active data with the old snapshot.
Keep the active version until that export is verified. Migration archives have no
automatic deletion in the first release; deletion is explicit after a verified
backup and names what recovery will be lost.

Backup uses a consistent metadata snapshot, coordinated body manifest and hashes;
copying an open database file is not a backup. Restore into a new directory first,
validate every required part, then offer registration. Sync is export/import in
this scope; multi-device concurrent database sync and collaboration are deferred.
Secrets and machine credentials are excluded; restored actions require rebinding.

The versioned backup manifest names required, optional and excluded categories:
selected workspace metadata/schema/identity, body files, attachments, comment
sidecars, and the complete canonical `.cerebro/ledger` store/segments and required
compatibility state. Validate ledger chain/projection consistency as well as body
hashes; Git or Markdown-only export cannot substitute for guarded-history backup.
Disposable caches may be omitted explicitly. App-global, non-reconstructible
`runtime.db` is not silently copied into a workspace backup: the authority
decision must choose a separately scoped operational-history export/restore or
explicit omission with a visible limitation. Restore never merges other vaults'
history, rewrites historical local IDs or automatically resumes schedules,
approvals or effect attempts. Account/action rebinding remains explicit.

Treat restore input as untrusted: constrain paths to the new root, refuse
traversal/absolute paths and unsafe symlink or duplicate-name entries, and bound
entry counts, individual expansion and total materialized bytes before extraction.
Keep restored state inactive until every required part and format validates.
An armed-ledger verified-concept restore, missing/corrupt ledger part, missing
attachment/comment, and unavailable operational-history case are required
acceptance alongside missing bodies and bad hashes.

## Acceptance and decision gates

1. Existing browser/native cases remain unchanged under the legacy adapter.
2. Same corpus produces equivalent typed values/relations/query pages in both
   prototypes, with explicit reports for every unsupported construct.
3. Unicode paths, renamed Agents, moved vaults, duplicate IDs and unresolved links
   cannot cross scopes, silently re-key history or broaden grants.
4. Crash tests at each journal boundary return either the old acknowledged
   state or the new acknowledged state after recovery, never mixed authority.
5. Backup/restore and post-cutover rollback retain edits made after migration.
6. The owner accepts the chosen portability, external-edit and retention contract
   before production migration tasks start. A successful prototype is insufficient.

Prototype reports must include 1k/5k records, wide metadata, large Markdown bodies
and malformed/unknown cases; record hardware/build and component timing, not a
language-speed claim. The first decision is service ownership; storage selection
and any native-UI experiment are independent decisions. No migration, benchmark,
native UI or backup behavior was exercised while writing this draft.
