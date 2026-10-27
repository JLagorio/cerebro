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

**Owner selection (2026-10-23):** SQLite metadata plus visible Markdown bodies,
following the accepted disposable comparison and explicit portability/backup
conditions in the authority decision packet. Retain React. A pure Rust/WASM
semantic pilot remains optional and must justify its extra build target.
Selection authorizes implementation of the acceptance gates, not current-vault
conversion or activation.

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

### M99.1 legacy read bridge (execution amendment, 2026-10-23)

The current file format has no stable-record-ID or metadata-revision producer.
The first useful consumer therefore retains the existing human whole-source
read behind an explicitly legacy service:

```text
LegacyRecordLocator { path: string }
LegacyRecordSnapshot { content: string, hash: string }
legacy::read_record(vault_path, LegacyRecordLocator) -> Result<LegacyRecordSnapshot, StoreError>
StoreError { code, message: string, retryable: boolean }
```

`content` retains complete UTF-8 source, including BOM, CRLF and frontmatter;
`hash` is SHA-256 of those exact bytes from that single read. This is a source
snapshot, not a decoded property map: explicit null, absent fields, numeric
lexemes and unsupported YAML remain in the source without a claim of typed
metadata fidelity. Empty source is a real success; unreadable/refused source is
an error. No read creates an ID, manifest, revision, receipt or file.

The service delegates to the existing guarded Markdown reader. Its vault/path
arguments are selectors for the existing human read door, not an authenticated
agent capability and not a portable workspace identity. This bridge adds no MCP
read access and must not be reused as agent admission. The existing
`read_note_source` command keeps `{content,hash}` success and string failures;
the internal error envelope preserves the reader's message, uses the existing
operational `capability_unavailable` code and sets automatic `retryable` false
because the legacy reader does not supply a reliable typed failure cause.

Schemars 0.8.22 derives JSON Schema from the Rust declarations in tests only.
The same deterministic schema-to-TypeScript tool serves later M96 DTOs. Native
tests check declaration/schema drift and shared source/error fixtures; TS tests
check schema/generated-type drift and the browser mock. The exporter rejects
unsupported schema instead of widening types. Generated types describe wire
shape; they are not a runtime authorization or validation boundary.

### Stable-identity service (pending its producers)

The names below remain proposed interfaces until M99.3's committed identity
manifest and real metadata revisions exist. The legacy path is never substituted
for `recordId`, and a fabricated zero is never substituted for a revision:

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

### M99.2 bounded value contract (execution amendment, 2026-10-23)

`PropertyValue` is a tagged union: `null`, `string`, `boolean`, `decimal`, `array`,
`object`, `date`, `instant`, `relation`. `PropertyChange` explicitly separates
`Set { key, value }` from `Remove { key }`; an absent key is not a value. This
phase provides Rust-owned schema/generated TS transport and a `cfg(test)` native
prototype decoder/converter. It exposes no production mutation endpoint, store
application or new writer. `WorkspaceMutation`/`MutationOutcome` above remain
proposed until M99.3 and subsequent guarded consumers provide real identity,
metadata revisions and receipts. No DTO accepts a client-supplied receipt.

`shared/workspace/values.v1.json` pins JSON finite-decimal grammar, limits and
shared cases. Raw JSON is decoded through `serde_json::RawValue`, preserving
number lexemes before any `Number`, f64 or YAML conversion. Decimals retain exact
text, including exponent spelling, trailing zeros and negative zero. Finite here
means a JSON decimal token, not a number restricted to IEEE-754 range: `1e400`
remains valid text; NaN and Infinity refuse. A lexeme is at most 256 bytes. The
prototype bounds source bytes to 65,536, container nesting to 32 and decoded
nodes to 4,096 before materialization can grow unboundedly. Duplicate decoded
object keys and invalid Unicode strings refuse instead of losing data.

Plain strings such as `007` or `2024-02-29` remain strings. `ValueSchema::Date`
allows only a calendar day and `ValueSchema::Instant` only a zoned instant under
the existing `shared/calendar/dates.v1.json` grammar; both permit explicit null.
Schema selection is explicit and applies to the supplied root value, never an
inferred conversion of arbitrary nested strings. Unknown map keys and their
values remain tagged recursively. Relations retain original spelling, optional
fragment and unresolved/ambiguous/resolved status. A resolved relation carries
an already supplied nonempty target ID; this decoder does not resolve, mint or
authorize it, nor does it derive fragment meaning from spelling.

