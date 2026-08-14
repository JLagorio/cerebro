# Cerebro M27 — Belief Dynamics + Attention Lanes — Design

**Date:** 2026-08-08
**Status:** Derived from the accepted Rev 3 roadmap (D9/D11/D12, the invariants section) and the frozen coverage matrix (rows §8–§10, §33, §35–§37, §44–§45, §48–§51, §72, §75, §77–§78, §80, §85, §89). For owner review.
**Scope:** The product visibly becomes what the spec describes: Support/Coverage/Validity chips, the scope/stage resolution pipeline, contradiction preservation that doesn't cry wolf, four attention lanes under nothing-speaks-first, the critical_attention bypass, protected lanes, and the Epistemic Status skeleton.
**Companion plan:** `../plans/2026-08-07-cerebro-m27-belief-dynamics.md` sequences the implementation. Where the two disagree, this spec wins.

## Context

M26 left the constructs on by default only after the preventive
anti-self-ancestry reachability check went live, with deterministic attention
primitives computed and stored, lineage edges flowing from real ingest, and
candidate-conflict signals recorded — but no full independence counting,
contradiction edges, chip derivations, or lanes. M27 owns those richer
dynamics and retrospective hygiene. Trust chips today derive `trustTier` from
`verified`; M27's three-axis chips subsume that derivation.

**The tone rule inherited from M8: nothing speaks first.** Every lane, chip,
and banner obeys default silence; surfaces answer when looked at. The named
exceptions: the M23 reconciliation banner, this milestone's
`critical_attention` bypass, and M25's quota/blindness banners — the last
stop being standalone when they consolidate into the Epistemic Status
skeleton below.

## Governing invariants

1. **Scope resolution BEFORE contradiction (D12/amendment 8).** A candidate
   contradiction must first fail resolution on: same subject? same revision?
   same environment/geography? same valid time? same stage? same meaning?
   "Rev A uses NVIDIA" vs "Rev C uses AMD" is not a contradiction;
   intended-vs-shipping is stage lag, not conflict. Without this step,
   contradiction preservation screams at normal temporal evolution, the user
   learns to ignore it, and the entire surface dies.
2. **Independence is tri-state (§85).** `known_same_lineage /
   known_independent / independence_unknown` — "no lineage edge detected"
   never silently counts as independence (two engineers may both have heard
   it in one meeting). Corroboration counts known_independent only;
   independence_unknown renders as exactly that. The lineage analogue of
   availability ≠ completeness. `known_independent` is produced only by a
   committed M22 `observation.independence_recorded` event over the two root
   Observations, with the exact proof tags
   `distinct_firsthand_origin | independent_system_artifact |
   human_confirmed`; the reducer verifies both pinned
   `source_registration_event_id`s and retains the proof's `rule_version` in
   the derived facet provenance/UI detail. The first two are emitted by M25's
   deterministic registered-source proof path. `human_confirmed` is emitted
   only from the applied HIGH M24 confirmation proposal and pins both its
   `proposal_id` and approved `decision_event_id`. Thus production has real
   deterministic and human-confirmed positive paths; absence of either event
   remains unknown.
3. **Repetition strengthens nothing (§72/§75).** Copies collapse to one
   ancestral evidence family — deterministically, at the M25 prefilter, as a
   reducer/graph property, never an LLM judgment. M26 already prevents new
   self-descendant support at proposal apply; M27 adds full independence
   counting and finds cycles/descendant-only reinforcement in migrated and
   pre-check history.
4. **Protected lanes (§33).** Preference may tune verbosity, ordering within
   normal lanes, phrasing, grouping, cadence. It may NEVER suppress
   blindness, material contradiction, critical_attention, or high-impact
   human-review requirements. The preference firewall is schema-disjointness
   (attention tables never touch belief tables) PLUS this rule, both tested.

## The three orthogonal axes (D9 — "confidence" does not survive)

Freshness rules are a shared data artifact, `shared/policy/freshness.v1.json`
(same discipline as the policy table): default predicate-class rules —
charter rationale: durable · CI status: hours · shipping BOM:
days/revision-bound (§45). Freshness semantics are not connector-dependent;
source-level `stale_after` (M8) is a different thing and is not touched.

Derivation is keyed, never guessed from one arbitrary basis assertion:

```text
BeliefFacetKey {
  belief_id, belief_revision_event_id,
  predicate: known { value: non_empty_string } | unknown,
  state_stage: planned | approved | implemented | validated
             | deployed | shipping | unknown
}
```

