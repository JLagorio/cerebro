# Workspace service contracts

M99.1 starts with the existing human whole-source read. This directory is not a
new workspace format or metadata authority. `legacy-source-cases.v1.json` is
replayed by the native service and browser adapter: exact UTF-8 source, same-read
whole-file hashes, valid empty files, and failures that never become empty data.
The ordinary note target rules remain owned by the existing reader and its
`src-tauri/fixtures/note-targets.json` cases.

`contracts.v1.json` is generated from Rust declarations in
`src-tauri/src/workspace_service/types.rs` using the already locked Schemars
0.8.22 as a dev dependency. It is not a second hand-maintained type declaration.
`src/lib/generated/workspace.ts` is its mechanically checked TypeScript
projection. Public `read_note_source`/`readNoteSource` keep their existing names,
argument keys, source/hash success and string failures. The internal error
envelope is not a newly exposed IPC endpoint.

The exporter in `scripts/contracts/` is shared infrastructure for later service
DTOs, including M96. Supported schema forms are closed objects, typed dictionaries, required and
optional fields, strings, booleans, null, nullable type arrays, string enums,
arrays, local references, and tagged/untagged unions. Unknown schema keywords,
untyped open objects, unresolved or
remote references and numeric formats fail generation. Add a tested projection
before adopting another construct. In particular, 64-bit counters and exact
decimals must not silently become JavaScript numbers. Types describe wire shape;
they do not replace Rust validation, shared semantic cases, or authorization.

## Regenerate

Use the repository's pinned Rust, Node and pnpm toolchains. From the repo root:

```sh
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib workspace_service::tests::export_workspace_contract_schema -- --ignored --exact
pnpm exec node --import tsx scripts/contracts/generate.ts
```

The native exporter is deliberately ignored in ordinary test runs. It writes
only the generated schema, never vault data. The TypeScript generator validates
the complete schema before replacing its output. Review the Rust declaration,
schema and generated TS changes together.

## Check

```sh
cargo test --offline --manifest-path src-tauri/Cargo.toml --lib workspace_service -- --test-threads=2
pnpm exec node --import tsx scripts/contracts/generate.ts --check
pnpm exec vitest run scripts/contracts scripts/workspace-contract.test.ts src/lib/ipcContract.test.ts --maxWorkers=2
```

Native tests fail if Rust declarations drift from the schema. Vitest and the
read-only `--check` command fail if the schema drifts from generated TS. Shared
fixtures exercise real read behavior independently of those shape checks.

The legacy format still has no stable-ID/revision producer for service reads.
The legacy locator remains a path selector; the whole-file hash is never renamed
to a body hash or replaced with a fabricated revision. No read writes a manifest,
and no new body writer is introduced.

## Value prototype (M99.2)

`values.v1.json` is the semantic artifact and case corpus for the native
`workspace_service/value.rs` decoder. M99.6 promotes the canonical tagged values
and bounded decoder for inactive selected-store staging. Legacy patch conversion
and the earlier disposable query/store experiments remain `cfg(test)`. The generated
contract is available to browser/tooling checks. This does not activate a workspace
or production mutation endpoint, migrate a current vault or introduce a second writer.

Raw JSON numbers enter as `RawValue` and remain exact decimal strings. The
artifact pins lexical/structural bounds and references the existing shared date
grammar. Plain strings never become dates implicitly. Tagged unknown maps and
unresolved/ambiguous relations retain their data. Relation IDs are carried only,
never minted, resolved or treated as authority by this module.

The pure legacy converter refuses `Set(null)`, noncanonical/unsafe numeric
conversion and typed relations. Only `Remove` becomes the existing top-level
null deletion marker; nested null remains supported. It makes no promise about
losslessly rewriting pre-existing YAML. Original-byte inventory, real stable
identities/revisions and guarded mutation application remain later phase gates.

Rust replays the semantic cases, including duplicate keys and decimals beyond
f64 range. `src/engine/workspaceValue.test.ts` compiles shared transport cases
against the generated union and checks invalid shapes. TypeScript implements no
value semantics here, so there is no new semantic twin to register. If later
browser code duplicates a Rust rule, register/replay that twin under CV-04 first.

```sh
pnpm exec vitest run scripts/contracts scripts/workspace-contract.test.ts src/engine/workspaceValue.test.ts src/lib/ipcContract.test.ts --maxWorkers=2
```

## Migration inventory prototype (M99.3)

