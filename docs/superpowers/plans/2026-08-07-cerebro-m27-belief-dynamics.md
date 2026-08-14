# M27 — Belief dynamics + attention lanes

**Brief for the agent picking this up cold.** Written 2026-08-07. Read the
master roadmap D9, D11, D12, the invariants section, and matrix rows §8–§10,
§33, §35–§37, §44–§45, §48–§51, §72, §75, §77–§78, §80, §85, §89 first. M27 is where
the product visibly becomes the thing the spec describes: Support/Coverage/
Validity chips, contradiction handling that doesn't cry wolf, attention lanes
under nothing-speaks-first, and the Epistemic Status surface skeleton.

**The tone rule inherited from M8: nothing speaks first.** Every lane, chip,
and banner obeys default silence; surfaces answer when looked at. The
exceptions are named and narrow: the M23 reconciliation banner, this
milestone's `critical_attention` bypass, and M25's quota/blindness banners —
the last consolidate into the M27.8 Epistemic Status skeleton.

---

## Where things stand (verify at start — refs drift)

- M26 landed: the three constructs on by default, deterministic attention
  primitives computed and stored (staleness clocks, coverage states,
  unresolved-contradiction counts), resolver attaching observations,
  lineage edges flowing from real ingest, and preventive anti-self-ancestry
  reachability enforced at proposal apply. M27 owns full independence counting
  and retrospective graph hygiene, not that activation prerequisite.
- Contradiction *edges* do not exist yet — M26 stored candidate-conflict
  signals; classification is this milestone's job.
- The M24 contradiction-preservation gate slot in the policy table fires
  nothing (no edges to check). Support/Coverage/Validity have schema homes
  (D9) but no derivation and no rendering.
- Trust chips today: `trustTier` derived from `verified` (mcp.rs:751,
  okf.ts) — the M27 structured Support/Coverage/Validity chips replace this
  derivation, and knowledge.spec.ts asserts chip content literally (e2e
  coupling, again).

## Non-goals (defend these)

- No scalar salience, no naive multiplication of factors (§9 — the spec's
  own warning). Lanes are deterministic rules, ranked by rule class, never
  scored.
- No monolithic claim-status enum (§49): the three axes and Validity's
  freshness/conflict/lifecycle fields remain orthogonal.
- No Risk/Decision/Issue objects; `critical_attention` is a generic bypass
  precisely so catastrophe does not wait for them (§8).
- No learned freshness policies, no learned authority (M28+); M27 ships
  default predicate-class rules as data.
- No Skeptic; anti-self-ancestry is a reachability check at proposal-apply,
  not an agent.
- No full §35 project view — the Epistemic Status surface is a skeleton
  with a named growth path.

## Four rules that must survive contact with implementation

**Scope resolution BEFORE contradiction (D12/amendment 8).** A candidate
contradiction must first fail resolution on: same subject? same revision?
same environment/geography? same valid time? same D12 stage? same meaning?
"Rev A uses NVIDIA" vs "Rev C uses AMD" is not a contradiction;
intended-vs-shipping is stage lag, not conflict. Resolution produces a typed
outcome — `resolved_temporally / resolved_by_scope / resolved_by_stage /
resolved_by_granularity / same_meaning / genuine_direct / partial /
conditional` — and
**only the unresolved classes become contradiction edges**. Without this
step, contradiction preservation screams at normal temporal evolution and
the user learns to ignore it, which kills the entire surface.

**Independence is tri-state (§85).** `known_same_lineage /
known_independent / independence_unknown` — "no lineage edge detected"
never silently counts as independence (two engineers may both have heard it
in one meeting). Corroboration counting uses known_independent only;
independence_unknown renders as exactly that. The lineage analogue of
availability ≠ completeness.

**Repetition strengthens nothing (§72/§75).** Four copies of one Slack
message collapse to one ancestral evidence family — deterministically, as a
reducer/graph property, never an LLM judgment. M26 already refuses a new
BeliefBasis support edge reachable from the target belief; M22 independently
keeps review attestation out of Support. M27 counts
known-independent families and retrospectively finds cycles and descendant-
only reinforcement in history created before that check.

**Protected lanes (§33).** Preference may tune verbosity, ordering within
normal lanes, phrasing, grouping, cadence. It may NEVER suppress blindness,
material contradiction, critical_attention, or high-impact human-review
requirements. "User dismisses manufacturing warnings → hide manufacturing
warnings" is the failure this rule forbids. The preference firewall is
schema-disjointness (attention tables never touch belief tables) PLUS this
rule, both tested.

