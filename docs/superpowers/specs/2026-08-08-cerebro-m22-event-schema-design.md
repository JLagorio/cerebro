# Cerebro M22 — Event Schema v1, Reducer, Conformance Parity, OKF Migration — Design

**Date:** 2026-08-08
**Status:** Derived from the accepted Rev 3 roadmap
(`../plans/convergent-intelligence-overhaul.md`, D3/D7/D8/D11/D12) and the frozen
coverage matrix (rows §6, §41–§44, §53, §61, §64, §74, §84, §85). For owner
review.
**Scope:** The epistemic plane's permanent vocabulary: the four-object event
schema v1, crash-safe logical batches, the reducer that folds events into entity
state, conformance-vector parity, the byte-stable projection function, and the
deterministic OKF migrator (built and proven, not armed).
**Companion plan:** `../plans/2026-08-07-cerebro-m22-event-schema.md` sequences the
implementation. Where the two disagree, this spec wins.

## Context

M21 gave the vault a tamper-evident, hash-chained, append-only NDJSON ledger in
`<vault>/.cerebro/ledger/` with a disposable SQLite index in app-data, atomic
file writes, and shadow events recording what the app already does. Nothing yet
reads events back for meaning. M22 is the first consumer — and the single
biggest schema commitment in the roadmap, because the ledger is append-only.

M22 changes no write path and no user-visible behavior. Files remain
authoritative; `write_concept` still writes markdown. The milestone builds and
proves the machinery M23 will arm, including the migrator. The migrator is not
armed until the write-path flip so no uncaptured-write window is introduced.

## Governing invariants

1. **Additive-only, forever.** The M21 envelope is unchanged. Its frame version
   remains `v: 0`; event vocabulary versioning is the body field `schema: 1`.
   M21 plumbing bodies without `schema` remain valid and indexable. No field is
   ever renamed or repurposed; deprecation means stop emitting and keep reducing.
2. **Attestation is not evidence (D8).** `belief.attested` derives separate
   ReviewStatus and may anchor freshness only when a versioned predicate rule
   permits; it is structurally excluded from Support, lineage, and BeliefBasis.
   `human_assertion` is the opposite: a root Observation that may support a Belief
   revision and carries D11 authority metadata.
3. **CAS versions are reducer state, not event claims.** Events carry stable
   target IDs; the reducer assigns versions from committed `seq` order for every
   registered target class. M24's `expected_version` is a proposal precondition,
   never a producer-authored revision claim. Belief revision number remains a
   distinct, Belief-specific projection of that committed history.
4. **Ordering is `seq` alone (D3).** Content timestamps are labeled and never
   trusted for ordering.
5. **Atomic means reducer-atomic.** A logical batch is visible to entity state
   only after its valid `batch.committed` marker. A durable prefix without that
   marker is history for recovery diagnostics, but has zero epistemic effect.
6. **Independence requires positive knowledge.** Shared ancestry proves
   `known_same_lineage`; a valid `observation.independence_recorded` event proves
   `known_independent`; the absence of either remains `independence_unknown`.

## Event schema v1

### Kind namespace (additive from here on)

| kind | Meaning |
|---|---|
| `batch.committed` | Logical-batch commit marker |
| `source.registered` | Portable trusted identity/capability record for one logical source |
| `observation.recorded` | Any Observation; tagged payload inside body |
| `observation.subject_resolved` | Attach an unresolved Observation to an Entity or explicitly correct its effective attachment |
| `observation.independence_recorded` | Positive independence fact between two Observations |
| `belief.created` | New Belief (draft) |
| `belief.revised` | Content/field revision with an explicit basis state |
| `belief.relation` | Add or remove a stable supersedes \| refines \| contradicts relation |
| `belief.attested` | Human review attestation (D8 channel 1) |
| `belief.tombstoned` | Reserved; emitted from M24 policy only |
| `entity.alias_added` | Explicit alias registration (§84) |
| `migration.started` / `migration.completed` | Migrator epoch brackets |
| `proposal.submitted` / `proposal.queued` / `proposal.decision_recorded` / `proposal.applied` / `proposal.rejected` / `proposal.reverted` | Reserved; M24 bodies |

M23 adds `projection.overridden`, `ledger.divergence`, and
`ledger.reconciliation_resolved`. M24 defines the Proposal object and its event
bodies. Both milestones use the batch protocol fixed below.

### Common body fields (every schema-v1 event)

```json
{
  "schema": 1,
  "batch_id": null,
  "idempotency_key": null,
  "actor": { "id": "human:josef" },
  "occurred_at": null,
  "valid_from": null,
  "valid_to": null
}
```

- `batch_id` is null for an immediately visible event and a 128-bit lowercase
  hex ID for a logical-batch member or its commit marker.
