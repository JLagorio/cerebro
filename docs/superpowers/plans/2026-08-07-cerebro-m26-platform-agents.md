# M26 — Platform agents on by default: the three constructs

**Brief for the agent picking this up cold.** Written 2026-08-07. Read the
master roadmap D6 (the collapse of ten roles into three constructs + two Rust
services, and the LLM/Rust boundary principle), D5, the retrieval-adequacy
section, and matrix rows §3, §15–§17, §22–§27, §30, §36, §43, §47, §50,
§63, §65–§68, §71, §76, §78–§80, §83–§84, §90, §92–§93, §98 first. Everything before this milestone was substrate; M26 is
where LLM behavior returns — batched, budgeted, proposal-gated, and honest
about what it doesn't know.

**"On by default" has a precise meaning**: deterministic phases always on;
LLM phases on within M25's ambient budgets. It is defensible only after M24
gates writes, M25 meters spend, and the preventive M22-support-graph
anti-self-ancestry check runs at proposal apply. M27 broadens lineage analysis;
it does not retroactively supply a safety prerequisite for this flip. If any
of those prerequisites regress, flip nothing.

---

## Where things stand (verify at start — refs drift)

- M25 landed: usage metering, durable scheduler, materiality prefilter,
  quota-honest backoff, the control surface. The prefilter emits both
  `material_candidate(dimensions)` and `needs_semantic_judgment`; neither has
  a consumer yet.
- M24's proposal machinery is exercised only by synthetic tests. The old
  per-note distill jobs (jobs.ts lanes) still exist and still run the
  pre-overhaul prompts.
- Isolated CLI sessions exist (agent.rs); M24's proposal tools remain absent
  from the live and mock loopback servers until this milestone's registration
  phase.
- M22's entity IDs + aliases exist in reducer state; nothing resolves free
  text against them yet.

## Non-goals (defend these)

- No Skeptic (M28+ — independent retrieval authority is its definition; the
  M26 assembler's contradiction-aware retrieval is NOT it and must not be
  named it).
- No Pattern Scout (the Source Monitor is a deterministic fetcher; names
  must not lie about responsibilities — amendment 6).
- No learned entity resolution, no learned aliases (M28+); the M26 resolver
  is deterministic tiers ending in *unresolved, never guessed*.
- No persistent Discovery/Claim/Forecast/narrative objects — structured
  *ephemeral* outputs only (§68 pattern: promotion later, not migration).
- No scalar salience, no scores anywhere: adequacy and sufficiency are
  structured prose-plus-enums, never percentages.
- Attention *lanes* are M27; M26 ships the deterministic services those
  lanes consume (Source Monitor; attention primitives), not the surfaces.

## Four rules that must survive contact with implementation

**At most one semantic run per settled change-window** — complete deterministic
material candidates use zero CLI runs; Observer+Extractor+Resolver+Proposer
share ONE CLI run for every residual item (not per file, not per role).
Ambient spend stays capped at ~10–20 runs/day; background LLM concurrency
stays 1 inside MAX_CONCURRENT_RUNS=4.

**Source-taint containment (§92), not semantic immunity.** Prompts delimit and
label source bytes as untrusted data. A versioned heuristic records
`suspected_instructional_content` (+ classifier/reason codes) in a vault-scoped
runtime assessment keyed to the immutable Observation event; it never mutates
M22's closed Observation body. The heuristic can miss and the model can still be influenced.
The honest guarantee is structural: source bytes have no direct mutator,
agents only emit serde-valid proposals, M24 policy/CAS/atomicity cannot be
bypassed, and applied proposals retain lineage. A hostile source can induce a
valid LOW-risk proposal; tests must show ordinary policy and journaling, not
claim perfect non-execution.

**Context integrity (class (a) invariant).** Every belief-affecting assembly
runs contradiction and scope-neighbor retrieval. Accessible counterevidence
must be included; otherwise the manifest carries a typed `exhausted` or
`blocked` record with attempts, source set, and reason. “Intent attempted” is
not a terminal state and cannot satisfy the contract.

