# Cerebro M28+ — The Trigger Registry: Deferral Governance — Design

**Date:** 2026-08-08
**Status:** Derived from the accepted Rev 3 roadmap (D7's consumer rule, D10's cuts) and the frozen coverage matrix (its M28+ rows and "Pulled forward" section). For owner review.
**Scope:** M28.0 implements only the governance substrate that can evaluate and
record gates; M28+ governs the deferred capability plans. Fourteen registry
entries classify each gate as measurable or explicitly evidence-based
discretionary, name its M22–M27 promotion source, and preserve an explicit
do-not-build-early boundary—plus a protected-names glossary and standing
obligations that keep deferral honest.
**Companion plan:** `../plans/2026-08-07-cerebro-m28-trigger-registry.md` implements
M28.0 and holds the same registry in work-order form. Where the two disagree,
this spec wins.

## Context

The matrix's operating pattern is *persist the primitive early when
retrofitting would be painful; defer the rich consumer until it earns
itself* (the observation_kind pattern, generalized). Rev 2 pulled ten
foundational primitives forward into M22–M27 precisely so everything left in
M28+ is a **promotion of a persisted primitive, never a migration requiring
archaeology**. This registry is the other half of that bargain: the deferred
consumers, each behind a named gate.

## Governance rules

1. **A gate is either measurable or explicitly discretionary with written
   evidence.** Measurable gates state population, sample floor, window,
   threshold, and persisted fields. Discretionary gates state who decides and
   require a dated evidence pack naming the consumer, observed failure, why
   existing primitives are insufficient, cost/risk boundary, and golden
   scenarios. "This would be cool now" satisfies neither. If work seems to
   require a deferred capability early, that is a matrix amendment — scope
   change, same-commit matrix update, owner review — never an improvisation.
2. **A fired trigger produces a dated plan doc** in the M21–M27 house style,
   plus a matrix row update in the same commit. M28.0 authorizes only its
   evaluator/storage/validation substrate; neither that substrate nor any
   evaluation authorizes deferred-capability code.
3. **Names must not lie (D6).** Nothing may take a deferred capability's name
   before meeting its definition. Protected names: **Skeptic, Scout, Curiosity,
   Claim, Discovery, Forecast, Narrative.** Misnaming is a real defect — it silently
   satisfies triggers that have not been met.
4. **Promotions, not migrations.** If promoting a deferred object requires
   archaeology, a primitive was missed — a matrix defect to record, not paper
   over. Additive-only ledger discipline applies to every future schema.
5. **Settled decisions are not relitigated.** The narrowed cuts stay cut:
   scalar salience (§9), product metric dashboards (§37), the monolithic
   claim-status enum (§49), numeric calibration (§96). §91 ACL propagation
   stays cut outright.
6. **The eval suite grows with mechanisms, never after them.** Each fired
   trigger's plan doc includes its golden scenarios.

Every evaluation uses one closed record:

