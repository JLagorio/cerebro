# M22 — Event schema v1, reducer, conformance-vector parity, OKF migration

**Brief for the agent picking this up cold.** Written 2026-08-07. Read the
master roadmap (`convergent-intelligence-overhaul.md`) D2, D3, D7, D8, D11, D12,
the coverage matrix rows §6, §41–§44, §53, §61, §64, §74, §84, §85, and the
companion design
`../specs/2026-08-08-cerebro-m22-event-schema-design.md`. The design owns schema
semantics; this file owns implementation sequence and acceptance.

M22 is the largest permanent vocabulary commitment in the roadmap. The ledger
is append-only, so implement only the tagged variants and fields fixed in the
design. Reserved nullable provenance fields are the sole deliberate
no-current-consumer exception.

---

## Where things stand (verify at milestone start — refs drift)

- M21 delivered atomic `write_file`, the hash-chained NDJSON ledger,
  recovery verdicts, the disposable SQLite index, git-head anchoring, and v0
  shadow events from real write paths.
- The public surface is `LedgerWriter::append(kind, body)`, recovery, index,
  and shadow recording. M22 extends the writer but does not flip callers.
- The envelope constant remains `FRAME_VERSION = 0`. This plan introduces body
  `schema: 1`; it does not introduce frame `v: 1`.
- `write_concept` and `verify_concept` still write markdown directly. M23 owns
  the write-path flip, projection manifest, and active reconciliation mode.

## Non-goals (defend these)

- No production write-path flip and no migration-on-open. M23 arms both.
- No proposal policy, risk ladder, or expected-version enforcement. M24.
- No LLM call, new UI, or user-visible behavior.
- No Claims table or separate SourceArtifact/ExtractedAssertion tables.
- No HLC and no envelope field/version change.

## Rules that must survive implementation

**Frame v0, body schema 1.** A schema-v1 event is a normal M21 frame with
`v: 0` and `body.schema: 1`. Plumbing bodies without that schema keep indexing
but create no epistemic entity state.

**Attestation is not evidence.** `belief.attested` can affect verification state
only. It is invalid as an Observation lineage parent or Belief basis target.
Human firsthand/correction input uses the `human_assertion` Observation variant
and may support a revision.

**Unresolved is data.** Assertion subjects are explicitly `resolved` or
`unresolved`; snapshots and system events may say `none`. Never invent an entity
or assertion to make serde happy.

**Authority is provenance, not a caller-selected label.** Every Observation
pins an earlier or same-batch `source.registered` event. The core derives
`trusted_human_capture | registered_direct_artifact | agent_inferred` from that
portable registration, the trusted actor/call path, and the Observation variant.
Payload relationship/basis fields cannot elevate agent-inferred content.

**Atomicity is marker-based.** Multi-event transitions are invisible to entity
state until a valid `batch.committed` frame is durable. Physical frames remain
append-only and diagnosable even when their logical batch is ignored.

**Independence is positive and produced.** A recorded event with a valid tagged
firsthand/direct-artifact proof can establish `known_independent`; M24 later
adds the HIGH human-confirmed proof. M25's deterministic prefilter is the
production emitter for the first two. Shared ancestry establishes
`known_same_lineage`; no fact establishes `independence_unknown`.

**Versions are reducer-owned across target classes.** Stable observation,
belief, entity, relation, and source IDs receive deterministic CAS versions from
committed fold order. Producers never stamp their own version claims; later
milestones extend the same registry to proposal and comparison targets.

## Fixed schema summary

Every schema-v1 body begins with:

```json
{
  "schema": 1,
  "batch_id": null,
  "idempotency_key": null,
  "actor": { "id": "..." },
  "occurred_at": null,
  "valid_from": null,
  "valid_to": null
}
```

`TypedValue` is the tagged recursive union from the design (`missing`, `null`,
`boolean`, `number`, `string`, `array`, `object`). Belief patch `field_path`s are
RFC 6901 JSON Pointers. `SubjectRef` is exactly one of:

