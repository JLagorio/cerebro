# Rust ownership and a workspace without YAML

This is a decision study against Cerebro's working tree inspected on 2026-10-22,
including ongoing M91 changes. It proposes architecture; it changes no application
code and does not claim native, migration, or performance verification. Existing
files-first, CLI, and knowledge contracts are the starting point. The owner's
request authorizes reconsidering them, rather than treating them as vetoes.

**Recommended direction:** invest in Rust-owned domain and execution services while
retaining React for the interface. For the larger product direction, prefer a
deliberate hybrid: SQLite owns structured workspace metadata; Markdown files own
page bodies; Rust owns the boundary between them. Prove that choice on a migrated
copy before committing to it. If independent file portability remains the higher
priority, choose JSON sidecars instead. Do not combine a UI rewrite, a storage
migration, and an expanded action runtime in one release.

The immediate AI work does not require removing YAML. Durable threads, connector
credentials, workflow execution, and action receipts can become Rust services while
existing pages retain their current format. Storage changes should earn their
place through better transactions, identity, querying, and recovery—not the
appearance of a different serialization syntax.

## What the current source actually owns

| Area                    | Existing evidence                                                                                                                                                           | Consequence for a migration                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Page representation     | [Rust parsing][parse] separates frontmatter and body; [entry scanning][entry] derives properties, relationships, and titles                                                 | YAML is a domain input, not an editor decoration                                                                     |
| Typed records           | [Schema interpretation][schema] includes fields, layouts, calculated values, and relation ownership                                                                         | Replacing the parser leaves many consumers and compatibility rules                                                   |
| Agent configuration     | [Library drafts][draft] are forms over metadata, including deliberate grant commits                                                                                         | The UI already hides much YAML; removing it must preserve atomic grant changes                                       |
| Writes                  | [Writers][write] lock paths, serialize metadata, compare versions where required, and accept [guard-minted receipts][receipt]                                               | New persistence must preserve authorization and concurrency semantics                                                |
| Knowledge               | [Knowledge guards][knowledge] constrain verification; [the ledger index][index] is a disposable projection                                                                  | A metadata migration cannot manufacture new human verification or rewrite past evidence                              |
| Operations              | [runtime.db][runtime] owns scheduler, run, pending-write/governance, budget, recovery, and other operational records; the CLI interaction approval book remains memory-only | This database is explicitly **not reconstructible** from ledger segments; durable interactive approvals are new work |
| Native/browser boundary | [IPC facade][ipc] selects Rust commands or the browser mock; [engine configuration][engine-config] keeps the TS domain layer free of DOM APIs                               | There is a useful migration seam, but browser parity must be retained                                                |
| Editing                 | [NoteBodyEditor][editor] retains selection, drafts, undo, external-write reconciliation, and title integration                                                              | Replacing React means rebuilding substantial behavior, not merely translating views                                  |
| Embedded sheets         | [Rust sheet fences][sheet-rs] and [TS sheet fences][sheet-ts] parse a YAML header before CSV                                                                                | Removing page frontmatter alone does not remove YAML from the application                                            |

The parser caps frontmatter at 64 KiB. It also documents normalization of BOM,
CRLF fences, and closing-fence whitespace. Metadata patches preserve unknown keys
semantically, but reserialization drops comments and original scalar quoting;
`null` in the patch API **deletes a key**. These are existing contracts to inventory
before promising either lossless conversion or a richer typed model. [Parsing][parse]
and [patch implementation][write] establish these distinctions.

Identity also needs work independently of syntax. [Behavior identity][identity]
uses an optional slug for Agents and Skills, falling back to path. [Runtime scope][scope]
distinguishes portable ledger `store_uuid` from a local `vault_id` derived from
canonical path; moving a folder changes the latter. A new record ID must not
silently replace either meaning in historical rows.

## What the references demonstrate