```text
TriggerResult = not_ready | not_fired | fired
RegistryId = R1 | R2 | R3 | R4 | R5 | R6 | R7
           | R8 | R9 | R10 | R11 | R12 | R13 | R14
GateKey { registry_id: RegistryId,
          subcapability: root | registered_subcapability_key }
EvaluationScope = subscription_global
                | vault_store { vault_id, store_uuid }
CountMetricName = sample_runs | high_stakes_runs | complete_runs | headroom_days
                | eligible_attempts | granularity_blocked_attempts
                | distinct_artifacts | emission_runs | qualifying_gap_days
                | unresolved_attempts | eligible_attachment_parked_items
                | unresolved_parked_items | qualifying_sources
                | qualifying_observations | gap_episodes | emitted_plans
                | pending_plans | pending_high_stakes_plans
RatioMetricName = component_completeness | unused_headroom
                | granularity_blocked_rate | unresolved_rate
                | unresolved_parked_rate
QuantityMetricName = projected_component { component: M26 CostComponent }
                   | projected_input | projected_output
                   | projected_calls | projected_cost | gap_duration
MetricSeriesKey = aggregate | sample { run_id }
                | source { store_uuid, source_id }
                | day { local_date: YYYY-MM-DD }
                | bucket { ordinal: 1..4, start_date: YYYY-MM-DD,
                           end_date: YYYY-MM-DD }
                | statistic { quantile: p50 | p90 }
                | high_stakes_daily_load
TriggerMetric = count { name: CountMetricName, series: MetricSeriesKey,
                        value: integer >= 0 }
              | ratio_ppm { name: RatioMetricName, numerator: integer >= 0,
                            denominator: integer > 0,
                            value_ppm: integer 0..1_000_000,
                            series: MetricSeriesKey }
              | quantity { name: QuantityMetricName, value: integer >= 0,
                           unit: tokens | calls | bytes | micros | seconds,
                           series: MetricSeriesKey }
InputSnapshotRef = runtime { snapshot_id } | evidence { path: repo-relative-path }
TriggerEvaluation =
  measurable {
    evaluation_id, gate_key: GateKey, scope: EvaluationScope,
    evaluated_at: RFC3339,
    window: { start: RFC3339, end: RFC3339, timezone: IANA-name },
    input_snapshot_refs: [InputSnapshotRef; min_items=1],
    input_snapshot_hash: sha256,
    metrics: [TriggerMetric; min_items=1],
    evidence_pack_path: null, result: TriggerResult, rule_version,
    approving_owner: null, parent_evaluation_id: evaluation-id?
  }
| discretionary {
    evaluation_id, gate_key: GateKey, scope: EvaluationScope,
    evaluated_at: RFC3339,
    input_snapshot_refs: [InputSnapshotRef; min_items=1],
    input_snapshot_hash: sha256, evidence_pack_path: repo-relative-path,
    result: TriggerResult, rule_version, approving_owner: non_empty_string,
    parent_evaluation_id: evaluation-id?
  }
| hybrid {
    evaluation_id, gate_key: GateKey, scope: EvaluationScope,
    evaluated_at: RFC3339,
    window: { start: RFC3339, end: RFC3339, timezone: IANA-name },
    input_snapshot_refs: [InputSnapshotRef; min_items=1],
    input_snapshot_hash: sha256, metrics: [TriggerMetric; min_items=1],
    evidence_pack_path: repo-relative-path, result: TriggerResult,
    rule_version, approving_owner: non_empty_string,
    parent_evaluation_id: evaluation-id?
  }
```

Gate key and evaluation variant are a closed compatibility table; any other
root/subkey/variant combination refuses schema validation:

| gate key | required variant | parent evaluation |
|---|---|---|
| `R1:root`, `R3:root`, `R6:root`, `R7:root`, `R10:root`, `R13:root` | measurable | null |
| `R2:root` | hybrid | null |
| `R4:issue|risk|action|decision` | discretionary | null |
| `R5:assumption|causal_hypothesis|forecast` | discretionary | null |
| `R5:discovery` | measurable alias of R13 | required fired `R13:root`; window, snapshot, metrics, and result byte-equal the parent |
| `R8:root`, `R9:root`, `R11:root` | discretionary | null |
| `R12:<registered-tail-key>` | discretionary | required fired allowed parent below |
| `R14:connector:<registered-connector-id>` | discretionary | null |

R4/R5/R12/R14 root keys and subkeys on every other entry are invalid. The
scope is equally closed: R1/R2 use `subscription_global` and intentionally
aggregate all subscription usage/budget rows; R3–R14 use one non-null
`vault_store`, and every runtime/evidence row, source-series `store_uuid`, and
parent evaluation must match it. Cross-scope input is a refusal, not a partial
sample. The
closed R12 tail/allowed-parent map is:

- `per_type_temporal_decay` → any matching fired R4 object;
- `full_relation_vocabulary` → fired `R4:issue` or `R4:decision`;
- `decision_urgency_blocker_lanes` and `decision_revisit_conditions` → fired
  `R4:decision`;
- `scope_collision_maintenance` and `learned_aliases` → fired `R6:root`;
- `full_knowledge_fitness_review`, `learned_preferences`, and
  `participant_workstream_metadata` → fired `R8:root`; parenting the fitness
  review and preferences on R8 is an explicit owner choice, not a matrix
  derivation — both capabilities are consumed and rendered through the §35
  view surface, so the view milestone is their first real consumer;