```text
{ resolution: "resolved", entity_id, aliases: [<source spelling>...] }
{ resolution: "unresolved", raw_ref, aliases: [<source spelling>...] }
{ resolution: "none" }
```

Subject aliases are immutable hints, not alias registrations. Canonical aliases
arrive only through `entity.alias_added { entity_id, alias, normalized_alias }`;
the design's Unicode-15.1 `normalize_alias_v1` computes the key while `alias`
preserves display bytes. Lineage elements are exact
`{ edge: reported_by|derived_from|copied_from|summarized_from,
parent_observation_event_id }` records with canonical order, unique Observation
parents, and no self/same-batch cycles.

`source.registered` is the portable trusted source record. Its closed
`human_actor | connector | builtin | cerebro_runtime | legacy_reference` union
carries the domain-separated, canonical-identity-hashed `source_key`, the
variant's actor/connector/service/resource binding,
`content_only | human_assertion | direct_system_artifact` capability, and a
non-null independence domain exactly for direct artifacts. Only the core
registration API appends it; no agent-facing op exists. `legacy_reference` is
migration-only, always content-only, and can establish neither authority nor
positive independence.

`observation.recorded` has wrapper fields `observation_kind`, stable
`source_id`, `source_registration_event_id`, `subject`, `lineage`, `provenance`,
and a tagged `payload`. `source_id` is opaque lowercase hex128 derived from the
store UUID plus registration key. It is the M25 `(store_uuid, source_id)`
health/coverage key, never a source record ID:

- `source_snapshot`: artifact hash + raw pointer, no assertion fields;
- `system_event`: event type + typed detail, no assertion fields;
- `extracted_assertion`: assertion fields + extracted text/artifact/extractor;
- `derived_content`: assertion fields + rendered text/generator;
- `human_assertion`: assertion fields plus an exact
  `field_change | relation_change | alias_add | standalone` union. `field_change`
  carries target Belief, pointer, and typed before/after; `relation_change`
  carries the stable relation ID and exact add/remove body; `alias_add` carries
  target Belief/Entity plus original and normalized alias; `standalone` carries
  an optional intended Belief and can remain unattached. Every form carries
  `corrects` and `reason`. Alias removal is an explicit unsupported transition,
  not an override.

`derived_content` may additionally carry sorted, unique
`source_belief_revision_event_ids`. Every ID must name an earlier committed
`belief.created`/`belief.revised`; the reducer indexes the read-only references
for M26 self-ancestry and never treats them as independent support.

Assertion fields are `assertion_kind`, predicate, typed value, scope,
relationship-to-subject, assertion basis, core-derived authority provenance,
and the structural absence record.
They are illegal on non-assertion variants. Consult the design for the exact
enums and field presence rules; serde structs must encode those unions rather
than a flat optional-field bag.

Belief revisions have explicit basis:

```text
{ state: "unsupported", reason: <non-empty> }
{ state: "linked", links: [{ observation_event_id,
                              role: "supports" | "opposes" | "context" }] }
```

`belief.attested` pins both `attested_belief_revision_event_id` and its
`attested_content_hash`; validators require the ID/hash pair to name the same
committed revision. Equal content across a basis-only revision is not enough.

Both `belief.created` and `belief.revised` require one form. Revision patches
carry pointer + typed before/after and validate `before` against prior state.
The independent-origin primitive is `observation.independence_recorded`, with
two Observation event IDs, matching source-registration refs, a closed
`distinct_firsthand_origin | independent_system_artifact | human_confirmed`
proof, and a non-empty reason. The first two have exact trusted
actor/capability/domain checks plus a rule version; `human_confirmed`
additionally pins M24's HIGH
proposal and approving decision event.
`observation.subject_resolved` is an exact `attach | correct` union. Attach uses
the design's tier proof: `exact_id` has no basis event, `known_alias` names one
matching alias event, `explicit_relation` names a live relation path, and
`normalized_match` names one Entity-registering event. Correction pins the
current prior resolution event and from/to Entities, requires a distinct existing
target plus non-empty tier basis/reason, and preserves the full attachment
history.