Each distinct `(predicate, scope.stage)` among the revision's admissible
`supports` assertions yields one facet (`null` stage becomes `unknown`). An
unsupported revision yields one `unknown/unknown` facet. Multiple pairs remain
multiple facet rows; neither authority nor freshness is collapsed across them.
The persisted/derived structs are closed and orthogonal per facet:

```text
AuthorityClass = direct_artifact | responsible_owner_firsthand
               | firsthand_observer
CoverageDimensionState = yes | no | unknown | not_applicable
CoverageDimensionInput {
  assessment_id, source_id, state: CoverageDimensionState,
  basis_event_ids: [event-id], as_of: RFC3339
}
CoverageDimension {
  state: CoverageDimensionState,
  inputs: [CoverageDimensionInput; min_items=1]
}
AuthorityScope {
  predicate, state_stage, authority_class,
  authority_route_id, authority_rule_version, authority_artifact_hash,
  assertion_event_id, source_registration_event_id,
  authority_provenance: trusted_human_capture | registered_direct_artifact
}
Support =
  unsupported {
    ancestral_family_count: 0, independent_family_count: 0,
    independence_unknown_count: 0, authority_scope: null
  }
| single_source {
    ancestral_family_count: integer >= 1,
    independent_family_count: integer 0..1,
    independence_unknown_count: integer >= 0,
    authority_scope: null
  }
| corroborated {
    ancestral_family_count: integer >= 2,
    independent_family_count: integer >= 2,
    independence_unknown_count: integer >= 0,
    authority_scope: null
  }
| authoritative_for_predicate_stage {
    ancestral_family_count: integer >= 1,
    independent_family_count: integer >= 0,
    independence_unknown_count: integer >= 0,
    authority_scope: AuthorityScope
  }
Coverage =
  no_assessments { summary: blind, dimensions: null, assessment_ids: [],
                   fold_rule_version }
| assessed {
    summary: observed | partial | blind,
    dimensions: { source_connected: CoverageDimension,
                  source_healthy: CoverageDimension,
                  scope_known: CoverageDimension,
                  scope_accessible: CoverageDimension,
                  retention_known: CoverageDimension,
                  index_current: CoverageDimension,
                  retrieval_attempted: CoverageDimension },
    assessment_ids: [assessment-id; min_items=1],
    fold_rule_version
  }
Validity {
  freshness: fresh | stale | unknown,
  conflict: clear | contested,
  lifecycle: active | superseded | archived | tombstoned
}
ReviewStatus = unreviewed
             | current { attestation_event_id,
                         attested_belief_revision_event_id }
             | predates_current { attestation_event_id,
                                  attested_belief_revision_event_id }
```

`unsupported` means no admissible support revision, not “we searched and
found false.” `corroborated` requires known-independent ancestral families;
unknown independence is counted visibly but never promotes it.
`authoritative_for_predicate_stage` means one facet assertion matched
`shared/policy/authority-routes.v1.json` through M24's exact
`basis.authority_route_refs { authority_route_id, authority_rule_version,
artifact_hash }`. A route match is necessary but not sufficient: the
assertion's Observation must pin a matching `source.registered` event, and the
reducer verifies that trusted registration plus the assertion's closed
`authority_provenance`; caller payload tags alone confer nothing.
`direct_artifact` requires `authority_provenance: registered_direct_artifact`
and registration `authority_capability: direct_system_artifact`;
`responsible_owner_firsthand` requires `authority_provenance:
trusted_human_capture`, registration kind `human_actor`, capability
`human_assertion`, its bound actor, and an M22 `human_assertion` with
`relationship_to_subject.role: project_owner` and a permitted firsthand/
responsible-owner basis; `firsthand_observer` uses the same trusted human
registration/provenance checks and its separately permitted route.
`content_only`, `agent_inferred`, `legacy_reference`, a mismatched registration
event, or a runtime cache without its ledger registration can never produce
authority. A legacy reference also produces no deterministic independence;
health/coverage remains unknown unless M25 has separate trusted facts. The
matching route ID/version, registration event, and assertion are mandatory.
These are route classes, not a universal ranking, and direct machine evidence
is not discarded merely because it is not human-authored.