- `idempotency_key` is a producer-scoped stable key. It is optional for ordinary
  one-shot appends, required for migration outputs, and used as the logical
  operation key on retryable batches. Reuse with different canonical content is
  a hard conflict, never a silent dedupe.
- Envelope `seq` and `ingested_at` are core-stamped. `occurred_at` and
  `valid_*` are source content. `wall_clock_anomaly` stays in the M21 envelope.

The frame remains `v: 0`. A frame containing a schema-v1 body therefore has
`{"v":0,...,"body":{"schema":1,...}}`; there is no `v: 1` frame in M22.

### Shared tagged values and subjects

Patch values use a recursive tagged form so `null`, a missing field, and the
string `"null"` cannot collapse:

```text
TypedValue = { type: "missing" }
           | { type: "null", value: null }
           | { type: "boolean", value: <bool> }
           | { type: "number", value: <finite number> }
           | { type: "string", value: <string> }
           | { type: "array", value: [TypedValue...] }
           | { type: "object", value: { <key>: TypedValue... } }
```

`field_path` is an RFC 6901 JSON Pointer over canonical belief state: `/body`
for markdown body and `/fields/...` for frontmatter. It belongs only to a
`human_assertion/field_change`; relation edits use the separate tagged form
below. Subjects are also tagged:

```text
SubjectRef = { resolution: "resolved", entity_id: <stable-id>,
               aliases: [<non-empty source string>...] }
           | { resolution: "unresolved", raw_ref: <source text>,
               aliases: [<non-empty source string>...] }
           | { resolution: "none" }

LineageEdge = {
  edge: "reported_by" | "derived_from" | "copied_from" | "summarized_from",
  parent_observation_event_id: <event-id>
}
```

Assertion variants require `resolved` or `unresolved`. `source_snapshot` and
`system_event` may use `none`; they never fabricate a subject merely to satisfy
the schema. The unresolved source text remains available for M26 resolution
without rewriting the immutable Observation. Subject aliases preserve source
spelling and are immutable resolution hints; they do not register canonical
aliases. Only `entity.alias_added` mutates the alias registry.

`lineage` is an array of `LineageEdge`. Parent IDs are unique, and canonical
order is ascending committed parent `seq`, with same-batch parents ordered by
symbolic member ordinal. Each parent must be an earlier committed
`observation.recorded` event or a valid staged Observation in the same logical
batch. Self-reference, duplicate parents, non-Observation parents, and a same-
batch lineage cycle are refused. `extracted_assertion` requires at least one
edge. `derived_content` requires at least one parent across `lineage` and
`source_belief_revision_event_ids`; root snapshots, system events, and human
assertions may use an empty lineage array.

M26 records a deterministic attachment additively:

```text
observation.subject_resolved = {
  ...common, observation_event_id: <event-id>,
  change: {
    action: "attach", entity_id: <stable-id>,
    resolver_tier: "exact_id" | "known_alias" | "explicit_relation"
                 | "normalized_match",
    basis_event_ids: [<event-id>...]
  } | {
    action: "correct", prior_resolution_event_id: <event-id>,
    from_entity_id: <stable-id>, to_entity_id: <stable-id>,
    resolver_tier: "exact_id" | "known_alias" | "explicit_relation"
                 | "normalized_match",
    basis_event_ids: [<event-id>...], reason: <non-empty string>
  }
}
```

The target must be a committed Observation whose original subject is
`unresolved`; `none` is refused. `attach` requires no effective prior resolution.
`correct` requires one: `prior_resolution_event_id` must be the current effective
attach/correction event for this Observation, `from_entity_id` must equal its
current Entity, and `to_entity_id` must name a different existing Entity. A stale
prior pointer, same-Entity no-op, missing Entity, or correction before attach is
refused. The reducer never rewrites the immutable Observation or earlier
resolution; it appends resolution history and changes only the effective
attachment.

`basis_event_ids` is an ordered, duplicate-free proof over already committed
state; same-batch basis events are not permitted. Its tier contract is exact:

- initial `exact_id`: empty, and `raw_ref` must equal an existing `entity_id`
  exactly;
- `known_alias`: exactly one `entity.alias_added` whose `normalized_alias`
  matches `normalize_alias_v1(raw_ref)` and whose Entity is the target;
- `explicit_relation`: one or more currently live `belief.relation` add events,
  in traversal order, whose Belief subjects form a continuous path to the target
  Entity;
- `normalized_match`: exactly one Entity-registering `belief.created` or
  resolved-subject `observation.recorded` event whose preserved source alias
  normalizes to the mention and whose Entity is the target.

For `correct`, `basis_event_ids` and `reason` are always non-empty, and every
tier proves `to_entity_id`. Correction `exact_id` therefore contains exactly one
Entity-registering event for the directly supplied target ID; the other tier
cardinalities remain as above. A wrong kind, inactive relation, broken path,
mismatched Entity, non-canonical cardinality, or non-matching mention is a
reduce-time refusal.