- `learned_authority_routes` → fired `R7:root`;
- `custom_predicate_freshness` → any matching fired R4 object;
- `per_connector_scope_model` → fired matching
  `R14:connector:<registered-connector-id>`;
- `issue_theme_workstream_rungs` → fired `R4:issue`;
- `executive_narrative_rung` → fired `R9:root`;
- `advanced_graph_semantic_retrieval` → fired `R1:root`; the R1 parent is an
  owner choice — the Skeptic's independent retrieval authority is the first
  consumer that stresses retrieval beyond M26's golden-fixture floor — and the
  golden-miss evidence pack is still required as the tail's own pack;
- `meeting_executive_prep` → fired `R8:root` or `R9:root`.

Quantity units are fixed: projected input/output use
`tokens`, projected calls use `calls`, projected cost uses `micros`, gap
duration uses `seconds`, and projected components use M26's component unit;
all other name/unit pairings refuse. `evaluation_id =
sha256("cerebro-trigger-evaluation-v1\0" + canonical_gate_key + "\0" +
canonical_scope +
"\0" + rule_version + "\0" + input_snapshot_hash)`. Measurable evaluations
append to runtime `trigger_evaluations` with a unique evaluation ID and
canonical serialized metrics. Measurable records have exactly one runtime
snapshot ref; discretionary records have exactly the evidence ref matching
their pack path; hybrid records have exactly one of each. Runtime
`trigger_input_snapshots` retains the canonical source rows and distinct IDs—not
only aggregates—so each metric, day, four-week bucket, source, artifact,
attempt, plan, and gap episode is reproducible. `input_snapshot_hash` is the
domain-separated hash of the resolved canonical payloads in tag/key order;
missing or hash-mismatched refs are `not_ready`. Discretionary records are the canonical
frontmatter of
`docs/superpowers/evidence/triggers/<registry-id>/<date>-<slug>.md`; the path
must resolve; `input_snapshot_hash` hashes its canonical evidence payload and
referenced metric snapshot while excluding evaluation frontmatter/hash fields,
so it is not self-referential. Hybrid
evaluations require both homes joined by evaluation ID. A firing's
dated plan references the evaluation ID and preserves its canonical record.
Missing fields/data produce `not_ready`, never `fired`; rerunning one snapshot
is idempotent.

## M28.0 — Implement the governance substrate, no promotion

M28.0 is the one implementation authorized by this document. It ships
`shared/policy/trigger-registry.v1.json` containing the closed gate/mode/subkey/
parent/metric-unit rules above, loaded byte-identically by Rust and TypeScript;
a runtime-DB migration for immutable `trigger_input_snapshots` and idempotent
`trigger_evaluations`; a read-only evaluator that can query only the named
M22–M27 primitives and write those two governance tables; and an evidence-pack
validator that canonicalizes frontmatter/payload, verifies owner/path/parent
references, and recomputes hashes. The evaluator cannot append ledger events,
mutate vault content, launch an agent, register a proposal op, or enable a
feature. A `fired` result only permits the dated plan + same-commit matrix
update required by rule 2.

Cross-language schema/artifact parity, migration/rebuild, exact gate-mode
refusals, parent validation, missing-data `not_ready`, snapshot-hash tampering,
metric-unit/count/rate recomputation, and rerun idempotency are release gates.
Tripwires prove all R1–R14 feature flags and protected-name implementations are
unchanged by M28.0.

## The registry

