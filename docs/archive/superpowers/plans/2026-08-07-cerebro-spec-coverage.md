# Convergent Intelligence Spec — full coverage matrix (§1–§98)

Companion to `convergent-intelligence-overhaul.md` (Rev 2). That doc holds the
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

| § | Spec item | Disposition |
|---|---|---|
| 1 | Executive summary (optimize for understanding/convergence/…/correction) | Principle — the roadmap Verdict adopts it; enforced piecewise below |
| 2 | Problem (extraction explosion; coherent-but-wrong) | Principle — D7 restraint answers the first failure; coverage/adequacy (M25/M26) the second |
| 3 | Product vision ("technical Chief of Staff", epistemic humility) | Principle — shapes the M26 synthesis contract |
| 4 | North star: system gets smaller as understanding increases; minimum sufficient understanding, no material loss | Principle — enforced by D7 (4-object ontology) + M27 convergence dynamics; compression *metric* cut with §37 |
| 5 | Core model: Source→Observability→Evidence→Claims→Beliefs→Attention as distinct layers | Partial — **semantic separation preserved; physical persistence collapsed.** M22 keeps the layer boundaries through observation_kind, lineage, and assertion_basis while deliberately collapsing physical objects until Claims/Resolver have a consumer; enough schema survives to promote later without archaeology. Attention stays schema-disjoint (M27, invariant b). Do NOT read this row as "the Source/Evidence/Claim distinction is implemented" |
| 6 | Evidence records (17 fields; immutable revisions; tombstones; minimal interpretation) | M21 (immutability substrate) + M22 Observation. Day-one fields: id/kind/hashes/timestamps/actor/source ids/lineage, plus **reserved nullable provenance fields** (source_system, source_location, source_record_id, source_revision, source_author, source_workflow_state — §61) so connectors are data, not schema surgery. ACL metadata cut (D10). Richer participants/workstream metadata waits for a **consuming retrieval or project-model capability** — deferral is consumer-driven, never connector-driven (a human can create Xavier/Rev-C-scoped firsthand evidence before any connector exists) |
| 7 | Belief (mutable; strengthen/weaken/merge/split/contest/stale/supersede) | M22 object + revision chain; dynamics M27; merge/split as proposal ops M24/M26 |
| 8 | Attention ≠ knowledge; no hard cap; bypass classes for catastrophic/critical items | M27 lanes **including a generic `critical_attention` bypass from day one**: extremely conservative deterministic signals, human-confirmable, no scalar score, no Risk model — "production signing certificate expires tomorrow" must never wait for M28+ Risk objects. Specialized Risk/Decision lanes later refine and replace it |
| 9 | Salience factors; NOT a naive multiplication; 8 attention lanes | Partial: deterministic rule-based lanes M27 (contradiction, blindness, staleness, epistemic debt, critical_attention); scalar salience deliberately not built (the spec's own warning); decision-urgency/blocker lanes M28+ refine the generic bypass when their objects exist |
| 10 | Temporal semantics: 4 times; silence ≠ resolution; per-type evolution (Risk/Assumption/Decision/Action/Issue) | 4 times M22 (D3). **Silence-never-resolves is a formal class (a) invariant** (roadmap): elapsed time or absence of new observations may alter freshness/coverage/attention but may never by itself transition an unresolved object or belief to resolved/false/superseded — a mechanical M24 policy rule, because "no discussion for 30 days → probably resolved" is the easiest regression a Temporal/Maintenance pass can introduce. Per-type decay deferred with those objects (M28+); stale→recheck (M8) extends M27 |
| 11 | Hierarchy is a UX projection; ontology is a graph (depends_on, threatens, resolves…) | Vault hierarchy exists; lineage + belief relations M22; full relation vocabulary M28+ with Issues/Decisions |
| 12 | Issue model (container for claims/beliefs/deps; evolves, doesn't spawn) | M28+ (D7: Issues stay vault records until an epistemic consumer exists) |
| 13 | Issue lifecycle: multidimensional state (lifecycle/resolution/execution/decision/risk) | M28+; mechanism reserved now — M24 capability profiles keep it type-name-blind when it lands |
| 14 | State over history; reality-change vs understanding-change | M22 revision chains + D3 bitemporal split + D12 stage; current-state projections M23 |
| 15 | Object creation must be expensive; measure false-merge/contamination/overload | **M24/M26 enforceable behavior, not principle-only**: a create_belief proposal requires `candidate_matches_considered` + `distinctness_reason`; the creation path is exact-identity lookup → semantic candidate lookup → scoped/temporal candidate lookup → update/qualify existing if defensible → create only if meaningfully distinct — and symmetrically, no forced merge merely because candidates are similar. near_duplicates (knowledge.rs:49) is the backstop, not the mechanism. The three *rates* as metrics → §37 (eval suite, not dashboards) |
| 16 | Knowledge GC: 12 verbs, provenance-preserving | Split by nature: **epistemic transitions** (supersede/contest/merge/split/tombstone/archive) are risk-classed proposal ops M24; **maintenance/query actions** (recheck/compress-candidates/flag/surface) are M26 pass behaviors, not ledger opcodes. The 12 conceptual verbs do NOT imply 12 durable mutation opcodes. Provenance preserved by construction (append-only, M21) |
| 17 | Material change vs activity; outcome taxonomy; no-change → no rewrite, no interruption | M25 prefilter + M26 semantic materiality across **four materiality dimensions: world-state, belief-state, evidence-state, attention**. Independent corroboration is material even when the believed value is unchanged — single-source → corroborated is an epistemic change, and "no field changed → discard" would throw away reinforcement. Taxonomy = ingest-pass output schema M26; non-interruption = M27 default silence |
| 18 | Risk qualification gate (failure condition+impact+evidence+trigger) | M24 qualification gates as Type-doc capability profiles (presence checks at promotion); Risk-as-epistemic-object M28+ |
| 19 | Action qualification gate (owner+verb+completion condition) | Same as §18 — M24 profile, object M28+ |
| 20 | Decisions: action plane, not epistemic ladder; persist until superseded | Action-plane separation honored now (decisions stay vault records, D7); Decision objects + revisit conditions M28+ |
| 21 | Assumptions tracked toward validated/invalidated/accepted; debt accumulates | M28+ (behind consumer agent); generic epistemic-debt lane M27; assumption-specific debt with the object |
| 22 | Ingestion pipeline phases 0–9 | Mapped by determinism (amendment 5): 0 integrity, 4 materiality, 6 reconcile/policy, 7 state update = Rust (M24/M25); 1 observation, 2 extraction, 3 resolution, 5 proposal = M26 ingest pass; 8 synthesis = M23 projections + M26; 9 attention = M27. **Plus the context-integrity invariant traced here, at the pipeline definition**: any resolution/reconciliation that can modify an existing belief must receive candidate-supporting AND candidate-disconfirming context where available — "observation → resolve nearest belief → update" is not §22 compliance |
| 23 | Agents in isolated sessions; task-specific working memory; no persuasion bypass | Isolated CLI sessions exist (agent.rs); working-memory assembler M26; no-bypass = M24 policy by construction |
| 24 | Human cognitive analogy (LTM→recall→WM→reasoning→update) | Principle — plus its caveat (provenance of what entered WM) = M26 context manifest |
| 25 | Task-specific working memory: 12-item context contract; assembly exposed | M26 (assembler + manifest). **Context assembly is contradiction-aware from M26**: positive, contradiction, historical, authority, and scope-neighbor retrieval intents are the M26 contract — the Skeptic can wait; counterevidence retrieval cannot. M28+ Skeptic adds *independently initiated* adversarial retrieval on top of, never instead of, contradiction-aware assembly |
| 26 | No free-form agent chains; shared state + structured proposals; agent artifacts ≠ evidence | By construction D5/D6 (M24/M26); derived-≠-evidence = invariant (a) reachability check M27 |
| 27 | 11 agent responsibilities | D6: Observer/Resolver/Context-Assembler/Reconciler/Temporal/Synthesizer → 3 runtime constructs M26 (the M26 Resolver runs on §84's basic entity resolution — see that row); Attention → Rust M26/M27; Policy/Integrity → M24; Skeptic → M28+ (independent retrieval); Curiosity → M28+; Scout → **Pattern Scout M28+** (M26's Source Monitor is not it, amendment 6) |
| 28 | Structured agent outputs (op/target/expected_version/risk/reason) | M24 — serde-validated MCP proposal tools, terminal commit |
| 29 | Proactive intelligence (stale risks, zombie threads, ingestion failures); default silence | Partial: blindness/staleness/contradiction/critical_attention lanes M27; ingestion-failure surfacing M25; pattern-level detection M28+ (Pattern Scout, Curiosity) |
| 30 | Weekly/periodic convergence ("how has our model of reality changed?") | **Split — pulled forward.** M26 (item 3b): on-demand and scheduled convergence synthesis over ledger diffs (believed-then vs believed-now, what materially changed, what became more/less certain, what went blind/stale/contested) — a cheap consumer of ledger + revision chains + materiality + chips that all exist by then, and one of the first genuinely magical user surfaces after the substrate work. M28+: persistent narrative object + richer executive storytelling |
| 31 | Project narrative (compact, evolving, confidence-and-coverage-aware) | M28+ with an **earned-persistence trigger**: the narrative becomes an object when ≥2 independent product surfaces require stable narrative identity/history beyond query-time synthesis (e.g., weekly convergence + executive briefing) — a testable defer rule, not a chronological one |
| 32 | Progressive compression ladder (raw→…→executive narrative) | Partial: lower rungs M22/M23; Issues/Themes/Workstream/Executive rungs M28+ with their objects; unsafe-compression rules → §77 row |
| 33 | User working model: preference signals; hard epistemic/preference firewall; visible+editable | Firewall by construction (schema-disjoint, invariant b, M27) **plus a protected-lanes rule: preference may never suppress blindness, material contradiction, critical_attention, or high-impact human-review requirements** — preferences tune verbosity, ordering within normal lanes, phrasing, grouping, cadence; "user dismisses manufacturing warnings → hide manufacturing warnings" is the failure this rule forbids. Dismissals exist (M8); *learned* preference model M28+ |
| 34 | YAML-native knowledge; YAML as projection, not canonical storage | D1 + M23 — resolved exactly as the spec's own §34/§93 tension suggests |
| 35 | UX: primary project view (Current Story / What Changed / Needs Attention / …) | Full view M28+ (substrate first) — but an **Epistemic Status surface lands across M25–M27** (what changed, coverage gaps, contradictions, stale understanding, needs review, system/budget health) so blindness banners, proposal rejections, and coverage states have one coherent home instead of scattered cards; it later grows into §35's richer view |
| 36 | Explainability: 12 questions every conclusion must answer | Partial: provenance M22; chips M27; adequacy statement M26; **provisional "what would change my mind" in M26** — agent-generated invalidation conditions labeled as such, derived from current support/coverage ("would change if a newer production manifest contradicts the reviewed engineering evidence") — strengthened M28+ by Skeptic + verification policies |
| 37 | Success metrics (16: time-to-understanding … calibration) | **Product dashboards cut; engineering epistemic eval suite NOT cut.** Single-user data cannot calibrate, but golden/synthetic epistemic scenarios are ideal regression fixtures: false creation, false merge, missed contradiction, stale truth, ancestry reinforcement, critical-attention misses each get benchmark tests as their mechanisms land (M24–M27). The raw events (corrections, merges, surfacing, dismissals, rejections) are ledgered from M22 |
| 38 | Anti-goals (12) | Principle — D7 and D10 enforce the load-bearing ones (no exhaustive ontology, no persistent object per mention, no availability-as-completeness) |
| 39 | Product philosophy: system handles memory/compression/…; human retains judgment | Principle — M24's human card + D11's ownership-≠-infallibility are the enforcement points |
| 40 | Desired end state | Principle |
| 41 | Epistemic model: knowledge plane (artifact→observation→assertion→claim→belief) vs action plane | M22 (knowledge plane, D7 collapse with subtypes); action plane = vault records, unchanged |
| 42 | Observed fact vs reported claim vs inferred claim vs belief | M22 — observation_kind (amendment 2) + assertion_basis (D11) |
| 43 | Source provenance: full transformation lineage; derived summary never independent evidence | M22 lineage edges; self-reinforcement ban = invariant (a) check M27 |
| 44 | Source authority: query-specific, ownership-aware, firsthandness-aware | D11 (amendment 4): metadata M22; used qualitatively in M27 conflict handling; full per-predicate authority *policies* M28+ (simple high-stakes requirements arrive earlier — §52) |
| 45 | Evidence freshness per predicate/knowledge type | Partial — **default predicate-class freshness rules land with M27's Validity axis** (charter rationale: durable · CI status: hours · shipping BOM: days/revision-bound): freshness semantics are not connector-dependent, and Validity needs them to mean anything. Source-level stale_after exists (M8) and is a different thing. Learned/custom per-predicate policies M28+ |
| 46 | Observability/coverage: per-source health, scope, retention, lag; availability ≠ completeness | Partial: CLI/runtime health M25; Source Monitor M26. **The data model keeps the dimensions separate** — source_connected, source_healthy, scope_known, scope_accessible, retention_known, index_current, retrieval_attempted — the UI may summarize to "partial"; the model never collapses, because retrieval-adequacy explanations depend on the distinctions. Per-connector scope models M28+ |
| 47 | Retrieval sufficiency (policy + human judgment, not model self-certification) | The 10-dimension structured assessment (roadmap section); produced M26, adversarially exercised M28+ (Skeptic); never a score. Self-certification blocked earlier by §71's stopping rule |
| 48 | Confidence split: evidence / retrieval-coverage / world-state | D9 → M27 Support/Coverage/Validity chips |
| 49 | Claim status (8 states; "verified" used sparingly) | **Translated, not implemented**: the spec's unified 8-value status vocabulary decomposes into orthogonal fields — Support (single-source/corroborated/attested), Validity (fresh/stale/contested/superseded), lifecycle — under D9. corroborated is a support condition, stale is validity, contested is conflict status, superseded is lifecycle; a monolithic status enum would re-entangle what Rev 2 deliberately separated, so **no such enum is created**. Recorded here as a deliberate improvement on the spec |
| 50 | Contradiction is not binary (7 kinds) | M27 as a **resolution pipeline, not flat labels**: candidate conflict → scope/stage/temporal/granularity resolution → outcome ∈ {resolved_temporally, resolved_by_scope, resolved_by_stage, resolved_by_granularity, genuine_direct, partial, conditional}. Several spec "contradiction types" are resolution *outcomes* meaning "not a contradiction after all" — **only the unresolved classes become contradiction edges**, keeping the graph clean |
| 51 | Source conflict resolution: no auto-winner; preserve competing claims; human judgment when material | M27 contradiction preservation + M24 human card; authority via D11 |
| 52 | Verification policies (preferred routes per predicate; minimum for high stakes) | **Split — pulled forward.** M24/M26: simple deterministic high-stakes verification requirements by evidence class + authority (M27's conflict handling consumes them) (e.g., `shipping_soc` high-stakes requires a production artifact OR responsible-owner firsthand) — needs one connector, humans, and files, nothing more, and it enforces no-self-certification early. M28+: learned/custom cross-source preferred routes |
| 53 | Coverage gaps surfaced; negative evidence needs observation completeness | **Absence assertions are structurally distinct from M22**: `assertion_kind: absence` + searched_domain, search_scope, coverage_basis, observation_window, query_strategy, limitations — "no evidence of X" ≠ "X is false" by construction, even before any UI shows it. M24 refuses formal absence claims lacking a coverage record; gap surfacing M25/M27 |
| 54 | Decision intelligence (prepare, never decide) | M28+ (with Decisions) |
| 55 | Decision frames (16 fields) | M28+ |
| 56 | Decision readiness relative to stakes | M28+ (§67's sufficiency-per-use and §71's stopping rule are its early ancestors) |
| 57 | Value of information (proportionate discovery) | M28+ |
| 58 | Forward intelligence (approaching decisions/dependencies; forecasts labeled as forecast) | M28+ (forecast objects); next_expected_event arrives with Issues |
| 59 | Meeting preparation surface | M28+ (product surface over M26 assembly) |
| 60 | Executive preparation surface | M28+ |
| 61 | Connected organizational intelligence (GitHub/Jira/Slack/…; source-type epistemics) | Partial: source-type modeling M22 (observation_kind) **plus the reserved nullable provenance fields from §6** (source_system/location/record_id/revision/author/workflow_state) so future connectors never force schema surgery; connectors.rs scaffolding exists; live connectors are their own post-M27 milestones |
| 62 | Incremental intelligence: precomputed state, affected-only recompute, local vs always-on split | M25 (hash-diff, durable cursors, batching) + D10 (continuous = while-app-open + catch-up); always-on service deferred |
| 63 | Failure containment (10 principles) | Spread, each named: append-only M21 · revisable beliefs M22 · contradictions preserved M27 · high-impact-needs-evidence M24 · coverage→confidence M27 · unknowns explicit (language discipline) · stale sources ≠ silence M25 · derived-≠-ancestry M27 · versioned/reversible M21/M24 · fail-by-uncertainty (synthesis contract M26). **Plus two made explicit: model failure cannot corrupt canonical source evidence** (append-only Observations + proposal-only mutation, M21/M24) **and operational failure cannot masquerade as epistemic silence** (M25's runtime-health vs source-health split, §86) |
| 64 | Human judgment as first-class input; corrections preserved as distinct objects | D8 two channels M22/M23, **plus optional `corrects:` / `reason:` on human assertions**: "that Slack comment referred to Rev B, not Rev C" is both new firsthand evidence AND a pointer to the mistaken observation/extraction/revision — the raw material for asking "which extraction mistakes repeat?" (§81) |
| 65 | Core philosophy: the 9-part answer shape ("here is what we observed…") | M26 synthesis output contract (structured per §98) |
| 66 | Discovery-first reasoning; stakes-proportional; provisional answers labeled | Partial: provisional labeling M26; §71's minimal stopping rule M24/M26; full stakes-proportional discovery loop M28+ (Curiosity/Skeptic) |
| 67 | Evidence sufficiency (insufficient/partial/adequate/strong, per intended use) | **NOT folded into retrieval adequacy — two distinct outputs.** Retrieval adequacy: "did we look sufficiently?" Evidence sufficiency: "given what we found, is it enough for THIS use?" Excellent retrieval + weak evidence and poor retrieval + one authoritative direct observation are both real states. The M26 answer contract reports both: "Retrieval: partial · Sufficiency: adequate for a reversible prototype decision; insufficient for production release." Per-use thresholds mature with §52 |
| 68 | Discovery plans instead of fabricated certainty | **M26 emits structured (ephemeral) discovery plans** — goal / steps / stop_when / stakes as schema, not prose — so later promotion to persistent Discovery objects (M28+) is trivial: promotion, not migration, same philosophy as Claims |
| 69 | Discovery objects (first-class, with coverage + remaining steps) | M28+ (behind consumer; §68's structured output is the promotion source) |
| 70 | Curiosity agent (identify missing knowledge) | M28+ |
| 71 | Discovery stopping rules; model may not self-certify sufficiency on high-impact | **Minimal deterministic rule lands M24/M26**: intended use HIGH/CRITICAL AND (Coverage ≠ observed OR required authority class missing) → the answer remains provisional / requires human verification. No Curiosity machinery needed — "looks adequate to me" is structurally impossible for high-stakes answers from day one. Full stopping-rule system M28+ |
| 72 | Reinforcement only through genuinely additional evidence | M27 lineage-independence counting (with §85's tri-state) |
| 73 | Correction over accumulation; beliefs never permanent by age | M22 revisions + M24 proposals; nothing in the schema confers age-based permanence |
| 74 | Belief revision history w/ valid-time + system-time; late learning about early change | M22 revision chain + D3 — the spec's AMD-effective-June-18-learned-Aug-7 case is representable by construction |
| 75 | Reinforcement vs repetition (lineage, not application count) | M27 — copies collapse to one ancestral evidence family, as a reducer/graph property, never an LLM judgment (owner carry-in 5) |
| 76 | Compound knowledge: convergence labeled as causal hypothesis until evidenced | **Guard M26, object M28+**: from the first synthesis, shared root causes may not be stated as settled unless directly supported — causal explanations are labeled hypothesis. The persistent causal-hypothesis object waits; the epistemic sin it prevents is blocked from day one |
| 77 | Compression unsafe if it removes disagreement / changes decisions / obscures scope / collapses causes / loses provenance | The five conditions map: disagreement M27 gate · decision implications M24 risk ladder · scope M22 qualifiers · causes §76 guard · provenance by construction M21 |
| 78 | Graph maintenance (12 ops) | M26 **identifies** merge candidates; only exact-equivalence LOW-risk merges auto-apply; semantic merges are proposal/risk-gated (M24); entity merges are CRITICAL → human review. "The maintenance pass merges duplicates" is never casual. Circular-reasoning + lineage-duplication detection M27; scope-collision detection needs §84's learned tier (M28+) |
| 79 | Knowledge entropy actively reduced | Principle → M26 maintenance pass |
| 80 | Knowledge fitness: periodic justify-existence review (incl. "reinforced only by own descendants") | Partial: stale→recheck exists (M8), extends M26; descendant-only-reinforcement is an M27 reachability query; full fitness review M28+ |
| 81 | Self-improvement via explicit artifacts (9 mechanisms, inspectable) | Mostly M28+, with a standing prohibition now: **no self-improvement mechanism may silently mutate agent prompts or policies from observed user behavior** — learned aliases, attention preferences, and verification routes are inspectable, editable records/settings; "Cerebro learned how the user thinks" as hidden adaptation would undermine the entire explainability model. Source-reliability calibration → §96 |
| 82 | Core learning principle (accuracy of model, not volume of knowledge) | Principle |
| 83 | Context integrity: multi-intent retrieval; Skeptic gets independent retrieval authority | **Elevated to a standing invariant** (roadmap, class a): no belief-affecting semantic inference may rely solely on a context set selected to support the candidate conclusion when accessible counterevidence retrieval is feasible — enforced at the M26 assembler contract, not merely at the M28+ Skeptic, which adds *independence* on top |
| 84 | Entity resolution: canonical identity, aliases + validity periods, scope qualifiers | **Split — the matrix's biggest catch** (M26 named a Resolver while this row said M28+; those conflicted). **M22**: stable entity/subject IDs + explicit aliases when known. **M26**: basic resolver — exact ID → known alias → explicit relation → high-confidence existing-entity match → otherwise *unresolved*, never guessed (without this, Falcon/Falcon C/Rev C/Product A/Xavier cannot attach observations, reinforce lineage, detect scope conflicts, or retrieve contradictions). **M28+**: learned alias model, temporal alias validity, ambiguity improvements |
| 85 | Evidence lineage edges + independence-weighted corroboration | M22 edges (mandatory schema) + M27 counting with a **tri-state: known_same_lineage / known_independent / independence_unknown** — two engineers writing the same thing may both have heard it in one meeting; "no lineage edge detected" never silently counts as independence. The lineage analogue of availability ≠ completeness |
| 86 | Source health / ingestion integrity (lag, errors, partial indexing, stale credentials) | M25 — with **source health and reasoning-runtime health as distinct categories**: a dead Slack connector means reality may be changing unobserved; a dead CLI quota means evidence exists but cannot currently be processed. Different semantics, different blindness messages. Connector-specific health with live connectors |
| 87 | Negative evidence requires observation-completeness assessment | Invariants (b)/(c) + §53's structural absence schema (M22) + M24 refusal without a coverage record |
| 88 | Causal hypotheses distinct from descriptive patterns | M28+ (object); §76 guard from M26 |
| 89 | Epistemic debt visible alongside execution risk | M27 lane with an **operational definition**: a materially relied-upon belief or dependency where one or more required epistemic conditions are weak — stale evidence, partial/blind coverage, unresolved contradiction, missing authority, missing verification route, or known unsupported inference. Deterministic reasons, never an LLM-generated vibe. Assumption-specific debt M28+ |
| 90 | Known unknowns vs unknown unknowns; never claim epistemic closure | Language discipline + coverage records (M25); "all known sources considered" ≠ "all sources known" wording in the M26 adequacy output |
| 91 | Permissions / derived-data ACL propagation | Cut (D10): exactly one human; actor stamps on events are the access record; revisit only if multi-user ever exists |
| 92 | Prompt injection / trust boundaries: source content is data, never instruction | M26 line item with honest semantics: **the guarantee is the boundary, not the detection** — source content cannot become system/tool instructions regardless of whether injection is detected (structural: nothing an agent reads can mutate state except through M24-validated proposals). Detection is heuristic telemetry recorded as `suspected_instructional_content` + classifier, never a `prompt_injection: true` fact |
| 93 | Canonical state: 11 storage requirements; proposals cite state version; concurrent-agent safety | M21 (immutable revisions, transactions, rollback-by-rebuild) + M22 (graph, temporal queries, lineage) + M24 (expected_version, idempotent re-evaluation). Full-text search exists (search.rs); **basic semantic retrieval moves to M26** — query expansion and/or embeddings in app-data, whatever satisfies the assembly contract, because BM25 alone cannot search aliases, paraphrases, or contradiction candidates, and retrieval adequacy must not assess an intentionally crippled retriever. Advanced graph/semantic retrieval + learned resolution M28+ |
| 94 | Mutation risk classes; human review for high/critical; no LLM-approves-LLM | M24 — D5 ladder; HIGH/CRITICAL always a human card; consensus-of-models is not a verification tier anywhere |
| 95 | The 15 epistemic invariants | Classified (a) mechanically enforceable / (b) by construction / (c) aspiration-never-sold-as-guarantee — full classification in the roadmap, now including silence-never-resolves (§10) and context integrity (§83) in class (a) |
| 96 | Calibration: bands until empirically calibrated; forecast objects | Numeric probabilities cut permanently (D9). **Ordinal calibration is not constitutionally prohibited**: when Forecast objects arrive (M28+), asking whether "high" forecasts resolve true materially more often than "medium" is a legitimate empirical check — measuring whether labels mean anything is never banned; presenting fake precision is |
| 97 | Deployment: local vs always-on responsibilities; honest definition of "continuous" | D10 — continuous = while-app-open + launch catch-up (M25); always-on service deferred with its responsibility list intact |
| 98 | Final principle: "what evidence should exist if this is true, who would know, what would change my mind" | **Schema, not just principle**: the M26 synthesis output carries structured fields — `basis`, `missing_expected_evidence`, `authoritative_next_sources`, `invalidation_conditions` — required for high-stakes conclusions, optional (unrendered when unhelpful) for routine answers. The spec's best philosophical line becomes system behavior; M28+ Skeptic strengthens it |

## Pulled forward (matrix Rev 2)

Foundational portions of ten deferred sections moved into M22–M27 — schema and
contracts, not product surfaces — because an earlier milestone implicitly
depended on them:

1. **§84 basic entity identity/resolution** → M22 IDs+aliases, M26 basic
   resolver (M26 cannot be a Resolver without it — the blocking catch).
2. **§25/§83 counterevidence-inclusive context assembly** → M26 contract;
   Skeptic independence stays M28+.
3. **§8 generic critical_attention bypass** → M27 (catastrophe must not wait
   for Risk objects).
4. **§10 silence-never-resolves** → formal class (a) invariant, M24 policy.
5. **§15 enforceable creation qualification** → M24/M26 proposal rule.
6. **§17 evidence-state materiality** → M25/M26 (corroboration is material
   when the value is unchanged).
7. **§52/§71 minimal high-stakes verification + stopping rule** → M24/M26 (no
   self-certification of critical sufficiency).
8. **§93 basic semantic retrieval** → M26 (adequacy must not assess a crippled
   retriever).
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
source health, §89 operational debt definition, §92 boundary-over-detection,
§96 ordinal calibration permitted.

## Reading this matrix honestly

Counts by disposition after Rev 2: roughly 32 sections land in M21–M27 fully,
24 partially (a scheduled foundation + a deferred consumer, split stated per
row), 24 deferred to M28+ behind named triggers, 13 are principles with named
enforcement points, **1 is cut outright** (§91 ACL propagation), and 4 are
narrowed rather than cut (§9 scalar salience, §37 dashboards→eval suite, §49
monolithic enum→decomposed axes, §96 numeric→ordinal calibration). The tallies
are approximate by design — many rows straddle buckets; **the rows are
authoritative, never the tallies**. The standard this matrix now meets:
**nothing is unaccounted for, and no foundational capability is deferred past
the point at which an earlier milestone implicitly depends on it.**