### Observation body (`observation.recorded`)

The wrapper is common, while `payload` is discriminated by
`observation_kind`. `source_id` is an opaque lowercase 128-bit hex ID, stable
within a store, for a logical origin such as a connector installation/scope, a
human actor, or the Cerebro runtime. It is not a provider, record, or revision
ID and does not change when a record is revised. Every source is registered by
a trusted core path before first use:

```text
SourceRegistration =
  { kind: "human_actor", source_key, actor_id,
    authority_capability: "human_assertion", independence_domain_id: null }
| { kind: "connector", source_key, connector_instance_id, logical_scope_id,
    authority_capability: "content_only" | "direct_system_artifact",
    independence_domain_id: null | <stable-id> }
| { kind: "builtin", source_key, service_id,
    authority_capability: "content_only" | "direct_system_artifact",
    independence_domain_id: null | <stable-id> }
| { kind: "cerebro_runtime", source_key, service_id,
    authority_capability: "content_only", independence_domain_id: null }
| { kind: "legacy_reference", source_key, resource: <non-empty string>,
    authority_capability: "content_only", independence_domain_id: null }

source.registered = {
  ...common, source_id, registration: SourceRegistration
}
```

For every variant, form an identity object containing `kind` plus only its
identity fields (`actor_id`; connector instance + scope; service ID; or legacy
resource). Then `source_key` is
`<kind>:<sha256(canonical_json(identity_object))>`. This makes composite IDs
collision-safe without reserving a delimiter inside actor, connector, scope, or
service IDs. `legacy_reference.resource` is the trimmed non-empty OKF source
resource and is the only migration-only variant. The server requires
`source_id` to equal the first 128 bits of
`SHA-256("cerebro-source-v1\0" + store_uuid + "\0" + source_key)` and writes the
registration with `append_once`. Only the trusted core registration API may
append this kind; it server-stamps `actor: system:source-registry`, and no M24
agent-facing op exposes it. A direct-system registration requires a
non-empty `independence_domain_id`; every other capability requires null.
Re-registering a source ID or key with different canonical bytes is refused.
`legacy_reference` can never satisfy an authority or positive-independence rule;
it preserves an imported locator without pretending that Cerebro observed the
artifact or knows its live connector scope.
M25 caches registrations and keys health/coverage by `(store_uuid, source_id)`,
but this ledger event remains the portable authority. Every
`source_registration_event_id` must name the matching earlier committed
registration or an earlier staged registration in the same valid batch; a
forward or cross-source reference is refused.

```json
{
  "schema": 1,
  "batch_id": null,
  "idempotency_key": null,
  "actor": { "id": "agent:<run-id>" },
  "occurred_at": null,
  "valid_from": null,
  "valid_to": null,
  "observation_kind": "source_snapshot",
  "source_id": "0fd47b7320e64204bfc433bc360d5945",
  "source_registration_event_id": "<source.registered event-id>",
  "subject": { "resolution": "none" },
  "lineage": [],
  "provenance": {
    "source_system": null,
    "source_location": null,
    "source_record_id": null,
    "source_revision": null,
    "source_author": null,
    "source_workflow_state": null
  },
  "payload": {
    "source_artifact_hash": null,
    "raw_pointer": "docs/source.md"
  }
}
```

Payload variants are exact tagged unions:

```text
source_snapshot = {
  source_artifact_hash: null | <sha256>, raw_pointer: <opaque locator>
}

system_event = {
  event_type: <stable string>, detail: TypedValue
}

extracted_assertion = AssertionPayload + {
  extracted_text: <string>, source_artifact_hash: <sha256>,
  extractor_version: <string>, raw_pointer: <opaque locator>
}

derived_content = AssertionPayload + {
  rendered_text: <string>, generator_version: <string>,
  source_belief_revision_event_ids?: [<belief.created|belief.revised event-id>...]
}

human_assertion = AssertionPayload + (
  { assertion_form: "field_change",
    target_belief_id: <stable-id>, field_path: <JSON Pointer>,
    before: TypedValue, after: TypedValue,
    corrects: null | <observation-event-id>, reason: null | <string> }
  | { assertion_form: "relation_change",
      target_belief_id: <stable-id>, relation_id: <stable-id>,
      action: "add" | "remove", from: <belief-id>, to: <belief-id>,
      relation: "supersedes" | "refines" | "contradicts",
      corrects: null | <observation-event-id>, reason: null | <string> }
  | { assertion_form: "alias_add",
      target_belief_id: <stable-id>, entity_id: <stable-id>,
      alias: <non-empty source string>,
      normalized_alias: <normalize_alias_v1(alias)>,
      corrects: null | <observation-event-id>, reason: null | <string> }
  | { assertion_form: "standalone",
      intended_belief_id: null | <stable-id>,
      corrects: null | <observation-event-id>, reason: null | <string> }
)

AssertionPayload = {
  assertion_kind: "presence" | "absence",
  predicate: <stable predicate string>, value: TypedValue,
  scope: { stage: null | "planned" | "approved" | "implemented"
                       | "validated" | "deployed" | "shipping",
           revision: null | <string>, environment: null | <string>,
           geography: null | <string> },
  relationship_to_subject: { role: "project_owner" | "team_member"
                                   | "adjacent" | "unknown" },
  assertion_basis: "firsthand" | "responsible_owner" | "reported"
                 | "inferred" | "unknown",
  authority_provenance: "trusted_human_capture"
                      | "registered_direct_artifact" | "agent_inferred",
  absence: null | { searched_domain: <string>, search_scope: <string>,
                    coverage_basis: <string>, observation_window: <string>,
                    query_strategy: <string>, limitations: <string> }
}
```