**Two outputs, never merged (§47/§67).** Retrieval adequacy ("did we look
sufficiently?") and evidence sufficiency ("is what we found enough for THIS
use?") are separate structured outputs in every synthesis. "Retrieval:
partial · Sufficiency: adequate for a reversible prototype decision;
insufficient for production release."

**Preventive anti-self-ancestry before activation.** For each proposed
BeliefBasis support Observation, walk its Observation-lineage parents, every
`derived_content.source_belief_revision_event_ids` reference, and the linked
basis Observations of reached revisions. Reaching any revision of the target
Belief refuses `self_ancestry`. The cycle-safe walk lands before the live MCP
tools/default-on switch; M22 already excludes review attestations from basis/
Support, and M27 retains full independence counting and retrospective hygiene.

---

## Phases

One commit per phase, `type(scope): sentence (M26.n)`.

### M26.1 — Basic entity resolver (deterministic, Rust)
Resolution tiers over M22 state: exact entity ID → known alias → explicit
relation traversal → high-confidence existing-entity match (normalized
string equality class, NOT embeddings) → **unresolved**. Unresolved is a
first-class outcome that parks the observation for the ingest pass to
propose `add_entity_alias` (a MEDIUM op — an alias claim is a claim) or a
qualified `create_belief` (M24.7 path). Falcon/"Falcon C"/"Rev C"/"Product A"/Xavier
fixtures — the full matrix §84 set — from the roadmap's worked examples
become the test corpus. Without this, observations
cannot attach, lineage is fiction, contradiction detection is fiction —
which is why it lands first. Implement the design's tagged
`ResolverAttempt`: ineligible rows use exactly `subject_none |
malformed_subject | non_assertion_observation | missing_assertion_event |
already_attached`; eligible rows carry non-empty mention hashes, `target_count`,
candidate count, chosen entity, `attached | parked`, and outcome `exact_id |
known_alias | explicit_relation | normalized_match | unresolved |
claim_granularity_blocked | conflicting_attachment`. Use the exact tagged
attached/unresolved/granularity/conflict variants so chosen entity, prior
resolution, and reason-code nullability cannot disagree. Mint `attempt_id`
with the design's domain-separated store/run/item/candidate hash and enforce
unique `(store_uuid, attempt_id)`. Persist the canonical unique candidate-ID
set and require `candidate_count` to equal its length: attached/conflict rows
have one target and exactly one candidate, which is the chosen entity; conflict
chooses a different entity from the prior attachment; ambiguous/no-candidate
unresolved rows have respectively at least two/zero candidates and the one
matching reason; only granularity-blocked may have multiple targets.
Eligibility means a valid non-empty subject and at
least one typed target, not already attached. Only a granularity-blocked row
may omit `assertion_event_id`; it requires `target_count >= 2`, reason
`compound_assertion_targets`, and `parked`. Resolved outcomes attach;
unresolved parks. Same prior attachment is ineligible; a different prior
attachment parks and prepares HIGH non-reversible
`correct_observation_subject` with prior event/from/to/tier and non-empty
basis/reason, never auto-replaces. Persist the IDs/timestamp needed for M28's exact distinct
attempt/item/artifact queries, exclude the ineligible tag from denominators,
and store no raw source text.
For a successful tier, emit M22's
`observation.subject_resolved { observation_event_id, change: { action:
"attach", entity_id, resolver_tier, basis_event_ids } }`; never rewrite the
Observation. Re-prove M22's `subject:none`, tagged HIGH correction, and
unresolved refusal vectors.

### M26.2 — Basic semantic retrieval (app-data)
Query expansion over aliases/relations plus, if needed to satisfy the
assembly contract, local embeddings in app-data (never in the vault; index
remains disposable — rebuild test extends to it). BM25 (search.rs) alone
cannot find aliases, paraphrases, or contradiction candidates, and adequacy
must not assess an intentionally crippled retriever (§93). Scope: enough to
serve M26.5's retrieval intents; anything fancier waits for a consumer. This
corpus must recall known aliases, paraphrases, and seeded accessible
counterevidence that lexical-only retrieval misses, including after a full
disposable-index rebuild.

Upgrade M24's server-minted candidate receipt to v2: retain all deterministic
legs and require `semantic { status: completed, retriever_version, index_head,
query_fingerprint, candidate_ids }`. The reducer head/fingerprint are server-
derived and every result must appear in `considered`. Failure mints no receipt
and returns `semantic_search_unavailable`; missing/stale/caller-authored legs
are refusal goldens.

### M26.3 — Register the live proposal surface + preventive ancestry gate
M24's proposal tools are still absent from the live loopback MCP server.
Generate the live allowlist from the M24 policy inventory, register the
proposal-op tools plus terminal `commit_proposals`, and add a tripwire that
requires live inventory = policy inventory **and** the semantic-receipt-v2
validator/goldens to be active. The live vocabulary includes
`add_entity_alias`, `split_belief`, `merge_beliefs_exact`, and HIGH
`correct_observation_subject`; entity identity merge is the distinct CRITICAL
`merge_entities` op. No synonym or constructible unmapped op is allowed.

In the same phase, wire the design's dependency walk into M24 apply. Starting
at every candidate support Observation, traverse Observation `lineage`,
`derived_content.source_belief_revision_event_ids`, and reached revisions'
linked basis Observations, reading explicit hops from M22's
`derived_belief_sources` reducer index; reaching any revision of the target Belief refuses
`self_ancestry`, regardless of risk. Direct, transitive, old-revision, cycle,
and unrelated-control vectors must be green before any non-kill-switch
registration, not merely before default-on: registering the tools outside the
kill switch requires the preventive-ancestry reachability vectors green in
addition to the semantic-receipt goldens.
This phase publishes `shared/policy/policy.v2.json` (`format: 2`) before live
registration, adding predicate `no_self_ancestry` to the global closed
registries and to every belief-basis-changing op and binding it to the
ledger-destined rejection `self_ancestry`, registered (reserved) in the global
closed registry since policy.v1 (M24). Its rejection uses `rule:
no_self_ancestry`, expected typed boolean `true`, and actual typed object
exactly `{ target_belief_id, reached_revision_event_id,
support_observation_event_id }`; unknown v1/v2 codes refuse table load, and
enabling live tools against v1 fails on the absent `no_self_ancestry`
predicate binding, not on an unknown code.

### M26.4 — The batched ingest pass
Replaces per-note distill jobs. Consume both M25 verdict branches:
`material_candidate(dimensions)` and `needs_semantic_judgment`. A structured
material candidate whose typed diff/lineage completely determines an M24
proposal may bypass the LLM and submit deterministically. Every other material
candidate and semantic-judgment item in the settled window joins ONE combined
CLI run; an all-deterministic window uses zero runs and neither branch loses
work:
context = the changed artifacts + resolver output + candidate beliefs
(support AND disconfirming — §22's context-integrity line applies to
reconciliation); output = M24 proposals via MCP tools, terminal commit,
bounded in-session retry on typed rejection. Semantic materiality residual
(D6/amendment 5): the pass may conclude "not material" — recorded as an
exact `ingest.semantic_assessed` event from the design, charged, and the window closes; the verdict states which of
§17's four dimensions it evaluated (world-state, belief-state,
evidence-state, attention), and a corroboration-only window (zero field
changes, a new independent source) is MATERIAL on the evidence-state
dimension — "no field changed → discard" is forbidden. Prompt discipline per the
§92 taint rule; `suspected_instructional_content` heuristic telemetry wired.
For every disposition, batch the semantic outcome, any M24 proposal lifecycle/
mutation events, and all successor `ingest.assessed` terminal receipts under
one M22 marker. A blocked outcome is visible and typed; a crash leaves either
the prior queued receipts or the complete terminal association.
Implement the closed event constraints literally: material/proposals,
non-material/closed, or undetermined/blocked with one enumerated reason;
blocked has no material dimensions/proposals, and material dimensions are
always a subset of evaluated dimensions.
Declare its M22 registered-target version effect as none: the assessment ID is
idempotent history, and referenced receipts/proposals do not advance merely by
reference. Add same-batch/rebuild/no-effect vectors.
Operation closure is literal: aliases use `add_entity_alias`, decomposition
uses `split_belief`, exact-equivalence belief coalescing uses
`merge_beliefs_exact`, conflicting prior attachment prepares HIGH
`correct_observation_subject`, and entity identity uses CRITICAL `merge_entities`.
Old distill
lanes are deleted in the same commit their replacement proves itself
(byte-level: the learn queue UI keeps working off the new pass's outputs).

### M26.5 — Query-time assembly (attended-only, pay-per-use)
The Context Assembler as a deterministic Rust service + one synthesis run:

- Retrieval intents, all mandatory for belief-affecting questions:
  positive, contradiction, historical, authority, scope-neighbor.
- Implement the closed `WorkingMemoryManifest` type from the design:
  assembly/question and one shared `QueryIntendedUse` matching M24's closed
  kind/stakes/predicate-class contract (+ description); source/item/byte limits and actuals; all five named
  `IntentRecord`s with `satisfied | exhausted | blocked` (no `attempted`
  terminal state); query hashes/alias expansions/source and candidate sets;
  selected typed event/revision refs, lineage, scope/stage/time; and
  `counterevidence: included | exhausted | blocked`. Accessible relevant
  counterevidence must be selected. If caps prevent it, return
  `blocked(cap_conflict)` and do not synthesize; exhaustion/blockage must name
  attempts and sources. Manifest items are the exclusive `assertion |
  belief_revision` tags: an assertion has singular `source_id` and `belief_context:
  none | supported_at{belief_id,revision}`; linked belief revisions require
  basis-Observation and source arrays; unsupported beliefs require both empty.
  Never fabricate one source for a multi-source or unsupported belief.
- Attended is bounded by `max_sources_per_run`, `max_context_bytes`, and
  `max_evidence_items`, and metered, but it is **never** gated by ambient daily
  run/token ceilings or prior token spend. Do not put `max_daily_runs` in the
  attended contract. Ingest, maintenance, Source Monitor-triggered ingest, and
  scheduled convergence use M25's daily-run, daily/output-token, quota,
  consecutive-failure, and elapsed-time ambient gates.
- Implement exact serde types `DimensionAssessment`, `RetrievalAdequacy`,
  `EvidenceSufficiency`, and `SynthesisAnswer` from the design. Adequacy has
  ten required named fields — source availability, source health, scope
  coverage, temporal suitability, authority coverage, firsthandness,
  retrieval breadth, contradiction search, lineage independence, stakes —
  each with state/basis/gaps and its own RFC3339 `as_of`, never a score.
  Basis refs include exact M25 `coverage_dimension{assessment_id,dimension}`
  tags over the closed seven keys; validate current store/subject/scope and set
  assessment `as_of` to the minimum referenced per-dimension time (or assembly
  as-of when none), never synthesis time.
  Sufficiency separately records intended use, stakes, `insufficient | partial
  | adequate | strong`, typed basis refs, typed limitations, and the
  human-verification requirement. Its intended use must byte-equal the
  manifest's; synthesis cannot weaken the M24 kind/stakes/predicate class.
- `SynthesisAnswer` has exactly the nine numbered parts from the design:
  observations; current answer; basis; scope/time; uncertainties and
  counterevidence; retrieval adequacy; evidence sufficiency; next evidence;
  invalidation conditions. Implement every nested design type too:
  `StatementLabel`, `EvidenceRef`, `LabeledStatement`, `CitedStatement`,
  `ScopeAndTime`, `NextSource`, `DiscoveryStep`, and `DiscoveryPlan`; no opaque
  arrays/maps remain. The answer also carries typed provisional reason codes,
  manifest ID, and the `agent_supplied` label. `basis`, `missing_expected_evidence`,
  `authoritative_next_sources`, and `invalidation_conditions` are non-empty
  for HIGH/CRITICAL uses. Citation refs must equal statement basis refs;
  current-answer basis must equal the union of the basis citations and every
  evidence ref resolves to the current manifest; high-stakes current-answer basis is non-empty; provisional reasons/codes are
  both non-empty iff provisional is true.
- Discovery plans use the design's content ID:
  `sha256("cerebro-discovery-plan-v1\0" + store_uuid + "\0" +
  canonical_json({goal,step_drafts:[{action,source}],stop_when,stakes}))`.
  Exclude caller IDs; server-derive `step_id = plan_id + ":" + ordinal` after
  hashing. Persist the checked
  `pending | started | terminal(completed | dismissed | failed)` lifecycle;
  dismissal may skip start, while completed/failed require it. Transitions are
  monotonic/idempotent. This is not a Discovery object. Shared root causes stay
  labeled hypothesis unless directly supported (§76).
- The M24 stopping rule binds: HIGH/CRITICAL use + coverage/authority gap →
  the answer says "provisional" and says why. "All known sources
  considered" ≠ "all sources known" (§90) is the required wording shape.

### M26.6 — Maintenance pass
ONE scheduled run extending the jobs.ts lane scheduler onto durable state
(M25's runtime DB): recheck stale items (extends M8's stale→recheck), flag
items for attention, surface merge and compress candidates — per §16, the
twelve conceptual GC verbs are pass behaviors and risk-classed proposal
ops, never twelve ledger opcodes. **Conservative by table (§78)**: only
`merge_beliefs_exact` takes the LOW exact-equivalence path; semantic
coalescing is proposal/risk-gated and cannot masquerade as exact;
`merge_entities` is CRITICAL → human card; `split_belief` is the only
decomposition op. Silence-never-
resolves is already schema-enforced (M24) — the maintenance pass is the
thing that rule exists to constrain; a regression test tries to sneak a
time-based resolution through the pass's proposal stream. Role
composition: this pass is the Reconciler+Temporal slice of D6's maintenance
construct (D6 names Reconciler+Temporal+Curiosity+risk-gated Skeptic);
Curiosity and the Skeptic join at M28+ per the trigger registry.

### M26.7 — Source Monitor + attention primitives + governance metrics (Rust)
Source Monitor: refetch stale cached sources on launch/timer, hash-compare,
only changed hashes create ingest work — deliberately NOT named Scout.
Attention primitives: the deterministic signal computations M27's lanes will
rank (staleness clocks, coverage states, unresolved-contradiction counts —
the latter over migrated `contradicts` belief-relations only, until M27's
contradiction edges exist) — computed and stored, no UI, no lane ranking
yet. Emit the exact deterministic `conflict.candidate_detected` body from the
design with pinned assertion/belief-revision endpoints and ordered
`comparison_id` computed from the domain prefix plus the canonically sorted
endpoint tuples, and the design's non-empty closed candidate-reason enum,
including `declared_contradicts_relation`; the first event creates comparison
CAS state at v1. Exact retry returns the existing comparison without append;
a duplicate event or ID/endpoint mismatch refuses. It asserts no contradiction.
M27 consumes it, and rebuild-from-ledger restores the handoff after runtime DB
loss. Add runtime tables/rows from the design, each carrying `vault_id` and
`store_uuid` (in addition to linked run IDs):
`resolver_outcomes`; `discovery_plan_runs`; `run_cost_components` separating
the design's ten closed components/units — uncached input, cache read/write,
output, retrieval/tool calls, selected context bytes/tokens, and prompt
bytes/tokens — with unique `(run_id, component)`; `assembly_metrics`; and
`source_taint_assessments` keyed to Observation event ID with closed heuristic
verdict/classifier/reason enum and empty-vs-nonempty verdict constraint. Every successful belief-affecting synthesis
writes all ten cost rows exactly once, using zero rather than absence. Ship
`shared/policy/cost-projection.v1.json` with integer per-component
`multiplier_ppm`/`fixed_quantity`; enforce
`ceil(q * multiplier_ppm / 1_000_000) + fixed_quantity`, the fixed unit map,
and immutable optional micro-price snapshot. Record attended and ambient
quantities, but feed only ambient records to gates. Vendor price may be null;
quantities may not. Store no raw source text. Restart, cross-vault, complete-
row, unit-refusal, and projection goldens must make M28's windows reproducible
from persisted rows alone.

### M26.8 — Convergence synthesis (§30, pulled forward)
On-demand and scheduled "how did our model change?" over ledger diffs:
believed-then vs believed-now between two seq points. Day-one sections —
all M26-computable: material changes, new/resolved blindness, staleness
transitions. The certainty-shift section (support/validity deltas) and new
contestation are M27-gated: they activate when D9's Support/Validity chips
exist (M27.5 owns the activation and its acceptance test). A cheap consumer of
ledger + revision chains + materiality; its what-changed output is M26's slice
of the §35 Epistemic Status surface that lands across M25–M27. On-demand
returns an attended answer. Scheduled convergence is ambient and stores the
typed disposable result in app-data `convergence_runs(vault_id, store_uuid,
run_id, from_seq, to_seq, trigger, schema_version, output_content_hash,
output_json, generated_at, superseded_by_run_id?)`. It emits no epistemic
event and has no narrative identity/projection; deletion causes recomputation. UI copy says
“convergence run/output,” never Narrative. This is the first genuinely
magical user surface of the overhaul; it is also the milestone's demo.

### M26.9 — The flip + eval fixtures
On-by-default only after M26.3's live-inventory and ancestry suites:
deterministic phases always on; ambient LLM phases on within budget;
M25's pause/lane controls govern everything. Eval fixtures (the M26 slice,
synthetic): resolver false-attach (must end unresolved); alias/paraphrase/
known-counterevidence semantic recall; manifest included/exhausted/blocked
states; omitted accessible counterevidence (contract violation → refusal);
injection-shaped source content (heuristic telemetry + structural boundary),
including a valid LOW-risk proposal induced by adversarial text that still
passes ordinary policy/journaling;
sufficiency/adequacy divergence cases (excellent retrieval + weak evidence,
and the reverse), corroboration-only window (zero field changes, one new
independent source whose independence is a committed positive M22
`observation.independence_recorded` record → an evidence-state proposal, never
a discard; the golden must fail an implementation that treats any second
source as corroboration — §17: independence_unknown never strengthens), merge
conservatism and operation inventory, direct/transitive/explicit-source
anti-self-ancestry, exact ten-dimension/as-of/nine-part closed serde shapes,
resolver eligibility/rate queries, cost completeness/projection, monotonic
discovery lifecycle, deterministic-zero-vs-combined-one-run routing,
attended cap-but-never-daily-budget behavior, and ambient output/failure gates.

