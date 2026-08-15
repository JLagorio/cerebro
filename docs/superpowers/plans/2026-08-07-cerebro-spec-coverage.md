# Convergent Intelligence Spec — full coverage matrix (§1–§98)

Companion to `convergent-intelligence-overhaul.md` (Rev 3). That doc holds the
architecture decisions (D1–D12) and milestones (M21–M28+); this one traces
**every numbered section of the source spec** to its disposition, so nothing is
silently dropped. Dispositions:

- **M21–M27** — scheduled, with where.
- **M28+ (trigger)** — deferred behind a named trigger, per D7's rule that every
  object/behavior waits for its consumer.
- **Partial** — split across dispositions; the split is stated.
- **Principle** — shapes design and prompts; no standalone build artifact. Where
  a principle has an enforcement point, it is named.
- **Cut** — explicitly not built, with rationale. Cut ≠ forgotten: this row is
  the record.

**Matrix Rev 2 (2026-08-07)** — tightened per owner review before freeze. The
review's standard, now this matrix's standard: *nothing is unaccounted for, AND
no foundational capability is deferred past the point at which an earlier
milestone implicitly depends on it.* The operating pattern throughout: **persist
the primitive early when retrofitting would be painful; defer the rich consumer
until it earns itself** (the observation_kind pattern, generalized). Ten
foundational primitives were pulled forward from M28+ into M22–M27 (see "Pulled
forward" below); the biggest single catch was §84 — M26 named a Resolver while
this matrix had entity resolution at M28+, exactly the class of quiet
contradiction a coverage matrix exists to expose.

**Matrix Rev 3 (2026-08-08)** — executable-traceability correction. Rev 2
correctly named the required capabilities, but the M22–M28 review found several
places where no durable primitive or complete handoff existed. Rows below now
require: tagged Observation variants, stable source identity, unresolved
subjects, explicit belief-support and positive-independence records, logical
batch commit, restart-idempotent migration, a complete Proposal basis, total
materiality routing, uncollapsed vault-scoped coverage, preventive
self-ancestry before default-on, orthogonal/replay-stable validity, and
measurable or explicitly discretionary deferred triggers. A row is covered only
when it points to representable state, an implementation task, and an acceptance
test — milestone prose alone is not coverage.

| § | Spec item | Disposition |
|---|---|---|
| 1 | Executive summary (optimize for understanding/convergence/…/correction) | Principle — the roadmap Verdict adopts it; enforced piecewise below |
| 2 | Problem (extraction explosion; coherent-but-wrong) | Principle — D7 restraint answers the first failure; coverage/adequacy (M25/M26) the second |
| 3 | Product vision ("technical Chief of Staff", epistemic humility) | Principle — shapes the M26 synthesis contract |
| 4 | North star: system gets smaller as understanding increases; minimum sufficient understanding, no material loss | Principle — enforced by D7 (4-object ontology) + M27 convergence dynamics; compression *metric* cut with §37 |
| 5 | Core model: Source→Observability→Evidence→Claims→Beliefs→Attention as distinct layers | Partial — **semantic separation preserved; physical persistence collapsed.** M22 uses discriminated Observation bodies: snapshots/system events do not fabricate assertions, while extracted/human assertions carry typed predicate/value/scope. `source.registered` is an Event identity/capability primitive, not a fifth product object. Explicit Observation→Belief basis/support edges preserve the Evidence→Belief boundary; Claims remain unmaterialized until their consumer trigger. Attention stays schema-disjoint (M27, invariant b). Do NOT read this row as "the Source/Evidence/Claim distinction is implemented" |
| 6 | Evidence records (17 fields; immutable revisions; tombstones; minimal interpretation) | M21 (immutability substrate) + M22 Observation. Day-one fields: id/kind/hashes/timestamps/actor/**stable source_id**/lineage plus a `resolved | unresolved | none` subject reference, and **reserved nullable provenance fields** (source_system, source_location, source_record_id, source_revision, source_author, source_workflow_state — §61) so connectors are data, not schema surgery. ACL metadata cut (D10). Richer participants/workstream metadata waits for a **consuming retrieval or project-model capability** — deferral is consumer-driven, never connector-driven (a human can create Xavier/Rev-C-scoped firsthand evidence before any connector exists) |
| 7 | Belief (mutable; strengthen/weaken/merge/split/contest/stale/supersede) | M22 object + revision chain **with per-revision basis/support Observation IDs and an explicit unsupported state**. A changed basis with an empty content patch is the canonical support-only revision, so zero-field corroboration is representable. Dynamics M27; `split_belief`, `merge_beliefs_exact`, contest/lifecycle ops map to exact M24 events and are consumed M26/M27 |
| 8 | Attention ≠ knowledge; no hard cap; bypass classes for catastrophic/critical items | M27 lanes **including a generic `critical_attention` bypass from day one**: extremely conservative deterministic signals, human-confirmable, no scalar score, no Risk model — "production signing certificate expires tomorrow" must never wait for M28+ Risk objects. Specialized Risk/Decision lanes later refine and replace it |
| 9 | Salience factors; NOT a naive multiplication; 8 attention lanes | Partial: deterministic rule-based lanes M27 (contradiction, blindness, staleness, epistemic debt, critical_attention); scalar salience deliberately not built (the spec's own warning); decision-urgency/blocker lanes M28+ refine the generic bypass when their objects exist |
| 10 | Temporal semantics: 4 times; silence ≠ resolution; per-type evolution (Risk/Assumption/Decision/Action/Issue) | 4 times M22 (D3). **Silence-never-resolves is a formal class (a) invariant**: M24 checks a structured transition cause, never prose. Elapsed time may alter freshness/coverage/attention but never resolve/false/supersede. M27 freshness is replay-stable: Rust emits transition events carrying `effective_at` + `rule_version` on timer/launch catch-up; the reducer never consults wall-clock `now`. Per-type decay waits for its objects (M28+); stale→recheck extends through M26 maintenance and M27's lane |
| 11 | Hierarchy is a UX projection; ontology is a graph (depends_on, threatens, resolves…) | Vault hierarchy exists; lineage + belief relations M22; full relation vocabulary M28+ with Issues/Decisions |
| 12 | Issue model (container for claims/beliefs/deps; evolves, doesn't spawn) | M28+ (D7: Issues stay vault records until an epistemic consumer exists) |
| 13 | Issue lifecycle: multidimensional state (lifecycle/resolution/execution/decision/risk) | M28+; mechanism reserved now — M24 capability profiles keep it type-name-blind when it lands |
| 14 | State over history; reality-change vs understanding-change | M22 revision chains + explicit support revisions + D3 bitemporal split + D12 stage; current-state projections M23. M22 logical batches make assertion+revision capture reducer-atomic |
| 15 | Object creation must be expensive; measure false-merge/contamination/overload | **Joint M24/M26 enforceable behavior, not principle-only**: M24 requires a structured candidate-search receipt + distinctness reason and executes deterministic exact/alias/scoped checks while server-enriching the unchanged draft-only `write_concept` bridge. M26 upgrades it to server-minted semantic receipt v2 (retriever/index/query/result disposition) before registering agent proposal tools/default-on. The full path is exact identity → alias → semantic candidate → scoped/temporal candidate → update/qualify existing if defensible → create only if meaningfully distinct. Similarity alone never forces merge; near_duplicates is a backstop. Rates → §37 evals |
| 16 | Knowledge GC: 12 verbs, provenance-preserving | Split by nature: **epistemic transitions** (supersede/contest/merge/split/tombstone/archive) are risk-classed proposal ops M24; **maintenance/query actions** (recheck/compress-candidates/flag/surface) are M26 pass behaviors, not ledger opcodes. The 12 conceptual verbs do NOT imply 12 durable mutation opcodes. Provenance preserved by construction (append-only, M21) |
| 17 | Material change vs activity; outcome taxonomy; no-change → no rewrite, no interruption | M25 prefilter + M26 semantic materiality across **four dimensions: world-state, belief-state, evidence-state, attention**. Routing is total: no/non-material closes deterministically; fully structured `material_candidate` becomes a deterministic proposal or joins the next M26 batch; `needs_semantic_judgment` always joins it. Independent corroboration is material only with a positive M22 independence record; `independence_unknown` never strengthens. M26 emits typed `ingest.semantic_assessed`; outcome, proposal events, and terminal source-item receipts are reducer-atomic. Non-interruption = M27 default silence |
| 18 | Risk qualification gate (failure condition+impact+evidence+trigger) | M24 qualification gates as Type-doc capability profiles (presence checks at promotion); Risk-as-epistemic-object M28+ |
| 19 | Action qualification gate (owner+verb+completion condition) | Same as §18 — M24 profile, object M28+ |
| 20 | Decisions: action plane, not epistemic ladder; persist until superseded | Action-plane separation honored now (decisions stay vault records, D7); Decision objects + revisit conditions M28+ |
| 21 | Assumptions tracked toward validated/invalidated/accepted; debt accumulates | M28+ (behind consumer agent); generic epistemic-debt lane M27; assumption-specific debt with the object |
| 22 | Ingestion pipeline phases 0–9 | Mapped by determinism: 0 integrity, 4 materiality, 6 reconcile/policy, 7 state update = Rust (M24/M25); 1 observation, 2 extraction, 3 resolution, 5 proposal = M26 ingest; 8 synthesis = M23 projections + M26; 9 attention = M27. M22 `batch_id` + `batch.committed` makes multi-event state updates reducer-atomic. Context integrity requires supporting AND accessible disconfirming context; a known counterexample must be included or recorded blocked/exhausted — "intent attempted" and "resolve nearest belief" are not compliance |
| 23 | Agents in isolated sessions; task-specific working memory; no persuasion bypass | Isolated CLI sessions exist (agent.rs); working-memory assembler M26; no-bypass = M24 policy by construction |
| 24 | Human cognitive analogy (LTM→recall→WM→reasoning→update) | Principle — plus its caveat (provenance of what entered WM) = M26 context manifest |
| 25 | Task-specific working memory: 12-item context contract; assembly exposed | M26 (assembler + manifest). **Context assembly is contradiction-aware from M26**: positive, contradiction, historical, authority, and scope-neighbor retrieval intents are the M26 contract — the Skeptic can wait; counterevidence retrieval cannot. M28+ Skeptic adds *independently initiated* adversarial retrieval on top of, never instead of, contradiction-aware assembly |
| 26 | No free-form agent chains; shared state + structured proposals; agent artifacts ≠ evidence | By construction D5/D6 (M24/M26); source content has no instructional or direct mutation authority and remains evidence-linked. Predicate/stage-specific epistemic authority comes only from D11/M27 policy-qualified routes. Heuristic taint assessments are operational rows keyed to immutable Observations, not schema mutations. M22 derived content explicitly pins its source Belief revisions; M26 traverses those refs plus Observation lineage/support to refuse derived self-ancestry **before default-on**, with full independence weighting and retrospective hygiene M27 |
| 27 | 11 agent responsibilities | D6: Observer/Resolver/Context-Assembler/Reconciler/Temporal/Synthesizer → 3 runtime constructs M26; M26 maintenance is Reconciler+Temporal only. Attention → Rust M26/M27; Policy/Integrity → M24; Skeptic and Curiosity are explicit M28 additions, not hidden M26 roles; Scout → **Pattern Scout M28+** (Source Monitor is not it) |
| 28 | Structured agent outputs (op/target/expected_version/risk/reason) | M24 — serde-validated Proposal with proposal/run IDs, closed target classes + reducer-owned per-target versions, fully closed discriminated/nested payloads, intended use, structured transition/evidence/coverage basis, full BeliefBasis on create/update, risk, and reason. Every op maps to exact mutation events and legal transitions/rejections; every commit-set state change uses an M22 logical-batch marker; mixed-risk sets, decisions, and forward reverts are durable. Final application rechecks CAS plus mutable candidate-search/coverage preconditions |
| 29 | Proactive intelligence (stale risks, zombie threads, ingestion failures); default silence | Partial: blindness/staleness/contradiction/critical_attention lanes M27; ingestion-failure surfacing M25; pattern-level detection M28+ (Pattern Scout, Curiosity) |
| 30 | Weekly/periodic convergence ("how has our model of reality changed?") | **Split — pulled forward.** M26: on-demand and scheduled synthesis over ledger diffs. Scheduled results persist as bounded runtime run artifacts keyed by seq endpoints so they have a consumer, but are explicitly not Narrative objects. Structured discovery plans use deterministic versioned IDs and a closed operational lifecycle without becoming Discovery objects. Support/Validity sections activate with M27. M28+: stable narrative identity/history + executive storytelling |
| 31 | Project narrative (compact, evolving, confidence-and-coverage-aware) | M28+ with an **evidence-based discretionary earned-persistence gate**: the owner accepts a pack from ≥2 independently shipped surfaces whose current workflows both fail without shared cross-run identity/history. It never requires a Narrative ID before Narrative exists |
| 32 | Progressive compression ladder (raw→…→executive narrative) | Partial: lower rungs M22/M23; Issues/Themes/Workstream/Executive rungs M28+ with their objects; unsafe-compression rules → §77 row |
| 33 | User working model: preference signals; hard epistemic/preference firewall; visible+editable | Firewall by construction (schema-disjoint, invariant b, M27) **plus a protected-lanes rule: preference may never suppress blindness, material contradiction, critical_attention, or high-impact human-review requirements** — preferences tune verbosity, ordering within normal lanes, phrasing, grouping, cadence; "user dismisses manufacturing warnings → hide manufacturing warnings" is the failure this rule forbids. Dismissals exist (M8); *learned* preference model M28+ |
| 34 | YAML-native knowledge; YAML as projection, not canonical storage | D1 + M23. Manifest entries carry reducer-current revision; reconciliation compares file + manifest + reducer. Accept-current-files records assertion/revision or override batches before re-baselining, so every accepted byte remains reproducible from canonical state |
| 35 | UX: primary project view (Current Story / What Changed / Needs Attention / …) | Full view M28+ (substrate first) — but an **Epistemic Status surface lands across M25–M27** (what changed, coverage gaps, contradictions, stale understanding, needs review, system/budget health) so blindness banners, proposal rejections, and coverage states have one coherent home instead of scattered cards; it later grows into §35's richer view |
| 36 | Explainability: 12 questions every conclusion must answer | Partial: provenance M22; chips M27; adequacy statement M26; **provisional "what would change my mind" in M26** — agent-generated invalidation conditions labeled as such, derived from current support/coverage ("would change if a newer production manifest contradicts the reviewed engineering evidence") — strengthened M28+ by Skeptic + verification policies |
| 37 | Success metrics (16: time-to-understanding … calibration) | **Product dashboards cut; engineering epistemic eval suite NOT cut.** Single-user data cannot calibrate, but golden/synthetic epistemic scenarios are ideal regression fixtures: false creation, false merge, missed contradiction, stale truth, ancestry reinforcement, critical-attention misses each get benchmark tests as their mechanisms land (M24–M27). The raw events (corrections, merges, surfacing, dismissals, rejections) are ledgered from M22 |
| 38 | Anti-goals (12) | Principle — D7 and D10 enforce the load-bearing ones (no exhaustive ontology, no persistent object per mention, no availability-as-completeness) |
| 39 | Product philosophy: system handles memory/compression/…; human retains judgment | Principle — M24's human card + D11's ownership-≠-infallibility are the enforcement points |
| 40 | Desired end state | Principle |
| 41 | Epistemic model: knowledge plane (artifact→observation→assertion→claim→belief) vs action plane | M22 (knowledge plane, D7 collapse with subtypes); action plane = vault records, unchanged |
| 42 | Observed fact vs reported claim vs inferred claim vs belief | M22 — observation_kind (amendment 2) + assertion_basis (D11) |
| 43 | Source provenance: full transformation lineage; derived summary never independent evidence | M22 lineage edges + per-belief-revision basis/support edges; preventive self-reinforcement ban at M26 proposal apply before default-on; M27 independence weighting and retrospective graph hygiene |
| 44 | Source authority: query-specific, ownership-aware, firsthandness-aware | D11 (amendment 4): metadata M22; M27 derives predicate/stage-specific authority through closed policy-qualified routes for both firsthand humans and direct machine artifacts, with conservative mixed/unknown handling. Full learned per-predicate authority *policies* remain M28+ (simple high-stakes requirements arrive earlier — §52) |
| 45 | Evidence freshness per predicate/knowledge type | Partial — default predicate-class rules land M27, but freshness is not a clock read inside the reducer. Rust timer/launch catch-up emits transition events with effective time + rule version; replay is stable and convergence can observe the transition. Source-level stale_after (M8) remains distinct. Learned/custom per-predicate policies M28+ |
| 46 | Observability/coverage: per-source health, scope, retention, lag; availability ≠ completeness | Partial: stable `source_id` M22; vault-scoped uncollapsed record M25; Source Monitor M26. Separate fields: source_connected, source_healthy, scope_known, scope_accessible, retention_known, index_current, retrieval_attempted, each with its own basis/as-of. A versioned truth table alone derives observed/partial/blind. Runtime DB rows carry store UUID; source health and reasoning-runtime health remain distinct. Per-connector scope models M28+ |
| 47 | Retrieval sufficiency (policy + human judgment, not model self-certification) | The 10-dimension structured assessment (roadmap section); produced M26, adversarially exercised M28+ (Skeptic); never a score. Self-certification blocked earlier by §71's stopping rule |
| 48 | Confidence split: evidence / retrieval-coverage / world-state | D9 → M27 Support, Coverage, and a structured Validity bundle. Support includes unsupported and predicate/stage-specific authority; Validity contains orthogonal freshness, conflict, and lifecycle fields; human review derives a separate ReviewStatus |
| 49 | Claim status (8 states; "verified" used sparingly) | **Translated, not implemented**: no monolithic enum. Support = unsupported/single/corroborated/authoritative-for-predicate+stage; freshness = fresh/stale/unknown; conflict = clear/contested; lifecycle = active/superseded/archived/tombstoned; ReviewStatus = unreviewed/current/predates_current. Stale+contested is representable. D9 and all M27 docs use this tuple, resolving Rev 2's contradictory wording |
| 50 | Contradiction is not binary (7 kinds) | M26 persists deterministic candidate signals with pinned assertion + belief + belief-revision endpoints and stable `comparison_id`; they claim only “classify this pair.” M27's pipeline resolves scope/stage/time/granularity before semantic meaning; semantic outcomes are evidence-linked agent-supplied `classify_conflict` proposals targeting that ID. Outcome ∈ {resolved_temporally, resolved_by_scope, resolved_by_stage, resolved_by_granularity, same_meaning, genuine_direct, partial, conditional}; only unresolved classes edge, atomically with their classification. Migrated `contradicts` relations are reclassified before gates/lanes activate |
| 51 | Source conflict resolution: no auto-winner; preserve competing claims; human judgment when material | M27 contradiction preservation + M24 human card; authority via D11 |
| 52 | Verification policies (preferred routes per predicate; minimum for high stakes) | **Split — pulled forward.** M24 Proposal carries intended use plus structured evidence/coverage/authority basis; deterministic requirements never parse reason prose. M25 supplies coverage records; M26 binds answer schema; M27 conflict handling consumes predicate/stage-specific authority. M28+: learned/custom cross-source routes |
| 53 | Coverage gaps surfaced; negative evidence needs observation completeness | M22 assertion variant for absence carries searched_domain, search_scope, coverage_basis, observation_window, query_strategy, limitations; non-assertion variants have no assertion_kind. M24 requires a referenced complete coverage record. M25 defines coverage assessment/gap/restored event bodies + vectors over the uncollapsed dimensions; M27 surfaces them |
| 54 | Decision intelligence (prepare, never decide) | M28+ (with Decisions) |
| 55 | Decision frames (16 fields) | M28+ |
| 56 | Decision readiness relative to stakes | M28+ (§67's sufficiency-per-use and §71's stopping rule are its early ancestors) |
| 57 | Value of information (proportionate discovery) | M28+ |
| 58 | Forward intelligence (approaching decisions/dependencies; forecasts labeled as forecast) | M28+ (forecast objects); next_expected_event arrives with Issues |
| 59 | Meeting preparation surface | M28+ (product surface over M26 assembly) |
| 60 | Executive preparation surface | M28+ |
| 61 | Connected organizational intelligence (GitHub/Jira/Slack/…; source-type epistemics) | Partial: stable logical `source_id` + observation kind M22, plus reserved nullable provenance fields (source_system/location/record_id/revision/author/workflow_state). Migration uses an explicitly content-only `legacy_reference` registration keyed by canonical resource; it cannot imply health, authority, or independence, while the full legacy source object remains in Belief fields for byte-stable projection. M25 health/coverage keys use `(store_uuid, source_id)`. Future connectors are data, not schema surgery; live connectors are post-M27 milestones |
| 62 | Incremental intelligence: precomputed state, affected-only recompute, local vs always-on split | M25 hash-diff/cursors/batching with prior normalized snapshots and a closed pending/terminal/retry route matrix. Runtime DB is multi-vault and migrated transactionally. One claim transaction owns queue/concurrency leases, budget reservation, and run creation; crash recovery is explicit. Loss pauses ambient work, reconstructs portable receipts where possible, and holds ambiguity for owner choice—never automatic re-spend. Initial capture/receipt and terminal outcome/receipt transitions commit atomically. D10 while-app-open + versioned responsibility/catch-up records; service deferred behind R10 |
| 63 | Failure containment (10 principles) | Spread, each named: append-only M21 · revisable beliefs M22 · contradictions preserved M27 · high-impact-needs-evidence M24 · coverage→confidence M27 · unknowns explicit (language discipline) · stale sources ≠ silence M25 · derived-≠-ancestry M27 · versioned/reversible M21/M24 · fail-by-uncertainty (synthesis contract M26). **Plus two made explicit: model failure cannot corrupt canonical source evidence** (append-only Observations + proposal-only mutation, M21/M24) **and operational failure cannot masquerade as epistemic silence** (M25's runtime-health vs source-health split, §86) |
| 64 | Human judgment as first-class input; corrections preserved as distinct objects | D8 two channels M22/M23. Human assertions form a closed `field_change | relation_change | alias_add | standalone` union with typed values, authority basis, and optional correction pointer/reason; relation and alias forms pair one-to-one with their exact effect events, while unsupported alias removal is refused. M22 subject attachment correction separately pins the current resolution event, old/new Entity, proof, and reason without rewriting history. M23 commits assertions + the complete replacement Belief basis + exact effects in one logical batch; editorial overrides are canonical projection state but structurally excluded from evidence |
| 65 | Core philosophy: the 9-part answer shape ("here is what we observed…") | M26 closed synthesis output contract: every nested citation, labeled statement, uncertainty, alternative, next-evidence item, provisional reason, and manifest reference has a tagged/cardinality-checked type (structured per §98) |
| 66 | Discovery-first reasoning; stakes-proportional; provisional answers labeled | Partial: provisional labeling M26; §71's minimal stopping rule M24/M26; full stakes-proportional discovery loop M28+ (Curiosity/Skeptic) |
| 67 | Evidence sufficiency (insufficient/partial/adequate/strong, per intended use) | **NOT folded into retrieval adequacy — two distinct outputs.** Retrieval adequacy: "did we look sufficiently?" Evidence sufficiency: "given what we found, is it enough for THIS use?" Excellent retrieval + weak evidence and poor retrieval + one authoritative direct observation are both real states. The M26 answer contract reports both: "Retrieval: partial · Sufficiency: adequate for a reversible prototype decision; insufficient for production release." Per-use thresholds mature with §52 |
| 68 | Discovery plans instead of fabricated certainty | M26 emits structured ephemeral plans (goal/steps/stop_when/stakes), assigns versioned deterministic IDs, and persists a closed pending/started/completed/failed/dismissed operational lifecycle, not a Discovery object. That metadata makes the R13 trigger measurable; the schema remains the later promotion source |
| 69 | Discovery objects (first-class, with coverage + remaining steps) | M28+ (behind consumer; §68's structured output is the promotion source) |
| 70 | Curiosity agent (identify missing knowledge) | M28+ |
| 71 | Discovery stopping rules; model may not self-certify sufficiency on high-impact | **Minimal deterministic rule lands M24/M26**: intended use HIGH/CRITICAL AND (Coverage ≠ observed OR required authority class missing) → the answer remains provisional / requires human verification. No Curiosity machinery needed — "looks adequate to me" is structurally impossible for high-stakes answers from day one. Full stopping-rule system M28+ |
| 72 | Reinforcement only through genuinely additional evidence | M22 explicit support + positive-independence primitives; M26 preventive self-ancestry refusal before default-on; M27 tri-state independence counting and retrospective cycle/descendant checks |
| 73 | Correction over accumulation; beliefs never permanent by age | M22 revisions + M24 proposals; nothing in the schema confers age-based permanence |
| 74 | Belief revision history w/ valid-time + system-time; late learning about early change | M22 revision chain + D3 — the spec's AMD-effective-June-18-learned-Aug-7 case is representable by construction |
| 75 | Reinforcement vs repetition (lineage, not application count) | M22 records support and positive independence; M25 recognizes known-independent materiality only from that record; M27 collapses copies into ancestral families and counts corroboration as a reducer/graph property, never absence-of-edge or LLM judgment |
| 76 | Compound knowledge: convergence labeled as causal hypothesis until evidenced | **Guard M26, object M28+**: from the first synthesis, shared root causes may not be stated as settled unless directly supported — causal explanations are labeled hypothesis. The persistent causal-hypothesis object waits; the epistemic sin it prevents is blocked from day one |
| 77 | Compression unsafe if it removes disagreement / changes decisions / obscures scope / collapses causes / loses provenance | The five conditions map: disagreement M27 gate · decision implications M24 risk ladder · scope M22 qualifiers · causes §76 guard · provenance by construction M21 |
| 78 | Graph maintenance (12 ops) | M24 closes the op vocabulary (`merge_beliefs_exact` LOW, semantic/split ops gated, `merge_entities` CRITICAL, forward revert); M26 identifies candidates and may construct mapped ops; M27 circular/duplicate/descendant hygiene. "Maintenance merges duplicates" is never casual. Scope-collision waits for learned resolution |
| 79 | Knowledge entropy actively reduced | Principle → M26 maintenance pass |
| 80 | Knowledge fitness: periodic justify-existence review (incl. "reinforced only by own descendants") | Partial: stale→recheck exists (M8), extends M26; descendant-only-reinforcement is an M27 reachability query; full fitness review M28+ |
| 81 | Self-improvement via explicit artifacts (9 mechanisms, inspectable) | Mostly M28+, with a standing prohibition now: **no self-improvement mechanism may silently mutate agent prompts or policies from observed user behavior** — learned aliases, attention preferences, and verification routes are inspectable, editable records/settings; "Cerebro learned how the user thinks" as hidden adaptation would undermine the entire explainability model. Source-reliability calibration → §96 |
| 82 | Core learning principle (accuracy of model, not volume of knowledge) | Principle |
| 83 | Context integrity: multi-intent retrieval; Skeptic gets independent retrieval authority | Standing class-(a) invariant at M26. Every manifest item is a tagged assertion or unsupported-Belief-revision reference with complete source cardinality; every intent records selected evidence or blocked/exhausted attempts. Golden alias/paraphrase/counterevidence fixtures require known accessible counterevidence to be present, not merely an attempted intent. M28 Skeptic adds independently initiated retrieval on top |
| 84 | Entity resolution: canonical identity, aliases + validity periods, scope qualifiers | M22 subject reference is `resolved | unresolved | none`, with stable IDs and explicit aliases. Its append-only `attach | correct` event preserves every prior attachment and requires tier-specific proof; alias display spelling and a Unicode-version-pinned normalized key remain distinct. M26 deterministic tiers end unresolved, persist closed eligibility/outcome/reason telemetry with exact count-distinct queries, and propose mapped `add_entity_alias`/qualified create ops. M28 learned tier fires at a stated unresolved-rate/sample/window threshold. Claim-granularity Resolver + Claims share their own demand trigger; neither waits circularly for the other to "ship" |
| 85 | Evidence lineage edges + independence-weighted corroboration | M22 mandatory lineage + belief-support edges **and a positive independence record**. M25/M27 use the exact tri-state `known_same_lineage | known_independent | independence_unknown`; two apparent roots without positive basis remain unknown. Direct-artifact deterministic independence emits the same auditable record rather than becoming hidden reducer inference |
| 86 | Source health / ingestion integrity (lag, errors, partial indexing, stale credentials) | M22 stable source IDs + M25 vault-scoped source/coverage rows. Source health and reasoning-runtime health remain distinct; uncollapsed connection/scope/retention/index/retrieval dimensions explain blindness. Connector-specific details arrive with connectors |
| 87 | Negative evidence requires observation-completeness assessment | Invariants (b)/(c) + §53's structural absence schema (M22) + M24 refusal without a coverage record |
| 88 | Causal hypotheses distinct from descriptive patterns | M28+ (object); §76 guard from M26 |
| 89 | Epistemic debt visible alongside execution risk | M27 lane with an **operational definition**: a materially relied-upon belief or dependency where one or more required epistemic conditions are weak — stale evidence, partial/blind coverage, unresolved contradiction, missing authority, missing verification route, or known unsupported inference. Deterministic reasons, never an LLM-generated vibe. Assumption-specific debt M28+ |
| 90 | Known unknowns vs unknown unknowns; never claim epistemic closure | Language discipline + coverage records (M25); "all known sources considered" ≠ "all sources known" wording in the M26 adequacy output |
| 91 | Permissions / derived-data ACL propagation | Cut (D10): exactly one human; actor stamps on events are the access record; revisit only if multi-user ever exists |
| 92 | Prompt injection / trust boundaries: source content is data, never instruction | M26 **containment, not perfect provenance detection**: source has no direct tool authority; source-derived proposals are evidence-linked and policy-gated. A malicious source may still influence a valid proposal, so adversarial valid-LOW fixtures test containment. Detection remains heuristic `suspected_instructional_content` operational telemetry keyed to an immutable Observation, never an Observation mutation or factual `prompt_injection: true` field |
| 93 | Canonical state: 11 storage requirements; proposals cite state version; concurrent-agent safety | M21 durable frames + M22 reducer-visible logical batches/support graph/reducer-owned target versions with a closed event→target effect matrix + M24 closed CAS targets/idempotent commit sets and final mutable-precondition revalidation. Full-text exists; M26 semantic receipt v2 plus basic retrieval must pass golden alias, paraphrase, and accessible-counterevidence recall, regardless of implementation. Advanced retrieval + learned resolution M28+ |
| 94 | Mutation risk classes; human review for high/critical; no LLM-approves-LLM | M24 — D5 ladder; HIGH/CRITICAL always a human card; consensus-of-models is not a verification tier anywhere |
| 95 | The 15 epistemic invariants | Classified (a)/(b)/(c) in roadmap. M24 silence uses structured cause; M26 context acceptance retrieves known counterevidence and installs preventive self-ancestry before default-on; M27 freshness transitions are replay-stable. Source-instruction handling is honestly containment, never sold as perfect detection |
| 96 | Calibration: bands until empirically calibrated; forecast objects | Numeric probabilities cut permanently (D9). **Ordinal calibration is not constitutionally prohibited**: when Forecast objects arrive (M28+), asking whether "high" forecasts resolve true materially more often than "medium" is a legitimate empirical check — measuring whether labels mean anything is never banned; presenting fake precision is |
| 97 | Deployment: local vs always-on responsibilities; honest definition of "continuous" | D10 — continuous = while-app-open + launch catch-up (M25). Append-only contract versions plus typed `caught_up | retention_lost | declared_deadline_missed | not_applicable` outcomes pinned to the active version and linked gaps make R10 reproducible; always-on service remains deferred |
| 98 | Final principle: "what evidence should exist if this is true, who would know, what would change my mind" | **Schema, not just principle**: the M26 synthesis output carries structured fields — `basis`, `missing_expected_evidence`, `authoritative_next_sources`, `invalidation_conditions` — required for high-stakes conclusions, optional (unrendered when unhelpful) for routine answers. The spec's best philosophical line becomes system behavior; M28+ Skeptic strengthens it |

## Pulled forward (matrix Rev 2)

Foundational portions of ten deferred sections moved into M22–M27 — schema and
contracts, not product surfaces — because an earlier milestone implicitly
depended on them:

1. **§84 basic entity identity/resolution** → M22 IDs+aliases+unresolved subject
   representation, M26 basic resolver + measurable outcome telemetry.
2. **§25/§83 counterevidence-inclusive context assembly** → M26 contract with
   known-counterevidence recall fixtures; Skeptic independence stays M28+.
3. **§8 generic critical_attention bypass** → M27 (catastrophe must not wait
   for Risk objects).
4. **§10 silence-never-resolves** → formal class (a) invariant, M24 policy.
5. **§15 enforceable creation qualification** → explicit M24 deterministic
   receipt + mandatory server-minted M26 semantic receipt v2 before agent tools
   register.
6. **§17 evidence-state materiality** → M25/M26 with total verdict routing;
   corroboration requires M22 positive independence.
7. **§52/§71 minimal high-stakes verification + stopping rule** → M24/M26 (no
   self-certification of critical sufficiency).
8. **§93 basic semantic retrieval** → M26 golden alias/paraphrase/
   counterevidence recall (adequacy must not assess a crippled retriever).
9. **§98 structured synthesis fields** (incl. §36's provisional invalidation
   conditions) → M26.
10. **§30 convergence synthesis over ledger diffs** → M26 item 3b (persistent
    narrative still M28+ behind §31's earned-persistence trigger).

Also tightened without moving milestones: §5/§6 honest wording, §16 verbs ≠
opcodes, §33 protected lanes, §35 Epistemic Status surface, §37 eval suite not
cut, §45 predicate-class freshness defaults, §46 uncollapsed coverage
dimensions, §49 translated-not-implemented, §50 resolution outcomes vs
contradictions, §53 absence schema, §61 reserved provenance fields, §63 two
added principles, §64 corrects:/reason:, §67 sufficiency ≠ adequacy, §68
structured ephemeral plans, §76 hypothesis-labeling guard, §78 conservative
merges, §81 no hidden adaptation, §85 independence tri-state, §86 runtime vs
source health, §89 operational debt definition, §92 containment-over-guarantee,
§96 ordinal calibration permitted.

Rev 3 hardened representation and handoffs without adding product objects:
M22 support/source/independence/batch/version primitives and idempotent
migration; M23 canonical capture + three-way reconciliation; M24 complete
Proposal, canonical mutation mappings, atomic commit sets, and human
decision/revert state; M25 vault scoping, recovery, multidimensional ambient
gates, atomic terminal receipts, and responsibility/catch-up records; M26 total
material routing, server-minted semantic receipts, atomic outcome events,
preventive ancestry, committed conflict candidates, and measurable trigger
telemetry; M27 orthogonal/replay-stable dynamics with separate review status;
M28 measurable or explicitly discretionary gates.

## Registered after the freeze — the M31 deferrals (M31.8, 2026-08-14)

The M28 registry's governance text binds registry changes to this matrix, so
the three capabilities M31's claims audit surfaced and deliberately did not
build are recorded here in the same commit that registers them. They trace to
the M31 plan's non-goals, not to a numbered section of the source spec: no §
disposition above changes, and the section tallies below stay as written.

| # | Capability | Disposition |
|---|---|---|
| R15 | Unprompted recall — the attended assembler surfacing manifest items the question did not ask for | M28+ (trigger) — measurable: over 28 complete days after M31.7, ≥200 attended assemblies with a non-empty positive intent and `assembly_metrics.answer_latency_micros` p90 < 250_000 micros (p90 because the schema's quantile enum is p50\|p90); a firing licenses a plan that must first name the third execution contract — neither attended-metered nor ambient-gated. Deciding owner: the vault owner |
| R16 | Prior manifest as retrieval hint | M28+ (trigger) — evidence-based discretionary; the owner pack must answer the four recorded failure modes (`assembly_id` determinism, `Retriever`-trait purity, honest `exhausted`, and a retrieval-layer self-ancestry shape `policy/ancestry.rs` does not catch — it walks bases, a hint is not a basis); safe design is aliases-only widening. Owner: the vault owner |
| R17 | Folder-level ingest opt-out | M28+ (trigger) — evidence-based discretionary; the pack MUST contain the (a)/(b) product decision: (a) the LLM half skips the folder while `ingest/ambient.rs`'s four deterministic ledger-appending phases (detection, gauntlet, backfill, freshness) keep writing about "ignored" files, or (b) the app does not see the folder at all — `vault::scan::scan_vault`, the one choke point, is also the UI's file list. Owner: the vault owner |

R15–R17 are registered-deferred: analysis with an expressible gate, not
shipped behaviour. `trigger-registry.v1.json` still holds exactly R1–R14 —
an unnamed gate key resolves to nothing, which is the refusal — so none of
the three can be evaluated, let alone fire, until a successor artifact
revision lands with their first evaluator.

## Reading this matrix honestly

Counts by disposition after Rev 3: roughly 32 sections land in M21–M27 fully,
24 partially (a scheduled foundation + a deferred consumer, split stated per
row), 24 deferred to M28+ behind named triggers, 13 are principles with named
enforcement points, **1 is cut outright** (§91 ACL propagation), and 4 are
narrowed rather than cut (§9 scalar salience, §37 dashboards→eval suite, §49
monolithic enum→decomposed axes, §96 numeric→ordinal calibration). The tallies
are approximate by design — many rows straddle buckets; **the rows are
authoritative, never the tallies**. The standard this matrix now meets:
**nothing is unaccounted for, and no foundational capability is deferred past
the point at which an earlier milestone implicitly depends on it.**
