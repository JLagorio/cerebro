# Cerebro M26 — Platform Agents by Default: the Three Constructs — Design

**Date:** 2026-08-08
**Status:** Derived from the accepted Rev 3 roadmap (D5/D6, the retrieval-adequacy section) and the frozen coverage matrix (rows §16–§17, §22–§27, §30, §36, §47, §65–§68, §71, §76, §78, §83–§84, §90, §92–§93, §98). For owner review.
**Scope:** LLM behavior returns — batched, budgeted, proposal-gated, honest: the basic entity resolver, semantic retrieval, live MCP proposal-tool registration, the batched ingest pass, query-time assembly with the full answer contract, the maintenance pass, the Source Monitor and attention primitives, convergence synthesis, and the on-by-default flip.
**Companion plan:** `../plans/2026-08-07-cerebro-m26-platform-agents.md` sequences the implementation. Where the two disagree, this spec wins.

## Context

Everything before this milestone was substrate. M26 collapses the spec's ten
LLM roles into **three runtime constructs plus two deterministic Rust
services** (D6): the ingest pass (Observer+Extractor+Resolver+Proposer as one
batched run), the maintenance pass (the Reconciler+Temporal slice of D6's
construct as one scheduled run), query-time assembly (attended-only, pay-per-use) — with
Attention and the Source Monitor as Rust services, never LLM roles.

**"On by default" has a precise meaning:** deterministic phases always on;
LLM phases on within M25's ambient budgets. It is defensible only after M24
gates writes, M25 meters spend, and the preventive M22-support-graph
anti-self-ancestry check is live at proposal apply. If any of those regressed,
flip nothing. M27 expands that graph work into full independence counting and
retrospective hygiene; it is not allowed to supply a safety prerequisite for
this milestone's flip after the fact.

The LLM/Rust boundary is a principle, not an enumerated constitution: never
spend an LLM token where deterministic logic can answer correctly — and never
pretend Rust can answer a semantic question.

## Governing invariants

1. **At most one semantic run per settled change-window** — not per file,
   not per role. Fully deterministic structured candidates use zero; every
   residual item shares one batch. Ambient spend is capped at ~10–20 CLI
   runs/day; background LLM concurrency stays 1 inside MAX_CONCURRENT_RUNS=4.
2. **Source-taint containment (§92), not semantic immunity.** Source bytes are
   delimited and labeled untrusted data; they have no direct write authority.
   Injection-shaped content is detected by a versioned heuristic and recorded
   in vault-scoped operational `source_taint_assessments`, keyed to the
   immutable Observation event ID, as `suspected_instructional_content` plus
   classifier/reason codes. It never mutates M22's closed Observation body. The detector can miss and the
   model can still be influenced: Cerebro does **not** claim that hostile text
   can never induce a syntactically valid LOW-risk proposal. The structural
   guarantees are narrower and testable: source bytes cannot call a mutator,
   agents only emit serde-valid M24 proposals, policy/CAS/transactionality
   cannot be bypassed, and every applied proposal retains its source lineage
   and journal entry.
3. **Context integrity (class (a) invariant, §83).** No belief-affecting
   semantic inference may rely solely on a context set selected to support
   the candidate conclusion. Every belief-affecting assembly MUST run the
   contradiction and scope-neighbor intents. Accessible counterevidence must
   enter context; otherwise the manifest must carry a typed `exhausted` or
   `blocked` record naming the attempts and reason. Merely recording that an
   intent was attempted is not compliance.