Absent an authority-route match, zero admissible support families derives
`unsupported`; one family, or multiple families without a positively known-
independent pair, derives `single_source`; at least two positively independent
families derives `corroborated`. Unknown independence increments its visible
count but never crosses that threshold. The reducer collapses copied lineage
first, then accepts an independence event only when its two Observation IDs
land in distinct current families and its registration refs still byte-match
those Observations' pinned registrations; an event within one collapsed family
is invalid. `independent_family_count` is the number of distinct families
participating in at least one valid positive proof, not a count of pair rows.

Review attestation (D8 channel 1) never changes Support. Select the latest
attestation by ledger position, never supplied time: none → `unreviewed`; if it
pins the current revision → `current`; otherwise → `predates_current`. It may reset a freshness clock only when the versioned
predicate rule explicitly authorizes review as a basis. Coverage summarizes
without deleting M25/M26 dimensions. For a facet, take the latest compatible,
non-superseded assessment for every source in its supporting assertions plus
every assessment referenced by the applied proposal. Fold each dimension with
`no > unknown > yes`, ignoring a valid `not_applicable` unless all values are
`not_applicable`. Every folded dimension retains the sorted input rows with
their own basis refs and `as_of`; no global timestamp or winning scalar erases
source-specific evidence. Summary precedence reads each folded `.state`:

1. `blind` when there are no assessments, or any of `source_connected`,
   `source_healthy`, `scope_accessible`, `index_current`, or
   `retrieval_attempted` folds to `no`;
2. `observed` when assessment IDs are non-empty and every dimension is `yes`
   or valid `not_applicable`;
3. `partial` otherwise, including any `unknown`, `scope_known: no`, or
   `retention_known: no`.

The fold order and this summary precedence are one versioned data artifact,
`shared/policy/coverage-fold.v1.json` — the same discipline as
`freshness.v1.json` and `critical-attention.v1.json` — and every derived
Coverage records the `fold_rule_version` it was folded under.

Validity remains a bundle: a belief facet may be stale **and** contested while
active, or fresh and archived/superseded for historical display.

Freshness is replay-stable. Reducers never read the wall clock. A deterministic
scheduler emits:

```text
freshness.transitioned {
  ...common, facet: BeliefFacetKey,
  from: fresh | stale | unknown, to: fresh | stale | unknown,
  effective_at, rule_version,
  dedupe_key: hash(belief_revision_event_id, predicate, state_stage,
                   effective_at, rule_version)
}
```

Each freshness rule declares one closed `time_basis: valid_from |
occurred_at | belief_revision_time` and whether a current attestation may add
an anchor. Resolve that basis for every admissible support in the facet, add
the latest selected attestation only when allowed, discard missing candidates,
and choose the maximum `(timestamp, event_id)` deterministically. No known
candidate yields freshness `unknown`; otherwise `effective_at` is that anchor
plus the rule duration (or its revision-bound transition). An unknown support
does not erase a known anchor, and no model chooses among supports.

`effective_at` is therefore computed from that facet's pinned assertion/
revision evidence and the versioned rule. Timer processing and launch
catch-up emit every due transition in `(effective_at, belief_id, revision,
predicate, stage)` order; the reducer folds only the event body. A duplicate
`dedupe_key` append is an idempotent no-op under append_once semantics —
timer and launch catch-up may retry without effect. A rule change
re-evaluates facets and emits new
transitions with the new `rule_version`, never silently reinterpreting old
events. Rebuild on any later date is byte-identical.