Observations realize D7's content-addressing through `source_artifact_hash`
over the captured artifact bytes; event identity itself is core-allocated. No
consumer needs a content-addressed Observation identity.

`assertion_kind`, predicate, value, scope, and authority metadata exist only on
the three assertion variants. A source snapshot or system event cannot fabricate
an assertion to pass validation. Authority tags are not self-authenticating:
`trusted_human_capture` requires a `human_actor` registration, a common-body
actor equal to that registration's `actor_id`, capability `human_assertion`,
and `observation_kind: human_assertion`;
`registered_direct_artifact` requires an `extracted_assertion` whose pinned
registration has capability `direct_system_artifact`; every other assertion is
`agent_inferred`. The core derives this tag from the pinned registration and
trusted call path. An agent cannot choose or upgrade it. M27 authority routes
may trust only the first two tags; relationship/basis fields on
`agent_inferred` content remain claims, not authority proof.

A `field_change` is the exact M23 structured-edit form. A `relation_change` targets the `from` Belief, requires predicate
`belief_relation`, and its typed `value` is the canonical object containing
`{ relation_id, action, from, to, relation }`; it pairs one-to-one with the exact
`belief.relation` event rather than a `/fields/...` patch. An `alias_add` requires
predicate `entity_alias`; its typed `value` is the canonical object containing
`{ entity_id, alias, normalized_alias }`, and it pairs one-to-one with the exact
`entity.alias_added` event. The named Entity must be the subject Entity of
`target_belief_id`. Alias removal has no M22 event and is therefore refused,
never encoded as an override or silently rebaselined. A `standalone` assertion
is root human evidence that may remain unattached or support a same-batch/later
Belief; when `intended_belief_id` is present, any same-batch basis use must name
that Belief. `corrects` points to the mistaken immutable Observation; the
consuming Belief revision basis records how the correction changes current
belief state.

`source_belief_revision_event_ids` makes Belief-derived feedback explicit for
M26 self-ancestry checks. Omission means no Belief revision input. When present,
the array is non-empty, sorted, and duplicate-free; every ID must name an earlier
committed `belief.created` or `belief.revised` event. The reducer indexes these
read-only derivation references; they do not themselves change a Belief version
or make the derived Observation independent evidence.

Validation rules:

| Rule | Refusal |
|---|---|
| `source_id` empty or unstable-form | schema-rejected |
| missing/mismatched source registration, source key, or capability | reduce-time refusal |
| authority provenance disagrees with registration, actor, or Observation variant | schema/reduce-time refusal |
| assertion subject is `none` | schema-rejected; unresolved is valid |
| subject attach has a prior resolution, or correction has no current prior | reduce-time refusal |
| correction prior/from is stale, target is unchanged/missing, or basis/reason is empty | reduce-time refusal |
| `extracted_assertion` has empty lineage, or `derived_content` has neither lineage nor a Belief-revision source | schema-rejected (§43) |
| snapshot/system event contains assertion-only fields | unknown-field refusal |
| absence assertion lacks a complete `absence` record | schema-rejected (§53) |
| presence assertion carries an `absence` record | schema-rejected |
| lineage parent is not an `observation.recorded` event | reduce-time refusal (D8) |
| `field_change` target/field/before/after does not agree one-to-one with its paired patch | batch refusal |
| `relation_change` target/value does not agree one-to-one with its paired relation event | batch refusal |
| `alias_add` target/value does not agree one-to-one with its paired alias event | batch refusal |
| human alias removal | unsupported-transition refusal; reconciliation cannot adopt it |
| `standalone` carries field-change fields, or its intended Belief disagrees with a same-batch basis use | schema/batch refusal |
| derived-content Belief source is not an earlier committed creation/revision | reduce-time refusal |
| `corrects` is not an earlier Observation or `reason` is empty | reduce-time refusal |
| `belief.attested` hash does not match the projection of the pinned revision event | reduce-time refusal |

### Belief bodies and explicit basis