4. **Two outputs, never merged (§47/§67).** Retrieval adequacy ("did we look
   sufficiently?") and evidence sufficiency ("is what we found enough for
   THIS use?") are separate structured outputs in every synthesis.
   "Retrieval: partial · Sufficiency: adequate for a reversible prototype
   decision; insufficient for production release."
5. **No descendant reinforcement before default-on (§72/§75/§80).** At M24
   proposal apply, every proposed BeliefBasis support Observation is the root
   of a cycle-safe dependency walk. The walk follows Observation `lineage`
   parents, a `derived_content` Observation's explicit
   `source_belief_revision_event_ids`, and each reached Belief revision's
   linked basis Observations. The explicit revision hop reads M22's
   reducer-owned `derived_belief_sources` index, never source prose. If it reaches **any revision** of the target
   Belief, apply refuses the proposal as `self_ancestry`. M26 publishes
   `shared/policy/policy.v2.json` with `format: 2` before live registration,
   adding predicate `no_self_ancestry` to the global closed registries and
   every Belief-basis-changing op and binding it to the ledger-destined
   rejection `self_ancestry`, registered (reserved) in the global closed
   registry since policy.v1 (M24). The rejection is exactly
   `rule: no_self_ancestry`, expected `{type:"boolean",value:true}`, and actual
   a typed object with exactly `target_belief_id`,
   `reached_revision_event_id`, and `support_observation_event_id` string
   fields. Either table containing an unknown predicate/rejection fails table
   load; live registration against v1 fails on the absent `no_self_ancestry`
   predicate binding, not on an unknown code.
   This preventive check and its vectors land before live MCP registration is enabled for default-on
   runs. Review attestation needs no exception: M22 already makes it
   structurally ineligible for BeliefBasis and Support.

## The basic entity resolver (deterministic, Rust)

Resolution tiers over M22 state, in order: exact entity ID → known alias →
explicit relation traversal → high-confidence existing-entity match
(normalized string equality class, NOT embeddings) → **unresolved**.

`unresolved` is a first-class outcome, never a guess. It parks the
observation for the ingest pass to propose `add_entity_alias` (a MEDIUM op —
an alias claim is a claim) or a qualified `create_belief` (the M24 creation
path). The resolver never invents an alias and never uses embedding similarity
to attach. Without this, observations cannot attach, lineage is fiction, and
contradiction detection is fiction — which is why it lands first. The
Falcon / "Falcon C" / "Rev C" / "Product A" / Xavier worked examples — the
full matrix §84 set — are the test corpus. This resolver does NOT satisfy the
M28+ claim-granularity Resolver trigger, and must never be named as if it did.

Every attempt persists one closed tagged row; the SQL table flattens the tag
with equivalent `CHECK` constraints:

```text
ResolverAttempt =
  ineligible {
    vault_id, store_uuid, attempt_id, run_id, ingest_item_id, artifact_id,
    assertion_event_id?, assertion_candidate_hash, attempted_at,
    reason: subject_none | malformed_subject | non_assertion_observation
          | missing_assertion_event | already_attached
  }
| eligible {
    vault_id, store_uuid, attempt_id, run_id, ingest_item_id, artifact_id,
    assertion_event_id?, assertion_candidate_hash, attempted_at,
    normalized_mention_hashes: [sha256; min_items=1], target_count: integer >= 1,
    candidate_entity_ids: [EntityId; unique, canonical order],
    candidate_count: integer >= 0,
    resolution:
      attached { outcome: exact_id | known_alias | explicit_relation
                       | normalized_match,
                 chosen_entity_id, attachment_state: attached,
                 reason_codes: [] }
    | parked_unresolved { outcome: unresolved, chosen_entity_id: null,
                          attachment_state: parked,
                          reason_codes: [ambiguous_candidates | no_candidate;
                                         min_items=1] }
    | parked_granularity { outcome: claim_granularity_blocked,
                           chosen_entity_id: null, attachment_state: parked,
                           reason_codes: [compound_assertion_targets] }
    | parked_conflict { outcome: conflicting_attachment,
                        chosen_entity_id, prior_entity_id,
                        prior_resolution_event_id, attachment_state: parked,
                        reason_codes: [conflicting_attachment] }
  }
```

An attempt is eligible exactly when the extracted candidate has a syntactically
valid non-empty subject plus at least one typed predicate/value target and is
not already attached. A committed singular assertion supplies
`assertion_event_id`. It may be null only for
`outcome: claim_granularity_blocked`, where `target_count >= 2`, the versioned
extractor identified multiple independently attachable targets, and persisting
one M22 assertion/subject would conflate them; that outcome always parks.
Every other eligible variant requires the assertion event. A prior attachment
to the same entity is ineligible `already_attached`; a different attachment is
`parked_conflict` and prepares M24's HIGH, non-reversible
`correct_observation_subject` proposal with the pinned prior-resolution event.
Its payload pins `observation_event_id`, `prior_resolution_event_id`,
`from_entity_id`, `to_entity_id`, `resolver_tier`, non-empty
`basis_event_ids`, and non-empty reason. It never overwrites or auto-corrects.
The tagged union makes chosen-entity and reason-code nullability exact.
`attempt_id = sha256("cerebro-resolver-attempt-v1\0" + store_uuid + "\0" +
run_id + "\0" + ingest_item_id + "\0" + assertion_candidate_hash)`; runtime
storage enforces unique `(store_uuid, attempt_id)`, so retrying one run/item/
candidate is idempotent. `candidate_count` always equals the length of
`candidate_entity_ids`. Attached and conflicting-attachment rows have exactly
one target and exactly one candidate, which is the chosen entity;
the conflict's chosen entity must differ from its prior entity. An ambiguous
unresolved row has exactly `[ambiguous_candidates]` and at least two
candidates; a no-candidate row has exactly `[no_candidate]` and zero
candidates. Only the granularity-blocked variant may have more than one target,
and it has exactly `[compound_assertion_targets]`. These invariants prevent
retry duplicates and make every M28 numerator and denominator reconstructible.
Malformed/missing/`subject:none` candidates use the ineligible variant and
never enter M28 denominators. Rates count the distinct attempt, item, or
artifact ID named by the protocol, never joined-row multiplicity. Raw source
text is not copied into runtime.db. These rows make M28 R3/R6 rates computable
rather than anecdotal.

A successful deterministic tier emits M22's additive
`observation.subject_resolved { observation_event_id, change: { action:
"attach", entity_id, resolver_tier, basis_event_ids } }`; it never rewrites the
immutable Observation. A conflict only prepares the HIGH proposal; if the user
applies it, M22 emits the separately tagged `change.action: "correct"` event.
An original `subject: none` or unresolved outcome remains refused/parked per
M22's vectors.

## Basic semantic retrieval (app-data)

Query expansion over aliases/relations plus, if needed to satisfy the
assembly contract, local embeddings in app-data — never in the vault; the
index stays disposable (the rebuild test extends to it). BM25 alone cannot
find aliases, paraphrases, or contradiction candidates, and adequacy must not
assess an intentionally crippled retriever (§93). Scope: enough to serve the
assembly's retrieval intents; anything fancier waits for a consumer.

Basic semantic retrieval is an acceptance requirement, not an optional
optimization hidden behind “if needed.” The implementation may satisfy it
without embeddings, but the shipped golden corpus MUST recall known aliases,
paraphrases, and seeded accessible counterevidence that lexical-only search
misses. Rebuilding the disposable index from ledger + vault produces the same
rank-independent candidate set for those goldens.

M26 upgrades M24's server-minted creation receipt before any live proposal
tool is registered. Receipt v2 retains every v1 deterministic leg and replaces
the unavailable semantic field with:

```text
search_version: 2
semantic: {
  status: completed,
  retriever_version,
  index_head,
  query_fingerprint,
  candidate_ids
}
```

`index_head` must equal the receipt's reducer head, the query fingerprint is
server-derived from the proposed subject/content/scope, and every semantic
candidate must appear in `considered`. A retrieval failure mints no receipt and
returns `semantic_search_unavailable`; callers cannot submit `attempted` or an
empty caller-authored leg. Registration has a tripwire requiring the v2
validator and its stale/missing/unconsidered-result goldens.

## Live proposal surface and preventive lineage gate

M24 deliberately left its proposal tools off the live loopback MCP server.
M26 registers the M24 proposal-op tools and terminal `commit_proposals` in an
explicit phase, with an allowlist generated from the M24 policy inventory and
a tripwire proving that live and policy inventories are identical. The first
live inventory includes `add_entity_alias`, `split_belief`,
`merge_beliefs_exact`, HIGH non-reversible `correct_observation_subject`, and
the other M24 ops; `merge_entities` remains a distinct CRITICAL op. No
agent-facing synonym or unlisted merge/split/alias/correction operation exists.

Registration is activation, not just plumbing. Before it can be enabled, an
applied proposal that changes a BeliefBasis must run the M22 support-graph
reachability check described above. A self-descendant support edge is a
typed refusal and cannot be made live by lowering declared risk. The tools may
be registered for targeted tests behind the kill switch first; default-on
does not happen until the semantic-receipt tripwire, reachability vectors, and
M24 atomicity suite pass. Registering the tools outside the kill switch itself
requires the preventive-ancestry reachability vectors green in addition to the
semantic-receipt goldens — registration, not just default-on, is gated.

## The batched ingest pass

Replaces the per-note distill jobs. The scheduler consumes **both** M25 work
verdicts: `material_candidate(dimensions)` and
`needs_semantic_judgment`. A deterministic material candidate whose typed
diff/lineage data completely determines an M24 proposal may be converted by
Rust and submitted without an LLM. Every remaining material candidate and
every semantic-judgment item in the settled window join the same context and
produce at most **ONE** CLI run. A window containing only complete structured
candidates therefore produces zero CLI runs, not one ceremonial run; no item
is dropped merely because it entered the deterministic branch.

- **Context in:** the changed artifacts + resolver output + candidate
  beliefs — supporting AND disconfirming (§22's context-integrity line
  applies to reconciliation).
- **Output:** M24 proposals via serde-validated MCP tools, terminal commit,
  bounded in-session retry on typed rejection.
- **Operation closure:** unresolved aliases use `add_entity_alias`; belief
  decomposition uses `split_belief`; the only LOW exact-equivalence merge is
  `merge_beliefs_exact`; entity identity merges use `merge_entities` and stay
  CRITICAL; a conflicting prior attachment parks and prepares HIGH
  `correct_observation_subject`. All are policy-table entries from M24, not
  operations invented by this pass.
- **Semantic materiality residual (D6/amendment 5):** the pass may conclude
  "not material" — recorded as an outcome event, charged, window closed. The
  verdict states which of §17's four dimensions it evaluated (world-state,
  belief-state, evidence-state, attention); a corroboration-only window
  (zero field changes, a new independent source) is MATERIAL on the
  evidence-state dimension — "no field changed → discard" is forbidden.