| # | Capability | Mode and gate | Promotion source (already persisted) | Do not build early |
|---|---|---|---|---|
| R1 | **Skeptic pass** — independently initiated adversarial retrieval + critique; its retrieval authority cannot be the conclusion run's (§83, §47). MEDIUM findings amortize into maintenance; HIGH/CRITICAL remain human cards | **Measurable:** R1 cost protocol below over 28 complete days; sample and component completeness thresholds must pass and produce a versioned projection before a risk-gating plan may be written | M26 contradiction-aware assembly (not a Skeptic), `run_cost_components`/`assembly_metrics`; M27 classification outcomes | A shared-context “self-review”; dropping M26's ordinary contradiction retrieval once Skeptic exists |
| R2 | **Pattern Scout** — genuinely novel-pattern detection (§27/§29) | **Hybrid:** owner accepts a dated operational novelty definition and goldens, then the measurable fixed-ceiling headroom protocol below passes | M25 `budget_days` usage/effective-ceiling snapshots + the predeclared evidence; M26 Source Monitor is deterministic fetching only | Renaming Source Monitor; generic anomaly prompting in maintenance |
| R3 | **Claim-granularity Resolver + Claims-as-objects** — SourceArtifact / Observation / ExtractedAssertion split | **Measurable:** R3 pressure protocol below; the gate authorizes a plan for the resolver and object promotion together, removing the old circular dependency | M22 typed assertion/observation distinctions; M26 `resolver_outcomes` | Per-assertion object machinery before measured granularity pressure |
| R4 | **Issues/Risks/Actions/Decisions as epistemic objects** — `next_expected_event` with Issues; prepare-never-decide, 16-field frames, stakes-relative readiness, and value-of-information with Decisions (§54–§58) | **Evidence-based discretionary per object:** the owner accepts the consumer evidence pack below; one object never unlocks the batch | Vault records, M24 capability profiles, D12 stages, M27 generic critical bypass | Lifecycle machinery or specialized lanes without the accepted consumer |
| R5 | **Assumptions, Discovery objects, causal hypotheses, forecasts** — Assumptions gain validation state/debt; Discovery rides R13; causal and Forecast objects require their own surfaces. Forecast calibration stays ordinal; numeric probability remains cut | **Mixed:** Discovery uses measurable R13. Each other object is evidence-based discretionary per object using the consumer evidence pack below | M26 discovery-plan schema/hypothesis labels; M27 generic debt | Persisting any object before its own gate |
| R6 | **Learned entity resolution** — inspectable alias model, temporal validity, ambiguity improvements (§84) | **Measurable:** R6 bottleneck protocol below over four complete 7-day buckets | M22 IDs/aliases; M26 deterministic resolver + `resolver_outcomes` | Embedding-similarity auto-attach; hidden adaptation |
| R7 | **Cross-source verification policies** | **Measurable:** the R7 same-store/same-scope protocol below qualifies two distinct sources for 30 healthy days and ≥100 committed assertion Observations each | M22 store-scoped source IDs + D11 authority metadata; M25 health; M24 single-source presence checks | Preferred routes with fewer than two qualifying connectors |
| R8 | **§35 primary project view** | **Evidence-based discretionary:** owner accepts a usage/growth-pain evidence pack for the shipped M27 skeleton | M27 skeleton + M26/M27 data | Dedicated replacement view before lived evidence |
| R9 | **Persistent project Narrative + executive convergence storytelling** | **Evidence-based discretionary:** owner accepts a Narrative evidence pack showing at least two independently shipped surfaces whose current workflows both fail without shared cross-run identity/history | M26 convergence run/output cache plus the two surface artifacts in the pack | Narrative identity for one consumer, merely cached output, or a circular requirement for a Narrative ID before the gate fires |
| R10 | **Always-on companion service** | **Measurable:** R10 recurring-gap protocol below; launch catch-up must have failed a declared retention/deadline contract repeatedly | M25 coverage-gap/catch-up records and D10 responsibility boundary | A daemon for latency preference or an unmeasured gap |
| R11 | **Multi-master ledger merge** | **Evidence-based discretionary:** an accepted product/architecture evidence pack requires two independently live writer IDs to mutate the same store without adopt-and-reingest | M21 store/writer UUID segment identity | HLC/vector clocks for a single writer |
| R12 | **Named §-level tails** listed below | **Evidence-based discretionary per tail:** its parent gate must have fired **and** the owner must accept a tail-specific consumer evidence pack; parent activation alone never unlocks it | Each named parent + shipped primitive, below | Bundling tails with a parent without separate evidence |
| R13 | **Curiosity + full discovery loop** (§66/§70/§71; pattern detection jointly with R2) | **Measurable:** R13 unexecuted-plan protocol below | M26 `discovery_plan_runs`; M24/M26 minimal stopping rule | A loop before the backlog threshold; renaming maintenance Curiosity |
| R14 | **Live connectors as separate post-M27 milestones (§61)** | **Evidence-based discretionary:** owner schedules one connector after accepting a source-specific evidence pack covering consumer, auth/privacy, retention/scope, health semantics, and fixtures | `connectors.rs`; M22 nullable provenance | Route/scope machinery or a generic connector mega-milestone |