---

## Phases

One commit per phase, `type(scope): sentence (M27.n)`.

### M27.1 — Freshness defaults + the Validity axis
Predicate-class freshness rules as data (same shared-artifact discipline as
the policy table — `shared/policy/freshness.v1.json`): charter rationale —
durable · CI status — hours · shipping BOM — days/revision-bound (§45).
Implement the closed bundle
`Validity { freshness: fresh | stale | unknown, conflict: clear | contested,
lifecycle: active | superseded | archived | tombstoned }`; stale+contested must
coexist. First derive the design's `BeliefFacetKey` per distinct predicate/
stage among admissible supporting assertions; unsupported becomes one unknown/
unknown facet, while multi-facet revisions remain separate. Derive the tagged
`ReviewStatus = unreviewed | current{attestation,revision} |
predates_current{attestation,revision}`. Attestation may
reset freshness only when the versioned predicate rule explicitly permits it;
it never enters Support. Select the latest attestation by ledger position:
none is unreviewed, a pin to current revision is current, otherwise it predates.
The reducer never reads wall time. A deterministic scheduler emits
`freshness.transitioned { facet, from, to, effective_at, rule_version,
dedupe_key }`, computing effective time from the pinned facet assertion/
revision + versioned rule. Each rule declares `valid_from | occurred_at |
belief_revision_time`; select the maximum known `(timestamp,event_id)` across
same-facet supports and any policy-authorized latest attestation, or unknown
when none is known. The dedupe hash includes revision, predicate, stage,
effective time, and version; a duplicate dedupe_key append is an idempotent
no-op (append_once semantics), so timer/launch retries are safe. Timer and launch catch-up emit every due
transition in stable effective-time/ID/predicate/stage order; rule changes emit
new-version transitions instead of reinterpreting old ones.
Rebuild a week later must be byte-identical. Source-level `stale_after` (M8)
is a different thing and is not touched.

### M27.2 — Lineage-independence corroboration + the Support axis
Deterministic collapse of copies into ancestral families (content-hash +
copied_from/summarized_from edges, at the M25 prefilter layer where
duplicates are cheapest to catch); tri-state independence; Support
derivation as the design's tagged ordinary/authoritative union — derived from
lineage, agent-asserted never. Consume M22's exact committed
`observation.independence_recorded` proof tags. M25's registered-source
deterministic path emits `distinct_firsthand_origin` and
`independent_system_artifact`; M24's applied HIGH confirmation path emits
`human_confirmed` with proposal/approved-decision refs. Verify both source-
registration refs and distinct collapsed families, and retain/display each
proof's `rule_version`; no event remains unknown,
and `independent_family_count` counts proved families, not pair rows.
`authority_scope` pins predicate, stage, assertion, source-registration event,
trusted authority provenance, route ID/version, and closed class `direct_artifact |
responsible_owner_firsthand | firsthand_observer`. Match exact versioned M24
predicate/stage routes plus M22's portable `source.registered` reducer state:
direct artifacts require `registered_direct_artifact` and
`direct_system_artifact`; human routes require `trusted_human_capture`, a
bound `human_actor`, and `human_assertion`. `content_only`, `agent_inferred`,
`legacy_reference`, payload tags, and orphaned cache rows never qualify;
legacy references also confer no deterministic independence and retain unknown
health/coverage absent separate trusted M25 facts. Direct production artifacts can qualify without human
authorship, and authority never transfers across facets. Without a route
match: zero families → unsupported; one family or no positively independent
pair → single_source; ≥2 positively independent families → corroborated.
M26's preventive
reachability check is re-proven, not reintroduced here.

Coverage retains all seven M25 values. Each folded dimension preserves every
contributing assessment/source state, basis refs, and per-input as-of rather
than one global timestamp. Select the
latest compatible assessment per supporting/proposal source; fold dimensions
`no > unknown > yes`, ignoring valid not-applicable values unless all are N/A.
Summary is `blind` for no assessments or a `no` in connection/health/access/
index/retrieval; `observed` only when every dimension is yes/N/A; `partial`
otherwise. The fold order and summary precedence ship as one versioned
artifact, `shared/policy/coverage-fold.v1.json` (same discipline as
freshness.v1.json), and the derived Coverage records its `fold_rule_version`.
Ship exhaustive fold/precedence goldens. Two deterministic graph-hygiene checks
land alongside the reachability work, feeding the debt/maintenance lane:
circular-reasoning + lineage-duplication detection (§78 — a belief supported
through a cycle in its own lineage; duplicated lineage families that
survived the collapse) and the retrospective descendant-only-reinforcement
query (§80 — a belief whose entire support traces to its own descendants,
covering migrated/pre-M27 state the preventive proposal-apply check never
saw).