AppFlowy is a useful precedent for a substantial Rust service layer. Its
[workspace][af-cargo] separates documents, databases, AI, storage, collaboration,
and FFI; its [application manifest][af-flutter] is Flutter/Dart. It therefore
supports separating domain ownership from UI language. It does not demonstrate
that “fully Rust” requires a Rust interface. Several collaboration implementations
are external pinned dependencies, so the local snapshot alone cannot establish
their complete persistence or conflict guarantees. The [AppFlowy review](appflowy.md)
covers this limit and the Rust chat persistence opportunity.

Plane's [Page][plane-page] and [Issue][plane-issue] models show another deliberate
tradeoff: structured columns, explicit relationships, JSON/HTML document content,
binary document fields, and versions. Those are database-oriented records, not
Markdown files with a new header. Adopt its explicit identity and relationship
model where useful without importing project-management type names into Cerebro's
capability-based records. Neither reference makes a generic database migration
equivalent to preserving Cerebro's existing file behavior.

## Decision one: how far Rust should own the application

| Direction                                         | Benefit for this request                                                     | Principal cost                                                           | Recommendation                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| Rust owns new AI/workflow services; React remains | One place for execution, permissions, durable state, and connector lifecycle | Typed DTOs and stream/backpressure discipline                            | Start here                                   |
| Rust gradually owns existing domain semantics     | Fewer TS/Rust semantic twins; native and headless behavior agree             | Browser test infrastructure and migration of existing callers            | Move by bounded domain after new services    |
| Pure Rust core also compiled to WASM              | Browser previews can replay the same parsing/query rules                     | Build tooling, payload costs, and target-compatible dependencies         | Optional proof, not prerequisite             |
| Rust-authored web UI                              | More source written in Rust, still browser rendering                         | Rebuilding React components and JS editor integration                    | No demonstrated return for current goals     |
| Native Rust UI replacing the webview              | Potentially different platform integration and rendering model               | Editor, IME, accessibility, layout, charts, sheets, and test replacement | Research only until a focused prototype wins |