Relation IDs, migrated IDs, attested content hashes, corpus/key digests, and
alias normalization use the domain-separated byte formulas in the design. Do not substitute an
implementation-defined hash, locale-sensitive lowercase, or a fresh migration
body ID.

## Phases

One commit per phase, `type(scope): sentence (M22.n)`.

### M22.1 — Tagged schema types + validation

Add `src-tauri/src/ledger/schema.rs` (or `epistemic/schema.rs`; record the
choice in its module doc) with:

- common body metadata, `TypedValue`, tagged `SubjectRef`, and exact
  `LineageEdge`;
- trusted `source.registered` union/key derivation and Observation registration
  pin;
- all five tagged Observation payload variants;
- tagged attach/correct `observation.subject_resolved` with target/entity, closed
  resolver tier, tier-specific basis proof, and prior-resolution pin;
- `BeliefBasis`, belief bodies, stable add/remove relation bodies, and exact
  attestation/alias bodies;
- independence, migration bracket, and batch marker bodies;
- the complete reserved M24 lifecycle vocabulary: `belief.tombstoned`,
  `proposal.submitted`, `proposal.queued`, `proposal.decision_recorded`,
  `proposal.applied`, `proposal.rejected`, and `proposal.reverted`, without
  defining their bodies.

Use `deny_unknown_fields` so a snapshot containing `assertion_kind` is rejected
rather than silently accepted. Validation must cover:

- assertion subject `none` rejected; unresolved accepted;
- subject-resolution target must be unresolved; none/conflicting attach,
  correction-before-attach, stale prior, same-Entity correction, and bad proof
  refused;
- lineage enum/order/parent/duplicate/self/cycle rules; extracted assertions need
  Observation lineage, while derived content needs at least one Observation or
  Belief-revision parent;
- presence/absence record consistency;
- stable source ID, trusted registration/key/capability, and exact
  authority-provenance derivation/refusals;
- field-change, relation-change, alias-add, and standalone human forms, including
  exact effect pairing, alias-removal refusal, and correction/reason constraints;
- derived-content Belief source IDs name earlier committed creation/revision
  events and remain read-only;
- relation-ID derivation plus alias display/key normalization;
- unique revision patch pointers and valid tagged values; an empty patch is
  allowed only when the canonical basis changes, and a total no-op is refused;
- non-empty linked basis or explicit unsupported reason;
- attestation ID/hash pairs name the same committed revision; an
  `attested_content_hash` that does not match the projection of the pinned
  revision event is refused;
- exact firsthand/direct-artifact independence proofs; reserve the
  decision-backed human proof for M24 validation.

Property-test canonical encode→decode→encode for every variant. The frame tests
must pin `v: 0` with `body.schema: 1` so an accidental envelope bump fails.

### M22.2 — Logical batches + append-once

Extend the single-writer core with:

```text
append_once(idempotency_key, kind, body) -> ExistingOrCommitted
append_batch(events, operation_key?) -> BatchReceipt
```

`append_once` searches verified committed frames as well as the cache. An
identical key/kind/body returns the existing receipt; the same key with different
canonical content is a hard conflict.

`append_batch`:

1. preallocates one fresh batch ID and all member event IDs;
2. stamps members with the batch ID and operation-key-derived idempotency keys;
3. appends members contiguously;
4. appends `batch.committed` with ordered member IDs/count, a digest over
   canonical member frames, and a stable digest over the preallocation symbolic
   member plan;
5. fsyncs through the marker before acknowledgement.

Same-batch references are symbolic member ordinals until IDs are allocated, so
the logical operation digest stays stable when a retry gets new physical IDs. On
retry, an already committed matching operation key/digest returns its prior
receipt; an orphaned attempt does not claim the key and the retry uses a new
batch ID.
Kill-point tests cover every append boundary, marker truncation, marker fsync,
and lost acknowledgement.