- §92 taint discipline; `suspected_instructional_content` heuristic telemetry
  wired. A heuristic hit does not automatically reject an otherwise valid
  proposal, and a miss does not grant source text authority.
- The old distill lanes are deleted in the same commit their replacement
  proves itself; the learn-queue UI keeps working off the new pass's outputs.

The semantic disposition is a complete additive M22 event, not unnamed prose:

```text
ingest.semantic_assessed = {
  ...common,
  semantic_assessment_id, m26_batch_key,
  input_receipt_ids: [<M25 ingest.assessed receipt-id>...],
  outcome: material | non_material | undetermined,
  disposition: proposals_submitted | closed_non_material | blocked_visible,
  evaluated_dimensions: [world_state | belief_state | evidence_state | attention],
  material_dimensions: [world_state | belief_state | evidence_state | attention],
  proposal_ids: [<proposal-id>...],
  blocked_reason: null | runtime_unavailable | semantic_validation_failed
                       | policy_dependency_unavailable | source_access_lost
                       | batch_input_incomplete,
  explanation: <agent-supplied display text>,
  content_label: agent_supplied
}
```

Inputs are non-empty; material dimensions are a subset of evaluated dimensions.
`non_material` requires no material dimensions/proposals,
`closed_non_material`, and null blocked reason. `material` requires
`proposals_submitted`, at least one material dimension/proposal, and null
blocked reason. `undetermined` requires `blocked_visible`, empty material
dimensions/proposals, and one closed blocked reason; it routes the item to M25
`failed_visible`. No other outcome/disposition combination deserializes. The reducer indexes the event only as processing
history—never Observation lineage or Support. It has **no** registered-target
`state_versions` effect: `semantic_assessment_id` is an idempotent history key,
not a CAS target, and neither input receipts nor proposals advance merely by
being referenced. Per M25, the outcome, proposal
lifecycle/mutations, and successor terminal receipts are one trusted logical
batch; no caller can inject completion members.