```text
BeliefBasis = { state: "unsupported", reason: <non-empty string> }
            | { state: "linked", links: [
                  { observation_event_id: <event-id>,
                    role: "supports" | "opposes" | "context" }, ... ] }

belief.created = {
  ...common, belief_id, subject: <resolved SubjectRef>, content: <string>,
  fields: <object>, basis: BeliefBasis
}

belief.revised = {
  ...common, belief_id,
  patch: [{ field_path: <JSON Pointer>, before: TypedValue, after: TypedValue }, ...],
  basis: BeliefBasis
}

belief.relation = { ...common, relation_id, action: "add" | "remove", from, to,
                    relation: "supersedes" | "refines" | "contradicts" }

belief.attested = {
  ...common, belief_id, attested_belief_revision_event_id,
  attested_content_hash
}

entity.alias_added = {
  ...common, entity_id, alias: <non-empty source string>,
  normalized_alias: <normalize_alias_v1(alias)>
}
```

Every created/revised revision declares whether it is linked to evidence or
known unsupported. `linked.links` must be non-empty and each target must be a
committed Observation or an earlier staged `observation.recorded` member of the
same valid logical batch; forward references and references outside that batch
are refused. Attestations and projection overrides are refused as basis.
`supports` and `opposes` may target only assertion variants; `context` may
target any Observation. `unsupported` is state, not an empty list
accidentally interpreted as weak support. Revision pointers are unique and every
`before` value must match prior committed state. A revision patch may be empty
only when the canonical `basis` differs from the prior revision; this is the
support-only revision used when new independent corroboration changes evidence
state without changing content. Empty-patch/unchanged-basis no-ops are refused.

`relation_id` is lowercase hex128: the first 128 bits of
`SHA-256("cerebro-relation-v1\0" + canonical_json([from, to, relation]))`, where
`canonical_json` is M21's UTF-8 canonical serializer. Direction and array order
are significant. `add` refuses a live duplicate; `remove` requires the matching
live relation and keeps its history. `add` also refuses `from`/`to` IDs that do
not name committed Beliefs in reducer state (an earlier staged Belief creation
in the same valid batch counts, per the staged-reference rule); a relation can
never precede its endpoints.

`normalize_alias_v1` applies Unicode 15.1 NFKC case-folding, maps each run of
Unicode `White_Space` characters to one ASCII space, trims leading/trailing
space, and preserves punctuation. The normalized result must be non-empty.
`alias` preserves the exact display/source spelling for byte-stable projection;
`normalized_alias` must equal the computed value or the body is rejected.
Uniqueness and conflict checks use `normalized_alias`. An alias already live on
a different Entity is refused rather than guessed. Rust and TypeScript share
Unicode-version-pinned normalization vectors.

`belief.attested` pins both the generating event ID and content hash of the
revision reviewed. `attested_content_hash` is lowercase hex:
`SHA-256("cerebro-attested-content-v1\0" + <projected revision content bytes>)`,
where the content bytes are the exact byte-stable `project()` output of the
pinned revision event. The referenced event must be a committed
creation/revision of the named Belief and the hash must match that exact
projected revision — a mismatch between the pinned event ID and the hash is a
reduce-time refusal; a basis-only revision therefore cannot be confused with an
earlier equal-content revision. M23's `verify_concept` computes this same
construction at attestation time. It never appears in `BeliefBasis` and cannot
increase lineage support.

### Positive independence primitive

```text
observation.independence_recorded = {
  ...common,
  left_observation_event_id: <event-id>,
  right_observation_event_id: <event-id>,
  proof:
    { kind: "distinct_firsthand_origin",
      left_source_registration_event_id, right_source_registration_event_id,
      rule_version }
  | { kind: "independent_system_artifact",
      left_source_registration_event_id, right_source_registration_event_id,
      rule_version }
  | { kind: "human_confirmed",
      left_source_registration_event_id, right_source_registration_event_id,
      proposal_id, decision_event_id },
  reason: <non-empty string>
}
```

Both endpoints must be distinct committed Observations or earlier staged
Observation members of the same valid batch. The two registration refs must
match their endpoints. `distinct_firsthand_origin` requires two
`trusted_human_capture` assertions with `assertion_basis: firsthand` and
different registered actor IDs. `independent_system_artifact` requires two
`registered_direct_artifact` assertions whose non-null independence-domain IDs
are different. M25's deterministic prefilter may emit either proof in the same
batch as a new endpoint and its receipt. `human_confirmed` requires M24's HIGH
independence proposal plus its committed approving human-decision event; it is
unavailable until that body and validator ship. The reducer stores the unordered
pair. If known ancestry already connects the endpoints, the event is refused;
if later information exposes shared ancestry, M27 resolves the pair as
`known_same_lineage` and records an anomaly against the stale independence fact.
No event means unknown, never independent.

## Crash-safe logical batches