`migration-cases.v1.json` supplies native inventory cases and bounded-reader
limits. The original `workspace_migration/{inventory,identity,syntax}` modules now compile
with the inactive M99.6 semantic producer and staging boundary. Inventory archives
complete bytes with their hashes and records requested-path coverage; inventory
itself does not discover a whole vault or perform semantic conversion. The producer
rechecks requested evidence and consumes a root-bound identity plan before making
an inactive stage. An identity plan is identity evidence, never semantic permission. A ready row means inventory/syntax inspection
succeeded within that scope, not that automatic conversion is authorized.

The event reader uses already-locked MIT `unsafe-libyaml 0.2.11` through a direct
normal dependency because Serde's loader discards anchor evidence and the inactive
semantic producer now compiles outside tests. Original bytes
are never reconstructed from parser events. Tags, anchors/aliases, duplicate
decoded keys, directives and non-string keys retain explicit issues. The wrapper bounds
source bytes, events, nesting and aggregate decoded scalar bytes, and owns both
parser and event cleanup. It does not expand aliases.

Identity drafts use a separately supplied trusted workspace/root binding and
explicit moves. They do not infer identity from names or equal content. Consuming
a draft may produce new UUIDs in an in-memory proposed manifest only. Persisting
that proposal, restart stability and any production authority are later gates.
Governed projection bytes/codec and ledger identity stay separate; inventory
performs no verification, receipt minting, registration or source write.

The cases include 19 original-source fixtures and five explicit malformed or
colliding manifest fixtures. Native tests also exercise trusted root bindings,
scope omissions, guarded byte reads and once-consumed identity proposals.

## Selected SQLite staging (M99.6, inactive boundary)

`staging.v1.json` is the Rust-owned format vocabulary and bounded staging limits.
It is not a permission artifact or a second value codec. The selected database
lives in a separate new metadata directory; body files retain their visible
relative paths in a separate new, inactive body root. The staging marker is
written before body installation; only a fully checked manifest can publish the
`staged_inactive` marker. No state in this artifact authorizes registration.

Discovery covers every file and directory in the declared source root, including
hidden entries, with explicit file dispositions. A limit, symlink, special file,
invalid path or unreadable required part refuses completeness rather than
truncating the inventory. Unknown hidden content, Trash, reconciliation backups,
ledger carriers and CLI definitions are retained byte for byte. The narrow
exclusion vocabulary covers known credentials and operational state. `.env` and
`.env.*` filenames are excluded at any depth; `.environment.md` is not. Exclusions
record paths and reasons, never content or content hashes. Mail paths use the
existing mail table: their private, separately admitted content is excluded from
this unadmitted staging boundary. This does not turn git exclusion into a general
migration authorization rule.

The exact connector configuration path and its abandoned atomic-write temporary
files are known credentials too. `excluded_filename_patterns` matches a nonempty
middle between a basename prefix and suffix in the exact declared parent directory,
using the same reserved-name fold. It does not exclude neighboring filenames or
the same basename elsewhere. These omissions have the same explicit reason and
never record content, size or hash.

Governed conversion admission calls `knowledge::is_knowledge_path`; its spelling
rules are not duplicated in the retained-prefix table. Reserved, retained and
private identities use the existing native filesystem-name fold after NFC,
including case and HFS-ignorable aliases. This comparison does not rewrite path
bytes or broaden ordinary `.md` conversion. A noncanonical spelling of the
staging control directory is refused as `reserved_directory_alias` before output,
because the canonical marker directory cannot silently rename a retained path.
Canonical `.cerebro` content remains retained, except the explicit exclusions and
reserved marker/manifest paths.

New output directories, including archives and partial stages, are created with
Unix mode `0700`. Files use `0600`; the SQLite file is reserved with create-new and
no-follow before opening without CREATE, so rollback journals inherit its private
mode. Existing caller parents are never chmodded. These Unix mode guarantees do
not claim a portable ACL policy or protection from another process of the same user.

Root file/directory membership and all retained/copied source bytes are checked
again before and after staging, and when validating an inactive stage. The same
bounded tagged-value decoder used in M99.2 supplies metadata; unknown typed values
remain canonical. The original-source archive remains byte-identical. The stage
checks supplied identity/proposal/required-part consistency, but does not create
a production YAML semantic converter, verify knowledge, mint receipts or infer
grants. Those gaps and the remaining activation gates are explicit blockers.