### M22.3 — Reducer + complete index schema

Add `ledger/reduce.rs` and the following tables beyond M21 `events`/`meta`:

- `logical_batches`, `batch_members`, `state_versions`;
- `sources` with portable registration/capability/domain state;
- `entities`, `aliases`;
- `beliefs`, `belief_revisions`, `belief_basis_links`;
- `observations`, `lineage_edges`, `observation_subject_resolutions`,
  `observation_independence`, `derived_belief_sources`;
- `relations`;
- `reducer_anomalies`.

The physical `events` table records every hash-valid frame. Entity tables apply
an unbatched event immediately, but buffer a batch until a marker proves the
exact contiguous members and digest. Any invalid member refuses the entire
batch. Same-batch references are validated against staged members. Orphan,
interleaved, duplicate, truncated, wrong-digest, or partially invalid batches
have zero entity-state effect and deterministic anomaly rows.

Assign Belief revisions from committed fold order and store each revision's
generating event ID. Validate basis endpoints as committed Observations or
earlier staged Observation members of the same valid batch; refuse forward or
cross-batch references. Store unsupported state explicitly. Refuse a `belief.relation` add
whose `from`/`to` does not name a committed Belief (or an earlier staged Belief
creation in the same valid batch). Implement the design's closed version
matrix: source registration creates Source; observation record creates
Observation and increments the already registered Source;
subject resolution attach/correct increments its Observation; independence
increments both Observation endpoints; Belief create creates Belief and may
first-register its subject Entity; revise/attest increments Belief; relation
add/remove/re-add creates/increments Relation; alias addition increments its
existing Entity.
Resolved subjects may first-register an unseen Entity but never bump an existing
one merely by reference. Migration/batch brackets and all read references have
no version effect. Validate a batch against its pre-batch snapshot and then fold
named effects in member order. Source registrations and semantic references may
use an earlier staged
creation (for example, create Entity at 1 then add alias to reach 2); only CAS
expectations are fixed to the pre-batch snapshot. Store independence as an
unordered pair; refuse an independence event whose endpoints already share
ancestry. Unknown must never be materialized as an inferred independence row.

Rebuild twice from zero and compare byte-identical dumps, including anomalies
and orphan-batch diagnostics. A malformed schema-v1 event never panics or
silently skips.

### M22.4 — Conformance vectors (the parity mechanism)

Use root `conformance/`, not gitignored docs. Rust generates
`{ events, expected_state, expected_refusals }` fixtures and asserts committed
bytes match regenerated bytes. The minimal TS reducer replays the same vectors.

Coverage floor:

- every M22-defined event body, source-registration tag/capability, and
  Observation payload; reserved M24 kinds and human-confirmed independence wait
  for M24 bodies/vectors;
- all three subject states and every validation refusal;
- every resolver-tier attach proof plus valid correction and none/conflicting-
  attach/stale-prior/same-Entity/bad-proof refusals;
- every lineage edge and its parent/order/duplicate/cycle refusals;
- linked vs explicitly unsupported revisions and before-value mismatch;
- field-change, relation-change, alias-add, and standalone assertions, including
  alias-removal refusal;
- valid/invalid derived-Belief source IDs and the M26 self-ancestry index row;
- lineage/basis exclusion for attestation and non-Observation events;
- an attestation whose `attested_content_hash` does not match the pinned
  revision's projection;
- a relation add whose endpoint names no committed Belief;
- valid/forged authority provenance; explicit firsthand/direct-artifact
  independence proofs, invalid actor/domain/source proofs, shared ancestry, and
  unknown-with-no-fact;
- valid two-member batch; no marker; torn/duplicate marker; wrong member
  order/count/digest; interleaving; one bad member; same-batch basis link;
- domain-separated relation/migration IDs, alias normalization/display
  preservation, revision ordering, and every event-to-version effect.

No schema-v1 rule gets a second hand-written implementation in mockIpc.