`append_batch(events, operation_key?)` is the only API for a state transition
that needs more than one event, including M23 assertion+revision capture and
M24 multi-proposal commits:

1. Preallocate a fresh `batch_id` and every member `event_id`; stamp the same
   `batch_id` into each member body. If supplied, derive member
   `idempotency_key`s from `operation_key` and ordinal.
2. Append the member frames contiguously without acknowledging them.
3. Append `batch.committed`:

   ```json
   {
     "schema": 1,
     "batch_id": "<same-id>",
     "idempotency_key": "<operation-key-or-null>",
     "actor": { "id": "system:ledger" },
     "occurred_at": null,
     "valid_from": null,
     "valid_to": null,
     "member_event_ids": ["<id-1>", "<id-2>"],
     "member_count": 2,
     "members_digest": "<sha256 of canonical member frames in order>",
     "operation_digest": "<sha256 of the symbolic logical member plan>"
   }
   ```

4. Fsync through the marker, then and only then return the batch receipt.

The reducer always indexes physical frames, buffers batch members, and applies
them to entity state only when a marker names the exact contiguous ordered set
and the digest matches. Schema or reduce-time refusal of any member refuses the
whole batch. A torn tail, orphan member, duplicate marker, interleaving, missing
member, or digest mismatch produces an anomaly and zero entity-state effect.
References between members are valid because all IDs are preallocated and the
batch is validated as a unit.

Before allocating physical IDs, the API represents same-batch references by
member ordinal and hashes that symbolic `{ kind, body }` plan with `batch_id`
unstamped. That is `operation_digest`; unlike `members_digest`, it is stable
across a retry whose physical IDs differ. If a retry supplies an `operation_key`
already committed with the same operation digest, `append_batch` returns its
prior receipt. Different content under that key is an idempotency conflict.
Orphaned, uncommitted attempts do not claim the key; a retry receives a fresh
physical `batch_id`.

## Reducer and index

`reduce` folds frames in `seq` order. Additive tables beyond M21's
`events`/`meta` are:

| Table | Purpose |
|---|---|
| `logical_batches` / `batch_members` | marker validity, commit state, operation-key replay |
| `state_versions` | reducer-owned CAS version and last event for each registered target class/ID |
| `sources` | portable registration, authority capability, and independence domain |
| `entities` / `aliases` | stable subject identity and aliases |
| `beliefs` | current revision, content hash, verification pointers |
| `belief_revisions` | ordered revision state and generating event ID |
| `belief_basis_links` | explicit Observation→revision role edges, including unsupported reason |
| `observations` / `lineage_edges` | tagged payload index and transformation ancestry |
| `derived_belief_sources` | explicit Belief-revision inputs to derived Observations |
| `observation_subject_resolutions` | additive effective subject attachments |
| `observation_independence` | positive unordered independence facts |
| `relations` | inter-belief relations |
| `reducer_anomalies` | seq/event/batch/code/detail for every refusal or malformed batch |

Contract:

- `state_versions(target_class, target_id)` starts at 1 on the first effect named
  below and increments once for each later named effect. M22 registers
  `observation`, `belief`, `entity`, `relation`, and `source`; later milestones
  add `proposal` and `comparison` without changing the rule. A batch validates
  every precondition against its pre-batch snapshot, then folds its members in
  order. Immutable targets still have a version so a create can use
  `expected_version: null` and later additive attachments can use CAS.
- Revision numbers are assigned by committed fold order. The revision row stores
  its generating `event_id`, which M23 places in the projection manifest.
- Plumbing bodies without `schema: 1` remain only in `events`; they fabricate no
  entity state or provenance.
- Rebuild-from-zero produces a byte-identical index, including anomalies and
  pending/orphaned batch diagnostics.
- Schema-invalid events and invalid batches never panic or silently skip; they
  produce deterministic anomaly rows.

The M22 event-to-version matrix is closed:

| Event | Version effects |
|---|---|
| `source.registered` | create its `source` at 1; duplicate/different re-registration is refused |
| `observation.recorded` | create its `observation` at 1; increment its already registered `source`; if a resolved subject names an unseen Entity, create that `entity` at 1 without incrementing an existing Entity |
| `observation.subject_resolved` attach/correct | increment the target `observation`; referenced Entities must already exist and are read-only |
| `observation.independence_recorded` | increment each distinct endpoint `observation` once |
| `belief.created` | create its `belief` at 1; if its resolved subject names an unseen Entity, create that `entity` at 1 without incrementing an existing Entity |
| `belief.revised` / `belief.attested` | increment the named `belief` once |
| `belief.relation` | create the `relation` at 1 on first add; increment it on each valid remove or later re-add |
| `entity.alias_added` | increment the existing target `entity` once |
| `batch.committed` / migration brackets | no registered-target version effect |