### M27.3 — The resolution pipeline
Implement the design's tagged `ConflictEndpoint`: `asserted` wraps M26's exact
candidate endpoint/ID; `declared_relation` pins relation event/origin and belief/revision,
subject/content hash, and explicit `known{...} | unknown` scope/stage/time tags without inventing an
assertion. Legacy comparison IDs use the specified domain-separated hash.
Committed M26 `conflict.candidate_detected` events run the D12 gauntlet in
order. Add and cross-language vector-test the exact bodies
`conflict.comparison_registered`, `conflict.classified`, `contradiction.opened`,
`contradiction.closed`, and `contradiction.backfill_completed` from the spec.
Every classification carries non-empty closed `reason_codes`; only
`genuine_direct | partial | conditional` open pinned edges.
Implement the spec's outcome/provenance/reason matrix exactly: temporal/scope/
stage are deterministic-only; same-meaning and conditional are agent-only;
granularity/direct allow only their stated structural-or-agent forms; partial
is agent-incompatible-values or deterministic declared-relation reasons, never mixed.

All five bodies include M22 common fields and are ledger-resident. Build the
classification/edge/backfill reducer indexes; validate endpoint equality with
the M26 candidate (except tagged declared-relation expansion), comparison CAS,
classification provenance, and addressed-by references. Shared vectors cover
body/refusal/reducer destiny and rebuild; runtime-only signals cannot satisfy
the pipeline. Each unresolved classification and its required opened edge commit
in one M22 logical batch; resolved outcomes batch no edge. Crash vectors prove
neither half can become reducer-visible alone.
Extend `state_versions` exactly as the design: freshness increments its Belief;
classification increments comparison; open/close each increment comparison and
each distinct endpoint Belief; backfill marker has no effect. Close bodies pin
comparison and both endpoint Belief IDs. `classify_conflict` targets comparison,
both endpoint Beliefs, and basis Observations exactly; post-versions differ
resolved (+1 comparison) vs unresolved (+2 comparison, +1 each Belief).
For declared relations, registration first creates comparison v1;
classification makes v2, and unresolved open makes v3. Derive
`edge_id = sha256("cerebro-contradiction-edge-v1\0" + comparison_id + "\0" +
kind)` and enforce reducer uniqueness/idempotent exact replay; duplicate or
ID/body mismatch refuses and a closed edge never reopens.

Typed subject/scope/time/stage results are deterministic. `same_meaning` and
any granularity result requiring semantics must arrive through the M24-mapped
MEDIUM `classify_conflict` op targeting `comparison_id` and record
`classification: agent_supplied { proposal_id, model_id, prompt_version }`
plus evidence refs. Silence/time cannot close an edge. Authority is evaluated
for the endpoint predicate + stage, never universally.

Before gates or lanes activate, idempotently reclassify every committed
pre-activation M22 `belief.relation` add of `contradicts`, whether migrated or
ordinarily authored. Pin from/to revisions current at the relation event.
Missing assertions/qualifiers conservatively open a
`partial` edge with exact non-empty `relation_missing_*` reasons atomically with its
classification; they never silently resolve. Resume by `through_event_id`; activation requires a
`contradiction.backfill_completed` marker covering the pre-activation ledger
head. Until its classification commits, a legacy `contradicts` relation stays
a visible protected legacy conflict: the contradiction lane renders it tagged
legacy-unclassified (deterministic, no LLM), and the M27.4 gate predicate
counts it as an open edge. Afterward, `edit_relation` refuses a new `contradicts` add unless its
preallocated relation event, classification, and any required open edge commit
in one batch, inserting declared comparison registration before classification
(or it uses the exact asserted endpoint path). Policy v3 expands this action's
exact targets to Relation, both Beliefs, all endpoint basis Observations, and
Comparison; remove retains its ordinary targets and never closes an edge. The
lead/main/BOM fixture must end with zero edges and three coexisting beliefs.