`prepare_legacy_patch` is a pure representability check. `Remove` maps to the
existing top-level JSON-null deletion marker. `Set(null)` refuses with
`capability_unavailable`, preserving the input; nested null remains a value.
Only canonical integer lexemes within ±9,007,199,254,740,991 convert numerically;
fractions, exponent spelling, negative zero, trailing decimal zeros and larger
integers refuse rather than round or normalize. Typed relations refuse because
the legacy map cannot carry their resolution contract. Duplicate/empty change
keys and invalid tagged values produce `schema_invalid`. Both codes retain their
existing operational destiny and do not promise automatic retry. Refusal does
not alter the requested values or touch a file.

This adapter certifies only proposed values. It cannot certify preservation of
unknown original YAML syntax or numeric precision already lost by a legacy
parser. M99.3's original-byte inventory is required before conversion. Existing
human/knowledge guards, null-means-remove callers and receipt paths stay intact.
Rust replays semantics; TS compiler tests replay transport shapes from the same
cases and generated types. No handwritten browser semantic twin is introduced.

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

### M99.3 inventory and identity prototype (execution amendment, 2026-10-23)

Inventory operates on an explicit bounded list of relative source paths under a
canonical root. The report carries requested-path coverage and `whole_vault:
false`; a successful subset is not a complete workspace discovery or a cutover
certificate. Contained anchored reads reject symlinks and unsafe paths. Each
successful row archives the complete original bytes and their SHA-256 together;
read failures retain an explicit blocked row with no invented bytes/hash.
Source/file/aggregate byte and file-count limits bound materialization. Original
source hashes must be checked again by any future stage/cutover consumer.

A direct development-only dependency on already-locked MIT `unsafe-libyaml
0.2.11` exposes syntax that Serde's semantic loader discards. An owning RAII
wrapper frees initialized events and parser on every success/error path, checks
scalar pointers/lengths before slices, and bounds YAML bytes, event count, nesting
and total decoded scalar bytes. It preserves duplicate decoded mapping keys,
scalar text and its plain/nonplain flag, plus unknown nested collections without
numeric conversion. Explicit tags, anchors/aliases, dialect/tag directives,
non-string keys, multiple documents and malformed
or over-limit YAML block automatic conversion. Complete original bytes remain
authoritative; parser offsets do not reconstruct files.

Governed concepts retain the existing OKF v0.2 projection codec with a source-code
digest and complete bytes. Any inventoried ledger store ID and projection
manifest remain separate evidence; inventory never opens a ledger writer,
verifies a belief, rekeys history or claims a complete ledger backup. CLI-owned
definitions and sheet YAML are retained compatibility carriers, not ordinary
metadata rewrites. Relations missing from the requested scope remain explicitly
unresolved; this is not a claim they are absent from the entire vault.
If the existing semantic reader cannot read relation/index metadata, that source
is blocked with `semantic_read_unavailable` and excluded from the target index.
Its original bytes, hash and exact syntax remain intact; an unavailable semantic
read is never evidence of an empty relationship set or readiness for identity.

Identity planning consumes only the inventory, an optional existing manifest
paired with a separate trusted workspace/root binding, explicit moves and known
workspace registrations. It refuses duplicate IDs/paths, mismatched bindings,
foreign-root workspace collisions and unexplained missing prior targets. Equal
bytes, a title or a filename never imply a shared ID. An explicit move supplies
the committed record ID, old/new paths and the inventoried destination hash.
A copied document needs its own new identity unless a valid explicit move was
provided; a copied workspace manifest is a collision to resolve.

Draft creation mints nothing. Consuming a non-cloneable draft through
`into_proposed_manifest` invokes an injected UUIDv4 mint only for missing IDs and
returns an in-memory proposal. It is not an atomic/durable manifest commit or a
production permission check. M99.4 must publish its disposable manifest atomically
before asserting restart persistence; committed manifest replay calls no mint.
No source files, identity manifests, registrations, metadata revisions, ledger
identities, receipts or runtime history are written in this phase.

### M99.4 disposable store contract (execution amendment, 2026-10-23)

The shared prototype `WorkspaceStore` is test/tool-only and does not implement
the proposed production receipt-bearing mutation API. Its `PrototypeScope` has
no deserializer and is bound to an explicitly created temporary owner, readable
and writable IDs and allowed create paths. A `PrototypeOutcome` contains actual
committed record/workspace/schema versions, never a fabricated receipt. The
prototype does not bypass or replace human/knowledge admission; it cannot open
an active registered vault as a mutable store.