## Query-time assembly (attended-only)

A deterministic Rust Context Assembler + one synthesis run.

**Retrieval intents, all mandatory for belief-affecting questions:**
positive · contradiction · historical · authority · scope-neighbor. The
working-memory manifest is serde data, not an opaque prompt appendix:

```text
QueryIntendedUse {
  kind: draft_note | reversible_work | operational_decision
      | production_release | safety_or_compliance,
  stakes: LOW | MEDIUM | HIGH | CRITICAL,
  predicate_class: non_empty_string | null,
  description: non_empty_string
}
WorkingMemoryManifest {
  assembly_id, question_hash,
  intended_use: QueryIntendedUse,
  limits: { max_sources_per_run, max_context_bytes, max_evidence_items },
  actual: { source_count, context_bytes, evidence_item_count },
  intents: {
    positive: IntentRecord,
    contradiction: IntentRecord,
    historical: IntentRecord,
    authority: IntentRecord,
    scope_neighbor: IntentRecord
  },
  items: [ManifestItem],
  counterevidence: included { item_ids: [item-id; min_items=1] }
                 | exhausted { attempt_refs: [attempt-id; min_items=1],
                               source_ids: [source-id], reason: no_candidates }
                 | blocked { attempt_refs: [attempt-id; min_items=1],
                             source_ids: [source-id; min_items=1],
                             reason: source_inaccessible | runtime_unavailable }
}
ManifestItem =
  assertion {
    item_id, assertion_event_id,
    belief_context: none
                  | supported_at { belief_id, belief_revision_event_id },
    source_id, content_hash,
    selected_by_intents: [positive | contradiction | historical
                         | authority | scope_neighbor; min_items=1],
    lineage_event_ids: [event-id], scope, state_stage, valid_time, byte_count
  }
| belief_revision {
    item_id, belief_id, belief_revision_event_id,
    basis_observation_event_ids: [event-id], source_ids: [source-id], content_hash,
    selected_by_intents: [positive | contradiction | historical
                         | authority | scope_neighbor; min_items=1],
    lineage_event_ids: [event-id], scope, state_stage, valid_time, byte_count,
    support_state: linked | unsupported
  }
IntentRecord {
  status: satisfied | exhausted | blocked,
  attempts: [{ attempt_id, query_hash, expanded_aliases: [string],
               source_ids: [source-id], candidate_item_ids: [item-id],
               outcome: candidates_found | no_candidates | source_inaccessible
                      | runtime_unavailable }],
  selected_item_ids: [item-id],
  blocked_reason: null | source_inaccessible | runtime_unavailable | cap_conflict
}
```

The two `ManifestItem` tags are exclusive. An assertion item always pins its
singular M22 `source_id`. A belief-revision item may name multiple sources through its
basis; `source_ids` may be empty only when `support_state: unsupported` and
`basis_observation_event_ids` is also empty. A `linked` belief revision requires
both arrays non-empty. `actual.source_count` is the distinct union of assertion
`source_id`, belief-revision `source_ids`, and attempt source IDs, so no singular source is fabricated for a multi-source
or unsupported belief.

The manifest's home is operational, never ledger-resident: every assembly
persists its manifest in a runtime-DB table scoped by `vault_id`/`store_uuid`
and keyed by `manifest_id`, which is what lets `assembly_metrics` rows,
adequacy `manifest_item` basis refs, and
`SynthesisAnswer.working_memory_manifest_id` resolve against the current
assembly's manifest.

`attempted` is deliberately not an intent status. A relevant accessible
counterevidence candidate must appear in `items` and in
`counterevidence.included`. If inclusion would exceed an item/byte/source cap,
the assembler returns `blocked(cap_conflict)` and does not run a
belief-affecting synthesis; it never quietly trims the contradiction. A
search that returns nothing may be `exhausted` only after its attempts and
source set are recorded. An inaccessible source is `blocked`, keeps the
answer provisional where an answer is still allowed, and feeds Coverage.

**Attended limits and ambient budgets are different contracts.** Attended
assembly always enforces `max_sources_per_run`, `max_context_bytes`, and
`max_evidence_items` so a request is bounded. It is metered, but it is never
blocked by an ambient daily-run ceiling, daily token ceiling, or prior token
spend; there is no `max_daily_runs` field in the attended assembler contract.
Ingest, maintenance, Source Monitor-triggered ingest, and scheduled convergence
are ambient: M25's daily run gate, daily/output-token gates, quota backoff,
consecutive-failure gate, and elapsed-time abort/degrade rules apply to them.
Per-run model limits may still terminate an attended request honestly as a
model/runtime failure; they are not a user budget refusal.

**Output contract (serde-validated, labeled agent-supplied).** The ten
adequacy dimensions are required keys, never a score and never a generic map:

