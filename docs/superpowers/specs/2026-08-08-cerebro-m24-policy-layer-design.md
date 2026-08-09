# Cerebro M24 — Policy as Data: Risk Classes, Versions, Typed Rejections — Design

**Date:** 2026-08-08
**Status:** Derived from the accepted Rev 3 roadmap (2026-08-08, D5/D10/D11) and the frozen coverage matrix (rows §10, §15, §18–§19, §28, §47, §52–§53, §71, §94). For owner review.
**Scope:** The complete mutation-governance skeleton, exercised with agents OFF:
the declarative policy table, the D5 risk ladder, the complete Proposal schema,
typed rejections with declared destinies, durable review and revert, the
transactional submitProposal channel, expected-version CAS, qualification
gates, the deterministic half of creation qualification, the high-stakes
stopping rule, silence-never-resolves, and the first epistemic-eval fixture
slice.
**Companion plan:** `../plans/2026-08-07-cerebro-m24-policy-layer.md` sequences the implementation. Where the two disagree, this spec wins.

## Context

M23 left one hard-coded governance decision (write_concept auto-applies at
LOW) and a reducer that carries per-entity revisions. M24 replaces the
hard-coded decision with the general mechanism — and does so before any agent
construct exists, so the entire skeleton is proven by synthetic proposals.
"On by default" (M26) is only defensible once writes are gated, rejections
are typed and visible, and versions are checked; M24 is that precondition.

**The core bet: policy is data, not code.** One declarative table loaded by
Rust and imported verbatim by TS. Hand-mirrored policy logic WILL drift — the
project already parses mcp.rs from a TS test to hold a 12-tool parity, and
that does not scale. If a rule cannot be expressed in the table, the table
format grows; a rule implemented as twin code in two languages is a
review-blocking defect. Escape hatch if interpreter drift ever appears:
compile the Rust policy crate to WASM for the mock — not preemptively.

## Governing invariants