Both implementations persist tagged values, stable IDs, schema revision and
record metadata revision. Ordinary Markdown stays at visible relative body paths;
governed and CLI compatibility bytes remain separate retained sources. Sidecar
metadata generations are internal, with a single atomic committed manifest.
SQLite uses a separate temporary metadata directory and actual transactions.
Neither representation treats hidden body blobs as the visible body authority.

An OS advisory file lock serializes the prototype's readers, writers, backup and
recovery. A bounded intent journal contains old/new affected metadata and body
pre/post bytes/hashes before visible-file installation. Metadata commits only
after visible bytes match; journal cleanup follows commit. Reopen checks metadata
and body state together and rolls back to old or completes new at the tested
intent/visible/metadata durable boundaries. Unexpected third-party bytes or a
missing required part refuse recovery instead of inventing success. This is a
temporary-filesystem experiment, not a complete production crash protocol.

Read/mutation/query detect changed or missing visible bodies. External body edits
are explicitly refused; no automatic hash adoption occurs. Copying only Markdown
does not recreate canonical metadata, relations or grants. Prototype backup
captures versioned identity/schema/metadata and matching visible bodies under the
lock; restore validates required parts and checksums into a fresh temporary root.
Full ledger/attachment/comment/history backup remains a separate later gate.

Queries reuse the existing shared schema and filter/sort evaluator over readable
records before ranking. Exact tagged values remain stored; predicates/sorts that
cannot project faithfully to the legacy evaluator return an explicit unsupported
result. Cursors bind query, allowed IDs, schema and persisted snapshot, with pages
of 100 and a stable-record-ID tie-break. Unsupported schemas, stale revisions and
scope mismatches fail without silently narrowing requests.

The actual Rust harness supplies report data; the Node wrapper is orchestration,
not another store implementation. Raw 1k/5k/adversarial timings retain toolchain,
hardware/build and concurrent-load context. Current samples cannot select a
storage winner or satisfy the quiet-machine performance gate.

The implemented report entry point is the explicitly invoked native
`comparison::tests::write_report` harness, launched by
`scripts/workspace-store-report.ts` with an already-built test executable. The
wrapper rejects stale compiled source hashes and unexplained differences. It
retains per-source dispositions, original checksums and requested-path coverage;
the fixture list does not imply a complete real-vault scan. Raw artifacts and
their snapshot limitations are retained in the
[comparison record](../plans/2026-10-23-m99-store-comparison/README.md).

The adapters currently materialize complete canonical metadata and SQLite
rewrites it in one transaction. Neither is an optimized indexed-query design.
Metadata decoding checks decoded duplicate object keys and bounded expansion
before materialization. SQLite bounds metadata payload and identity-column
projections into Rust; this does not claim to bound the SQLite engine's internal
disk reads for a malicious database. The durability claim is limited to the
explicitly tested interruption points, not every possible I/O or power failure.

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

The owner selected SQLite metadata with visible Markdown bodies on 2026-10-23.
The first M99.6 slice compiles a staging library for new inactive destinations;
it exposes no IPC migration/registration or current-vault conversion. Its source
inventory discovers the whole declared root and records an explicit disposition
for every file. Known private/operational exclusions retain names/reasons without
reading secret bytes; ordinary unknown hidden files, Trash, reconciliation backup,
ledger and CLI carriers are retained verbatim or explicitly refused. Bounds,
symlinks, special files and unreadable parts block completeness rather than being
silently skipped. Additions, deletions and moves invalidate inventory coverage.

An opaque Rust stage plan consumes explicitly supplied conversion proposals. It
uses the existing tagged value decoder and persists real IDs/revision 1 in the
separate selected SQLite database; it never fabricates a legacy revision or a
receipt. Identity uniqueness and required parts are checked. The complete source
archive, visible bodies, retained parts and metadata database are checksummed in
a bounded manifest. A preparing marker precedes body writes; the final marker is
`staged_inactive`, only after complete validation. Read-only restart validation
binds the manifest to separately supplied trusted source/body/metadata roots and
workspace identity. Neither the manifest nor a successful check authorizes
activation. Conflicting body YAML refuses validation and cannot replace metadata
or grants. The semantic conversion producer, governed-codec/ledger validation,
full consumer matrix, crash journal, backup rehearsal and minimum-client release
remain explicit activation gates. This bounded slice does not complete M99.6.

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