```text
CoverageDimensionKey = source_connected | source_healthy | scope_known
                     | scope_accessible | retention_known | index_current
                     | retrieval_attempted
DimensionBasisRef = manifest_item { item_id }
                  | runtime_health { component }
                  | coverage_dimension { assessment_id,
                                         dimension: CoverageDimensionKey }
DimensionAssessment {
  state: sufficient | partial | insufficient | unknown | not_applicable,
  basis_refs: [DimensionBasisRef],
  gaps: [LabeledStatement],
  as_of: RFC3339
}
RetrievalAdequacy {
  overall: sufficient | partial | insufficient | unknown,
  statement: LabeledStatement,
  dimensions: {
    source_availability: DimensionAssessment,
    source_health: DimensionAssessment,
    scope_coverage: DimensionAssessment,
    temporal_suitability: DimensionAssessment,
    authority_coverage: DimensionAssessment,
    firsthandness: DimensionAssessment,
    retrieval_breadth: DimensionAssessment,
    contradiction_search: DimensionAssessment,
    lineage_independence: DimensionAssessment,
    stakes: DimensionAssessment
  }
}
EvidenceSufficiency {
  intended_use: QueryIntendedUse,
  level: insufficient | partial | adequate | strong,
  basis_refs: [EvidenceRef],
  limitations: [LabeledStatement],
  requires_human_verification: boolean
}
```

A `coverage_dimension` ref must resolve to the current, store/subject/scope-
compatible M25 assessment and its exact named dimension; stale, superseded, or
mismatched records refuse. When coverage refs are present,
`DimensionAssessment.as_of` equals the minimum per-dimension `as_of` among
them, never a newer synthesis timestamp; without one it equals the assembly's
explicit `as_of`. The ref exposes M25's per-dimension basis, so a generic
assessment ID or prose cannot stand in for one of the seven states.

The full nine-part answer is one closed serde struct, not “roughly nine”
prose sections:

```text
StatementLabel = observation | conclusion | uncertainty | counterevidence
               | alternative | hypothesis | missing_expected_evidence
               | invalidation_condition | limitation | provisional_reason
EvidenceRef = manifest_item { item_id }
            | assertion { assertion_event_id }
            | belief_revision { belief_id, belief_revision_event_id }
LabeledStatement {
  text: non_empty_string,
  label: StatementLabel,
  basis_refs: [EvidenceRef]
}
CitedStatement {
  statement: LabeledStatement,
  citation_refs: [EvidenceRef; min_items=1]
}
ScopeAndTime {
  subjects: [M22 SubjectRef; min_items=1],
  scope: M22 assertion scope,
  state_stage: null | planned | approved | implemented | validated
                    | deployed | shipping,
  valid_time: { from: RFC3339?, to: RFC3339? },
  as_of: RFC3339
}
NextSource {
  source_id: source-id?,
  source_class: non_empty_string,
  authority_route_id: non_empty_string?,
  reason: LabeledStatement
}
DiscoveryStepDraft { action: non_empty_string, source: NextSource? }
DiscoveryStep {
  step_id, ordinal: integer >= 1,
  action: non_empty_string, source: NextSource?
}
DiscoveryPlan {
  plan_id, goal: non_empty_string,
  steps: [DiscoveryStep; min_items=1],
  stop_when: [LabeledStatement; min_items=1],
  stakes: LOW | MEDIUM | HIGH | CRITICAL
}
SynthesisAnswer {
  observations: [CitedStatement],                         // part 1
  current_answer: LabeledStatement,                      // part 2
  basis: [CitedStatement],                               // part 3
  scope_and_time: ScopeAndTime,                          // part 4
  uncertainties_and_counterevidence: {                   // part 5
      uncertainties: [LabeledStatement],
      counterevidence: [CitedStatement],
      alternatives: [LabeledStatement] },
  retrieval_adequacy: RetrievalAdequacy,                 // part 6
  evidence_sufficiency: EvidenceSufficiency,             // part 7
  next_evidence: {                                       // part 8
      missing_expected_evidence: [LabeledStatement],
      authoritative_next_sources: [NextSource],
      discovery_plan: DiscoveryPlan?
    },
  invalidation_conditions: [LabeledStatement],           // part 9
  provisional: {
    value: boolean,
    reason_codes: [coverage_gap | authority_gap | counterevidence_blocked
                  | evidence_insufficient | runtime_failure],
    reasons: [LabeledStatement]
  },
  working_memory_manifest_id,
  content_label: agent_supplied
}
```

`basis`, `missing_expected_evidence`, `authoritative_next_sources`, and
`invalidation_conditions` are non-empty for HIGH/CRITICAL uses; routine
answers may use empty arrays that the UI does not render. Shared-root-cause
language in `current_answer` or `alternatives` is labeled `hypothesis` unless
directly supported (§76). Retrieval adequacy and evidence sufficiency remain
separate even when they happen to have matching labels.

For every `CitedStatement`, `citation_refs` equals the canonical deduplicated
set of `statement.basis_refs`; disagreement is refused. HIGH/CRITICAL answers
require non-empty `current_answer.basis_refs`, `basis`, and every basis
citation. `current_answer.basis_refs` must equal the canonical union of every
`basis[].citation_refs`, and every `EvidenceRef` must resolve to the current
assembly's manifest (direct assertion/belief-revision refs must match a pinned
item). `provisional.value: true` requires non-empty reason codes and reason
statements; `false` requires both arrays empty.