Surfaces may compose a human-readable line ("single-source, partial coverage,
stale and contested"). Floats and calibration curves stay cut — signals,
never a score.

## The resolution pipeline

Ordinary comparisons wrap M26's exact `ConflictCandidateEndpointV1`; a
declared `contradicts` relation has a separate tagged endpoint because neither
legacy migration nor M22 relation editing fabricates assertions:

```text
ConflictEndpoint =
  asserted {
    assertion_event_id, belief_id, belief_revision_event_id,
    subject_id, predicate, value_hash, scope, state_stage, valid_time
  }
| declared_relation {
    relation_event_id, belief_id, belief_revision_event_id,
    relation_origin: legacy_migration | pre_activation_declared
                   | post_activation_declared,
    subject_id, content_hash,
    scope: known { value: M22 scope } | unknown,
    state_stage: known { value: planned | approved | implemented | validated
                              | deployed | shipping } | unknown,
    valid_time: known { from: RFC3339?, to: RFC3339? } | unknown
  }
ConflictReasonCode = temporal_disjoint | scope_disjoint | stage_disjoint
                   | granularity_mismatch | semantic_same_meaning
                   | incompatible_values | conditional_context
                   | relation_missing_assertion | relation_missing_scope
                   | relation_missing_stage | relation_missing_valid_time
                   | declared_contradicts_relation
```

For `asserted`, `assertion_event_id` pins what the evidence asserted and the
inner fields are byte-for-byte M26's endpoint;
`belief_revision_event_id` pins the support revision that used it. The
comparison ID remains M26's domain-separated hash of canonically sorted
endpoint tuples. A declared-relation comparison instead uses
`sha256("cerebro-relation-conflict-v1\0" + relation_event_id + "\0" +
ordered_canonical_endpoints)` and registers the same comparison CAS class.
Revisions with the same belief ID can therefore be compared historically
without moving the edge when current state changes.

Committed M26 `conflict.candidate_detected` signals run the D12 gauntlet in order: subject →
subject/revision qualifier → environment/geography scope → valid-time overlap
→ state stage → granularity/meaning. Each result records epistemic history —
“we almost called this a contradiction and here is why we didn't” is Skeptic
food. The additive event bodies are:

```text
conflict.classified {
  ...common, comparison_id, left: ConflictEndpoint, right: ConflictEndpoint,
  outcome: resolved_temporally | resolved_by_scope | resolved_by_stage
         | resolved_by_granularity | same_meaning
         | genuine_direct | partial | conditional,
  classification: deterministic { rule_version }
                | agent_supplied { proposal_id, model_id, prompt_version },
  evidence_event_ids, reason_codes: [ConflictReasonCode; min_items=1],
  classified_at
}
conflict.comparison_registered {
  ...common, comparison_id,
  left: declared_relation, right: declared_relation,
  source_relation_event_id,
  reason: declared_contradicts_relation,
  rule_version
}
contradiction.opened {
  ...common, edge_id, comparison_id, left: ConflictEndpoint, right: ConflictEndpoint,
  kind: genuine_direct | partial | conditional,
  classified_event_id
}
contradiction.closed {
  ...common, edge_id, comparison_id, left_belief_id, right_belief_id,
  addressed_by_event_id, evidence_event_ids,
  disposition: resolved_with_evidence | superseded_with_addressing
}
contradiction.backfill_completed {
  ...common, through_event_id, source_relation_count, resolved_count, opened_count,
  rule_version
}
```

For a declared relation, serialize/sort the endpoints and derive the comparison
ID with the relation-domain formula above; `source_relation_event_id` must
equal both endpoints' relation event. `conflict.comparison_registered` is the
only declared-endpoint creation event and creates comparison v1. Its server
idempotency key is `declared-comparison:<store_uuid>:<comparison_id>`: an exact
retry appends nothing and returns the existing comparison; a duplicate append,
wrong formula, mismatched relation event, or reused ID with different endpoint
bytes refuses. Classification requires that exact registered endpoint tuple.

`edge_id = sha256("cerebro-contradiction-edge-v1\0" + comparison_id + "\0" +
kind)`. `contradiction.opened` must carry that value and the classification's
unresolved kind. Reducer uniqueness on `(store_uuid, edge_id)` plus idempotency
key `contradiction-open:<store_uuid>:<edge_id>` makes exact replay append
nothing; a second event or reused ID with different comparison/kind/endpoints
refuses. Closing never changes edge identity, and a closed edge cannot reopen.

Outcome/provenance/reason combinations are closed:

| outcome | allowed classification | exact reason rule |
|---|---|---|
| `resolved_temporally` | deterministic only | exactly `temporal_disjoint` |
| `resolved_by_scope` | deterministic only | exactly `scope_disjoint` |
| `resolved_by_stage` | deterministic only | exactly `stage_disjoint` |
| `resolved_by_granularity` | deterministic structural rule or agent-supplied proposal | exactly `granularity_mismatch` |
| `same_meaning` | agent-supplied proposal only | exactly `semantic_same_meaning` |
| `genuine_direct` | deterministic typed-value rule or agent-supplied proposal | exactly `incompatible_values` |
| `partial` | agent-supplied proposal, or deterministic declared-relation expansion only | agent: `incompatible_values`; relation: one or more `relation_missing_*` codes, or exactly `declared_contradicts_relation` |
| `conditional` | agent-supplied proposal only | exactly `conditional_context` |

Agent-supplied classifications require non-empty proposal evidence; structural
classifications carry their core rule version. Mixed semantic/structural or
relation/non-relation reason sets refuse. A deterministic declared-relation
expansion (M24's `edit_relation(add, contradicts)`) classifies `outcome:
partial` with `classification: deterministic { rule_version:
declared_contradicts_relation }` and `reason_codes:
[declared_contradicts_relation]`, its `contradiction.opened` edge in the same
batch — partial is an unresolved class. Deterministic `genuine_direct` remains
reserved for the typed-value incompatibility rule with reason
`incompatible_values`.

M27 extends M22's event-to-`state_versions` matrix exactly:

| event | version effects |
|---|---|
| `freshness.transitioned` | increment the facet's `belief` once |
| `conflict.comparison_registered` | create its declared-relation `comparison` at v1; expected version was null |
| `conflict.classified` | increment its `comparison` once; endpoint Beliefs and evidence Observations are read-only |
| `contradiction.opened` | increment its `comparison` once and each distinct endpoint `belief` once |
| `contradiction.closed` | increment its `comparison` once and each distinct endpoint `belief` once |
| `contradiction.backfill_completed` | no registered-target effect |

Open/close validators require endpoint Belief IDs to equal the registered
comparison/edge endpoints. A `classify_conflict` proposal's exact target set is
the comparison, both distinct endpoint Beliefs, and its basis Observations;
resolved outcomes read the Beliefs, unresolved outcomes advance them through
the same-batch open. Thus expected post-version is comparison +1 for resolved
or +2 for unresolved, endpoint Beliefs unchanged or +1 respectively, and
Observations unchanged.
For either an M26 asserted candidate or M27 declared registration,
classification starts at comparison v1. It produces v2 when resolved; an
unresolved same-batch open produces v3 and advances each distinct endpoint
Belief once. Declared registration + classification + required open may share
one logical batch and fold in that order.

Fields called `classified_at` are supplied event content for display and never
ordering; the ledger-assigned system position orders events. Typed
subject/scope/time/stage comparisons are deterministic. `same_meaning` and
any granularity result that depends on semantic judgment must arrive as the
M24-mapped MEDIUM `classify_conflict` proposal targeting `comparison_id`,
retain evidence refs, and set
`classification: agent_supplied`; it cannot be smuggled in as a deterministic
reducer result. Policy escalators still apply. Silence or elapsed time cannot
emit `contradiction.closed`.

Only the unresolved classes (`genuine_direct / partial / conditional`) emit a
`contradiction.opened` edge. Classification and its required edge are one M22
logical batch, whether the classifier is deterministic or runs through M24;
resolved outcomes batch no edge. A crash can therefore expose neither an
unresolved classification without its protected edge nor an edge without its
classification. Authority (D11) is evaluated for the endpoint's predicate +
stage, never as a universal rank. The pipeline and gate consult M24's high-stakes
verification requirements (§52): a missing required verification route is both
a debt-lane reason and a gate-escalation signal.
The canonical fixture: the lead says Rev C is AMD; main has the AMD config
committed; the manufacturing BOM says NVIDIA — **zero contradiction edges**,
three stage-scoped beliefs coexisting without alarms.

The reducer adds `conflict_classifications`, `contradiction_edges`, and the
backfill checkpoint. It validates exact endpoint equality with the committed
M26 candidate (or the tagged declared-relation input), comparison
CAS version, classification provenance, edge state, and addressed-by refs.
Every body is ledger-resident epistemic history and has shared Rust/TypeScript
body, refusal, reducer-destiny, and rebuild vectors; none is runtime-only
telemetry.
Before the preservation gate or lanes activate, an idempotent backfill reads
every committed pre-activation M22 `belief.relation` add whose relation type is
`contradicts`—whether emitted by migration or ordinary editing—pins the
from/to Belief revisions current at that relation event, and builds two
`declared_relation` endpoints with the exact origin; it never invents an
assertion. For each unseen comparison, the batch emits
`conflict.comparison_registered` first, then classification, then the required
open edge; replay resumes without duplicating any of the three. Available
qualifiers run the same deterministic gauntlet. Any missing assertion or
qualifier that prevents resolution produces `outcome: partial`, a non-empty
`relation_missing_*` reason-code set, and its `contradiction.opened` in the same M22
logical batch. The checkpoint is `contradiction.backfill_completed`; launch resumes
from `through_event_id`, and gate/lane activation requires a completed marker
covering the pre-activation ledger head. Until its classification commits,
each such relation remains a visible protected legacy conflict: the
contradiction lane renders it tagged legacy-unclassified (deterministically —
no LLM), and the gate predicate below counts it as an open edge. After that marker, M24's
`edit_relation` expansion refuses every new `contradicts` add unless its
preallocated relation event, deterministic classification, and required open
edge are in the same logical batch, with a declared comparison registration
between relation and classification; exact asserted candidates may instead use
the asserted endpoint path. No migrated, ordinary, or post-activation
`contradicts` relation can bypass classification/opening.

**The contradiction-preservation gate goes live:** the M24 policy slot fires.
Merge/supersede over an open edge is refused unless the proposal carries
M24's exact `basis.addressed_contradictions[{ edge_id, comparison_id,
disposition, evidence_refs }]`, exact comparison/endpoint-Belief/evidence-
Observation CAS targets (M24's top-level CAS targets: the comparison, both
endpoint Beliefs, and those Observations), and
a valid addressing mutation event. Each entry's sorted unique non-empty
`evidence_refs` must be a subset of top-level evidence. The interpreter
server-preallocates that addressing mutation's event ID and emits the mutation
followed by `contradiction.closed` in the same logical batch. The close's
endpoint IDs equal the open edge, its `evidence_event_ids` byte-equal the
entry's `evidence_refs`, and `addressed_by_event_id` equals that preallocated
mutation event—not a proposal lifecycle event or caller value. Silence, elapsed time, and
standalone callers cannot close. It fires only after the pipeline has failed to
resolve the claims apart; the gate must never trigger on stage lag. Golden
fixtures on both suites (table + goldens, no twin logic).

M27 publishes `shared/policy/policy.v3.json` (`format: 3`) before enabling the
gate. It binds predicate `open_contradictions_addressed` and ledger rejection
codes `contradiction_preservation_required | contradiction_edge_stale` to
`supersede_belief | mass_supersede | merge_beliefs_exact | merge_entities |
split_belief` (matching M24's own derivation — a split changes belief
identity).
The first rejects an omitted or newly discovered open edge with expected the
typed complete sorted edge-ID array and actual the supplied typed array; the
second rejects a closed/mismatched/replaced entry with expected the typed
current edge tuple and actual the supplied tuple. The predicate also derives,
for any target, live `belief.relation` rows of type `contradicts` with
`relation_origin: legacy_migration` that have no committed classification yet:
each counts as an open edge for gate purposes, refusable only through the same
addressing path or discharged by classification through the backfill pipeline
— an unclassified legacy conflict cannot be merged or superseded past. Unknown v2/v3 codes or gate
activation against v2 fails table load.

The same v3 table makes `edit_relation(action:add, relation:contradicts)`
action-specific: its exact target set is the new Relation, both endpoint
Beliefs, every basis Observation used to construct the endpoints, and the
Comparison (expected null when new, current only for an exact already-
registered asserted comparison). The interpreter preallocates the relation
event, derives the endpoint bytes/ID server-side, then emits in one logical
batch: relation add; an unseen M26 asserted-candidate event or M27
`conflict.comparison_registered`; classification; and, when unresolved, the
derived edge open. A missing M27 body/reducer returns M24
`capability_unavailable`; a missing/extra/stale target uses the existing typed
target/CAS rejection. `action:remove` retains the ordinary relation/Belief
target set and never closes, resolves, or deletes an edge.

Cross-language conformance vectors cover: swapped endpoints yield one
comparison ID; same value but disjoint stage/time resolves without an edge;
same scoped proposition with incompatible values opens the expected pinned
edge; a semantic `same_meaning` result without an applied `classify_conflict`
proposal is rejected; silence cannot close; an endpoint revision remains
stable after a newer belief revision; malformed/missing endpoint IDs refuse;
and all pre-activation migrated and ordinarily authored `contradicts` rows are
reclassified exactly once before gate/lane activation; a post-activation
declared `contradicts` add classifies deterministically as `partial` with
exactly `declared_contradicts_relation` and its same-batch open edge; a
post-activation add
without same-batch classification/opening refuses atomically.

## Chips in the UI

Support/Coverage/Validity ordinal chips render per belief facet (knowledge
surfaces + dossiers); a multi-facet belief renders separate scoped rows. The
`trustTier` derivation is subsumed — but never into Support.
Review attestation (D8 channel 1) renders as the separate `ReviewStatus` M23
r3/r5 state; `authoritative_for_predicate_stage` derives only from an exact
versioned authority-route match by a direct artifact or qualifying human
assertion in the facet's evidence lineage (D8 channel 2, D11), and the chip
names the predicate/stage and route class. A migrated verified concept therefore keeps
its explicit unsupported basis (`Support: unsupported`) and its review
attestation visible separately — Support untouched, exactly as the error-
handling row below states.

**This is the one place in M22–M27 where existing e2e assertions change
deliberately.** knowledge.spec.ts asserts literal chip content; those
assertions change in the chips commit, each named in the commit message body
(demo-vault/spec changes are test changes, per house rule). Every other
milestone requires e2e untouched.

## Lanes

Four lanes over M26's attention primitives, deterministic rules only, ranked
by rule class in Rust (the LLM never orders attention), all under
nothing-speaks-first:

| Lane | Trigger |
|---|---|
| contradiction | open genuine/partial/conditional edges, plus unclassified legacy `contradicts` relations tagged legacy-unclassified (deterministic, no LLM) |
| blindness | Coverage = blind — detected unqualified; relied-upon is an ordering signal within the lane, never a detection filter; M25 runtime-vs-source health feeds the copy |
| staleness | `Validity.freshness = stale` (independent of conflict/lifecycle) |
| epistemic debt | the §89 operational definition (below) |

**Epistemic debt, operationally (§89):** a materially relied-upon belief or
dependency with stale evidence, partial/blind coverage, unresolved
contradiction, missing authority, missing verification route, or known
unsupported inference — deterministic reasons, never an LLM vibe. M24's
parked unqualified items feed this lane.

**Staleness feeds recheck (§10):** the staleness lane emits recheck work into
the M26 maintenance lane, extending M8's stale→recheck — M27 builds no second
recheck mechanism.

**critical_attention bypass (§8):** extremely conservative deterministic
signals, human-confirmable, no scalar score, no Risk model — "production
signing certificate expires tomorrow" must not wait for M28+ Risk objects.
The initial `shared/policy/critical-attention.v1.json` inventory is deliberately
small and complete:

| id | Exact deterministic predicate | Reason |
|---|---|---|
| `production_signing_certificate_expired` | active `credential.kind = production_signing_certificate`, `environment = production`, `expires_at <= as_of`, and no active later M22 `supersedes` relation whose replacement is `from` and this credential is `to` | shipping trust path is already broken |
| `production_signing_certificate_expiring` | same typed fields, with `as_of < expires_at <= as_of + 72h`, and no active later `supersedes` relation in that exact direction | human-confirmable imminent expiry |

Evaluation receives explicit `as_of`; it does not read time inside a reducer.
The artifact contains `format`, each trigger's required typed fields,
comparison operator, duration, allowed stage/environment values, replacement
relation (`supersedes`, replacement `from` → replaced credential `to`), and
copy key. Missing/unparseable fields do not fire (they remain
ordinary debt/blindness); each listed trigger has positive, boundary, replaced,
wrong-environment, and malformed-field goldens in Rust and TypeScript. Adding
an initial trigger requires the same artifact + vector change, not hidden
code. Specialized lanes later refine and replace the bypass.

**Protected-lanes enforcement:** preference knobs (verbosity, ordering,
cadence) exist and are tested to be *incapable* of suppressing the protected
classes — a test attempts suppression via every preference path and asserts
visibility survives. Dismissals (M8) remain per-item and must not become a
suppression path for protected classes.

## Lineage graph hygiene (§78/§80)

Two deterministic graph checks land alongside the reachability work — never
an LLM judgment — surfacing into the debt/maintenance feed:

- **Circular reasoning + lineage duplication (§78):** a belief supported
  through a cycle in its own lineage, and duplicated lineage families that
  survived the prefilter collapse, are detected and surfaced.
- **Descendant-only reinforcement (§80):** a retrospective reachability query
  detects beliefs whose entire support traces to their own descendants —
  covering migrated/pre-M27 state the preventive proposal-apply check never
  saw.

## Epistemic Status surface (skeleton, §35)

One coherent home: what changed (M26 convergence) · coverage gaps ·
contradictions · stale understanding · needs review (M24 HIGH/CRITICAL queue)
· system/budget health (M25). It consolidates what M25–M27 would otherwise
ship as scattered banners, and grows into §35's full project view behind the
M28+ trigger registry entry for §35.

## Error handling

| Scenario | Behavior |
|---|---|
| Stage-lagged truths (lead/main/BOM) | Zero edges; coexisting stage-scoped beliefs; no alarms |
| Genuine direct conflict | Edge created; lane surfaces it; merge refused until addressed |
| No admissible evidence | Support = unsupported; no implication that the belief is false |
| Four copies of one message | Support remains single_source — one ancestral family |
| Responsible firsthand owner for a different stage | Not authoritative here; authority is predicate/stage-specific |
| Direct production artifact matching the predicate/stage route | `direct_artifact` may be authoritative; human authorship is not required |
| One revision supported across two predicate/stage pairs | Two facet rows; no arbitrary canonical pair or cross-facet authority |
| Coverage source inaccessible | Hard-dimension `no` folds to blind; unknown or completeness-only gaps fold to partial |
| Attestation on AI-derived belief | Separate ReviewStatus (and only policy-authorized freshness); Support untouched because M22 forbids lineage entry |
| No lineage info between two sources | independence_unknown; not counted as corroboration |
| Stale belief with an open edge | Validity is `{ freshness: stale, conflict: contested, lifecycle: active }` |
| Rebuild a week later | Same freshness bytes; no reducer wall-clock read |
| Preference set to minimum verbosity | Blindness/contradiction/critical still visible |

## Testing

Eval fixtures (the M27 slice): missed contradiction (genuine conflict must
edge + lane) · false contradiction (stage lag must NOT) · pinned-endpoint and
swapped-order vectors · semantic meaning classification without an applied
`classify_conflict` proposal refuses; with one it is labeled agent-supplied ·
classification without the committed M26 candidate (outside tagged declared-relation
backfill) refuses · migrated unsupported `contradicts` endpoints retain the
relation/revision IDs, emit non-empty migration reason codes, and backfill/
restart once before gates/lanes · merge/supersede over a belief with an
unclassified legacy `contradicts` relation refuses · ancestry
reinforcement (M26 prevention re-proven; historical descendant-only state
flagged) · repetition non-reinforcement · unsupported support · scoped
authority for direct-artifact and responsible-owner routes · multi-facet and
unknown-facet derivation · exhaustive Coverage fold/summary boundaries ·
separate tagged unreviewed/current/predates-current ReviewStatus · all
active/superseded/archived/tombstoned lifecycle values · stale+contested
coexistence · the named "stale truth" golden scenario (§37) · freshness
transition emitted at the
rule boundary and replayed a week later byte-identically · a duplicate
`dedupe_key` append is an idempotent no-op · critical-attention
positive/boundary/superseded-in-the-exact-direction/wrong-environment/malformed vectors for both initial
triggers · circular support (§78) · duplicated lineage family (§78) ·
protected-lane suppression attempts. Freshness rules, the Coverage
fold/precedence table, gate conditions, bypass
triggers, and lane definitions are data artifacts with goldens on both suites
— no twin logic. Playwright specs cover the three structured chips and the
Epistemic Status skeleton against mock fixtures. Language discipline in every
surface string ("agent-supplied," "stage lag," "independence unknown") —
honest words are spec compliance.

## Non-goals

No scalar salience, no naive factor multiplication (§9 — the spec's own
warning) · no monolithic claim-status enum (§49 — the three axes and
Validity's subfields are deliberately orthogonal) ·
no Risk/Decision/Issue objects · no learned freshness or authority
policies · no Skeptic (anti-self-ancestry is a reachability check, not an
agent) · no full §35 project view — the skeleton has a named growth path.

## Acceptance

A contradicted belief cannot be silently merged · migrated contradiction
relations are reclassified before gates/lanes · an unclassified legacy
conflict stays visible and gate-protecting until classified · semantic same-meaning outcomes
are evidence-linked agent-supplied proposals · repetition does not strengthen
anything · unsupported migration endpoints and reason codes remain executable ·
Support includes unsupported and route-matched human/direct-artifact authority
per predicate/stage facet · Coverage has one versioned fold/summary rule
(`shared/policy/coverage-fold.v1.json`, recorded as `fold_rule_version`) ·
ReviewStatus stays tagged and separate · lifecycle covers active/superseded/archived/
tombstoned · stale+contested is representable · freshness replay never reads current time ·
stage-lagged truths coexist without alarms · both enumerated critical triggers
surface without a Risk object · protected lanes proven unsuppressable ·
Epistemic Status skeleton live · eval fixtures landed · full gates green, with
the chip-assertion changes in knowledge.spec.ts named and deliberate.