### M27.4 — The contradiction-preservation gate goes live
The M24 policy slot fires: merge/supersede over open contradiction edges is
refused unless exact `basis.addressed_contradictions[{ edge_id, comparison_id,
disposition, evidence_refs }]` plus exact comparison/endpoint-Belief/evidence-
Observation CAS targets validate an addressing mutation. Require sorted unique
non-empty evidence that is a subset of top-level evidence. Server-preallocate
the mutation event ID, then batch that mutation and `contradiction.closed`;
the close copies edge endpoints/evidence exactly and uses the mutation ID as
`addressed_by_event_id`. No caller-authored or standalone close path exists.
Publish `shared/policy/policy.v3.json` (`format: 3`) first: bind
`open_contradictions_addressed` plus ledger codes
`contradiction_preservation_required | contradiction_edge_stale` to the five
supersede/mass-supersede/exact-belief-merge/entity-merge/split ops (M24
derives `split_belief` too — a split changes belief identity), with the design's
exact expected/actual typed edge arrays/tuples; gate activation against v2
refuses table load. The predicate also derives, per target, live `contradicts`
relations of origin `legacy_migration` with no committed classification — each
counts as an open edge, dischargeable only through the same addressing path or
by classification through the backfill pipeline. Fires only
after M27.3 has failed to resolve the claims apart — the gate must never
trigger on stage lag. The pipeline and the gate consult M24's high-stakes
verification requirements (§52): a missing required verification route is
both a debt-lane reason and a gate-escalation signal. Golden fixtures on
both suites (table + goldens, no twin logic). Refuse activation without the
backfill-complete marker; no separate legacy `contradicts` behavior survives.