The manifest, `EvidenceSufficiency`, M24 stopping-rule lookup, and answer
validation use one byte-equal `QueryIntendedUse`; a model cannot weaken kind,
stakes, or predicate class between retrieval and synthesis.

`plan_id` is
`sha256("cerebro-discovery-plan-v1\0" + store_uuid + "\0" +
canonical_json({goal, step_drafts:[{action,source}], stop_when, stakes}))`;
caller-authored step IDs are excluded. After minting the plan ID, the server
assigns the ordered steps 1-based `ordinal`s and
`step_id = plan_id + ":" + ordinal`. A render-only change cannot mint another
ID. Its runtime lifecycle is a closed union:

```text
DiscoveryPlanRun =
  pending { emitted_run_id, emitted_at, execution_started_at: null,
            execution_finished_at: null, execution_run_id: null, outcome: null }
| started { emitted_run_id, emitted_at, execution_started_at,
            execution_finished_at: null, execution_run_id, outcome: null }
| terminal { emitted_run_id, emitted_at, execution_started_at?,
             execution_finished_at, execution_run_id?,
             outcome: completed | dismissed | failed }
```

Every emitted plan receives one vault-scoped row with this lifecycle, its
stakes, canonical content hash, and ID. `dismissed` may transition directly
from pending; `completed`/`failed` require a start and executing run. Updates
are monotonic and idempotent. This is operational promotion metadata, not a
persistent Discovery object or epistemic claim.

The M24 stopping rule binds the contract: HIGH/CRITICAL use +
coverage/authority gap → the answer says "provisional" and says why. "All
known sources considered" ≠ "all sources known" (§90) is the required wording
shape.

## Maintenance pass

