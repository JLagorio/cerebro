# M28+ — The trigger registry (deferred capabilities, each behind a named gate)

**Brief for the agent picking this up cold.** Written 2026-08-07; amended
2026-08-14 by M31.8, which registered R15–R17 — three deferrals surfaced by
M31's claims audit rather than by the coverage matrix. The design spec
carries their full rows and the artifact-versioning rule
(`trigger-registry.v1.json` still holds exactly R1–R14; an unnamed gate key
refuses, so none of the three can be evaluated or fire until a successor
artifact revision lands with their first evaluator). M28.0 is a
small implementable governance milestone; M28+ is the **registry** it runs.
Per D7's consumer rule and the matrix's
persist-primitive/defer-consumer pattern, every entry names the deferred
capability, its gate, its already-persisted promotion source, and the boundary
that prevents premature construction. This plan authorizes only the M28.0
artifact/storage/read-only evaluator/evidence validator below. A fired gate
produces its own dated plan in the M21–M27 house style and never authorizes
deferred-capability implementation by itself.

**The standing rule: a gate is either measurable or explicitly discretionary
with written evidence.** Measurable gates name population, sample floor,
window, threshold, and persisted fields. Discretionary gates require a dated
owner-approved evidence pack naming the consumer, observed failure, primitive
shortfall, risk/cost boundary, and goldens. “This would be cool now” satisfies
neither. Early scope remains a same-commit matrix amendment + owner review,
never an improvisation.