Tauri's own documented architecture supports web frontends with Rust backend
logic and command/event IPC. Keeping React is consistent with a Rust-centered
application. It is not a temporary architectural failure. [Tauri overview](https://v2.tauri.app/start/),
[IPC model](https://tauri.app/concept/inter-process-communication/).

Do not move caret position, drag previews, open menus, or each keystroke over IPC.
Keep local editor transactions and presentation state in the renderer. Send
versioned commands at meaningful boundaries: commit field, save body, preview
action, start run, approve action, or query a page of results. Rust should return
typed outcomes and ordered deltas, with cancellation and explicit unavailable
states. A validation result in React is explanatory; Rust remains the enforcement
point.

Rust cannot by itself fix a slow DOM table or eliminate poor subscription
boundaries. Benchmark query time, IPC serialization, React commits, layout, and
paint separately before attributing a performance improvement to language. A
native-UI experiment should reproduce the actual rich editor, large table,
multi-pane navigation, keyboard flow, screen-reader behavior, and streaming chat;
a fast list demo is insufficient evidence.

WASM should start with one pure unit, such as metadata parsing plus query cases.
It cannot make the existing Tauri crate browser-compatible automatically: that
crate includes filesystem, process, SQLite, and platform services. Extract a pure
library with injected clocks and data, then decide whether its browser build
actually removes enough duplicated logic to justify another delivery target.
Keep browser fault injection and end-to-end tests; replacing the mock with a
different unverified runtime would discard useful coverage.

## Proposed Rust boundaries

Begin as explicit modules and service interfaces. Split crates when dependencies,
build time, testing, or reuse justify it; AppFlowy's number of crates is not a
target.

| Proposed boundary      | Owns                                                                                      | Must not own                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `workspace-domain`     | Record IDs, typed values, schema rules, relations, query plans, version checks            | Tauri handles, networking, UI state                             |
| `workspace-store`      | Selected metadata backend, file/body adapter, mutation journal, snapshot/export           | Model prompts or approval decisions                             |
| `knowledge-domain`     | Existing ledger semantics, evidence lineage, guarded projections                          | Operational execution history masquerading as beliefs           |
| `action-runtime`       | Versioned action contracts, executions, waits, attempts, approval bindings, idempotency   | Provider-specific UI or unrestricted credential access          |
| `connector-runtime`    | Accounts, secret references, MCP/native adapters, discovery, health, connection lifecycle | Authority derived from connector-supplied tool descriptions     |
| `agent-runtime`        | CLI/backend adapters, delegation, normalized events, cancellation, resource budgets       | Independent child privileges inferred from a child label        |
| `conversation-service` | Thread identity, branches, turn references, context receipts, retained artifacts          | Implicit promise to preserve an expiring CLI transcript forever |
| `desktop-adapter`      | Tauri IPC, native dialogs, lifecycle, notification integration                            | A second implementation of domain rules                         |

Generate or mechanically validate DTOs and errors from a Rust contract, then
keep compatibility tests for serialized payloads. Generation does not replace
semantic fixtures. Preserve shared policy artifacts as data: moving enforcement
to Rust does not justify duplicating the same rule in generated UI code.

The first extraction should follow a useful vertical slice: discover an approved
connector, preview one action, obtain its required approval, execute, persist its
result, and render that result in the existing chat. A crate reorganization without
an improved user journey should not consume the initial investment.

## Decision two: what “no YAML” means

These options change different things. The following ratings are qualitative
design judgments, not measured benchmarks.

| Storage choice                                 | Independent files/Git                                          | Structured transactions                               | Migration burden | Judgment                                                   |
| ---------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------- | ---------------- | ---------------------------------------------------------- |
| Keep YAML, improve forms                       | Strong current compatibility                                   | Existing file/batch limits                            | Low              | Good bridge, does not fulfill literal removal              |
| JSON or TOML frontmatter                       | Still one self-contained document                              | Essentially unchanged                                 | Medium           | Syntax preference, limited architectural payoff            |
| Markdown plus canonical JSON sidecars          | Portable when pairs travel together                            | Requires multi-file journaling                        | Medium/high      | Best files-first alternative                               |
| Canonical SQLite metadata plus Markdown bodies | Bodies remain portable; complete workspace needs export/backup | Strong for metadata; files still require coordination | High             | Preferred for sustained automation investment              |
| Database/CRDT documents, Markdown export       | Exportable rather than files-first                             | Depends on selected document/transaction model        | Very high        | Reconsider only for rich-document/collaboration priorities |

**Forms only.** Useful immediately: users should not need to edit grants, schemas,
connector definitions, or workflow actions as syntax. Existing forms already cover
part of this. However, hiding YAML does not retire the parser or change its failure
modes.

**Syntax replacement.** JSON makes values explicit but removes comments; TOML
offers a different human-editing style. Neither creates stable identities or
multi-record transactions. TOML 1.0's enumerated value types do not include null,
so mapping existing explicit-null values requires a convention rather than a
literal substitution. [TOML specification](https://github.com/toml-lang/toml.io/blob/main/specs/en/v1.0.0.md).
Do not choose syntax before defining the value model.

**Sidecars.** Prefer a stable-ID filename such as `.cerebro/records/<id>.json`,
with body path as a field, over `page.md.json` whose identity changes on rename.
That design needs portable identity discovery, orphan detection, collision rules,
and a copy/export command that includes both parts. A user copying only the body
creates a plain page; it cannot retain hidden grants or relations by inference.
The database remains a rebuildable read model in this option. This is a credible
choice if manual Git merges and independent folder ownership outweigh structured
application transactions.

**Hybrid recommendation.** Put records, typed properties, relations, schema
definitions, view definitions, Agent configuration versions, and workflow
definitions in a dedicated workspace database. Keep ordinary page bodies and
attachments on disk. Keep secrets in a separately designed credential store;
metadata contains references. Preserve the epistemic ledger as its existing
authority, with concept displays projected through its guards. Keep operational
history distinct even if services share storage infrastructure.

This changes the product promise: copying the Markdown folder no longer copies
the whole workspace. Export can produce useful Markdown plus JSON and restore a
workspace; that is **not identical to files being the complete source of truth**.
The UI, product brief, backup story, Git integration, and CLI guidance must state
the change. The owner can choose that tradeoff explicitly; it must not arrive as
an incidental implementation detail.

**Database/CRDT documents.** This can remove restrictions imposed by Markdown
carriers and enable a different collaboration model. It also changes the editor's
source representation, loss reports, imports, external editing, and verification
anchors. Do not take it merely to avoid a YAML header. Keep it as a separately
funded product decision after observing real needs beyond Markdown's carriers.

## Preserve values and identities before changing authority

Define a versioned value algebra with distinct absent, explicit null, string,
boolean, number, array, object, date-only, instant, and relation forms where the
schema requires them. Numeric range and precision need explicit limits. Do not
convert the string `007` into a number, a date-looking string into an instant,
or an unrecognized mapping into a blank field.

The legacy reader must report duplicate keys, YAML tags, anchors/aliases,
non-string keys, nonfinite numbers, and unresolved relationships. [Current YAML
conversion][parse] unwraps tags and stringifies non-string keys; that is not a
sufficient lossless migration codec. Retain original bytes in the migration
archive and produce a per-record loss/ambiguity report. Unsupported values block
automatic conversion of that record, rather than being silently discarded.
Separate “set null” from “remove property” in the new command API while keeping a
compatibility adapter for today's null-means-delete patch behavior.

Assign stable IDs once in a committed migration manifest. Record old path,
historical path aliases, existing slug, type identity, import source identity,
and old content hash. Resolve links using today's order before converting them;
preserve ambiguous and unresolved text for review. References should hold both
resolved target ID and original spelling/fragment where applicable. Do not
reinterpret a previously unresolved name as a newly granted Agent relation.

Preserve the portable store UUID and record a deliberate mapping from existing
local vault registrations. A copied folder must explicitly attach to an existing
workspace or become a clone with new identity; matching content is not proof that
two folders represent the same authority. Renames keep record IDs. Deletions make
tombstones. Re-created paths must not inherit deleted approvals or credentials.

Keep title authority explicit: ordinary page titles derive from the first
top-level H1 through the existing editor projection; a database display-title
cache is derived, not a second writer. Filename fallback remains non-writing
until adoption. Concepts retain their guarded title contract. Moving metadata
must not silently unify those different semantics or remount the body editor.

Import provenance, source classifications, knowledge revisions, and verification
history survive without re-keying established evidence. An existing verification
must continue to name the version the person reviewed. If changing serialization
alters a byte-based identifier, retain the old identity and record a migration
mapping; do not issue a fresh human verification. Historical ledger segments remain
immutable: identity aliases and migration evidence are append-only records in the
appropriate record, never edits to old events. An uncertain conversion remains
unverified and visible.

## A migration with one authority at every phase

1. **Inventory and contracts.** Produce a read-only report over a copied real
   vault: schemas, unknown metadata, grants, imports, links, sheet fences, path
   collisions, and unsupported bytes. Specify what a complete backup includes.
   Current YAML/files, ledger, and runtime records remain authoritative.
2. **Rust service seam.** Move selected domain operations behind typed commands
   while using existing writers. Add chat/action persistence independently. The
   legacy format still owns record metadata; any new index is derived and may
   not accept domain writes.
3. **Shadow conversion.** Build the candidate workspace database and ID mapping
   from an immutable snapshot. Compare projected records, query results, grants,
   knowledge source classification, and links. Exercise export/reimport. The
   candidate remains read-only and cannot dispatch agents.
4. **Exclusive cutover.** Prefer activating a migrated copy under a new workspace
   registration while preserving the original. Settle open drafts, pause schedules and clients, stop
   active children, and acquire a workspace-wide migration lock. Verify the
   snapshot hashes again. Journal original bytes and identities, stage stripped
   bodies and the database, validate both, then commit a versioned workspace-mode
   marker. Recovery must either finish or restore the documented commit point;
   no reader may guess authority from whichever artifact exists first.
5. **New-mode operation.** The database is the sole metadata writer. Markdown is
   the sole body writer through the body service; external body edits enter as
   explicit observed changes. Old frontmatter is import input only, never a second
   live metadata source. Compatibility exports are labeled projections and do
   not feed themselves back into the active scanner.
6. **Legacy retirement.** Keep the old-format importer and original migration
   archive for a declared period. Remove YAML from active page writes only after
   all active writers and guards use the new mode. Sheet format migration is a
   separate versioned operation with shared Rust/browser cases; legacy sheet
   readers may retain YAML until supported content has been converted.

An application migration lock cannot stop arbitrary external editors or an
unrestricted CLI process. A final hash check alone does not close the race before
replacement. For in-place conversion, require a proven exclusive writer boundary
or abort/preserve both versions on detected drift; do not advertise atomic
exclusion that the platform does not enforce. The default migrated-copy route
avoids overwriting subsequent edits to the original. Detect those edits and offer
an explicit reconciliation/import; never scan both folders as live metadata
authorities for the same workspace.

Body files and SQL cannot be made one transaction merely by calling both from
Rust. Extend the existing [batch journal][journal] pattern deliberately: durable
operation ID, expected metadata/body versions, staged body, original bytes,
database intent, completion marker, and idempotent recovery. Choose and test the
commit point for each operation. If disk has changed unexpectedly during recovery,
preserve both versions and surface a conflict instead of overwriting blindly.
Do not call a failed database commit a successful save because the file rename
completed.

During the first cutover preview, rollback is exact restoration of the recorded
snapshot while writers remain paused. After new-mode edits, rollback becomes an
**export/migration to an older representation**, with explicit unsupported-value
handling; restoring the old snapshot would discard new work. Reverse conversion
must preserve IDs, source classifications, revisions, body changes, and action
receipts where the target format can represent them. It must not replay actions.

## External editors, Git, agents, and recovery

External Markdown editing remains supported for bodies in the hybrid. Unknown
files become plain pages or explicit import candidates. A unique observed rename
can preserve identity; a delete/create pair or identical duplicate is ambiguous
and requires reconciliation. Filesystem metadata or equal hashes alone do not
justify transferring grants. If a user inserts YAML into a migrated body, do not
silently reactivate metadata parsing; offer an explicit import preview.

Git continues to version body files, but a body-only commit is not a complete
workspace checkpoint. Provide a deterministic metadata export or a first-class
workspace snapshot for review and restore. A Git checkout must trigger reconciliation
of body versions and metadata references. Conflicting exports require an import
plan, not automatic last-writer wins. Remote sync needs its own operation/snapshot
protocol; never point a generic folder-sync client at an open authoritative WAL
database and call that synchronization.

Store canonical databases in app-managed storage with a clear workspace locator,
not inside a casually synced Markdown folder. Use SQLite's supported snapshot
mechanisms for live backups; its online backup API and `VACUUM INTO` are documented
options. A complete application snapshot must coordinate the database with body
versions, ledger segments, attachments, and relevant operational state.
[SQLite backup documentation](https://www.sqlite.org/backup.html).

Portable exports must not include plaintext connector secrets or personal tokens.
Credentials need a separately protected backup or reconnection flow. Restored
workflows start paused; old pending approvals, leases, and scheduled actions do
not become fresh authority or automatically execute again. Preserve their history
and require explicit recovery according to each execution's recorded outcome.

The most consequential boundary is raw agent file access. [CliWrites][cli-writes]
explicitly states that Claude Code Write/Edit bypass Cerebro's writer doors;
M91 observes child writes for the run's changeset but does not turn observation
into authorization or a receipt. Database metadata reduces what a raw Markdown
write can alter, but it does not protect the database from an unrestricted process
running as the same user.

For managed autonomous actions, require scoped tools and a proven process/file
boundary that prevents direct modification of canonical storage. CLI settings
that disable selected tools are useful controls, not proof of an OS sandbox.
Offer a separately described power-user mode if broad shell/filesystem access is
retained; it cannot promise that every mutation passed the guarded service.
Human external edits remain a supported trust boundary, not an agent identity.
Knowledge Verify must still require the human-only guard over the exact reviewed
version. A model emitting `verified: true`, SQL, or an exported JSON record is not
that human decision.

## Investment and decision gates

These are planning ranges, not measured delivery commitments. A **team-week** means
one focused week for two experienced engineers with part-time product/design/QA
support. Packages overlap; do not add them mechanically. Unknown data diversity,
platform acceptance, and recovery requirements can expand the estimates.

| Investment                                   | Initial range     | Evidence required before expanding                                           |
| -------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| Domain/storage inventory and migration spike | 2–3 team-weeks    | Real-vault conversion report; no unexplained semantic drift                  |
| Rust action/conversation service boundaries  | 3–6 team-weeks    | One complete action journey; durable history; restart behavior               |
| Selective Rust domain consolidation          | 4–8 team-weeks    | Existing golden cases replay; browser/native contract parity                 |
| JSON sidecar migration alternative           | 4–8 team-weeks    | Rename/copy/crash/Git merge/export recovery demonstrated                     |
| Hybrid metadata store and migration          | 8–14 team-weeks   | Consistent backups, reversible cutover, identity and permission preservation |
| Full existing-domain migration               | 10–18+ team-weeks | Measured reduction in duplicated semantics without interaction regressions   |
| Full Rust UI replacement                     | 20–40+ team-weeks | Representative editor/accessibility/native prototype proves a material win   |
| Canonical rich-document/CRDT transition      | 14–28+ team-weeks | A funded collaboration/rich-document requirement plus import/export fidelity |

The first decision is whether a complete portable folder or transactional
application metadata matters more for the next product stage. Both are coherent;
neither is free. The preferred investment for the stated AI priorities is Rust
services plus the hybrid prototype, with the existing React interface retained.
The prototype should be rejected if it cannot preserve grant authority, knowledge
history, restart safety, and understandable export/restore behavior. YAML removal
is the result of a sound authority decision, not its substitute.

[parse]: ../../../../src-tauri/src/vault/parse.rs
[entry]: ../../../../src-tauri/src/vault/entry.rs
[schema]: ../../../../src/engine/schema.ts
[draft]: ../../../../src/engine/libraryDraft.ts
[write]: ../../../../src-tauri/src/vault/write.rs
[receipt]: ../../../../src-tauri/src/vault/receipt.rs
[knowledge]: ../../../../src-tauri/src/knowledge.rs
[index]: ../../../../src-tauri/src/ledger/index.rs
[runtime]: ../../../../src-tauri/src/runtime/mod.rs
[ipc]: ../../../../src/lib/ipc.ts
[engine-config]: ../../../../tsconfig.engine.json
[editor]: ../../../../src/editor/NoteBodyEditor.tsx
[sheet-rs]: ../../../../src-tauri/src/sheet/fence.rs
[sheet-ts]: ../../../../src/engine/sheet/fence.ts
[identity]: ../../../../src/engine/identity.ts
[scope]: ../../../../src-tauri/src/runtime/scope.rs
[af-cargo]: ../../../examples/AppFlowy-main/frontend/rust-lib/Cargo.toml
[af-flutter]: ../../../examples/AppFlowy-main/frontend/appflowy_flutter/pubspec.yaml
[plane-page]: ../../../examples/plane-preview/apps/api/plane/db/models/page.py
[plane-issue]: ../../../examples/plane-preview/apps/api/plane/db/models/issue.py
[journal]: ../../../../src-tauri/src/runtime/batch_journal.rs
[cli-writes]: ../../../../src-tauri/src/agent/cli_writes.rs