### M22.5 — Projection function (Belief → OKF, byte-stable)

Add pure `ledger/project.rs`. For every demo-vault `knowledge/*.md` file:

```text
project(reduce(migrate(file))) == read(file)
```

Assert frontmatter order, bracketed wikilinks, body whitespace, and trailing
newline. Store the generating revision event ID alongside reducer revision state
for M23's manifest. Do not write any file in this phase.

### M22.6 — Deterministic, restart-idempotent migrator

Add `ledger/migrate.rs`:

- concept → `belief.created` with an explicit `unsupported` basis and complete
  OKF frontmatter/body state for byte-stable projection;
- verified stamp → `belief.attested`, pinned to the migrated creation event ID
  and its content hash;
- each parseable `sources[]` entry → one `source_snapshot`; entries with the
  same case-sensitive trimmed non-empty `resource` share one content-only
  `legacy_reference` registration. The snapshot uses subject `none`, empty
  lineage, null artifact hash, `raw_pointer = resource`, and the exact legacy
  provenance mapping from the design. Citation-local ID/title/author/date/usage
  metadata remains in Belief fields; an entry without a parseable resource emits
  no source event and never falls back to ID/title identity;
- relations → `belief.relation`; aliases → `entity.alias_added`.

First emit the globally resource-deduplicated source registrations in `source_id` order
with `source-register-v1:<store-uuid>:<source-id>` keys. Normalize and sort
paths. Emit path outputs in the design's two phases so no relation precedes an
endpoint Belief: first every path's Belief creation, source snapshots, aliases,
and attestation; then every path's `belief.relation` events — path-sorted
deterministically within each phase. The migrator is armed only at M23.0 and
has never run in production, so this order change is safe pre-freeze. Give every path output the deterministic key
`migrate-v1:<store-uuid>:<path>:<role>:<ordinal>` and call `append_once`.
Derive every migrated Belief/Entity ID with the design's
`cerebro-migrate-id-v1` domain and normalized path; derive relation/source IDs
with their fixed formulas. A dependent output resolves the prior append-once
receipt before embedding its event ID, including migrated attestation. Never
generate a fresh canonical-body ID on retry.

`migration.started` pins the store UUID, migration schema, and corpus source
digest. `migration.completed` records those plus output count and output-key
digest. Their deterministic keys are `migrate-v1:<store-uuid>:started` and
`migrate-v1:<store-uuid>:completed`; completion validation scans committed keys
and must agree with the started digest/count plan.

Hash the path-sorted canonical JSON `{ path, content_hash }` array for the corpus
digest and the UTF-8-byte-sorted canonical JSON key array for the key digest.
Counts exclude the two brackets. Cross-platform fixtures pin every byte.

The completed marker is only the fast whole-run guard. Per-output keys are the
prefix guard: after kill -9, rerun returns existing outputs and appends the
remainder. If the corpus digest changed mid-epoch or a key's canonical content
does not match, refuse and require reconciliation rather than duplicating.

All events use `actor: system:migrator`, valid RFC3339 original stamps as event
time, and
core-stamped migration time as ingestion time. A non-RFC3339 original (a
date-only `last_modified`, say) yields null `occurred_at`, never a fabricated
instant. The real migrator is not called
from production paths in M22; a hidden dry-run command may ship with mock parity.

### M22.7 — Migration and batch acceptance soak

Against a temp copy of demo-vault, automate:

- byte-identical re-projection and untouched mtimes;
- a pre-seeded localStorage `learnAttempts` ledger — the store the distiller
  actually consults — and an empty distiller queue after scan;
- verified chain and byte-identical index rebuild;
- kill/restart after every migration output with no duplicate key/event effect;
- completed-marker fast no-op;
- batch kill matrix and acknowledgement-loss idempotency.

The repository demo-vault is never modified in place.

## Acceptance matrix