ONE scheduled run extending the jobs.ts lane scheduler onto durable M25
state: recheck stale items (extends M8's stale→recheck), flag items for
attention, surface merge and compress candidates — per §16, the twelve
conceptual GC verbs are pass behaviors and risk-classed proposal ops, never
twelve ad-hoc ledger opcodes. **Conservative by table (§78):** only
`merge_beliefs_exact` may take the LOW exact-equivalence path; semantic
coalescing must use a risk-gated mapped proposal and may never masquerade as
exact; `merge_entities` is CRITICAL → human card, always. `split_belief` is
the sole decomposition op. Silence-never-resolves is already
schema-enforced (M24) — the maintenance pass is what that rule exists to
constrain; a regression test tries to sneak a time-based resolution through
the pass's proposal stream. D6's maintenance construct names
Reconciler+Temporal+Curiosity+risk-gated Skeptic; M26 ships the
Reconciler+Temporal slice — Curiosity and the Skeptic join at M28+ per the
trigger registry.

## Source Monitor + attention primitives (deterministic Rust)

Source Monitor: refetch stale cached sources on launch/timer, hash-compare,
only changed hashes create ingest work — deliberately NOT named Scout
(amendment 6: the spec's Scout detects genuinely novel patterns, a deferred
LLM capability). Attention primitives: the deterministic signal computations
M27's lanes will rank — staleness clocks, coverage states,
unresolved-contradiction counts (over migrated `contradicts`
belief-relations only, until M27's contradiction edges exist) — computed
and stored, no UI, no ranking yet.

Potential conflicts are also a closed deterministic signal rather than an
unstated M27 input:

```text
ConflictCandidateReason = same_subject_predicate | incompatible_value_hash
                        | overlapping_scope | overlapping_valid_time
                        | stage_requires_classification
                        | declared_contradicts_relation
ConflictCandidateEndpointV1 = {
  assertion_event_id, belief_id, belief_revision_event_id,
  subject_id, predicate, value_hash, scope, state_stage, valid_time
}
conflict.candidate_detected = {
  ...common, comparison_id,
  left: ConflictCandidateEndpointV1,
  right: ConflictCandidateEndpointV1,
  detector_version,
  reason_codes: [ConflictCandidateReason; min_items=1]
}
```

Serialize each endpoint tuple as canonical JSON, sort the two byte strings,
then compute
`comparison_id = sha256("cerebro-conflict-comparison-v1\0" + first + "\0" +
second)`. Detection order can therefore never duplicate a comparison. Detection
requires committed assertion/basis/revision references and creates the M22
`comparison` CAS target at v1 when unseen. The server uses idempotency key
`conflict-candidate:<store_uuid>:<comparison_id>`: an exact retry returns the
existing comparison and appends no event/version; a second event or a reused ID
with different endpoint bytes is refused. It asserts only that the pair needs
classification—never that a contradiction exists. M27 aliases this endpoint
shape, consumes the signal, and supplies classification/edge bodies. Reducer
index/refusal/deduplication vectors land here so runtime-DB loss cannot erase
the handoff.

The M22 version matrix extension is exact:

| event | `state_versions` effect |
|---|---|
| `ingest.semantic_assessed` | none |
| first `conflict.candidate_detected` | create its `comparison_id` at v1; expected version was null |

Shared vectors assert the no-effect semantic event, first-create, exact retry,
duplicate append refusal, endpoint-hash mismatch refusal, and rebuild to the
same comparison v1.

M26 also adds vault-scoped operational rows required to govern later
promotions instead of guessing from anecdotes:

- `resolver_outcomes`, with the per-attempt fields defined above;
- `discovery_plan_runs(vault_id, store_uuid, plan_id, emitted_run_id,
  emitted_at, stakes, content_hash, lifecycle_state, execution_started_at,
  execution_finished_at, execution_run_id, outcome)`, constrained by
  `DiscoveryPlanRun` above;
- `run_cost_components(vault_id, store_uuid, run_id, component, model_id,
  quantity, unit, observed_cost_micros?, pricing_snapshot_id?)` with unique
  `(run_id, component)`;
- `assembly_metrics(vault_id, store_uuid, run_id, manifest_id,
  intended_stakes, source_count, evidence_item_count, context_bytes,
  retrieval_query_count, blocked_intent_count)`;
- `source_taint_assessments(vault_id, store_uuid, observation_event_id,
  classifier_version, verdict: no_signal | suspected_instructional_content,
  reason_codes, assessed_at)`, where `reason_codes` uses the closed enum
  `instruction_like_imperative | role_address | tool_request |
  policy_override_language | encoded_instruction_pattern`; `no_signal`
  requires an empty set and `suspected_instructional_content` a non-empty set;
  this is
  operational heuristic telemetry and never an Observation field.

`run_cost_components` has exactly this closed component/unit mapping:

| component | unit |
|---|---|
| `uncached_input_tokens` | `tokens` |
| `cache_read_tokens` | `tokens` |
| `cache_write_tokens` | `tokens` |
| `output_tokens` | `tokens` |
| `retrieval_calls` | `calls` |
| `tool_calls` | `calls` |
| `selected_context_bytes` | `bytes` |
| `selected_context_tokens` | `tokens` |
| `prompt_template_bytes` | `bytes` |
| `prompt_template_tokens` | `tokens` |

A successful belief-affecting synthesis writes all ten rows exactly once;
zero is a valid quantity, absence is not. Quantities are non-negative integers.
`model_id` is required for the four model-accounting token rows and may be null
for calls/context/template rows. This required-row matrix is the definition of
M28 R1 component completeness.

Two of the ten are derived estimates rather than wire-exact counts (M31.6):
`selected_context_tokens` and `prompt_template_tokens` are computed from
their byte counterparts at four bytes per token, and their rows carry
`estimated = 1`; the other eight are exact and carry `estimated = 0`. The
flag is provenance, not a unit override — an estimated row still counts
toward component completeness, and the R1 protocol (M28 spec) states how
estimated rows are treated in the projection.

M26 ships `shared/policy/cost-projection.v1.json`, a data-only projection
contract, not a Skeptic implementation. It names the closed component set,
`skeptic_model_id`, and for each component integer `multiplier_ppm` and
`fixed_quantity`. For observed quantity `q`, projection is exactly
`ceil(q * multiplier_ppm / 1_000_000) + fixed_quantity`; unit mappings above
cannot be overridden. The artifact also names an optional immutable pricing
snapshot whose per-unit integer-micro rates are used only for monetary totals.
The evaluator persists every projected component plus aggregate input tokens,
output tokens, calls, and priced cost; changing any coefficient requires a new
artifact version and rule version.

Counts are recorded for attended and ambient runs; only ambient rows feed the
M25 gate. Unknown vendor pricing remains null while quantities stay usable by
M28's versioned projection. No row stores secret or raw source content.

## Convergence synthesis (§30, pulled forward)

On-demand and scheduled "how did our model change?" over ledger diffs:
believed-then vs believed-now between two seq points. Day-one sections —
all M26-computable: material changes, new/resolved blindness, staleness
transitions. The certainty-shift section (support/validity deltas) and new
contestation are M27-gated: they activate when D9's Support/Validity chips
exist, not before (M27.5 owns the activation and its acceptance test). A cheap
consumer of ledger + revision chains + materiality; the what-changed output is
M26's slice of the §35 Epistemic Status surface that lands across M25–M27. No
persistent narrative object — §31's earned-persistence
trigger stands. This is the first genuinely magical user surface of the
overhaul, and the milestone's demo.

On-demand convergence is returned as an attended answer. Scheduled
convergence is an ambient run and stores a disposable, typed result in
app-data: `convergence_runs(vault_id, store_uuid, run_id, from_seq, to_seq,
trigger, schema_version, output_content_hash, output_json, generated_at,
superseded_by_run_id?)`.
It has no ledger event, narrative ID, user-editable canonical projection, or
cross-run identity; deletion merely causes recomputation. The UI may cache and
render the latest row, but must call it a convergence run/output, never a
Narrative. Scheduled runs obey all ambient gates.

## Error handling

| Failure | Behavior |
|---|---|
| Ambiguous entity mention | Resolver returns unresolved; nothing attaches |
| Resolver disagrees with prior subject attachment | Park; prepare HIGH `correct_observation_subject`; never auto-replace |
| Ingest run dies mid-stream | Zero proposals applied (M24 transactionality, re-proven) |
| Source text addressed to "the AI" | Operational taint assessment when detected; the immutable Observation is unchanged, and any resulting proposal still passes ordinary serde/policy/CAS and retains lineage — no claim of perfect detection or non-influence |
| Quota death during flip week | M25 behavior holds; nothing silent |
| Accessible counterevidence omitted, or intent only marked attempted | Contract violation → refusal, not a degraded answer |
| Counterevidence source inaccessible after recorded attempts | Typed `blocked` manifest; provisional answer if policy permits, never “all sources searched” |

## Testing

- Resolver fixtures cover every eligible outcome and ineligible reason;
  malformed/`subject:none`/already-attached rows never enter M28 denominators,
  and the exact R3/R6 distinct-ID queries have golden counts.
- Window routing: deterministic complete `material_candidate` items produce
  zero LLM runs; mixed material/semantic items produce one combined run;
  neither verdict branch loses work.
- Receipt handoff: create proposals require server-minted semantic receipt v2;
  missing/stale/unavailable/unconsidered semantic legs refuse before live tool
  registration or application.
- Source-taint fixtures: direct mutation remains impossible; a detected signal
  is stored operationally without changing the Observation. An adversarial source that induces
  a valid LOW-risk proposal demonstrates the honest boundary: the proposal is
  policy-evaluated, applied or rejected normally, journaled, and lineage-linked
  — it is not magically rejected merely because the text looked hostile.
- Corroboration-only window (zero field changes, one new independent
  source): produces an evidence-state proposal, never a discard. The seeded
  second source carries a committed positive M22
  `observation.independence_recorded` record, so the golden cannot pass on an
  implementation that treats any second source as corroboration (§17:
  independence_unknown never strengthens).
- Live-MCP inventory equals the M24 table; alias/split/exact-belief-merge/
  subject-correction fixtures construct only their mapped ops. Conflicting
  attachment parks and routes `correct_observation_subject` HIGH;
  `merge_entities` routes CRITICAL → human card.
- Preventive reachability: direct and transitive Observation lineage plus
  `derived_content.source_belief_revision_event_ids` are traversed; reaching
  any old or current revision of the target Belief refuses before default-on,
  cycles terminate, and unrelated support still applies.
- Semantic outcome vectors cover material, non-material, and blocked shapes;
  kill points prove outcome/proposal/terminal-receipt atomicity.
- Candidate-conflict vectors pin both endpoints, dedupe swapped pairs, reject
  missing support revisions, and rebuild the M27 queue after runtime-DB loss.
- Basic semantic retrieval goldens prove recall for alias, paraphrase, and a
  seeded accessible counterevidence item that BM25 alone misses.
- Context manifests show terminal states for all five intents. Accessible
  counterevidence is included; genuine exhaustion and source blockage carry
  attempt/source records; `attempted` alone fails serde/contract validation.
- Manifest serde rejects an item with neither tag, a mismatched belief/revision,
  a linked belief without basis/source refs, and an assertion without its one
  source; multi-source and unsupported-belief vectors remain representable.
- Sufficiency/adequacy divergence fixtures: excellent retrieval + weak
  evidence, and the reverse.
- Schema vectors require `as_of` on all ten named adequacy dimensions, every
  defined nested statement/ref type, and all nine answer parts; missing,
  renamed, or impossible tagged fields fail deserialization.
- Cap enforcement: attended context/source/item caps refuse oversize assembly
  but daily run/token spend never blocks attended use; ambient daily run,
  output-token, failure, quota, and elapsed-time gates abort/degrade.
- New IPC/MCP commands ship with mock stubs + parity assertions; verdict
  logic stays table/vector-driven.
- A simulated week of churn: ≤20 ambient runs/day AND within
  context/token caps.
- Resolver outcome, cost-component, assembly, and discovery-plan lifecycle
  rows are vault-scoped and survive restart. Cost vectors require all ten rows,
  enforce units, and reproduce the integer projection fixture. Discovery
  vectors prove content-addressed dedupe, monotonic transitions, direct
  dismissal, and R13's pending-age query. M28 rate/window fixtures compute
  solely from persisted rows.
- Convergence over a seeded diff: then/now/changed/blind sections correct;
  scheduled output is a disposable `convergence_runs` row and creates no
  Narrative or epistemic event.
- **CI never touches the owner's quota:** every soak runs against copied
  vaults with the CLI mocked or budget-zeroed, on M25's recorded stream
  fixtures.
- Prompt templates live in-repo, reviewed like code; every epistemic field
  they can populate ships labeled agent-supplied.
- e2e: the flip respects the distiller kill switch through the runtime-DB
  migration, or every Playwright spec starts burning fake runs.

## Non-goals

No Skeptic (M28+ — independent retrieval authority is its definition; the
assembler's contradiction-aware retrieval is NOT it and must not be named it)
· no Pattern Scout · no learned entity resolution or learned aliases · no
persistent Discovery/Claim/Forecast/narrative objects · no scalar salience,
no scores anywhere · attention *lanes* are M27; M26 ships the services they
consume.

## Acceptance

On-by-default live only after live-tool inventory, M24 atomicity, and
anti-self-ancestry checks are green · both M25 verdict branches consumed, with
at most one semantic run per settled window · basic semantic recall goldens
green · attended assembly bounded by source/item/byte caps but never daily-
budget blocked · ambient work bounded at ~10–20 runs/day and by output/failure
gates · all ten adequacy dimensions carry basis/state/as-of, both adequacy and
sufficiency and every closed nested type are present · R1 cost and R13 plan
lifecycle inputs are reproducible · convergence demo works and scheduled output stays
a non-Narrative cache · old distill path deleted with the learn-queue UI
intact · eval fixtures landed · full gates green.