Lineage, Belief-basis, correction, subject-resolution-basis, and derived-Belief
references are reads unless another row explicitly names them. Multiple effects
on one target in a valid batch fold in member order after all CAS checks use the
pre-batch snapshot. Semantic references may name a valid earlier staged creation;
for example, `belief.created` first-registers an Entity at 1 and a later same-
batch alias addition advances it to 2. Every vector records the complete
resulting version map.

## Conformance vectors — the parity mechanism

The root `conformance/` directory is visible to both toolchains. Rust generates
JSON vectors of `{ events, expected_state, expected_refusals }` and asserts the
committed files match byte-for-byte. A minimal TS reducer in
`src/lib/epistemic/` replays every vector and asserts identical state and
refusals. No schema-v1 rule is independently reimplemented as hand-mirrored UI
guard logic.

Coverage floor:

- every M22-defined event body and Observation payload kind (M24 owns vectors for
  the reserved tombstone/proposal kinds once it defines their bodies);
- every source-registration tag/capability/key derivation, duplicate/conflict,
  pinned-registration mismatch, and authority-provenance downgrade/forgery;
- legacy-reference resource deduplication, case-sensitive identity, exact
  snapshot provenance mapping, metadata-preserving projection, missing-resource
  no-event behavior, and refusal to use a legacy registration for authority or
  independence;
- resolved, unresolved, and no-subject boundaries;
- every resolver tier's exact attach proof; valid correction; stale-prior,
  same-Entity, none, conflicting-attach, and bad-proof refusals;
- every lineage edge enum, canonical ordering, bad parent, duplicate, self, and
  same-batch-cycle refusal;
- every schema/reducer refusal above;
- linked and explicitly unsupported Belief revisions;
- field-change, relation-change, alias-add, and standalone human assertions,
  including explicit alias-removal refusal;
- valid and invalid `source_belief_revision_event_ids` plus its read-only
  version behavior;
- attestation and override exclusion from belief basis, plus a `belief.attested`
  whose `attested_content_hash` does not match the projection of its pinned
  revision event;
- a `belief.relation` add whose endpoint names no committed Belief;
- independence known only by a valid tagged firsthand/direct-artifact proof,
  shared-lineage precedence, invalid source/domain/actor proof refusals, and
  unknown in the absence of both; M24 later owns `human_confirmed` decision vectors;
- a valid two-member batch, missing marker, torn marker, wrong order/digest,
  duplicate marker, one invalid member, and same-batch references;
- relation-ID hashing, alias normalization/display preservation, revision
  ordering, and the complete event-to-version matrix.

## Projection function

`project()` is a pure function rendering reduced Belief state to OKF v0.2
markdown, byte-stable in frontmatter order, wikilink brackets, and trailing
newline. For every demo-vault `knowledge/*.md` file:

```text
project(reduce(migrate(file))) == read(file)
```

It writes nothing in M22. M23 arms it.

## Migration (deterministic, zero LLM calls)

Mapping:

| OKF source | Events emitted |
|---|---|
| concept file | `belief.created` with unsupported basis and the complete OKF frontmatter/body state; attestation if verified |
| each parseable `sources[]` entry | one deduplicated content-only `legacy_reference` registration per trimmed `resource`, plus one snapshot per entry; no fabricated assertion/hash |
| relation frontmatter | `belief.relation` |
| explicit aliases | `entity.alias_added` |

The full source objects—including citation-local `id`, title, author,
`last_modified`, usage count, and usage window—remain in the migrated Belief
fields from which byte-stable projection renders them. The supplementary
Observation does not try to flatten that object into provenance. For source
registration, identity is exactly the case-sensitive, trimmed, non-empty
`resource`; two entries with that resource share one `legacy_reference`
registration even when their citation-local metadata differs. An entry without
a parseable resource emits no registration or Observation and remains only in
the Belief fields, matching the current OKF parser's inability to treat it as a
source. There is no ID/title fallback and therefore no guessed source identity.

Each emitted snapshot has `subject: none`, empty lineage, null artifact hash,
and `raw_pointer = resource`. Its provenance maps
`source_system = "legacy_okf"`, `source_location = resource`,
`source_record_id = id | null`, `source_author = raw author | null`, with
`source_revision` and `source_workflow_state` null. `last_modified` and usage
metadata stay in Belief fields; the migrator does not turn a date-only value
into a fabricated RFC3339 instant. D8's unsnapshotted-reference events are
realized as exactly these `source_snapshot` observations with
`source_artifact_hash: null`.