## Exact measurement protocols

**R1 cost protocol.** Use the preceding 28 complete local calendar days in the
evaluation record's IANA timezone after M26 default-on. Require ≥30 successful belief-affecting synthesis runs,
including ≥10 HIGH/CRITICAL intended uses, and non-null component quantities
for ≥95% of the sample. A run is component-complete only when all ten M26
components occur exactly once, quantities are non-negative integers, and each
unit matches M26's fixed table; zero counts, absence does not. Apply
`shared/policy/cost-projection.v1.json` component-by-component using exactly
`ceil(q * multiplier_ppm / 1_000_000) + fixed_quantity`. Persist policy hash,
every projected component, versioned p50/p90 input/output tokens and calls,
priced cost when a snapshot exists, and projected HIGH/CRITICAL daily load in
the trigger evaluation. Passing the data floor fires planning; the plan must
set/decline risk gates from that projection. No sampled run is represented as
an actual Skeptic run. For each persisted distribution, sort integer values
ascending and use nearest rank `x[ceil(p * n) - 1]` for p50 (`p=.50`) and p90
(`p=.90`); no interpolation or floating point is allowed.

**R2 fixed-ceiling headroom protocol.** Before the 28-day window begins, the
owner-approved evidence pack records a positive `max_daily_tokens`, IANA
timezone, setting-content hash, and `window_starts_at`. That ceiling is fixed
for the observation window. Every one of the 28 M25 `budget_days` rows must
carry the identical immutable effective token ceiling, settings hash, and
settings version declared by the pack; a missing/mismatched row (including a
change-and-revert) evaluates `not_ready`. For each complete local day compute integer-safe
`unused_ppm = floor((ceiling - ambient_tokens_used) * 1_000_000 / ceiling)`.
Use saturating subtraction: `unused_ppm = max(0, unused_ppm)` when usage
exceeds the ceiling.
The headroom leg passes only when `unused_ppm >= 200_000` on at least 21 days.
This predeclared snapshot plus M25's per-day snapshot/usage—not the current mutable setting—makes
historical headroom reproducible.

**R3 granularity-pressure protocol.** Evaluate four complete consecutive
7-day buckets. Across them require ≥200 eligible assertion-resolution attempts
from ≥50 distinct artifacts, with ≥50 attempts in each bucket. Fire when
`claim_granularity_blocked / eligible_attempts >= 10%` in at least three
buckets. Both are `COUNT(DISTINCT attempt_id)` over M26's `eligible` tag;
the numerator additionally requires
`outcome = claim_granularity_blocked`, `attachment_state = parked`, and
`target_count >= 2`. It is an outcome, not a free-form reason. Artifact floors
use `COUNT(DISTINCT artifact_id)`, and bucket membership uses `attempted_at` in
the evaluation timezone. The fired plan builds the claim-
granularity Resolver and promotes the persisted typed assertions together.

**R6 resolver-bottleneck protocol.** Over the same shape of four complete
7-day buckets, require ≥200 eligible attempts from ≥50 artifacts and ≥50 per
bucket. In at least three buckets, both `unresolved / eligible_attempts >=
15%` and `unresolved_parked_items / eligible_attachment_parked_items >= 40%`
must hold. The first numerator/denominator are distinct eligible `attempt_id`s.
The item numerator is distinct `ingest_item_id` where an eligible row has
`outcome = unresolved` and `attachment_state = parked`; its denominator is
distinct `ingest_item_id` for every eligible parked row. Ineligible tags are
excluded and reported by the closed M26 reason; no join multiplicity counts.
This is the exact meaning of “attachment bottleneck.”