Historical M99.4 timing reports and source snapshots remain immutable. Validator
unit fixtures derive current source hashes for their temporary copied inputs;
that is a complete real-shaped test fixture, not new native measurement evidence.

## Portable inactive backup boundary (M99.8)

`export.v1.json` owns the directory-bundle vocabulary. The native library entry
points are `backup_workspace`, `validate_backup` and `restore_workspace`;
there is no IPC, registration, activation or current-vault conversion door.
Validation evidence is opaque and never grants selected-reader authority. Unix
bundle validation/restore uses held directory descriptors, no-follow component
access and create-new output. Live export additionally requires the reviewed
macOS descriptor-alias boundary; other platforms return an explicit unsupported
capability for live export.

Export acquires both existing ownership locks without creating or labeling them,
pins the selected database read-only, and uses SQLite's online backup API to a
new reserved file. A scoped nondefault VFS keeps the held macOS descriptor alias
through path resolution and delegates the actual main-file open and locks to
unix-posix. The connection holds a real shared read transaction; original-path
identity and actual journal/WAL/SHM absence are checked throughout. No default
VFS or shared syscall hook changes. The canonical schema/value reader, bounded
receipt row decoder and ledger chain decoder are reused without recovery,
migration, projection writes or receipt/ID minting. Persisted receipt shapes for
page.body and page.full_width are passively validated against current record
identities/counter bounds and their existing producer invariants; this does not
reconstruct missing historical images or prove cryptographic authenticity.
Source membership, identities, included hashes, metadata and lock ownership are
revalidated before publishing the complete bundle manifest. Known exclusions are
classified before content, length or hash reads in both current-body and installed
historical-original namespaces. Old staging manifests are excluded wholesale,
since they may disclose historical private sizes and hashes.

Offline SQLite validation uses an already bounded immutable byte capture with
readonly in-memory deserialize; SQLite never reopens a bundle/restored pathname.
WAL/unknown image header modes are refused, and captured bytes are rechecked on
disk before publication. The captured buffer is limited by the existing database
cap; deserialization cannot resize or write it.

Restore verifies the complete declared and physical bundle, copies exact database
and retained bytes into separate new roots, rechecks installed contents and input,
and only then changes its owned preparing marker to `restored_inactive`. It
installs no binding or owner lock and resumes no operational work. Current legacy
and selected admission remain closed for this inactive result. Partial outputs
are retained without a completed manifest/marker; cleanup or retry needs a new
explicit destination. Neither manifests nor portable data can select policy paths.

The effective category limits are derived from the compiled selected-authority,
staging, file-kind and byte-preview artifacts referenced by the export vocabulary.
Canonical bodies retain the selected 16 MiB per-body, 128 MiB aggregate and
10,000-record support; metadata retains its 64 MiB database bound. Retained files
use the maximum existing staging, attachment, import and preview cap (currently
64 MiB per part), with the explicit 128 MiB retained aggregate support limit.
Logical path depth/bytes follow selected authority, plus only the compiled wrapper
prefixes in storage. Counts, expanded path coverage and aggregate arithmetic are
bounded. Data exceeding this support contract returns `SourceLimit` and is never
reported as a complete backup. This is not arbitrary-size archival support.

This first dependency contract reuses the existing Rust media destination and
fence grammar for whole-line images and standalone Markdown links, including
multiple, nested, encoded, title, query and fragment carriers. Ordinary unlinked
Markdown is supported. Inline, reference-style, HTML and wiki embeds return
`UnsupportedDependency` when encountered outside fences, as do Canvas carriers;
none is advertised as completely dependency-verified. General Markdown/Canvas
coverage, selected consumers, activation and complete portable rollout acceptance
remain separate work. This bounded library slice does not close those gates.

Tests retain the original real schema-3 post-edit fixture and all original RED
assertions. Additional regressions exercise actual 10 MiB and exact-body-limit
paired writes, the native attachment cap, explicit dependency refusals, source
and destination drift, publication failures and absent ownership locks. The limit
helper derives effective caps from the same runtime loaders; no numeric twin was
introduced. Test preparation is not execution evidence.

The vocabulary has one Rust consumer and no digest or TypeScript projection to
regenerate. Any future wire DTO follows the existing Rust contract exporter.
Do not reformat the shared JSON artifact. Existing staging exclusions remain owned
by `staging.v1.json` and apply separately in each declared carrier namespace.