The migrator first collects these unique registrations, sorts them by
`source_id`, and emits each with key
`source-register-v1:<store-uuid>:<source-id>`. It then emits path outputs in
two phases so no relation precedes an endpoint Belief: phase one walks the
sorted normalized paths emitting Belief creation, source snapshots by source
ordinal, aliases by normalized key, then attestation; phase two walks the same
sorted paths emitting `belief.relation` events by canonical tuple. The migrator
is armed only at M23.0 and has never run in production, so changing this
deterministic order — and any digest derived from it — is safe pre-freeze.
Every path output receives a deterministic key
`migrate-v1:<store-uuid>:<normalized-path>:<role>:<ordinal>` and is written by
`append_once(key, kind, canonical_body)`. A snapshot first resolves its
registration receipt and pins that event ID. `append_once` returns an already
committed identical event, appends when absent, and hard-refuses the same key
with different kind/body. It checks verified ledger frames, not merely SQLite,
so index loss cannot cause duplicate migration output.

Every stable ID inside a migrated canonical body is deterministic too. Define

```text
migrate_id(class, identity) = first_128_bits_hex(
  SHA-256("cerebro-migrate-id-v1\0" + store_uuid + "\0" + class + "\0" + identity)
)
```

The migrated `belief_id` identity is its normalized knowledge-relative path;
the implicit subject `entity_id` uses the same path under class `entity`.
Relation IDs use the relation formula above after endpoint IDs are known.
Source IDs use the fixed source formula. Event IDs remain core-allocated; a
later output that references an earlier migration event first resolves that
output's append-once receipt, so retries reuse the already committed event ID.
No restart path generates a fresh body ID and then asks `append_once` to ignore
the mismatch.

`source_digest` is SHA-256 over canonical JSON of the path-sorted array
`[{ "path": normalized_path, "content_hash": SHA-256(file_bytes) }]`.
`output_keys_digest` is SHA-256 over canonical JSON of the UTF-8-byte-sorted key
array. `planned_output_count` and `output_count` exclude the two migration
brackets and count exactly that key set.

The bracket bodies are fully versioned events:

```text
migration.started = {
  ...common, store_uuid: <uuid>, migration_schema: 1,
  source_digest: <sha256>, planned_output_count: <integer>
}

migration.completed = {
  ...common, store_uuid: <uuid>, migration_schema: 1,
  source_digest: <same sha256>, output_count: <integer>,
  output_keys_digest: <sha256 of sorted deterministic keys>
}
```

Their idempotency keys are respectively `migrate-v1:<store-uuid>:started` and
`migrate-v1:<store-uuid>:completed`. The completed body must agree with the
started body and with the committed keyed-output scan or it is refused.

`migration.started` pins `{ store_uuid, migration_schema: 1, source_digest }`.
On restart, a changed source digest before completion is a reconciliation error,
not a second epoch. `migration.completed` records the same identity plus
`output_count` and `output_keys_digest`. Completion is the fast whole-run guard;
per-output append-once keys are the prefix guard. Therefore a crash after any
committed prefix resumes without duplicating it, even when no completed marker
exists.

All migrated events use `actor: system:migrator`, source timestamps for
`occurred_at`, and migration time only in the core-stamped `ingested_at`.
Migration reads files and never writes projections. It is built and proven here
but armed only in M23.0.

## Error handling

| Failure | Behavior |
|---|---|
| schema-invalid body | deterministic `reducer_anomalies` row; reduce continues |
| source registration/provenance mismatch | refused; no Observation or privileged authority |
| lineage or basis edge to attestation/override | refused; no evidence edge |
| kill -9 before marker | physical prefix retained; retry uses a fresh batch |
| kill -9 after marker fsync before response | operation-key retry returns prior receipt |
| one invalid batch member | entire batch has zero entity-state effect |
| kill -9 mid-migration | append-once keys skip committed outputs and append only the remainder |
| migration source changes mid-epoch | refuse completion and enter reconciliation; never duplicate |
| mixed plumbing and schema-v1 bodies | reduce cleanly; plumbing creates no entity state |

## Testing

- Property tests cover encode→decode→encode for every body/variant and reject
  non-finite or tag/value-mismatched `TypedValue`s.
- Reducer rebuilds twice from zero to byte-identical dumps, including anomalies.
- Batch kill points cover every member boundary, the marker boundary, fsync, and
  acknowledgement loss.
- Vectors meet the coverage floor and replay green in Rust and TypeScript.
- Migration soak runs against a copy of demo-vault: byte-identical projection,
  unchanged mtimes, cold distiller queue, verified chain, byte-identical rebuild,
  kill/restart after every output, and no duplicated migration key.
- Existing e2e stays untouched and green; M22 writes no files.

## Non-goals

No write-path flip (M23) · no policy/expected-version enforcement (M24) · no LLM
calls · no new UI · no Claims table or split SourceArtifact/Assertion tables · no
HLC · no envelope change.

## Acceptance

The companion plan's acceptance matrix is the verbatim test list. Done means the
matrix is green, vectors cover every M22-defined body/refusal/batch state in both
suites, demo-vault round-trips byte-identically with mtimes and queue cold,
migration is restart-idempotent at every prefix, all Rust/TS/e2e gates pass, and
there is zero user-visible change.