**R7 same-store verification protocol.** Declare one `store_uuid` and one
canonical `verification_scope_digest` (resolved subjects, predicate classes,
and compatible stage/environment/geography constraints) in the input snapshot.
Within one 30-complete-day window, qualify two distinct `source_id`s whose
ledger `source.registered` state has `registration.kind: connector`; evaluation
joins only the M25 portable cache `source_registration(store_uuid, source_id)`
with its matching `registration_event_id` and canonical registration fields
(`human_actor`, `builtin`, `cerebro_runtime`, and `legacy_reference` do not
qualify). Each must remain `connected` and `healthy` without a state
transition for the full window and contribute ≥100 distinct committed
assertion-bearing `observation.recorded` event IDs matching that same scope
digest. Each counted Observation must carry the M22 scope, relationship, and
assertion-basis metadata needed by D11. Cross-store IDs, source snapshots,
derived content, unrelated scopes, and joined-row duplicates do not count. An
orphaned/stale cache row, or an Observation whose pinned
`source_registration_event_id` differs from the joined registration, also does
not count.

**R10 recurring-gap protocol.** Over 30 complete days, require ≥3 distinct
joined M25 `catchup_outcomes`/`coverage.gap` episodes for the same live
`responsibility_id`, on ≥3 different days, each lasting ≥4 hours from
`app_closed_at` to `resolved_at` and ending with persisted catch-up outcome
`retention_lost` or `declared_deadline_missed`; total qualifying duration must
be ≥12 hours. Ordinary app-closed delay, successful catch-up, quota backoff,
and source outage do not count. Each outcome must link the matching gap ID and
contract active during the episode. The plan must show how a resident process
would have prevented each sampled loss.

**R13 unexecuted-plan protocol.** Over 30 complete days, require ≥20 distinct
M26 `plan_id`s emitted across ≥10 `emitted_run_id`s. Fire only when ≥12 are
still in exact lifecycle state `pending` for at least 14 full days at
`evaluated_at`, and ≥4 of those pending rows are HIGH/CRITICAL. `started` and
all terminal rows are excluded; in particular `terminal(dismissed)` is not
unexecuted. M26's content-addressed ID makes a re-render the same plan.

## Discretionary evidence packs and R12 tails

A consumer evidence pack must name the deciding owner, concrete consumer and
workflow, at least three representative persisted examples, the failure of
the current primitive, expected write/read paths, risk/cost/privacy boundary,
and golden acceptance/refusal cases. R4 and non-Discovery R5 objects require
one pack **per object**. R8 additionally includes skeleton usage and observed
growth pains; R9 includes both independent shipped surface artifacts and the
specific cross-run identity failure; R11 includes the two-writer concurrency
requirement; R14 includes
the source-specific auth, retention, scope, and health contract.

Every R12 tail is separately discretionary after its parent and uses that
same pack: per-type temporal decay (R4 object) · full relation vocabulary
(R4 Issues/Decisions) · decision-urgency/blocker lanes and revisit conditions
(R4 Decisions) · scope-collision maintenance (R6) · full knowledge-fitness
review (R8; named maintenance consumer) · learned preferences (R8; preference
consumer + §81 visible/editable artifact) · learned aliases/routes/preferences
from the §81 mechanism set (R6/R7/R8 respectively) · custom predicate
freshness (consumer over M27 defaults) · per-connector scope models (qualifying
R14 connector) · participant/workstream metadata (named retrieval/project
consumer) · issue/theme/workstream compression rungs (R4 Issues) · executive
narrative rung (R9) · advanced semantic/graph retrieval (R1; a golden miss
from M26 basic retrieval blocks a named consumer) · meeting/executive prep
(R8/R9). No parent gate automatically fires a tail. Of §81's self-improvement
mechanisms this registry covers only learned aliases, routes, and preferences
plus source-reliability calibration (§96's ordinal track, via R5); the closed
key table makes that a safe-by-default closure — any further §81 mechanism
requires a registry amendment, never an improvisation.

## Acceptance

This design is satisfied on an ongoing basis, not at a milestone exit: every
deferred capability in the matrix appears exactly once in this registry with
either an exact measurable protocol or an explicit owner-approved evidence
pack · every evaluation has the closed persisted record/result/idempotency
contract · missing samples never fire · R1/R2/R3/R6/R7/R10/R13 evaluate from
the specified persisted primitives/snapshots with exact distinct-ID filters,
floors/windows/thresholds · R4/R5/R8/R9/
R11/R12/R14 decisions retain dated written evidence · no code in M22–M27 takes a
protected name without meeting its definition · every firing produces a plan
doc + matrix update in one commit · no promotion requires archaeology.