1. **Two records, two destinies (D5).** The epistemic ledger receives valid
   proposals, applied mutations, *meaningful* policy rejections ("agent
   attempted to supersede a human-reviewed belief without sufficient
   verification" — epistemic history, Skeptic food), and human decisions. The
   operational log receives schema mistakes (`confidence: "banana"`),
   malformed MCP arguments, CAS races during internal retries, timeouts,
   quota failures. Every rejection code declares its destiny in the table.
   Otherwise the
   append-only ledger becomes "Claude forgot a required field 92,000 times."
2. **Agent-declared risk can only RAISE.** The static table assigns base risk
   per (op, target class); a proposal may declare higher, never lower. No
   consensus-of-models is a verification tier anywhere (§94).
3. **Proposals travel exclusively through the serde-validated proposal
   boundary** — never stdout JSON. In M24 that boundary is internal and
   test-only; its MCP tools are deliberately unregistered until M26. An
   invalid proposal is a typed result the eventual caller can retry against,
   bounded. Proposals accumulate server-side and apply through the M22/M23
   logical-batch commit protocol on a terminal commit call: a run that dies
   mid-stream applies no mutations or projections.
4. **Silence never resolves (§10, class (a) invariant).** Elapsed time or
   absence of new observations may alter freshness/coverage/attention but may
   never by itself transition anything to resolved/false/superseded. Landed
   here as a mechanical policy refusal because "quiet for 30 days → probably
   resolved" is the easiest regression a future maintenance pass can
   introduce.

## The policy table

Location: `shared/policy/policy.v1.json` at repo root — importable by vite
(TS) and `include_str!` (Rust); a test on each side asserts both loaded the
byte-identical artifact.

```json
{ "format": 1,
  "target_classes": ["observation", "belief", "entity", "relation",
                     "source", "proposal", "comparison"],
  "rejection_destinies": { "<RejectionCode>": "ledger | operational" },
  "thresholds": { "lineage_fan_in_high": <positive integer> },
  "escalators": [
    { "signal": "target_has_attestation", "floor": "HIGH" },
    { "signal": "lineage_fan_in", "above": "lineage_fan_in_high",
      "floor": "HIGH" } ],
  "ops": {
    "<op>": { "target_classes": ["<class>"],
              "base_risk": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
              "revert": "one_click" | "none",
              "allowed_transitions": ["<TransitionCode>"],
              "requires": ["<PredicateCode>"],
              "possible_rejections": ["<RejectionCode>"] } },
  "risk_ladder": {
    "LOW":      { "apply": "auto",   "journal": true },
    "MEDIUM":   { "apply": "auto",   "journal": true },
    "HIGH":     { "apply": "queued-human-card" },
    "CRITICAL": { "apply": "queued-human-card", "review": "diff" } } }
```

D5's per-op "max auto-apply risk" column is realized as this global
`risk_ladder` object — semantically equivalent for v1. Reversibility is
per-op, not implied by MEDIUM risk. `target_classes` is the closed set an op's
exact event plan may read or mutate; the interpreter refuses a target whose
class is absent, then requires the top-level CAS set to equal the plan's
preallocated read/write targets exactly.

The table accepts only these predicate codes:
`actor_matches_run | target_set_exact | versions_current | basis_refs_valid |
candidate_receipt_current | exact_equivalence_proven | alias_unbound |
qualification_roles_present | trusted_observation_provenance |
high_stakes_route_satisfied | independence_confirmable |
silence_transition_allowed | absence_coverage_complete |
subject_correction_current | revert_current_and_invertible |
conflict_capability_available | open_contradictions_addressed`. M26 adds
`no_self_ancestry` to the same versioned schema before live registration; it
cannot inject an unversioned predicate. Transition codes are exactly
`append | create | revise | qualify | supersede | relation_add |
relation_remove | contest_open | conflict_classify | alias_add |
subject_correct | independence_confirm | exact_merge | entity_merge | split | tombstone | archive |
deprecate | mass_supersede | forward_revert`; the canonical-event table below
defines each expansion.

Rejection destiny is one global closed registry, not repeated inconsistently
under each op:

| Destiny | `RejectionCode` |
|---|---|
| operational | `schema_invalid`, `malformed_arguments`, `run_actor_mismatch`, `internal_cas_race`, `idempotency_key_reused`, `capability_unavailable` |
| ledger | `risk_lowered`, `target_set_mismatch`, `invalid_reference`, `untrusted_provenance`, `stale_target_version`, `policy_precondition_stale`, `candidate_receipt_missing`, `candidate_receipt_stale`, `candidate_receipt_caller_authored`, `candidate_unconsidered`, `qualification_missing`, `high_stakes_verification_required`, `independence_not_confirmable`, `silence_transition_forbidden`, `absence_coverage_incomplete`, `absence_coverage_mismatch`, `alias_collision`, `subject_resolution_stale`, `subject_resolution_mismatch`, `equivalence_not_proven`, `equivalence_receipt_stale`, `self_ancestry`, `contradiction_preservation_required`, `contradiction_edge_stale`, `illegal_transition`, `revert_not_current`, `revert_not_supported`, `human_rejected`, `atomic_set_refused` |

The table lists only codes possible for that op. Unknown codes, predicates,
transitions, target classes, or a code missing from the global registry fail
table load before either interpreter starts. The ledger-destined
`self_ancestry` code is registered (reserved) in this closed registry from
policy.v1 so the registry is closed from birth; its binding predicate
`no_self_ancestry` arrives with policy.v2 (M26) — until then the code is
registered but unbound.

`RuleCode` is the closed union `PredicateCode | TransitionCode | risk_ladder |
target_version | candidate_receipt | commit_set | human_decision`.
`proposal.rejected.rule` and the rejected return variant use it; `expected` and
`actual` are always M22 `TypedValue`s, never untyped JSON/null. Version and
state mismatches use scalar tagged values; missing data uses
`{type:"missing"}`; `human_rejected` uses expected `"approve"` and actual
`"reject"`; `atomic_set_refused` uses an object actual value containing exactly
`refused_by_proposal_id` and its `RejectionCode`. Schema/transport errors never
construct `proposal.rejected` and return their typed operational error shape
instead.

M26's `self_ancestry` refusal is ledger-destined and binds
`rule: no_self_ancestry`; `expected` is `{type:"boolean",value:true}` and
`actual` is `{type:"object",value:{target_belief_id,
reached_revision_event_id,support_observation_event_id}}`, with all three
values typed strings. These name the proposed target, reached revision, and
ancestry-walk root exactly; there is no free-form detail field.

### Shared authority-route contract

`shared/policy/authority-routes.v1.json` is the current byte-identical Rust/TS
artifact; every released content snapshot is also retained as a
content-addressed snapshot at
`shared/policy/authority-routes/<artifact_hash>.json`. Its closed schema is:

```text
AuthorityRoutesV1 = {
  format: 1, artifact_version: positive_integer,
  routes: [AuthorityRoute...]
}
AuthorityRoute = {
  authority_route_id, authority_rule_version: positive_integer,
  predicate_classes: [non_empty_string...],
  state_stages: [planned | approved | implemented | validated |
                 deployed | shipping | unknown...],
  criteria: [
    { kind: direct_artifact,
      observation_kind: extracted_assertion,
      registration_kinds: [builtin | connector...],
      authority_capability: direct_system_artifact,
      require_source_artifact_hash: true, require_raw_pointer: true }
    | { kind: responsible_owner_firsthand,
        observation_kind: human_assertion,
        registration_kind: human_actor,
        authority_capability: human_assertion,
        relationship_roles: [project_owner],
        assertion_bases: [firsthand | responsible_owner...] }
    | { kind: firsthand_observer,
        observation_kind: human_assertion,
        registration_kind: human_actor,
        authority_capability: human_assertion,
        relationship_roles: [project_owner | team_member | adjacent...],
        assertion_bases: [firsthand] }
  ]
}
AuthorityRouteRef = {
  authority_route_id, authority_rule_version, artifact_hash
}
```

`artifact_hash` is lowercase SHA-256 of the complete canonical artifact. Route
IDs are stable; `(authority_route_id, authority_rule_version)` is unique and
never reused for changed content. All arrays are non-empty, sorted, unique;
each route has at most one criterion of each closed class. An edit bumps the
artifact version and every changed route's rule version, while the prior hash
remains loadable. Table load rejects duplicate applicability, unknown source/
stage/role/basis values, a criterion whose fixed observation kind differs, or
a current file that does not equal its content-addressed snapshot.

Matching is exact over Proposal `intended_use.predicate_class`, the
Observation assertion predicate/stage/kind and its pinned portable M22
`source.registered` record. `direct_artifact` requires a `builtin|connector`
registration with `authority_capability: direct_system_artifact`, trusted
`authority_provenance: registered_direct_artifact`, plus the M22 artifact hash
and raw pointer; human authorship cannot satisfy it. Human routes require a
`human_actor` registration bound to the capture actor, capability
`human_assertion`, provenance `trusted_human_capture`, and their explicit
relationship/basis intersection. `agent_inferred` cannot satisfy any authority
route. The successful tuple `(authority_route_id,
authority_rule_version, artifact_hash, assertion_event_id)` is the same input
M27 later stores in `AuthorityScope` (with artifact hash available through the
immutable snapshot), so authority is predicate/stage-specific and rebuildable.

**Op inventory v1** (the D5 ladder):

| Risk | Ops | One-click inverse |
|---|---|---|
| LOW | `append_observation`, `cache_source`, `create_belief` (draft), `merge_beliefs_exact` | none |
| MEDIUM | `update_belief`, `supersede_belief`, `promote_draft`, `edit_relation`, `contest_belief`, `classify_conflict`, `add_entity_alias`, `revert_proposal` — on non-human-reviewed targets | `update_belief`, `supersede_belief`, `promote_draft`, `edit_relation`, `contest_belief` only |
| HIGH | anything touching a human-reviewed belief, `correct_observation_subject`, `confirm_observation_independence`, `split_belief`, `tombstone_belief`, `archive_belief`, `deprecate` | none |
| CRITICAL | `merge_entities`, `mass_supersede` | none |

The per-op allowed target classes are closed as follows: append =
`observation, source, entity`; cache = `observation, source`; create =
`belief, observation, entity`; update = `belief, observation`; split = `belief,
observation, entity, relation, comparison`; supersede,
exact-belief merge, and mass-supersede = `belief, relation, comparison,
observation`; promotion and all
belief lifecycle ops = `belief`; relation edit = `relation, belief,
observation, comparison`; contest =
`belief, observation`; conflict classification = `comparison, belief, observation`;
alias addition = `entity`; entity merge = `entity, belief, relation,
comparison, observation`; subject
correction = `observation, entity`; independence confirmation = `observation`;
revert = `proposal` plus only the classes
named by its stored `RevertPlan`. Read-only evidence targets still
carry their current version when additive attachment state can change; the
exact planned set, not this allowed-class superset, is the CAS set.

A `classify_conflict` target set is exactly the comparison, its two distinct
endpoint Beliefs derived from committed comparison state, and every basis
Observation. Resolved outcomes emit only `conflict.classified`: comparison
`+1`, endpoint Beliefs and Observations read-only. Unresolved
`genuine_direct | partial | conditional` outcomes add same-batch
`contradiction.opened`: comparison `+2` total and each endpoint Belief `+1`,
with Observations read-only. A caller-supplied endpoint is never authoritative;
any missing/extra/mismatched target is `target_set_mismatch`. The op remains
`capability_unavailable` until M27 installs these exact bodies and effects.

M22 creates an unseen Entity when `observation.recorded` or `belief.created`
first carries its resolved subject. Accordingly append/create include that
Entity target with `expected_version: null`; if it already exists, they include
its current version. `source_snapshot` cache has subject `none` and cannot take
this branch. Omitting the applicable Entity is `target_set_mismatch`.

The similarly named merge operations are intentionally different.
`merge_beliefs_exact` is LOW only with a server-minted deterministic receipt
proving the records have the same stable subject, scope, temporal interval,
normalized content, and no conflicting attestation; it aliases revisions to
one survivor without merging entities. `merge_entities` changes identity and
is always CRITICAL. `split_belief` is HIGH because assigning existing evidence
and revisions between new beliefs is interpretive; attestation and fan-out
escalators may raise it to CRITICAL. `add_entity_alias` is MEDIUM and refuses
an alias already bound to another entity. `classify_conflict` stores the
structured scope/stage/temporal/granularity outcome that M27 computes; it is
MEDIUM with the normal attestation and fan-in escalators. `revert_proposal` is a new
forward mutation, never deletion: its effective risk is floored at the larger
of MEDIUM, the original effective risk, and the risk of the inverse mutation.
Only still-current, auto-applied changes can therefore be one-click auto-
reverted. Alias addition, conflict classification, subject correction,
split/merge, creation, tombstone, and archive/deprecation have no v1 one-click
inverse; a later correction is a new ordinary proposal rather than an invented
removal opcode.

`contest_belief` records a contest relation (MEDIUM base; the attestation
escalator floors it HIGH on human-reviewed targets); its Validity surfacing
activates with M27's contested axis. `archive_belief` is a tombstone-class,
provenance-preserving lifecycle transition distinct from tombstone — HIGH.
All six §16 epistemic transitions are represented in M24; M26 may construct
them but does not introduce an ungoverned opcode.

Deterministic risk escalators, never the agent's own estimate: target has an
attestation → floor HIGH; lineage fan-in above threshold → floor HIGH. Both
are table `escalators` entries — signals `target_has_attestation` and
`lineage_fan_in`, each `floor: HIGH`; the fan-in threshold is the named
`thresholds.lineage_fan_in_high` value in policy.v1.json, never code — and
each escalator carries a golden.

**Tripwire** (the write_target pattern, mcp.rs:1362): a test enumerates every proposal op
the code can construct and fails if any is unmapped in the table. No op ships
unmapped, ever.

**Golden fixtures**: `shared/policy/goldens/*.json` — proposal + state
preconditions → expected verdict + destiny — run by both suites from the one
shared artifact. The goldens exist *before* the Rust interpreter so the
table's semantics are settled as data first.

## The proposal channel

### Proposal schema v1

The schema is complete here rather than an open-ended envelope. `targets` is
non-empty; basis-reference arrays may be empty when the op permits it; IDs are
stable opaque IDs; every enum is closed and serde rejects unknown values.

```json
{
  "schema": 1,
  "proposal_id": "<stable-id>",
  "run_id": "<run-id>",
  "targets": [
    { "target_id": "<stable-id>",
      "target_class": "observation | belief | entity | relation | source | proposal | comparison",
      "expected_version": 7 }
  ],
  "op": { "kind": "<discriminator>", "payload": {} },
  "intended_use": {
    "kind": "draft_note | reversible_work | operational_decision | production_release | safety_or_compliance",
    "stakes": "LOW | MEDIUM | HIGH | CRITICAL",
    "predicate_class": null
  },
  "basis": {
    "transition_cause": "new_evidence | human_correction | qualification_met | conflict_resolution | maintenance | revert | elapsed_time | absence_of_observations",
    "evidence_refs": ["<observation-event-id>"],
    "coverage_refs": ["<coverage-assessment-id>"],
    "authority_refs": ["<observation-event-id>"],
    "authority_route_refs": [
      { "authority_route_id": "<stable-id>", "authority_rule_version": 1,
        "artifact_hash": "<sha256>" }
    ],
    "addressed_contradictions": [
      { "edge_id": "<stable-id>", "comparison_id": "<stable-id>",
        "disposition": "resolved_with_evidence | superseded_with_addressing",
        "evidence_refs": ["<observation-event-id>"] }
    ],
    "absence_claim": false
  },
  "declared_risk": "LOW | MEDIUM | HIGH | CRITICAL",
  "reason": "<human-readable explanation>",
  "candidate_search_receipt": null
}
```

`expected_version` is nullable only for a target created by this proposal.
Multi-target ops name every read/write target and its expected version; an op
may not hide a target in free-form payload. `reason` is display-only. Policy
rules inspect `op.kind`, typed payload fields, `intended_use`, `basis`, and
server-minted receipts — never words in `reason`.

`op.payload` is a tagged union, with a dedicated serde struct for each op:

| `op.kind` | Required payload |
|---|---|
| `append_observation` | `{ observation }`, the complete server-canonical M22 body; it is never accepted directly from an agent DTO |
| `cache_source` | `{ source_id, artifact_hash, raw_pointer }` |
| `create_belief` | `{ belief_id, subject, content, fields, basis: BeliefBasis, distinctness_reason }` |
| `update_belief` | `{ belief_id, patch, basis: BeliefBasis }`; `patch` may be empty only for a changed-basis revision |
| `supersede_belief` | `{ belief_id, successor_id }` |
| `promote_draft` | `{ belief_id, qualification_profile: QualificationProfileRef }` |
| `edit_relation` | `{ relation_id, action: add|remove, from, to, relation }` |
| `contest_belief` | `{ belief_id, counterevidence_refs }` |
| `classify_conflict` | `{ comparison_id, outcome: same_meaning|resolved_temporally|resolved_by_scope|resolved_by_stage|resolved_by_granularity|genuine_direct|partial|conditional, basis_refs: [ObservationEventId...] }` |
| `add_entity_alias` | `{ entity_id, alias }` |
| `correct_observation_subject` | `{ observation_event_id, prior_resolution_event_id, from_entity_id, to_entity_id, resolver_tier: exact_id|known_alias|explicit_relation|normalized_match, basis_event_ids, reason }` |
| `confirm_observation_independence` | `{ left_observation_event_id, right_observation_event_id, basis_event_ids, reason }` |
| `merge_beliefs_exact` | `{ survivor_id, merged_ids, equivalence_receipt: EquivalenceReceipt }` |
| `merge_entities` | `{ survivor_id, merged_ids, reassignment_plan: EntityReassignmentPlan }` |
| `split_belief` | `{ belief_id, primary_output_id, outputs: [SplitOutput...], evidence_assignment: [EvidenceAssignment...] }` |
| `tombstone_belief` | `{ belief_id, replacement_id, reason_code: duplicate|superseded|invalid|owner_requested }` (`replacement_id` nullable) |
| `archive_belief` | `{ belief_id, replacement_id: null }` |
| `deprecate` | `{ belief_id, replacement_id }` (`replacement_id` nullable) |
| `mass_supersede` | `{ replacements: [SupersedePair...] }` |
| `revert_proposal` | `{ applied_proposal_id, applied_event_ids }`; the server loads the stored `RevertPlan` |

The remaining nested structs are closed:

```text
FieldRole = failure_condition | impact | evidence | trigger | completion_condition
          | owner | verb
AgentObservationDraft =
  agent_extracted_assertion { ingest_context_id, assertion_kind, predicate,
    value: TypedValue, scope, extracted_text, extractor_version }
| agent_derived_content { source_observation_event_ids, assertion_kind,
    predicate, value: TypedValue, scope, rendered_text, generator_version }
AddressedContradiction = {
  edge_id, comparison_id,
  disposition: resolved_with_evidence | superseded_with_addressing,
  evidence_refs: [<observation-event-id>...]
}
QualificationProfileRef = {
  type_id, type_schema_hash,
  required_roles: [FieldRole...] // non-empty, unique
}
EquivalenceReceipt = {
  receipt_id, index_head,
  belief_ids: [<belief-id>...], // sorted survivor + merged IDs
  subject_id, scope_digest,
  valid_interval: null | { from: null | <RFC3339>, to: null | <RFC3339> },
  normalized_content_hash, attestation_conflict: false,
  merged_basis: BeliefBasis,
  relation_rewrites: [RelationRewrite...]
}
RelationRewrite = {
  prior_relation_id, prior_from, prior_to,
  relation: supersedes | refines | contradicts,
  disposition: collapse_self | reuse_existing | add_replacement,
  replacement: null | { relation_id, from, to,
                         relation: supersedes | refines | contradicts }
}
EntityReassignmentPlan = {
  survivor_id, merged_ids: [<entity-id>...],
  affected_belief_ids: [<belief-id>...],
  live_aliases: [{ normalized_alias, alias_event_id, from_entity_id }...],
  affected_relation_ids: [<relation-id>...],
  plan_digest: <sha256>
}
SplitOutput = {
  belief_id, subject, content, fields
}
EvidenceAssignment = {
  observation_event_id, role: supports | opposes | context,
  output_belief_id
}
SupersedePair = { belief_id, successor_id }

RevertPlan = {
  source_operation_digest,
  expected_post_versions: [{ target_class, target_id, version }...],
  steps: [
    { kind: belief_revised, belief_id, patch, basis: BeliefBasis }
    | { kind: lifecycle_restored, belief_id, from: superseded, to: active,
        relation_id, successor_id }
    | { kind: qualification_restored, belief_id, from: qualified, to: draft,
        qualification_profile: QualificationProfileRef }
    | { kind: relation_restored, relation_id, action: add | remove,
        from, to, relation }
    | { kind: contest_closed, belief_id, open_contest_event_id,
        addressed_by: revert_application }
  ]
}
```

All ID arrays are non-empty where the op is plural, sorted and unique in their
canonical form. Receipt/plan IDs are server-minted; hashes cover the complete
canonical nested value. `EquivalenceReceipt.belief_ids` must exactly equal the
payload set. Its `merged_basis` is the canonical sorted/unique union of every
linked basis entry on the survivor/merged beliefs (or the survivor's current
unsupported basis when no link exists), and `relation_rewrites` exactly covers
the current live relations incident to a merged ID in prior-relation-ID order.
For each rewrite, replacing every merged endpoint with the survivor either
collapses a self-edge, reuses an already-live canonical tuple, or supplies the
exact M22-derived replacement ID; those dispositions respectively require
`replacement: null`, `null`, or the complete replacement. An omitted/extra or
stale relation is `equivalence_receipt_stale`.

`EntityReassignmentPlan` must enumerate every currently indexed
belief, alias, and relation affected by the identity merge; an omitted or
extra target is `target_set_mismatch`. Each alias entry pins its originating
M22 alias event and carries that event's canonical `normalized_alias`; display
spelling is never hashed as identity. A split's `primary_output_id` names one
output. Every prior basis link appears exactly once in `evidence_assignment`,
and every assignment names one declared output; an output basis is derived as
the canonical assigned links or exactly `{state:"unsupported",
reason:"split_output_without_assigned_evidence"}` when none. `mass_supersede`
has unique predecessors and every predecessor and successor appears in
`targets`. A stored contest inverse keeps only the symbolic
`addressed_by: revert_application`; the future event ID is never guessed or
hashed into the original application.

The top-level `targets` are the CAS set; payload IDs must match it exactly.
No generic JSON-patch or arbitrary event-payload bypass exists.

For `append_observation`, the server preallocates the Observation event ID,
uses it as a created `observation` target, and stamps actor, content times,
batch, and idempotency fields from trusted request/session state. The agent
serde DTO is the closed `AgentObservationDraft`: it cannot name `source_id`,
`source_registration_event_id`, `authority_provenance`, relationship role,
assertion basis, artifact hash/raw pointer, or any common field, and cannot
select `human_assertion`, `source_snapshot`, or `system_event`. The server
resolves its run/ingest context to M22's portable `source.registered`, binds the
source and registration event, and canonicalizes agent observations with
`authority_provenance: agent_inferred`; an unknown privileged field is refused,
not overwritten.

Only typed internal constructors can produce the complete payload directly:
M23 trusted human capture binds a `human_actor` registration/actor and
`trusted_human_capture`; M25 trusted ingestion may bind a registered
`direct_system_artifact` and `registered_direct_artifact`; trusted runtime code
alone may produce source snapshots or system events. Every combination is
validated again against the pinned registration. An actor, variant,
capability, or provenance mismatch is `untrusted_provenance`; policy never
trusts the display assertion metadata without this chain.

`comparison_id` is M26's stable
pinned-endpoint hash and targets the `comparison` class; the op returns
`capability_unavailable` until M27 registers the classifier event body. For
create/update, every Observation named by payload `basis.linked.links` must also
appear in top-level `basis.evidence_refs`. An empty update patch is legal only
when its full canonical BeliefBasis changes; it creates M22's support-only
revision for corroboration with no content diff. An empty patch plus unchanged
basis is a schema-refused no-op.

`correct_observation_subject` expands only to M22's tagged correction:
`observation.subject_resolved.change = { action: correct,
prior_resolution_event_id, from_entity_id, to_entity_id, resolver_tier,
basis_event_ids, reason }`. Targets are the Observation plus both existing
Entities at current versions. The prior event must be that Observation's
current effective resolution, `from_entity_id` must match it,
`to_entity_id` must differ and exist, and basis/reason are non-empty. A stale
prior event is `subject_resolution_stale`; a mismatched endpoint is
`subject_resolution_mismatch`. The op is HIGH and non-reversible. Policy table
load returns `capability_unavailable` until the M22 correction body, validator,
reducer effect, and conformance vectors are present; no live registration can
precede that dependency.

`confirm_observation_independence` is the sole M24 human-confirmed producer of
M22's positive independence fact. It targets two distinct committed assertion
Observations plus every basis Observation at current versions, requires a
non-empty sorted/unique basis and reason, refuses any known ancestry path or
missing/mismatched source registration, and is always HIGH/non-reversible. An
approval batches `observation.independence_recorded` with
`proof: { kind: human_confirmed, left_source_registration_event_id,
right_source_registration_event_id, proposal_id, decision_event_id }`, where
the decision ID is the actual approving `proposal.decision_recorded` event;
callers cannot author the proof tag or
decision reference. The M22 event advances each endpoint Observation once;
basis Observations are read-only. M25's deterministic producers use the other
two basis tags under their stricter registered-origin rules and never route
through this human-confirmed op.

`add_entity_alias.alias` is the original display spelling. Before policy or
append, the server computes `normalized_alias = normalize_alias_v1(alias)`
using M22's frozen Unicode-15.1 algorithm and emits both fields in
`entity.alias_added`; a caller-supplied normalization cannot override it.
Empty normalized output and a normalized key already owned by a different
Entity are refused. Alias lookup, collision checks, and merge reassignment all
use the normalized key, while the original spelling remains display data.

Relation identity is equally canonical. For `edit_relation`, the supplied
`relation_id` must equal M22's lowercase hex128 first 128 bits of
`SHA-256("cerebro-relation-v1\0" + canonical_json([from, to, relation]))`.
`supersede_belief` derives the ID for its server-created successor relation by
the same rule. A mismatched caller ID is schema-refused before policy; neither
operation can create a second identity for the same relation tuple.

`edit_relation(action: add, relation: contradicts)` is the one special
relation expansion. The server derives M26/M27's complete pinned assertion
endpoints and comparison ID from the two current Beliefs; its exact targets are
the new Relation, both endpoint Beliefs, endpoint/basis Observations, and the
Comparison (expected null when unseen, current otherwise). Under M27 capability
the batch order is relation add, `conflict.comparison_registered` only when
unseen, `conflict.classified(outcome: partial, classification:
deterministic { rule_version: declared_contradicts_relation },
reason_codes: [declared_contradicts_relation])`, then required
`contradiction.opened` — partial is an unresolved class, so the edge still
opens and the preservation gate still protects it. Deterministic
`genuine_direct` remains reserved for M27's typed-value incompatibility rule
(reason `incompatible_values`); a declared relation asserts a conflict that
has not yet passed M27 scope/stage resolution, hence `partial`. A new
comparison therefore reaches v3 (register,
classify, open); an existing compatible comparison advances twice; each
distinct endpoint Belief advances once on open, Observations remain read-only,
and the Relation is created at v1. Reusing an ID for different endpoints is
refused. Before M27 registers that closed expansion the add is
`capability_unavailable`; removing a `contradicts` relation never closes an
edge or changes a Comparison because relation absence is not resolution.

`basis.addressed_contradictions` is required (empty when none) for
`supersede_belief`, `mass_supersede`, `merge_beliefs_exact`, `merge_entities`,
and `split_belief`, and forbidden for unrelated ops. Immediately before append,
the interpreter derives every still-open M27 contradiction edge incident to a
Belief whose identity or active lifecycle the operation changes. The supplied
sorted/unique edge set must equal that complete derived set; each entry's
comparison and two distinct endpoints must match reducer state. Every entry
requires non-empty sorted/unique Observation evidence that is a subset of
top-level `basis.evidence_refs`, and top-level CAS targets must include the
comparison, both endpoint Beliefs, and those Observations at current versions.
An omitted/new edge is `contradiction_preservation_required`; a closed,
mismatched, or replaced edge is `contradiction_edge_stale`.

For an accepted entry, the server preallocates the addressing mutation event
and emits M27 `contradiction.closed` immediately after it in the same logical
batch, carrying edge/comparison/endpoints, the declared disposition/evidence,
and `addressed_by_event_id` set to that mutation event. The caller cannot author
that ID. Thus supersede/merge and every required close become visible together;
the close applies M27's comparison/endpoint version effects in addition to the
mutation's own effects. A final set application re-runs the complete open-edge
query and all CAS checks; approval or reason prose cannot bypass it. Until M27
registers its closed body/reducer/vectors, a non-empty addressing list returns
`capability_unavailable` rather than emitting an untyped close.

Validation also requires an agent proposal's `run_id` to match its actor,
every evidence/authority reference to resolve to an M22 Observation (authority
refs are a subset of evidence refs), each authority route ref to resolve by
ID/version/hash in the immutable artifact set, every authority Observation to
match at least one supplied route, and every supplied route to be used. Every
coverage reference resolves to a subject/scope-compatible assessment, and
every payload read/write ID appears in `targets`. The active policy artifact
must still select the pinned route version at append time; a route edit makes a
queued proposal `policy_precondition_stale`. Transport/schema failures are
operational; a well-formed proposal refused on these epistemic preconditions
follows the table's declared destiny.

For `create_belief`, `candidate_search_receipt` is required and has this v1
shape:

```json
{
  "receipt_id": "<stable-id>",
  "index_head": "<ledger-chain-head>",
  "search_version": 1,
  "exact":  { "query": "<normalized identity>", "candidate_ids": [] },
  "aliases": { "queries": ["..."], "candidate_ids": [] },
  "scoped": { "subject_id": "<stable-id>", "scope": {},
              "valid_interval": null, "candidate_ids": [] },
  "semantic": { "status": "not_available", "candidate_ids": [] },
  "considered": [
    { "candidate_id": "<belief-id>",
      "decision": "update | qualify | distinct",
      "reason": "<human-readable>" }
  ]
}
```

The server mints the receipt from the current reducer/index head; callers
cannot assert that a search happened. M24 validates deterministic exact,
explicit-alias, and scoped/temporal lookup and refuses stale receipts. M26
upgrades the receipt schema with an actually attempted semantic-candidate
search and makes that field mandatory **before** proposal tools are
registered or agents become default-on. Thus §15's full search path is a
joint M24/M26 handoff, not a false claim that semantic retrieval exists in
M24. `write_concept` keeps its public arguments unchanged: the server performs
these searches, enriches the internal `create_belief` proposal, and then runs
policy.

### Canonical mutation events

Every accepted op expands to a closed event plan before policy computes its
`operation_digest`; “mutation event” never means arbitrary JSON. M24 adds these
schema-v1 bodies to M22's additive vocabulary:

```text
belief.qualification_changed = {
  ...common, belief_id, from: draft | qualified, to: draft | qualified,
  qualification_profile: QualificationProfileRef, cause: promoted | reverted
}
belief.lifecycle_changed = {
  ...common, belief_id,
  from: active | superseded | archived,
  to: active | superseded | archived,
  cause: superseded | archived | deprecated | reverted,
  replacement_id: null | <belief-id>
}
belief.tombstoned = {
  ...common, belief_id, replacement_id: null | <belief-id>,
  reason_code: duplicate | superseded | invalid | owner_requested
}
belief.contested = {
  ...common, belief_id, action: open | close,
  counterevidence_refs: [<observation-event-id>...],
  addressed_by_event_id: null | <event-id>
}
entity.merged = {
  ...common, survivor_id, merged_ids: [<entity-id>...],
  reassignment_plan: EntityReassignmentPlan,
  reassignment_digest: <sha256>
}
```

A created Belief has active lifecycle and draft qualification. Legal
qualification/lifecycle transitions are exact: promotion is `draft →
qualified`; its stored inverse is `qualified → draft`; supersede is `active →
superseded` with a required successor and relation; archive is `active →
archived` with `replacement_id: null`; deprecate is `active → archived` with a
nullable replacement and `cause: deprecated`; a stored lifecycle inverse is
`superseded → active` with `cause: reverted`. Tombstone is a distinct,
non-reversible `active|superseded|archived → tombstoned` reducer lifecycle
derived from `belief.tombstoned`. Same-state transitions, a replacement equal
to the target, and every transition not listed here are `illegal_transition`.
For `belief.contested`, `open` requires non-empty counterevidence and a null
`addressed_by_event_id`; `close` requires the matching open contest and a
non-null addressing event.

Complex op member plans use one replacement convention: a replacement is
always relation `from`, and the replaced predecessor is `to`. Define
`supersede_members(predecessor, successor)` as, in order: (1) M22
`belief.relation(add, from: successor, to: predecessor, relation: supersedes)`
with the exact derived relation ID; (2)
`belief.lifecycle_changed(predecessor, active → superseded, cause:
superseded, replacement_id: successor)`; then (3) sorted required
`contradiction.closed` members whose earliest addressing mutation is that
lifecycle event. Both Beliefs must exist and differ, the predecessor must be
active, and the generated relation must not already be live.

The remaining complex plans are exact:

1. `merge_beliefs_exact` validates all beliefs active and iterates the receipt's
   sorted IDs. Emit a survivor empty-patch `belief.revised` exactly when
   `merged_basis` differs from its current basis. Next, for each
   `relation_rewrites` entry in prior-ID order, emit remove of the prior live
   relation, then emit its replacement only for `add_replacement`; collapse and
   reuse emit no add. Finally, for each merged ID in order, emit
   `supersede_members(merged, survivor)`. The target set is exactly every
   survivor/merged/relation endpoint Belief, basis/addressing Observation, old
   and new Relation, and addressed Comparison; a generated Relation has null
   expected version.
2. `split_belief` sorts outputs by belief ID, derives each basis from the
   assignment rule above, and emits all output `belief.created` members first.
   It then emits one M22 `refines` relation per output, `from: output`, `to:
   predecessor`, in output order. Last it emits the predecessor lifecycle
   `active → superseded` with `replacement_id: primary_output_id`, followed by
   its sorted contradiction closes. Targets are exactly the predecessor,
   output Beliefs (null), unique resolved-subject Entities (null only when
   unseen), assigned/addressing Observations, generated Relations (null), and
   addressed Comparisons.
3. `mass_supersede` sorts unique pairs by `(belief_id, successor_id)` and emits
   `supersede_members` for each pair without interleaving pairs. Shared
   successors are allowed and remain read-only; predecessors must be distinct.
4. `merge_entities` emits exactly one `entity.merged` with the complete plan,
   then sorted required contradiction closes. The event itself performs every
   enumerated Entity/Belief/Relation version effect; no hidden alias/relation
   side event exists.
5. `revert_proposal` executes stored `RevertPlan.steps` in their stored order.
   Simple steps emit one named event. `lifecycle_restored` emits relation remove
   (`from: successor`, `to: belief`, `supersedes`) then lifecycle
   `superseded → active`. `contest_closed` materializes symbolic
   `addressed_by: revert_application` to the preallocated new revert
   proposal's `proposal.applied` event ID. After all forward members, emit that
   new `proposal.applied`, then `proposal.reverted` for the original. No future
   physical ID exists in the original stored plan.

For every plan, arrays and generated work are traversed only in the orders
above. The `operation_digest` hashes the canonical symbolic member kinds,
bodies, target effects, and symbolic cross-member references in that order; it
excludes fresh event/batch IDs. Preallocation then materializes the references
without changing the digest. The top-level CAS set must exactly equal all
mutated targets plus the explicit read targets named above; no expansion may
discover an unversioned target after policy acceptance.

The exact op expansion is:

| Op | Canonical effect |
|---|---|
| `append_observation` | one M22 `observation.recorded` |
| `cache_source` | one M22 `observation.recorded/source_snapshot`; cache bytes are a rebuildable operational projection |
| `create_belief` / `update_belief` | M22 `belief.created` / `belief.revised`, including the payload BeliefBasis |
| `supersede_belief` | M22-derived successor relation `add` plus `belief.lifecycle_changed` on the predecessor |
| `promote_draft` | `belief.qualification_changed` |
| `edit_relation` | ordinary M22 add/remove after exact relation-ID validation; `contradicts` add uses the comparison/classification/open expansion above |
| `contest_belief` | `belief.contested(action: open)` |
| `classify_conflict` | M27 classification expansion: `conflict.classified` plus same-batch `contradiction.opened` for an unresolved outcome; unavailable before those bodies/validators/reducers ship |
| `add_entity_alias` | M22 `entity.alias_added { entity_id, alias, normalized_alias: normalize_alias_v1(alias) }` |
| `correct_observation_subject` | one M22 `observation.subject_resolved` with `change.action: correct`; increments only the Observation target version |
| `confirm_observation_independence` | one M22 `observation.independence_recorded` with server-bound `human_confirmed` proof, endpoint registrations, proposal ID, and approval decision event |
| `merge_beliefs_exact` | exact member plan 1 above |
| `merge_entities` | exact member plan 4 above |
| `split_belief` | exact member plan 2 above |
| `tombstone_belief` | `belief.tombstoned` |
| `archive_belief` | `belief.lifecycle_changed(active → archived, cause: archived, replacement_id: null)` |
| `deprecate` | `belief.lifecycle_changed(active → archived, cause: deprecated, replacement_id from payload)` |
| `mass_supersede` | exact member plan 3 above |
| `revert_proposal` | exact member plan 5 above; `revert_not_supported` if the application stored no plan |

M24-new mutation effects on M22 `state_versions` are also closed:

| Event | Version effects |
|---|---|
| `belief.qualification_changed` | increment the named `belief` once |
| `belief.lifecycle_changed` | increment the named `belief` once; any companion `belief.relation` has its separate M22 relation effect |
| `belief.tombstoned` | increment the named `belief` once |
| `belief.contested` | increment the named `belief` once; counterevidence Observations are read-only |
| `entity.merged` | increment the survivor and every merged `entity` once, every `affected_belief_id` once, and every `affected_relation_id` once |

For `entity.merged`, those Entity, Belief, and Relation IDs are exactly its
write-target set; each must be present in top-level `targets` at its pre-batch
version. The survivor is disjoint from non-empty sorted/unique `merged_ids`,
all affected arrays are sorted/unique, and every enumerated alias event is
read-only provenance. The reducer rejects an omitted, extra, stale, or
multiply enumerated effect. Reindexing all enumerated identity references is
one event effect, so aliases do not increment the survivor repeatedly. If a
different event in the same valid batch also affects one of these targets,
normal M22 fold order adds that event's own increment after all CAS checks
have used the pre-batch snapshot.

M24 also performs M23's required projection-descriptor extension before any
new body emits. The manifest becomes format 2 and appends these canonical
per-Belief fields to `ProjectionStateDescriptor`:

```text
qualification_head_event_id: null | <latest qualification event>
lifecycle_head_event_id: null | <latest lifecycle event>
tombstone_event_id: null | <effective tombstone event>
contest_head_event_id: null | <latest open/close contest event>
entity_merge_event_ids: [<merge event affecting this Belief/subject, seq order>...]
```

Qualification/lifecycle/tombstone/contest bodies update the corresponding
named Belief descriptor component. `entity.merged` appends its event ID to
every `affected_belief_id` and every Belief whose rendered subject/alias view
the validated plan reassigns. The descriptor digest and `generating_event`
advance even when rendered bytes are unchanged. Format-1 migration rebuilds
each descriptor from the committed ledger, writes format 2 through M23's
manifest-first protocol, and never recaptures projection bytes. Cross-language
vectors cover each isolated component, combined same-batch order, entity merge,
and byte-identical output with a changed descriptor/head.

The reducer adds qualification, lifecycle, contest, and entity-merge indexes;
each body names its mutated CAS targets, rejects illegal transitions or missing
references, and has cross-language acceptance/refusal vectors. A new op cannot
ship until this table names its event expansion and the shared op-inventory
tripwire sees it. M27's conflict bodies follow the same rule in that milestone.

### Durable lifecycle and typed results

M22's reserved proposal kinds are extended additively with complete bodies.
Each body also carries M22's common fields, including `batch_id` and optional
`idempotency_key`; the fields below are the kind-specific portion:

- `proposal.submitted { proposal }` stores the validated schema above.
- `proposal.queued { proposal_id, commit_set_id, member_proposal_ids,
  effective_risk, policy_version, target_versions: [{ target_class, target_id,
  version }...], queued_at }` creates durable pending-review state for an
  all-or-nothing set.
- `proposal.decision_recorded { decision_id, proposal_id, decision:
  approve|reject, reviewer, decided_at, reason: null|string,
  reviewed_target_versions }` records either human choice. Reject requires a
  non-empty reason; approve requires null. Approval is authorization, not a
  CAS bypass.
- `proposal.applied { proposal_id, commit_set_id, effective_risk,
  decision_id, mutation_event_ids, resulting_versions, revert_plan:
  null|RevertPlan }` records success; `decision_id` is nullable only for
  auto-apply, and `revert_plan` is non-null exactly when the op's policy rule
  says `one_click`.
- `proposal.rejected { proposal_id, commit_set_id, code: RejectionCode,
  rule: RuleCode, expected: TypedValue, actual: TypedValue,
  decision_id: null|<decision-id>, refused_by_proposal_id: null|<proposal-id> }`
  records meaningful policy and human rejections. `decision_id` is required
  only for the human-rejected member; atomic peers name that proposal in
  `refused_by_proposal_id`. Malformed transport/schema and internal retry
  conflicts retain operational destiny.
- `proposal.reverted { proposal_id, reverted_by_proposal_id,
  prior_applied_event_ids, forward_event_ids, resulting_versions }` links the
  forward inverse to the earlier application without erasing either.

The reducer derives exactly one durable lifecycle state per proposal:
`submitted | queued | rejected | applied | reverted`. Duplicate terminal
events are refused. Pending review therefore survives restart and runtime-DB
loss; the operational DB may cache it but is never authoritative.

Proposal-class CAS effects are closed; each listed event increments exactly
the named proposal target once:

| Event | `state_versions(proposal, …)` effect |
|---|---|
| `proposal.submitted` | creates its `proposal_id` at v1; expected version was null |
| `proposal.queued` | increments its `proposal_id` |
| `proposal.decision_recorded` | increments the decision's `proposal_id` |
| `proposal.applied` | increments its `proposal_id` |
| `proposal.rejected` | increments its `proposal_id` |
| `proposal.reverted` | increments the original `proposal_id` named in the body |

A new revert proposal independently advances through its own
`proposal.submitted` and `proposal.applied` events while the same batch's
`proposal.reverted` advances the original. No event increments a commit-set
pseudo-target. Conformance vectors assert every row, same-batch fold order,
and stale expected-version refusal for both proposal IDs.

The proposal boundary returns
`applied { proposal_id, resulting_versions } | queued { proposal_id } |
rejected { proposal_id, code: RejectionCode, rule: RuleCode,
expected: TypedValue, actual: TypedValue }`. The store-layer
never-throw invariant is re-scoped in AGENTS.md (same commit) to human-UI
actions only; proposal channels return these typed results.

### Atomic application

Accumulation is keyed by `run_id`; a terminal `commit_proposals(run_id,
proposal_ids)` freezes the ordered set and derives `commit_set_id`. Policy
evaluates the entire set against one reducer snapshot. Any refusal leaves all
mutations unapplied: the offending proposal records its typed reason and every
peer records `atomic_set_refused` pointing to it. Those rejection events are
one M22 logical batch; a crash cannot terminally reject only part of the set.
If any member requires human review, **every** member becomes queued under the
same commit set; LOW/MEDIUM members are held, not silently applied. All
`proposal.queued` members are likewise one batch. Required approvals may be
recorded individually and idempotently while the set remains queued. A human
reject action batches its `proposal.decision_recorded` event with
`human_rejected` for that member and `atomic_set_refused` for every peer.

The set applies only after all required approvals. Immediately before any
terminal batch is planned, the interpreter re-runs every policy predicate over
the current reducer head—not only target CAS. It re-resolves evidence and
authority refs, verifies each referenced assessment is still
`coverage_current`, and re-runs the server candidate search at the current
index head. A changed candidate set/receipt or superseded coverage record
rejects the entire queued set as stale and offers a newly prepared proposal;
neither is silently refreshed inside the immutable proposal. This closes the
new-duplicate and stale-coverage windows that target-ID CAS alone cannot see.

Every commit-set transition uses M22 `append_batch` with a stable operation key:
initial set refusal, initial all-member queue, human set rejection, stale
precondition rejection, and final apply. The final apply preallocates event
IDs; writes contiguous mutation and `proposal.applied` members with one
non-null `batch_id`; then writes and fsyncs `batch.committed { batch_id,
member_event_ids, member_count, members_digest, operation_digest }`.
`operation_digest` hashes the symbolic ordered member plan before physical IDs
are stamped; `members_digest` hashes the resulting canonical member frames.
Physical frames remain
inspectable, but members are reducer-invisible until that marker validates.
Malformed, refused, or incomplete batches produce an anomaly/refusal and zero
entity-state effect. Only after the marker is durable does M23 project the new
reduced head through its manifest/reconciliation protocol. A projection crash
is repaired from the committed ledger and cannot turn a partial proposal batch
into visible state.

A dead run before terminal commit applies nothing. `proposal.submitted` uses
M22 `append_once(proposal_id, ...)`; `commit_set_id` derives from the run and
frozen ordered proposal IDs. Each set transition then uses a distinct stable
`operation_key = hash(commit_set_id, transition_code,
sorted_causal_decision_ids)`, where `transition_code` is `initial_queue |
initial_reject | human_reject | stale_reject | apply`. An acknowledgement-loss
retry compares that key and `operation_digest`, then returns the already
committed matching event/batch;
the same proposal ID or operation key with different canonical bytes is
refused as `idempotency_key_reused`.

- **The runtime DB is born here** — `<app-data>/runtime.db`, one
  `operational_log` table and `PRAGMA user_version = 1`, created in one
  transaction — because typed rejection noise needs a home before M25 exists.
  This is a deliberate small reordering of the roadmap's "see M25"; M24.6
  adds only `parked_promotions` (see Qualification), and M25 owns all further
  schema growth and transactional migrations.
- M23's hard-coded write_concept decision is **deleted**: `write_concept`
  server-enriches and routes a typed create/update op through the interpreter,
  which computes risk from the table; its public tool surface stays unchanged.
- **Agents stay OFF, mechanically:** proposal and commit tools are NOT
  registered on the loopback MCP server, and no mock tool stub pretends they
  are. M24 tests call the internal typed boundary directly. M26 has an
  explicit registration phase, after semantic candidate search is live and
  the preventive graph guards pass their fixtures, and before default-on. The live CLI agent's tool surface is unchanged in M24.
- **Ledger vocabulary creep**: proposal/rejection event kinds are additive;
  M22's discipline applies unchanged.

## expected_version (CAS)

A **ledger-entity concept, never a file concept** — file mtime is never a
version token; vault-plane files stay last-write-wins. Proposals carry
`expected_version` on every entry of `targets`; M22's reducer-owned
`state_versions(target_class, target_id)` is the sole comparison domain for
Beliefs, Observations, Entities, relations, sources, proposals, and M26/M27
comparisons. A mismatch on any target rejects the whole application, never
silently overwrites. Approval does not freeze
state: the policy engine rechecks every version immediately before batch
append **and** re-evaluates the current policy preconditions described above.
Coverage-current and candidate-index heads are reducer/index read dependencies,
not invented product target classes; freshness is protected by pre-append
revalidation. A stale queued card becomes `rejected` with
`stale_target_version`, remains visible with expected/actual versions, and
offers “prepare updated proposal”; it is never silently refreshed or applied.
CAS/batch semantics are explicitly out of mock scope (Rust-tested only); the
goldens mark version-conflict cases rust-only — by declaration, not omission.

## Qualification and creation rules

**Qualification gates as capability profiles.** Type-doc field role
annotations (`role: failure_condition`, `role: completion_condition`,
`role: owner`, …) — capability-gated, type-name-blind (the house
no-type-special-casing rule extended to policy). Promotion ops check presence
of required roles; unqualified items **park visibly** (persisted, queryable —
the M27 debt lane feeds on it), never blocking a human sketching a rough
note. Parked state is **operational, not ledger**: it is recomputable from
vault records plus qualification profiles, so per the standing when-in-doubt
rule it lives in the runtime DB, not the epistemic ledger. M24.6 adds the
`parked_promotions` table — `store_uuid`/`vault_id`, target record ref,
qualification profile ref, missing role fields, `as_of`, `cleared_at` — the
one M24 runtime-DB table beyond `operational_log`. A row is written when a
promotion is refused for missing roles, cleared when qualification later
passes, and is the query surface M27's epistemic-debt lane feeds on.
Qualification gates fire only on promotion ops; creating or sketching a rough
note never routes through them.

**Creation qualification (§15, enforceable in two explicit stages).** M24
requires the server-minted `candidate_search_receipt` plus the typed payload's
`distinctness_reason`. It proves exact-identity, explicit-alias, and scoped/
temporal lookups against a named index head, and records the disposition of
every returned candidate. Missing, stale, caller-authored, or unconsidered
results receive a typed rejection with destiny *ledger* (it is epistemic
history). M26 adds semantic candidate retrieval to the same receipt and makes
an attempted semantic leg a registration precondition for agent proposal
tools. The completed path is therefore exact identity → aliases → semantic
candidate → scoped/temporal candidate → update/qualify existing if defensible
→ create only if meaningfully distinct. Symmetrically, similarity alone never
forces a merge. `near_duplicates` is the backstop, not the mechanism.

**High-stakes stopping rule (§52/§71).** The interpreter reads
`intended_use.stakes`, `intended_use.predicate_class`, `basis.evidence_refs`,
`basis.coverage_refs`, `basis.authority_refs`, and
`basis.authority_route_refs`. For HIGH/CRITICAL use, every coverage reference
must resolve to a current M25 `coverage.assessed` record whose separate required
dimensions satisfy the policy, and the referenced Observations must match an
active predicate/stage rule in the exact versioned authority artifact above.
A structurally valid proposal with absent or insufficient live coverage/
authority queues with `high_stakes_verification_required`; a malformed,
unknown, wrong-subject, or stale reference rejects with `invalid_reference` or
`policy_precondition_stale`. There is no “queue or reject” implementation choice.
Example: `shipping_soc` at `shipping` stage requires a matching
`direct_artifact` or `responsible_owner_firsthand` criterion; “production
artifact” is not an unversioned code branch. Learned cross-source routes stay
M28+. Neither `reason` prose nor an agent's adequacy claim can satisfy this
rule. M24 implements the typed lookup/refusal interface and exercises exact
artifact/route/Observation combinations with goldens; until M25 persists
coverage and source registration, a well-formed proposal with no live match
queues for verification.

**Silence-never-resolves + absence enforcement.** A proposal with
`basis.transition_cause` equal to `elapsed_time` or
`absence_of_observations` may update freshness, coverage, or attention only;
an op payload that resolves, falsifies, tombstones, or supersedes is refused.
A formal absence claim sets `basis.absence_claim: true` and must reference a
current coverage assessment whose `scope_known`, `scope_accessible`,
`retention_known`, `index_current`, and `retrieval_attempted` fields satisfy
the applicable policy. Every referenced M22 absence Observation must exactly
match the assessment retrieval receipt's canonical `searched_domain`,
`search_scope`, `observation_window`, and `query_strategy`, and its structured
subject/scope must be compatible. M25 persists those four strings expressly
for this join. The join is through the Proposal's `evidence_refs` and
`coverage_refs`, not a field added retroactively to M22's Observation schema.
These checks use structured values and IDs only, never a search for words such
as “quiet” or “no evidence” in `reason`.

## Review and revert surface

M24 ships the smallest UI that makes the policy honest. A **Needs review**
list is reducer-backed and shows each queued proposal's operation, targets,
expected/current versions, effective risk, structured transition cause,
intended use, evidence and coverage links, reason, and diff for CRITICAL
operations. Each card has Approve and Reject actions; rejection requires a
reason, and both actions append `proposal.decision_recorded`. A changed target
marks the card stale and prevents approval.

Applied MEDIUM changes expose **Revert** only when their policy rule is
`revert: one_click` and `proposal.applied.revert_plan` is present. Alias and
classification corrections therefore use a new proposal and never show a
button backed by a nonexistent removal event. Clicking Revert constructs
`revert_proposal` with current expected versions and the applied event IDs;
the server—not the UI—loads the stored `RevertPlan`, then sends it through the
same policy and logical-batch path. It
appends new mutation and `proposal.reverted` events; it never deletes events,
rewinds the ledger, or overwrites a projection directly. If intervening state
makes the inverse unsafe, the user receives a stale rejection and can inspect
or prepare a new proposal.

## Error handling

| Failure | Behavior |
|---|---|
| Run dies mid-accumulation | Zero proposals applied |
| Crash before logical batch commit | Incomplete batch ignored on replay; zero mutations or projections visible |
| Commit durable, crash before projection/ack | Projection recovers from committed ledger; re-submit returns original result |
| Stale expected_version | Structured rejection; state untouched |
| Approval after target changed | Card becomes stale; approval cannot bypass CAS |
| Human reject | Durable decision + rejection; target state untouched |
| Revert requested for an op with no stored plan | `revert_not_supported`; no button/state change |
| Revert after intervening edit | Structured stale rejection; history untouched |
| Schema-garbage proposal | Typed in-session tool error; operational log, NOT ledger |
| LOW-declared supersede of attested belief | Escalated to HIGH by the table, queued |
| LOW-declared mutation of a belief with lineage fan-in above threshold | Escalated to HIGH by the table (`lineage_fan_in` escalator), queued |

## Testing

- Byte-identity test on the table load, both sides.
- Table-load refusal vectors for every unknown predicate/transition/target/
  rejection code and every op whose target-class, revert, or rejection set is
  incomplete.
- Tripwire over every constructible op.
- Goldens green on both suites from the one shared artifact.
- Kill-point tests on accumulation, all-member queue, initial/set-wide
  rejection, stale-precondition rejection, and final apply; no reducer state
  may expose a partial commit-set transition.
- Conformance vectors cover every `proposal.*` body, valid lifecycle
  transition, duplicate terminal event refusal, incomplete logical batch, and
  rebuild-from-zero lifecycle state; they also assert the proposal-class
  version-effect matrix and the HIGH tagged subject-correction success/stale/
  mismatch cases.
- **Epistemic eval fixtures (the M24 slice, shipped WITH the mechanism):**
  false creation (blocked by creation qualification) · false merge (CRITICAL
  queue, never auto) · silence-resolution attempt (rejected) · high-stakes
  self-certification attempt (rejected) · human-reviewed supersede without
  verification (rejected, ledgered). Synthetic event sequences + proposals,
  asserted through the real interpreter.
- Policy goldens exercise every discriminated op, including the distinction
  between LOW exact-belief merge and CRITICAL entity merge, alias collision,
  split gating, structured silence/absence/high-stakes checks, and forward
  revert. Schema vectors cover every nested payload struct, legal lifecycle
  edge, and required/forbidden field combination.
- Queued-set race goldens append a new candidate belief and supersede a
  coverage assessment before approval; both whole sets reject on pre-append
  revalidation even though their original target-ID CAS values still match.
- Qualification parking fixtures: promoting an unqualified item writes a
  `parked_promotions` row (visible, cleared once the required roles pass); a
  human creating or sketching a rough note is never blocked by a
  qualification gate.
- Revert goldens prove only the five v1 invertible MEDIUM ops store a
  `RevertPlan`; alias/classification and every non-invertible op return
  `revert_not_supported` and render no Revert action.
- Proposal MCP tools have schemas and descriptions ready but are absent from
  the live and mock registries; a parity assertion proves absence in M24. M26
  adds them in one explicit registration phase.
- Playwright covers queued-card survival across reload, approve, reject,
  stale approval, CRITICAL diff, one-click revert, and unsafe-revert refusal.

## Non-goals

No LLM invocations, semantic candidate search, or ingest/maintenance passes
(M26) · no metering/budgets/scheduler state (M25 — M24 creates only the runtime
DB file + its two tables, `operational_log` and `parked_promotions`) · no
attention lanes or conflict classifier execution
(M27 — `classify_conflict` and the contradiction-preservation gate exist but
M27 supplies their structured outcomes/edges) · no cross-source verification
policies (D10: needs ≥2 connectors) · no polished review UI (the functional
list ships here; richer Epistemic Status composition comes with M27).

## Acceptance

Synthetic proposals exercise the full logical-batch skeleton with agents OFF
· every constructible op mapped (tripwire) · goldens identical on both suites
· dead/incomplete runs expose no mutations; re-submits are idempotent · CAS
and current policy preconditions refuse stale versions, candidate receipts,
and coverage before and after human approval · creation/silence/
high-stakes/absence rules operate on structured fields and refuse their
fixtures · queued, rejected, applied, and reverted state survives rebuild ·
every commit-set queue/rejection/apply transition is reducer-atomic · only
invertible MEDIUM applications expose Revert · the minimal review/revert UI
and its e2e coverage ship · proposal tools remain
unregistered pending M26 semantic-search activation · AGENTS.md re-scope and
eval fixtures land · full gates green.