## Acceptance matrix

| Scenario | Must hold |
| --- | --- |
| ambiguous entity mention | resolver returns unresolved; nothing attaches |
| resolver finds a different entity after prior attachment | parks; prepares HIGH `correct_observation_subject`; no automatic replacement |
| all-structured settled window | both verdict branches consumed; complete candidates submit deterministically; zero CLI runs |
| mixed material + semantic settled window | every residual item joins exactly one CLI run |
| ingest run dies mid-stream | zero proposals applied (M24 transactionality, re-proven here) |
| create proposal lacks semantic receipt v2 | refused before registration/application; caller cannot claim an attempt |
| semantic disposition completes | typed outcome + proposal lifecycle/mutations + terminal receipts are one reducer-visible batch |
| source text addressed to "the AI" | operational heuristic assessment when detected, without Observation mutation; any induced proposal still uses ordinary serde/policy/CAS/journal/lineage; no perfect-immunity claim |
| belief-affecting question with known counterevidence | all five intents have terminal records and accessible counterevidence is included; omission refuses synthesis |
| inaccessible counterevidence source | manifest is `blocked` with attempts/reason; any allowed answer stays provisional |
| high-stakes question, partial coverage | answer marked provisional, reasons named |
| attended request after ambient ceiling | source/item/byte caps apply; daily run/token spend does not block it |
| simulated week of ambient churn | ≤ 10–20 runs/day and within output/failure gates |
| quota death mid-flip week | M25 behavior holds; nothing silent |
| support whose lineage or explicit source revision reaches the target | cycle-safe traversal reaches any target revision and refuses before default-on |
| potential conflict detected | pinned `comparison_id` signal persists; no contradiction edge before M27 classification |
| semantic goldens | alias, paraphrase, and seeded counterevidence all recalled after index rebuild |
| synthesis serde vectors | every adequacy dimension has state/basis/gaps/as-of; all nested answer types and nine parts are required; sufficiency remains separate |
| M28 R1/R13 handoff | ten cost rows and integer projection reproduce exactly; plan IDs dedupe and pending/started/terminal lifecycle queries are deterministic |
| convergence query/schedule over seeded diff | then/now/changed/blind correct; scheduled row is disposable and creates no Narrative/event |
| old distill path | deleted; learn-queue UI works from the new pass |