| Scenario | Must hold |
|---|---|
| schema-v1 frame encoded | envelope stays `v: 0`; body is `schema: 1` |
| every body variant round-trips | canonical bytes identical |
| snapshot/system event without subject/assertion | accepted with subject `none` |
| assertion with unresolved subject | accepted and indexed unresolved |
| assertion with subject `none` | schema-rejected |
| missing/forged source registration or authority provenance | whole event/batch refused; no privileged authority |
| trusted human capture | actor-bound human registration required; agent cannot construct it |
| registered direct artifact | exact direct-artifact capability/domain required; agent cannot upgrade content-only source |
| duplicate legacy references with one resource | one registration, one snapshot per entry, original source objects project byte-identically |
| legacy reference lacks a parseable resource | no registration/snapshot and no guessed fallback; original Belief fields still project |
| legacy reference presented as authority/independence | refused; content-only import cannot upgrade itself |
| initial subject attachment | exact tier proof attaches unresolved Observation |
| subject correction pins current attachment | effective Entity changes; history retained; Observation version increments |
| subject correction pins stale prior/same Entity | refused with no state/version effect |
| absence without complete structural absence record | schema-rejected; coverage-reference enforcement waits for M24 |
| field-change assertion missing target/field/typed change | schema-rejected |
| relation-change assertion lacks exact paired relation event | whole batch refused |
| alias-add assertion lacks exact paired alias event | whole batch refused |
| human removes an alias | unsupported-transition refusal; adoption cannot rebaseline it |
| standalone human assertion without a target | accepted and may remain unattached |
| derived content names non-revision/uncommitted Belief source | reduce-time refusal; no derivation row |
| revision has no evidence | explicit `unsupported` state required |
| basis or lineage points to attestation | refused; no evidence edge |
| attestation hash mismatches the pinned revision's projection | reduce-time refusal; no verification-state effect |
| relation add names an endpoint that is no committed Belief | reduce-time refusal; no relation state |
| no ancestry or independence fact | `independence_unknown`, never independent |
| positive firsthand/direct-artifact independence proof | pair indexed; M27 can reach `known_independent` |
| independence proof uses same actor/domain, wrong source, or ancestry-linked endpoints | refused; remains non-independent |
| valid batch marker | all members apply together after marker only |
| torn/invalid batch | zero member state effect plus anomaly |
| retry after acknowledged/lost response | existing batch receipt, no duplicate |
| mixed plumbing + schema-v1 bodies | clean reduce; plumbing creates no entity state |
| reduce twice from zero | byte-identical complete index dumps |
| each M22 event mutates targets | complete version map matches the closed matrix |
| TS reducer replays vectors | identical state and refusals |
| demo-vault migrate → project | bytes identical, mtimes untouched, queue empty |
| migrated relation emission | every `belief.relation` follows both endpoint Beliefs via the two-phase order |
| kill -9 mid-migration | rerun appends only missing deterministic outputs |
| migration key reused with different body | hard refusal, never silent dedupe |

## Traps

- Do not write `v: 1`; `FRAME_VERSION` remains 0.
- Do not flatten the Observation union into nullable fields. That recreates the
  fabricated-assertion bug the tagged payload prevents.
- Do not equate an empty basis list with unsupported, or no lineage edge with
  independent.
- A batch is not committed because all member frames happen to be durable. Only
  a valid, fsynced `batch.committed` marker makes it reducer-visible.
- `append_once` cannot trust only SQLite; the index is disposable.
- Tests copy demo-vault before migration. M22 never touches fixture mtimes.
- Use `pnpm test:run`, not watch-mode `pnpm test`; run the full Rust gate and
  untouched e2e suite. Never bypass hooks.

## Exit criteria

Acceptance matrix green · all tagged variants/refusals/batch states replay in
both reducers · portable authority provenance, explicit unsupported, and
produced independence semantics proven ·
demo-vault round-trip byte-identical with mtimes and queue cold · migration
restart-idempotent after every prefix · complete Rust/TS/e2e gates green · zero
production write-path or visible behavior change.