Every evaluation implements the design's closed `measurable | discretionary |
hybrid` `TriggerEvaluation` union, tagged count/ppm/quantity metrics, and
`not_ready | not_fired | fired` result. Its stable gate key combines registry
ID with `root` or an exact registered per-object/tail/connector key and a
closed scope. R1/R2 are intentionally `subscription_global`; R3–R17 require one
`vault_store{vault_id,store_uuid}`. The ID hashes gate key, scope, rule version,
and canonical input snapshot. Source metric series also carry `store_uuid`, and
cross-scope inputs/parents refuse. Measurable records go
to unique runtime `trigger_evaluations` rows with window/timezone and canonical
metrics; discretionary records are canonical frontmatter under
`docs/superpowers/evidence/triggers/<registry-id>/`; hybrid requires both. A fired plan references
the evaluation ID. Missing data is `not_ready`; reruns are idempotent.

### M28.0 — Governance substrate only

Ship `shared/policy/trigger-registry.v1.json` and byte-identical Rust/TypeScript
loaders for the design's closed gate/subkey/variant/parent/metric-unit table.
Add immutable runtime `trigger_input_snapshots` (canonical source rows and
distinct IDs, not only aggregates) and idempotent `trigger_evaluations`. The
closed evaluation record carries sorted snapshot refs plus their
domain-separated hash; measurable uses one runtime snapshot, discretionary
the matching evidence payload, and hybrid exactly both. Four-week protocols
record explicit 1–4 bucket series with start/end dates.

Implement a read-only evaluator over only the named M22–M27 primitives and an
evidence-pack validator that recomputes canonical hashes and checks owner,
path, gate mode, parent, and result. They may write only the two governance
tables: no ledger/vault mutation, agent launch, proposal registration, feature
flag, or protected-name implementation. Test cross-language artifact/schema
parity, migration/rebuild, every invalid gate-mode/root/subkey combination,
R5 Discovery's byte-equal fired-R13 alias, every R12 parent, missing-data
`not_ready`, hash tampering, metric recomputation/unit mismatch, idempotent
rerun, and a tripwire that all R1–R14 capabilities remain disabled.

The exact mode map is: measurable roots R1/R3/R6/R7/R10/R13/R15; hybrid root
R2;
discretionary roots R8/R9/R11/R16/R17; per-object discretionary R4
`issue|risk|action|decision`; per-object discretionary R5
`assumption|causal_hypothesis|forecast`; R5 `discovery` is a measurable alias
requiring a fired R13 root with byte-equal window/snapshot/metrics/result;
R12 uses only the design's registered tail keys and their fired allowed parent;
R14 uses only `connector:<registered-connector-id>`. All other combinations
refuse, and parent evaluation is null except R5 Discovery and R12.

---

## Registry

| # | Capability | Mode and gate | Promotion source | Do not build early |
|---|---|---|---|---|
| R1 | **Skeptic pass** — independently initiated adversarial retrieval + critique; its retrieval authority cannot be the conclusion run's (§83, §47). MEDIUM findings amortize into maintenance; HIGH/CRITICAL remain human cards | **Measurable:** R1 cost protocol below over 28 complete days; sample and component completeness thresholds must pass and produce a versioned projection before a risk-gating plan may be written | M26 contradiction-aware assembly (not a Skeptic), `run_cost_components`/`assembly_metrics`; M27 classification outcomes | A shared-context “self-review”; dropping M26's ordinary contradiction retrieval once Skeptic exists |
| R2 | **Pattern Scout** — genuinely novel-pattern detection (§27/§29) | **Hybrid:** owner accepts a dated operational novelty definition and goldens, then the measurable fixed-ceiling headroom protocol below passes | M25 `budget_days` usage/effective-ceiling snapshots + predeclared evidence; M26 Source Monitor | Renaming Source Monitor; generic anomaly prompting in maintenance |
| R3 | **Claim-granularity Resolver + Claims-as-objects** — SourceArtifact / Observation / ExtractedAssertion split | **Measurable:** R3 pressure protocol below; the gate authorizes a plan for the resolver and object promotion together, removing the old circular dependency | M22 typed assertion/observation distinctions; M26 `resolver_outcomes` | Per-assertion object machinery before measured granularity pressure |
| R4 | **Issues/Risks/Actions/Decisions as epistemic objects** — `next_expected_event` with Issues; prepare-never-decide, 16-field frames, stakes-relative readiness, and value-of-information with Decisions (§54–§58) | **Evidence-based discretionary per object:** the owner accepts the consumer evidence pack below; one object never unlocks the batch | Vault records, M24 capability profiles, D12 stages, M27 generic critical bypass | Lifecycle machinery or specialized lanes without the accepted consumer |
| R5 | **Assumptions, Discovery objects, causal hypotheses, forecasts** — Assumptions gain validation state/debt; Discovery rides R13; causal and Forecast objects require their own surfaces. Forecast calibration stays ordinal; numeric probability remains cut | **Mixed:** Discovery uses measurable R13. Each other object is evidence-based discretionary per object using the consumer evidence pack below | M26 discovery-plan schema/hypothesis labels; M27 generic debt | Persisting any object before its own gate |
| R6 | **Learned entity resolution** — inspectable alias model, temporal validity, ambiguity improvements (§84) | **Measurable:** R6 bottleneck protocol below over four complete 7-day buckets | M22 IDs/aliases; M26 deterministic resolver + `resolver_outcomes` | Embedding-similarity auto-attach; hidden adaptation |
| R7 | **Cross-source verification policies** | **Measurable:** the R7 same-store/same-scope protocol below qualifies two distinct sources for 30 healthy days and ≥100 committed assertion Observations each | M22 store-scoped IDs + D11 metadata; M25 health; M24 checks | Preferred routes with fewer than two qualifying connectors |
| R8 | **§35 primary project view** | **Evidence-based discretionary:** owner accepts a usage/growth-pain evidence pack for the shipped M27 skeleton | M27 skeleton + M26/M27 data | Dedicated replacement view before lived evidence |
| R9 | **Persistent project Narrative + executive convergence storytelling** | **Evidence-based discretionary:** owner accepts a Narrative evidence pack showing at least two independently shipped surfaces whose current workflows both fail without shared cross-run identity/history | M26 convergence run/output cache plus the two surface artifacts in the pack | Narrative identity for one consumer, merely cached output, or a circular requirement for a Narrative ID before the gate fires |
| R10 | **Always-on companion service** | **Measurable:** R10 recurring-gap protocol below; launch catch-up must have failed a declared retention/deadline contract repeatedly | M25 coverage-gap/catch-up records and D10 responsibility boundary | A daemon for latency preference or an unmeasured gap |
| R11 | **Multi-master ledger merge** | **Evidence-based discretionary:** an accepted product/architecture evidence pack requires two independently live writer IDs to mutate the same store without adopt-and-reingest | M21 store/writer UUID segment identity | HLC/vector clocks for a single writer |
| R12 | **Named §-level tails** listed below | **Evidence-based discretionary per tail:** its parent gate must have fired **and** the owner must accept a tail-specific consumer evidence pack; parent activation alone never unlocks it | Each named parent + shipped primitive, below | Bundling tails with a parent without separate evidence |
| R13 | **Curiosity + full discovery loop** (§66/§70/§71; pattern detection jointly with R2) | **Measurable:** R13 unexecuted-plan protocol below | M26 `discovery_plan_runs`; M24/M26 minimal stopping rule | A loop before the backlog threshold; renaming maintenance Curiosity |
| R14 | **Live connectors as separate post-M27 milestones (§61)** | **Evidence-based discretionary:** owner schedules one connector after accepting a source-specific evidence pack covering consumer, auth/privacy, retention/scope, health semantics, and fixtures | `connectors.rs`; M22 nullable provenance | Route/scope machinery or a generic connector mega-milestone |
| R15 | **Unprompted recall** — the attended assembler surfacing manifest items the question did not ask for (M31.8) | **Measurable:** R15 attended-latency protocol below over 28 complete days after M31.7; the fired plan must first name the third execution contract (neither attended-metered nor ambient-gated); deciding owner: the vault owner | M25 `runs.mode`; M26 `working_memory_manifests`; M31.5 `assembly_metrics.answer_latency_micros` + M31.6's attended-path writer | Any scalar salience score; routing through `budget::gate`; claiming the attended metered-never-gated exemption for output nobody asked for |
| R16 | **Prior manifest as retrieval hint** (M31.8) | **Evidence-based discretionary:** the vault owner accepts a pack answering the four recorded failure modes below; safe design is aliases-only widening | M26 `working_memory_manifests` (the persisted prior manifest); the M26 `Retriever` trait seam | A hint outside the `assembly_id` hash or around the `Retriever` trait; widening beyond aliases; `exhausted` for an intent whose work a hint skipped |
| R17 | **Folder-level ingest opt-out** (M31.8) | **Evidence-based discretionary:** the vault owner accepts a pack that MUST contain the (a)/(b) product decision below | `ingest/ambient.rs` deterministic pre-gate phases; `vault::scan::scan_vault` | A per-folder flag before the (a)/(b) decision; a half opt-out (LLM half skips, ledger keeps writing) shipped as honoring the user's intent |

## Exact measurement protocols

### R1 — Skeptic cost evidence

Use the preceding 28 complete local calendar days in the evaluation's IANA
timezone after M26 default-on.
Require ≥30 successful belief-affecting synthesis runs, including ≥10 HIGH/
CRITICAL intended uses, and non-null component quantities for ≥95% of the
sample. `shared/policy/cost-projection.v1.json` computes one independent
Skeptic-tier run per sample. Complete means all ten M26 components exactly once
with non-negative integer quantities and fixed units; zero is present, not
absent. Rows carrying `estimated = 1` (M31.6: `selected_context_tokens` and
`prompt_template_tokens`, derived at four bytes per token) COUNT toward
component completeness and are EXCLUDED from the projection — project only
`estimated = 0` rows and keep the estimated ones out of the projected
totals. The record field that names them separately does not exist yet and
is not invented here; it lands with R1's first evaluator (see the spec's R1
protocol). Apply exactly
`ceil(q * multiplier_ppm / 1_000_000) + fixed_quantity`. Persist policy hash,
all projected components, p50/p90 inputs/outputs/calls/cost when priced, and
HIGH/CRITICAL daily load in the evaluation. Passing fires planning; no sample
is misrepresented as an actual Skeptic run.
For p50/p90, sort integer values and take nearest rank
`x[ceil(p * n) - 1]` at `.50`/`.90`; never interpolate or use floats.

### R2 — Fixed-ceiling ambient headroom

Before the 28-day window, the owner evidence pack freezes a positive
`max_daily_tokens`, IANA timezone, setting hash, and window start. Any setting
change or missing `budget_days` row invalidates the window: all 28 rows must
match the pack's immutable effective ceiling, settings hash, and version, so a
change-and-revert remains visible. For every complete
day compute `max(0, floor((ceiling - ambient_tokens_used) * 1_000_000 /
ceiling))` with saturating integer subtraction;
require ≥200,000 on at least 21 days. Never reconstruct history from today's
mutable setting.

### R3 — Claim-granularity pressure

Evaluate four complete consecutive 7-day buckets. Across them require ≥200
eligible assertion-resolution attempts from ≥50 distinct artifacts, with ≥50
attempts in each bucket. Fire when `claim_granularity_blocked /
eligible_attempts >= 10%` in at least three buckets. Count distinct
`attempt_id` over M26's eligible tag; the numerator additionally requires
`outcome=claim_granularity_blocked`, parked, and `target_count>=2`. It is an
outcome, not reason prose. Count distinct artifacts and bucket by
`attempted_at` in the evaluation timezone. The fired plan builds the claim-
granularity Resolver and promotes the persisted typed assertions together; it no longer waits
circularly for a Resolver that has no build trigger.

### R6 — Entity-resolution bottleneck

Use four complete consecutive 7-day buckets, ≥200 eligible attempts from ≥50
artifacts total, and ≥50 attempts per bucket. In at least three buckets both
`unresolved / eligible_attempts >= 15%` and `unresolved_parked_items /
eligible_attachment_parked_items >= 40%` must hold. Exclude malformed/missing-subject
inputs from the denominator and report them separately. Attempt rates count
distinct eligible `attempt_id`; item rates count distinct `ingest_item_id`,
with unresolved+parked as numerator and every eligible parked item as
denominator. Ineligible tags are excluded and reported by closed reason. Learned aliases remain
inspectable/editable; the trigger does not authorize similarity auto-attach.

### R7 — Same-store cross-source qualification

Snapshot one `store_uuid` and canonical `verification_scope_digest`. Across 30
complete days, two distinct source IDs whose ledger
`source.registered.registration.kind` is `connector` remain
connected+healthy continuously and each contribute ≥100 distinct committed
assertion-bearing Observation event IDs matching that same subject/predicate/
scope digest. Join through M25's exact portable
`source_registration(store_uuid, source_id)` cache with matching registration
event/canonical fields. Count only records with M22 scope/relationship/basis
metadata; exclude human_actor/builtin/cerebro_runtime/legacy_reference sources,
cross-store IDs,
snapshots, derived content, unrelated scopes, join duplicates, stale/orphaned
cache rows, and Observations whose pinned registration differs.

### R10 — Recurring launch-catch-up gap

Over 30 complete days, require ≥3 distinct joined M25
`catchup_outcomes`/`coverage.gap` episodes for the same live
`responsibility_id`, on ≥3 different days, each lasting ≥4 hours from
`app_closed_at` to `resolved_at` and ending with persisted catch-up outcome `retention_lost` or
`declared_deadline_missed`; total qualifying duration must be ≥12 hours.
Ordinary app-closed delay, successful catch-up, quota backoff, and source outage
do not count. Every outcome links the matching gap and contract active during
the episode. The fired plan must show how residency would have prevented each sampled loss.

### R13 — Unexecuted discovery plans

Over 30 complete days, require ≥20 distinct M26 plan IDs across ≥10 emission
runs. Fire only when ≥12 remain in exact `pending` state for at least 14 full
days at evaluation and ≥4 are HIGH/CRITICAL. Exclude started and every terminal
row, including dismissed. Content-addressed IDs dedupe re-renders.

### R15 — Attended latency headroom (M31.8)

Use the preceding 28 complete local calendar days in the evaluation's IANA
timezone, starting no earlier than M31.7's fold cache (a straddling window
measures two different assemblers). Sample every attended assembly — `runs`
row with `mode = 'attended'` joined to `assembly_metrics` and, through
`manifest_id`, to its `working_memory_manifests` receipt — whose receipt
records at least one selected item under the positive intent and whose
`answer_latency_micros` is non-NULL (NULL rows are excluded from floor and
distribution alike; absent is never zero). Require ≥200 such assemblies
(`sample_runs`). Nearest-rank p50/p90 over sorted integers, R1's exact
no-float rule; the gate is p90 because the quantile enum is `p50 | p90` —
a p95 would be unrepresentable. Fire only when `p90 < 250_000` micros; a
sample below the floor is `not_ready`, a floor-passing sample at or above
the threshold is `not_fired`. Both quantiles persist as `answer_latency`
metrics (unit `micros`). The fired plan's first obligation is naming the
third execution contract unprompted recall would run under — neither
`Mode::Attended` (metered, never gated) nor ambient (gated by
`budget::gate`) — before proposing any mechanism.

## Evidence-based discretion and R12 tails

A consumer evidence pack names the deciding owner, concrete consumer and
workflow, at least three representative persisted examples, the failure of the
current primitive, expected write/read paths, risk/cost/privacy boundary, and
golden acceptance/refusal cases. R4 and non-Discovery R5 objects require one
pack **per object**. R8 additionally includes skeleton usage and observed
growth pains; R9 includes both independent shipped surface artifacts and the
specific cross-run identity failure; R11 includes the two-writer concurrency
requirement; R14 includes
the source-specific auth, retention, scope, and health contract.

R16's pack must individually answer the four failure modes recorded at
registration (M31.8): the hint must be inside the `assembly_id` hash or
determinism breaks; it must enter through the `Retriever` trait or retriever
purity breaks; an intent whose work a hint skipped may not report
`exhausted`; and a prior manifest seeding the next retrieval is a
retrieval-layer self-ancestry shape `policy/ancestry.rs` does not catch (the
walk covers belief bases; a hint is not a basis), so the pack names the
check that closes that loop. Safe design: aliases-only widening. R17's pack
MUST contain the (a)/(b) decision as re-verified at registration: the
deterministic pre-gate half of `ingest/ambient.rs` runs four
ledger-appending phases (conflict detection, the classification gauntlet,
the legacy-contradicts backfill, the freshness scheduler) plus the
attention/convergence/Source Monitor consumers, so "opt out" means either
(a) the LLM half skips while those four phases keep writing ledger records
about "ignored" files, or (b) the app does not see the folder at all —
`vault::scan::scan_vault`, the one choke point, is also the UI's file list.

Every R12 tail is separately discretionary after its parent and uses the same
pack: per-type temporal decay (R4 object) · full relation vocabulary (R4
Issues/Decisions) · decision-urgency/blocker lanes and revisit conditions (R4
Decisions) · scope-collision maintenance (R6) · full knowledge-fitness review
(R8; named maintenance consumer) · learned preferences (R8; preference
consumer + §81 visible/editable artifact) · learned aliases/routes/preferences
from the §81 mechanism set (R6/R7/R8 respectively) · custom predicate
freshness (consumer over M27 defaults) · per-connector scope models (qualifying
R14 connector) · participant/workstream metadata (named retrieval/project
consumer) · issue/theme/workstream compression rungs (R4 Issues) · executive
narrative rung (R9) · advanced semantic/graph retrieval (R1; a golden miss
from M26 basic retrieval blocks a named consumer) · meeting/executive prep
(R8/R9). Parent activation alone never fires a tail.

---

## Standing obligations while entries sleep

- A firing produces a dated plan doc plus matrix-row update in one commit;
  this registry never authorizes code directly.
- Additive-only ledger discipline applies to every future schema. If a
  promotion requires archaeology, record a matrix defect; do not paper it
  over.
- Protected names are **Skeptic, Scout, Curiosity, Claim, Discovery,
  Forecast, Narrative**. Nothing uses one before meeting its definition.
- Narrowed cuts stay cut: scalar salience (§9), product dashboards (§37), the
  monolithic status enum (§49), numeric calibration (§96), and ACL propagation
  (§91).
- Every fired plan grows the eval suite with its mechanism and ships its
  goldens in the same work.

## Registry acceptance

Each deferred capability appears once with an exact measurable protocol or an
explicit owner-approved evidence pack · evaluation schema/result/idempotency
is closed · missing samples evaluate `not_ready` · R1/R2/R3/R6/R7/R10/R13/R15
are
reproducible from specified persisted primitives/snapshots using the same
distinct-ID filters/windows/floors/thresholds as the design ·
R4/R5/R8/R9/R11/R12/R14/R16/R17 retain
dated written evidence · every firing produces plan + matrix update · no
promotion requires archaeology.