## Traps

- **This milestone touches the owner's real quota.** Every soak/e2e-adjacent
  test runs against copied vaults with the CLI mocked or budget-zeroed;
  nothing in CI may spawn a real CLI run. The mock CLI stream fixtures from
  M25 are the substitute.
- **Prompt surface is product surface**: ingest/assembly prompt templates
  live in-repo, reviewed like code; "labeled agent-supplied" applies to
  every epistemic field they can populate. “Source is data” is containment
  discipline, not a promise that a model cannot be influenced.
- **Name discipline**: Source Monitor ≠ Scout; assembler ≠ Skeptic;
  resolver ≠ claim-granularity Resolver. Misnaming is a real defect here —
  it silently satisfies M28+ triggers that have not been met.
- **Parity**: new IPC/MCP commands need mock stubs + parity assertions;
  verdict logic stays table/vector-driven. Live MCP ops are generated from
  the M24 table; a hand-maintained second inventory is forbidden.
- e2e boot disables the background distiller via localStorage — the flip
  must respect the same switch through the M25.1 runtime DB migration, or
  every Playwright spec starts burning fake runs.
- Gates: `pnpm test:run`, full Rust gate, `PORT=5273 pnpm e2e`, never
  `--no-verify`.

## Exit criteria

On-by-default live only after live-tool inventory, atomicity, and preventive
anti-self-ancestry checks pass · both M25 verdict branches consumed with zero
or one semantic run per window · basic semantic retrieval goldens green ·
attended source/item/byte caps enforced without daily-budget refusal · ambient
work bounded at ~10–20 runs/day plus output/failure gates · ten adequacy
dimensions, separate sufficiency, and nine answer parts serde-validated ·
governance metrics persisted · convergence demo works and scheduled output
stays a non-Narrative cache · old distill path deleted · full gates green.