### M27.5 — Chips in the UI
Support/Coverage/Validity ordinal chips render per belief facet (knowledge
surfaces + dossiers); multi-facet beliefs render separate scoped rows. They
compose a human-readable line ("single-source, partial coverage, stale and
contested"). The `trustTier` derivation is
subsumed — but never into Support. Review attestation (D8 channel 1) renders as
the separate ReviewStatus M23 r3/r5 state;
`authoritative_for_predicate_stage` derives only from a route-matched direct
artifact or qualifying human assertion in the facet lineage (D8 channel 2,
D11); the chip names predicate, stage, and route class. A migrated verified
concept keeps its explicit unsupported basis (`Support: unsupported`) and
its review attestation visible separately — Support untouched. This phase also
activates M26's chip-gated convergence certainty-shift and contestation
sections, which now render Support/Validity deltas. **This is the
milestone's e2e minefield**: knowledge.spec.ts asserts literal chip content
— those assertions change deliberately, in this commit, each named in the
commit message body (treat demo-vault/spec changes as test changes, per
house rule).

### M27.6 — Lanes: contradiction + blindness, then staleness + debt
The four lanes over M26's attention primitives, deterministic rules only:
contradiction (open genuine/partial/conditional edges, plus unclassified
legacy `contradicts` relations tagged legacy-unclassified) · blindness (Coverage
= blind, detected unqualified — relied-upon is an ordering signal within the
lane, never a detection filter; the §89 qualifier belongs to the debt lane
only; M25 runtime-vs-source health feeds the copy)
· staleness (`Validity.freshness = stale`, independent of conflict/lifecycle)
· **epistemic debt with the operational
definition** (§89): a materially relied-upon belief/dependency with stale
evidence, partial/blind coverage, unresolved contradiction, missing
authority, missing verification route, or known unsupported inference —
deterministic reasons, never an LLM vibe. M24's parked unqualified items
feed the debt lane. All under nothing-speaks-first. The staleness lane
emits recheck work into the M26 maintenance lane (extending M8's
stale→recheck, §10); M27 builds no second recheck mechanism.

### M27.7 — critical_attention bypass + protected lanes
The generic bypass (§8): extremely conservative deterministic signals,
human-confirmable, no scalar score, no Risk model ("production signing
certificate expires tomorrow" must not wait for M28+). Ship
`shared/policy/critical-attention.v1.json` with exactly two initial IDs:
`production_signing_certificate_expired` (`expires_at <= as_of`) and
`production_signing_certificate_expiring`
(`as_of < expires_at <= as_of + 72h`). Both require an active
`production_signing_certificate` in `environment=production` with no active
later M22 `supersedes` relation directed replacement `from` → candidate `to`.
Evaluation receives explicit `as_of`; reducers do
not read the clock. The artifact carries required fields/operators/duration/
environment/replacement/copy keys. Add positive, exact-boundary, replaced,
wrong-environment, and malformed-field goldens in both suites for each ID.
Protected-lanes enforcement in the same commit: preference knobs exist
(verbosity, ordering, cadence) and are tested to be *incapable* of
suppressing the protected classes — a test attempts suppression via every
preference path and asserts visibility survives.

### M27.8 — Epistemic Status surface (skeleton)
One coherent home (§35 skeleton): what changed (M26 convergence) · coverage
gaps · contradictions · stale understanding · needs review (M24 HIGH/CRITICAL
queue) · system/budget health (M25). Consolidates what M25–M27 would
otherwise ship as scattered banners; grows into §35's full project view
later (M28+ trigger registry). Playwright specs against mock fixtures.

### M27.9 — Eval fixtures (the M27 slice)
Missed contradiction (genuine conflict must edge + lane) · false
contradiction (stage lag must NOT) · pinned/swapped endpoint IDs · semantic
classification rejected without and labeled agent-supplied with an applied
`classify_conflict` proposal · migrated unsupported endpoints + migration
reason codes + backfill idempotence/activation ordering · merge/supersede over
an unclassified legacy `contradicts` relation refused · M26 self-ancestry
prevention re-proven · repetition non-reinforcement (four copies = one family)
· unsupported Support · direct-artifact and responsible-owner authority scoped
to predicate/stage · multi/unknown facets · exhaustive Coverage folds ·
stale+contested coexistence · the named "stale truth" golden scenario (§37) ·
freshness event at
the boundary plus byte-identical replay a week later · every critical trigger
and boundary case · circular support · duplicated lineage family ·
descendant-only reinforcement · protected-lane suppression attempts.

## Acceptance matrix

| Scenario | Must hold |
| --- | --- |
| lead/main/BOM stage fixture | zero contradiction edges; three coexisting stage-scoped beliefs |
| genuine direct conflict | edge created; lane surfaces it; merge refused until addressed |
| migrated `contradicts` relations | reclassified once; gate/lanes wait for covering backfill marker |
| unclassified legacy `contradicts` relation | merge/supersede over its belief refused; visible in the contradiction lane tagged legacy-unclassified until classified |
| semantic same-meaning decision | applied `classify_conflict`; evidence-linked and labeled agent-supplied |
| no admissible support | `Support.level = unsupported`, without implying false |
| four copies of one message | Support remains `single_source` (one family) |
| responsible owner for another stage | not authoritative for this predicate/stage |
| matching direct production artifact | may satisfy the exact predicate/stage authority route without human authorship |
| multi-predicate/stage revision | separate facet rows; no arbitrary canonical scope |
| Coverage boundary table | hard access `no` → blind; all yes/N/A → observed; every other valid combination → partial |
| attestation on AI-derived belief | separate ReviewStatus (plus only policy-authorized freshness); Support untouched because M22 forbids lineage entry |
| no lineage info between two sources | independence_unknown; not counted as corroboration |
| stale belief with open contradiction | stale + contested + active represented together |
| replay after wall-clock advance | same bytes; freshness changes only through transition events |
| preference set to minimum verbosity | blindness/contradiction/critical still visible |
| expired/72h cert fixtures | exact artifact triggers/boundaries fire with no Risk object |
| chips over migrated demo-vault | explicit unsupported basis remains `Support: unsupported`; review attestation renders separately as r3/r5, never as authoritative Support; e2e assertions updated deliberately |
| activated M26 convergence sections | chip-gated certainty-shift/contestation sections activate and render Support/Validity deltas |
| archived or tombstoned belief | exact lifecycle value survives alongside historical freshness/conflict state |

## Traps

- **e2e/demo-vault coupling peaks here** — chip and lane copy is asserted
  literally; every changed assertion is named in the commit message body.
- **No twin logic**: freshness rules, the Coverage fold/precedence table, gate
  conditions, bypass triggers, and
  lane definitions are data artifacts with goldens on both suites. Reducers
  may not call `now()`; explicit `effective_at`/`as_of` inputs are mandatory.
- **Lane ranking is Rust** (D6): the LLM never orders attention.
- Dismissals exist (M8) and remain per-item; they must not become a
  preference path that suppresses a protected class.
- Language discipline in every surface string: "agent-supplied," "stage
  lag," "independence unknown" — honest words are spec compliance.
- Gates: `pnpm test:run`, full Rust gate, `PORT=5273 pnpm e2e`, never
  `--no-verify`.

## Exit criteria

A contradicted belief cannot be silently merged · migrated contradictions are
reclassified before enforcement · semantic classifications are proposal-
gated and labeled · repetition does not strengthen anything · Support covers
unsupported through route-matched human/direct-artifact authority per facet ·
Coverage summary is deterministic · tagged declared-relation endpoints preserve legacy
relations without fabricated assertions · stale+contested is
representable · freshness replay is clock-independent · stage lag coexists
without alarms · both enumerated critical signals surface without a Risk
object · protected lanes are unsuppressable · Epistemic Status skeleton live ·
eval fixtures landed · full gates green.
