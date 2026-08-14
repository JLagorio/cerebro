# M24 — Policy as data: risk classes, versions, typed rejections

**Brief for the agent picking this up cold.** Written 2026-08-07. Read the
master roadmap D5, D10, D11 and matrix rows §15, §18–§19, §28, §47, §52–§53,
§71, §94, §10 first, then the M22 schema doc (the objects policy governs) and
M23 (the one hard-coded auto-apply decision this milestone replaces with a
table). M24 builds the entire mutation-governance skeleton **with agents
OFF** — synthetic proposals exercise everything.

**The core bet: policy is data, not code.** One declarative table loaded by
Rust and imported verbatim by the TS mock. Hand-mirrored policy logic WILL
drift — the project already parses mcp.rs from a TS test to hold a 12-tool
parity, and that does not scale. If a rule cannot be expressed in the table,
the table format grows; a rule implemented as twin code in two languages is a
review-blocking defect. Escape hatch if interpreter drift ever appears:
compile the Rust policy crate to WASM for the mock — do not preemptively.

---

## Where things stand (verify at start — refs drift)

- M23 landed: knowledge/ is projection-first; write_concept auto-applies via
  a hard-coded LOW decision; verify_concept emits attestations; capture
  valve live; reducer state carries per-entity revisions (M22).
- No expected_version anywhere; no proposal object has ever been emitted;
  rejections today are ad-hoc strings from mcp.rs guards.
- Agents still cannot mutate epistemic state except through the M23
  write_concept path. That stays true throughout M24 mechanically: the new
  proposal tools are NOT registered on the loopback MCP server until M26 —
  in M24 the machinery is exercised through its internal typed boundary and
  tests only. The hidden diagnostic may invoke that boundary, but it is not an
  MCP registration.

## Non-goals (defend these)

- No LLM invocations. No ingest pass, no maintenance pass — M26.
- No metering, no budgets, no runtime-DB scheduler state — M25. (M24 does
  create the runtime DB *file* with two tables — `operational_log` at birth
  (M24.2), `parked_promotions` at M24.6 — because typed rejection noise and
  parked promotions need a home now. M25 owns its growth.)
- No attention lanes, no contradiction machinery — M27. The
  contradiction-preservation *gate* slot exists in the table (op guard
  hook) but fires nothing until M27 populates contradiction edges.
- No polished review UI. M24 does ship the functional minimum: a reducer-
  backed Needs review list, Approve/Reject, stale-card handling, CRITICAL diff,
  and Revert for eligible applied changes. M27 composes it into the richer
  Epistemic Status surface.
- No cross-source verification policies (D10 — needs ≥2 connectors).
  M24's high-stakes rules are single-connector-compatible presence checks.

## Four rules that must survive contact with implementation

**Two records, two destinies (D5).** The epistemic ledger receives: valid
proposals, applied mutations, *meaningful* policy rejections ("agent
attempted to supersede a human-reviewed belief without sufficient
verification" — that is epistemic history and Skeptic food), and human
decisions. The **operational log** (runtime DB) receives: schema mistakes
(`confidence: "banana"`), malformed MCP arguments, CAS races during internal
retries, timeouts, quota failures. Every rejection code declares its destiny
in the table. Otherwise the append-only ledger becomes "Claude forgot a
required field
92,000 times" — server logs, reinvented.

**Agent-declared risk can only RAISE.** The static table (the shared JSON,
loaded by both engines) assigns base risk per (op, target class); a proposal
may declare higher risk, never lower.
No consensus-of-models is a verification tier anywhere (§94).

**Proposals travel exclusively through the serde-validated proposal
boundary** — the submitProposal channel (D5) — never stdout JSON (agent.rs
silently skips unparseable lines).
M24 keeps that boundary internal and its eventual MCP tools unregistered;
M26 registers them only after semantic candidate search is live and the
preventive graph guards pass their fixtures. Proposals
accumulate server-side and apply through the M22/M23 logical-batch protocol on
a terminal commit call: a run that dies mid-stream exposes no mutations or
projections.

**Silence never resolves.** Elapsed time or absence of new observations may
alter freshness/coverage/attention but may never by itself transition an
unresolved object or belief to resolved/false/superseded. This is a
schema-level policy refusal (class (a) invariant), landed here because
"quiet for 30 days → probably resolved" is the easiest regression a future
maintenance pass can introduce.

---

## The policy table (fixed here)

Location: `shared/policy/policy.v1.json` at repo root — importable by vite
(TS) and `include_str!` (Rust); a test on each side asserts both loaded the
byte-identical artifact. Shape:

    { "format": 1,
      "target_classes": ["observation", "belief", "entity", "relation",
                         "source", "proposal", "comparison"],
      "rejection_destinies": { "<code>": "ledger" | "operational" },
      "thresholds": { "lineage_fan_in_high": <positive integer> },
      "escalators": [
        { "signal": "target_has_attestation", "floor": "HIGH" },
        { "signal": "lineage_fan_in", "above": "lineage_fan_in_high",
          "floor": "HIGH" } ],
      "ops": {
        "<op>": { "target_classes": ["<class>"],
                  "base_risk": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
                  "revert": "one_click" | "none",
                  "allowed_transitions": ["<closed transition code>"],
                  "requires": ["<closed predicate code>"],
                  "possible_rejections": ["<closed code>"] } },
      "risk_ladder": {
        "LOW":      { "apply": "auto",   "journal": true },
        "MEDIUM":   { "apply": "auto",   "journal": true },
        "HIGH":     { "apply": "queued-human-card" },
        "CRITICAL": { "apply": "queued-human-card", "review": "diff" } } }

The companion design freezes every predicate, transition, target class,
rejection code/destiny, per-op possible class set, and nested payload/event
struct. Table load refuses an unknown or incompletely registered value.
Reversibility is per-op: only update, supersede, promotion, relation edit, and
contest store one-click `RevertPlan`s. Alias/conflict correction and every
split/merge/lifecycle/destructive op require a new ordinary proposal.

The same phase ships `shared/policy/authority-routes.v1.json` plus immutable
content-addressed snapshots. Its closed routes pin ID, rule version, artifact
hash, predicate classes, M22 stages, and exact criteria for
`direct_artifact | responsible_owner_firsthand | firsthand_observer`.
Direct routes require a pinned `builtin|connector` registration with
`direct_system_artifact` capability and `registered_direct_artifact`
provenance; human routes require actor-bound `human_actor` registration,
`human_assertion` capability, `trusted_human_capture`, and their explicit
role/basis. Agent-inferred metadata never qualifies. Rust/TS load identical
bytes and changed routes retain their prior snapshots/version.

Op inventory v1 (D5 ladder): `append_observation`, `cache_source`,
`create_belief` (draft), `merge_beliefs_exact` — LOW · `update_belief`,
`supersede_belief`, `promote_draft`, `edit_relation`, `contest_belief`,
`classify_conflict`, `add_entity_alias`, `revert_proposal` on non-human-
reviewed targets — MEDIUM · anything touching a human-reviewed belief,
`correct_observation_subject`, `split_belief`, `tombstone_belief`,
`confirm_observation_independence`, `archive_belief`, `deprecate` — HIGH ·
`merge_entities`, `mass_supersede` — CRITICAL.
`contest_belief` records a contest relation (the attestation escalator floors
it HIGH on human-reviewed targets); its Validity surfacing activates with
M27's contested axis. `classify_conflict` stores M27's structured scope/stage/
temporal/granularity outcome. `archive_belief` is a provenance-preserving
lifecycle transition distinct from tombstone. `merge_beliefs_exact` is LOW
only with a server-minted equivalence receipt and never merges identities;
`merge_entities` is always CRITICAL. `split_belief` is HIGH,
`add_entity_alias` refuses cross-entity collisions, and `revert_proposal` is a
forward inverse with risk floored at MEDIUM, the original risk, and the
inverse op's current risk. All §16 epistemic transitions are accounted for
here; M26 does not introduce an ungoverned op.
`correct_observation_subject` is the HIGH, non-reversible bridge to M22's
tagged subject-resolution correction. It pins the Observation's current
resolution event, from/to existing Entities, resolver tier, basis, and reason;
stale/mismatched correction is typed and the op is unavailable unless M22's
validator/reducer/vectors are present.
`confirm_observation_independence` is likewise HIGH/non-reversible and emits
only M22's `human_confirmed` proof after an actual approving decision; M25 owns
the two versioned deterministic registered-origin proofs.
Deterministic risk escalators, never the agent's own estimate: target has
attestation → floor HIGH; lineage fan-in above threshold → floor HIGH. Both
are the table's `escalators` entries; the fan-in threshold is the named
`thresholds.lineage_fan_in_high` value in policy.v1.json, and each escalator
has a golden.

**Tripwire** in the write_target style (mcp.rs:1362): a test enumerates every
proposal op the code can construct and fails if any is unmapped in the table.

## Frozen Proposal contract

Implement the complete v1 schema from the companion design, not a loose
`op/target/reason` map:

    ProposalV1 {
      schema, proposal_id, run_id,
      targets: [{ target_id, target_class, expected_version }],
      op: { kind, <kind-specific typed payload> },
      intended_use: { kind, stakes, predicate_class },
      basis: { transition_cause, evidence_refs, coverage_refs,
               authority_refs, authority_route_refs,
               addressed_contradictions, absence_claim },
      declared_risk, reason, candidate_search_receipt
    }

The op is a closed serde tagged union for every inventory entry above. No
generic patch/payload can hide a target or transition. `reason` is display
text only: silence, absence, high-stakes, authority, and coverage rules read
the structured fields and referenced records, never prose.

Implement the design's exact `QualificationProfileRef`,
`EquivalenceReceipt`, `EntityReassignmentPlan`, `SplitOutput`,
`RelationRewrite`, `EvidenceAssignment`, `AddressedContradiction`,
`SupersedePair`, and server-stored `RevertPlan` types;
placeholder JSON maps are forbidden. The exact lifecycle mapping is
promotion `draft→qualified`, supersede `active→superseded`, archive/deprecate
`active→archived` with their distinct replacement rules, and tombstone to the
separate non-reversible reducer state.

Rejections bind `code` to the design's closed `RejectionCode`, including
the ledger-destined `self_ancestry` (registered from policy.v1, bound by
M26's `no_self_ancestry` predicate) with its
exact expected `boolean:true` plus target/reached-revision/support-root object,
`rule` to
`RuleCode`, and `expected/actual` to M22 `TypedValue`; each code has one exact
detail shape. Proposal target versions follow the design's effect matrix:
submission creates v1; queue/decision/apply/reject increment the named
proposal; revert increments the original while the new revert proposal follows
its own submit/apply sequence.

Target classes are the closed set `observation | belief | entity | relation |
source | proposal | comparison`, backed by M22's reducer-owned version
registry. `create_belief` and `update_belief` payloads carry the full M22
BeliefBasis. An update patch may be empty only when that basis changes, making
independent corroboration without a field diff a canonical support-only
revision. `classify_conflict` names M26/M27's `comparison_id`, never a separate
`conflict_id`.

The exact target-class matrix from the design is executable policy. In
particular, append/create includes an Entity target when an unseen resolved
subject will exercise M22's create-on-first-reference effect (`expected_version:
null`, or the current version when it exists); cache_source has subject `none`.
Tombstone has its own closed `reason_code` payload, separate from exact archive
and deprecate transition payloads.
Subject correction requires Observation + from/to Entity targets at current
versions and maps exactly to M22 `change.action: correct`.
Alias payloads retain the display spelling, but the server computes M22's
Unicode-15.1 `normalize_alias_v1(alias)` and emits/compares that canonical key;
callers cannot supply a competing normalization. `edit_relation` validates,
and supersede derives, M22's lowercase hex128 relation ID: the first 128 bits
of `SHA-256("cerebro-relation-v1\0" + canonical_json([from, to, relation]))`.

Agent append DTOs cannot select source/registration/provenance, human
assertions, source snapshots, system events, relationship role, or assertion
basis. The server binds M22 `source.registered` and canonicalizes agent content
as `agent_inferred`; only M23 trusted capture and M25 trusted ingestion can
construct privileged human/direct-artifact bodies. Mismatches receive
`untrusted_provenance` and goldens cover every attempted escalation.

Classification targets the comparison, both derived endpoint Beliefs, and all
basis Observations; resolved classification advances only comparison, while
unresolved classification+open advances comparison twice and each endpoint
once. `edit_relation(add, contradicts)` additionally registers an unseen
comparison, then classifies/opens it under M27's declared-relation rule;
ordinary/remove relations do not. Split/merge/supersede basis carries the exact
complete `addressed_contradictions` set. Final application re-queries every
incident open edge, includes comparison/endpoints/evidence in CAS targets, and
batches mutation plus sorted `contradiction.closed` members; omitted/new/stale
edges are typed refusals.

The design's complex member plans are normative: successor/refinement
relations point replacement `from` → replaced predecessor `to`; exact merge
uses its server-minted merged basis and relation rewrite plan; split creates
sorted outputs, refines them to the predecessor, then supersedes it with the
declared primary output; mass supersede sorts pairs; entity merge is one
complete enumerated effect; revert executes symbolic stored steps and binds
future event IDs only at application. Member order, target set, and symbolic
operation digest are fixed, not interpreter discretion.

Creates require a server-minted, chain-head-bound candidate receipt covering
deterministic exact-identity, explicit-alias, and scoped/temporal lookups plus
the disposition of every candidate. Its semantic leg is explicitly
`not_available` in M24. M26 implements and requires an attempted semantic leg
before it registers proposal tools. `write_concept` receives no new public
argument; the server enriches its internal proposal.

Proposal lifecycle is portable reducer state, not runtime cache:
`submitted | queued | rejected | applied | reverted`, derived from complete
`proposal.submitted`, `proposal.queued`, `proposal.decision_recorded`,
`proposal.rejected`, `proposal.applied`, and `proposal.reverted` event bodies
defined in the design. Human approval and rejection are both durable;
approval never bypasses a fresh CAS check.

The canonical mutation mapping in the design is part of this frozen contract.
M24 defines qualification, lifecycle, contest, tombstone, and entity-merge
bodies and maps every op to those or to exact M22 events. The semantic
`classify_conflict` mapping remains typed but returns `capability_unavailable`
until M27 supplies its classification expansion: `conflict.classified` plus a
same-batch `contradiction.opened` member for unresolved outcomes. No interpreter
branch may emit an unnamed mutation kind.

Their version effects are equally closed: qualification, lifecycle,
tombstone, and contest each increment the named Belief once; lifecycle's
companion relation event advances that Relation separately. Entity merge
increments survivor plus every merged Entity once and every Belief/Relation
enumerated by its validated reassignment plan once. Alias events in the plan
are read-only provenance, not repeated survivor increments. The merge's
top-level CAS targets must exactly equal those write effects.

Before emission, bump M23's projection manifest to format 2 and extend each
Belief descriptor with qualification, lifecycle, tombstone, contest, and
applicable entity-merge event heads. Migration recomputes from the ledger via
manifest-first recovery; every state-only advance changes descriptor digest/
generating head even when bytes do not change.

## Phases

One commit per phase, `type(scope): sentence (M24.n)`.

### M24.1 — The table, before any engine
`shared/policy/policy.v1.json` + loaders on both sides + byte-identity test +
the tripwire + **golden proposal→verdict fixtures** (`shared/policy/
goldens/*.json`: proposal + state preconditions → expected verdict + destiny)
run by both suites. The fixtures exist before the Rust interpreter so the
table's semantics are settled as data first (roadmap M24 item 1, verbatim).

### M24.2 — Typed rejections + the operational log
`Rejection { code, rule, expected, actual }` as a serde type; the runtime DB
is born: `<app-data>/runtime.db` (rusqlite, same bundled feature), one table
`operational_log`, initialized transactionally at `PRAGMA user_version = 1`.
Every refusal path in mcp.rs/knowledge.rs that governs the
epistemic plane converts from ad-hoc strings to typed codes with a declared
destiny. AGENTS.md amendment in the same commit: the store-layer never-throw
invariant is re-scoped to human-UI actions; proposal channels return typed
results.

### M24.3 — Complete Proposal types + internal submit boundary
Implement the frozen schema and every discriminated op payload before an
interpreter can accept proposals. Validation requires stable `proposal_id`,
`run_id`, the complete target/version set, intended use, structured basis,
evidence/coverage/authority references, declared risk, and reason. Extend the
M22 conformance vectors for every complete `proposal.*` and M24 mutation event
body, every legal/refused lifecycle transition, basis-only revision, relation
removal, entity merge, subject-resolution correction, every proposal-class
and M24-mutation version effect, and every closed nested payload/RevertPlan/rejection-detail
variant. The
internal typed submit boundary returns
`applied | queued | rejected`; no proposal/commit MCP tool is registered in
the live or mock server in M24, and a parity assertion proves that absence.

### M24.4 — Interpreter + logical-batch accumulation
Build the Rust interpreter over the table. Server-side accumulation is keyed
by run; terminal `commit_proposals(run_id, ordered_proposal_ids)` evaluates one
snapshot. Any refused member leaves the entire set unapplied. If one member
requires human review, every member is durably queued under one `commit_set_id`;
LOW/MEDIUM peers are held until all required decisions exist, one rejection
rejects the set. Initial all-member queue, initial refusal, human set rejection,
stale-precondition rejection, and final apply each use one M22 `append_batch`
with a transition-specific operation key; no crash can expose a partial
commit-set state. Accepted mutations are contiguous
members sharing one `batch_id`, and mutation plus `proposal.applied` events are
invisible to reducer state until the valid `batch.committed` marker (ordered
member IDs/count, canonical-member digest, and symbolic operation digest) is
fsynced.
M23 projects only the committed reduced head. Retry equality uses the stable
operation key plus symbolic digest, so fresh physical IDs cannot defeat
idempotency. Kill points before every member,
before the marker, after marker fsync, and before projection/ack for **every set
transition** prove all-or-nothing state and projection recovery. The stable key
is the commit-set ID + transition code + causal decision IDs; acknowledgement-
loss retry returns the existing result and same key/different bytes is refused.

M23's hard-coded write_concept decision is deleted. `write_concept` server-
enriches and routes a typed create/update operation through the interpreter,
which computes risk from the table; its public arguments and response prose
remain unchanged. Policy parity remains table + goldens; the TS side does not
hand-copy interpreter rules.

### M24.5 — expected-version CAS + durable review lifecycle
Check every `targets[]` version against the same reducer snapshot immediately
before append using M22 `state_versions` for every target class. Any mismatch
rejects the whole application. Persist queued,
human decision (approve **and** reject), rejection, application, and reversion
as ledger events; build their reducer state. Approval is authorization only:
recheck CAS at application, turn a changed card into a visible
`stale_target_version` rejection, and offer preparation of an updated proposal.
The same pre-append pass re-runs all policy predicates: it re-resolves evidence/
authority, requires referenced coverage still be current, and repeats candidate
search at the current head. A new candidate or superseded assessment rejects
the whole immutable set rather than silently refreshing it.
CAS/logical-batch behavior is Rust-only by declaration; goldens mark those
cases Rust-only instead of faking it in mockIpc.

### M24.6 — Qualification gates as capability profiles
Type-doc field **role annotations** (`role: failure_condition`,
`role: impact`, `role: evidence`, `role: trigger`,
`role: completion_condition`, `role: owner`, `role: verb`) — capability-gated,
type-name-blind (the house no-type-special-casing rule extended to policy).
Promotion ops check presence of required roles; unqualified items **park
visibly** (a persisted parked state the M27 debt lane will feed on), never
blocking a human sketching a rough note. Parked state is operational, not
ledger — recomputable from vault records plus qualification profiles (the
when-in-doubt rule): this phase adds the runtime-DB `parked_promotions` table
(store/vault ID, target record ref, qualification profile ref, missing role
fields, `as_of`, `cleared_at`), written on promotion refusal, cleared when
qualification passes, queryable as the M27 epistemic-debt lane feed.

### M24.7 — Deterministic creation qualification (§15)
Before `create_belief`, the server performs exact-identity, explicit-alias,
and scoped/temporal lookup against the current chain head and mints the
candidate receipt. Require a disposition for every candidate and
`distinctness_reason`; reject a missing, stale, caller-authored, or incomplete
receipt with ledger destiny. `write_concept` is server-enriched without an
argument change. Similarity alone never forces a merge; `near_duplicates`
(knowledge.rs:49) remains a backstop. The semantic receipt leg remains
explicitly unavailable here. M26 must implement and require it before its
proposal-tool registration phase; only M24+M26 together satisfy the full
exact→alias→semantic→scoped/temporal path.

### M24.8 — Structured high-stakes, silence, and absence rules
Implement two class-(a) table rules exclusively over typed fields and refs.
For HIGH/CRITICAL `intended_use.stakes`, resolve `basis.coverage_refs`,
`basis.evidence_refs`, and `basis.authority_refs`; missing required coverage
dimensions or the predicate's evidence/authority route prevents auto-apply.
M24 uses fixture-backed typed assessment records; until M25 begins emitting
`coverage.assessed`, a structurally valid missing/insufficient route queues with
`high_stakes_verification_required`; malformed or stale refs reject. There is
no implementation-selectable “queue or reject” branch.
For transition cause `elapsed_time` or `absence_of_observations`, allow only
freshness/coverage/attention updates; refuse resolve/false/tombstone/supersede.
An absence assertion must set `basis.absence_claim` and reference a current
coverage assessment with the required scope, retention, index, and retrieval
dimensions. Its referenced M22 absence Observation must agree with the
assessment receipt's canonical subject/domain/scope/window/query fields; M25
persists the exact four comparison strings. The Proposal's typed evidence and
coverage references provide the join. `reason` prose has no policy effect.

### M24.9 — Minimal review/revert UI + eval fixtures
Ship a reducer-backed Needs review list showing operation, target versions,
effective risk, intended use, structured basis, evidence/coverage links, and
CRITICAL diff. Approve and Reject append durable decisions; rejection requires
a reason. Only applications whose rule is `revert: one_click` and whose
`proposal.applied` stores a `RevertPlan` expose Revert. The UI submits applied
event IDs/current versions; the server loads the plan and appends a new forward
mutation plus `proposal.reverted`. Non-invertible ops render no button and
return `revert_not_supported` if called directly. History is never rewound.

The eval suite ships WITH the mechanism (standing risk): golden scenarios as
regression tests — false creation (blocked by M24.7), false merge (CRITICAL
queue, never auto), silence-resolution attempt (rejected), high-stakes
self-certification attempt (rejected), human-reviewed supersede without
verification (rejected, ledgered). These are synthetic event sequences +
proposals, asserted through the real interpreter. Playwright covers queue
survival across reload, approve, reject, stale approval, CRITICAL diff,
one-click forward revert, and unsafe-revert refusal.

## Acceptance matrix

| Scenario | Must hold |
| --- | --- |
| any constructible op | mapped in table (tripwire) |
| unknown/incomplete table or nested payload value | table/schema load refusal before either interpreter runs |
| goldens on both suites | identical verdicts, identical destinies |
| run dies mid-accumulation | zero proposals applied |
| crash before `batch.committed` | incomplete members have zero reducer/projection effect |
| crash during queue or set-wide rejection | prior set state or complete all-member transition; never a partial queue/rejection |
| marker durable, crash before projection/ack | projection recovers; retry returns stored result |
| stale expected_version, including after approval | structured rejection; state untouched; card remains inspectable |
| queued create gains a new candidate / coverage is superseded | whole set rejects at pre-append policy revalidation |
| supersede of attested belief at LOW declared risk | escalated to HIGH, queued |
| mutation of a belief with lineage fan-in above `lineage_fan_in_high` at LOW declared risk | escalated to HIGH, queued |
| create without current server receipt/all candidate dispositions | rejected, ledgered |
| promote an unqualified item | parks visibly: `parked_promotions` row written and surfaced; cleared when roles pass |
| human creates/sketches a rough note | never blocked by a qualification gate (fixture) |
| exact-belief merge vs entity merge | exact proof may auto at LOW; identity merge always CRITICAL |
| support-only corroboration | empty content patch + changed basis creates one revision; total no-op refused |
| mixed-risk atomic set | all queued under one set; no LOW peer applies before required approval |
| alias Unicode variants/collision or split | server normalization is exact; cross-entity normalized alias refused; split queued HIGH or escalated |
| edit/supersede relation identity | caller ID is validated or server ID derived from M22's exact hash preimage; no duplicate tuple identity |
| stale/mismatched subject correction | HIGH op refused; Observation/Entities unchanged |
| proposal lifecycle/revert sequence | proposal-class versions match the closed effect matrix exactly |
| M24 mutation/version sequence | each new event advances only its closed targets; entity merge advances each enumerated Entity/Belief/Relation once |
| "30 days quiet → resolved" proposal | schema-rejected |
| absence claim without coverage record | refused |
| human reject | decision and rejection durable; target untouched |
| eligible revert | new forward mutation linked to original application |
| alias/classification or other non-invertible revert | no UI action; direct call returns `revert_not_supported` |
| unsafe/stale revert | structured refusal; no history removed |
| app reload | queued/applied/reverted state rebuilds from ledger |
| schema-garbage proposal | typed in-session tool error; operational log, NOT ledger |

## Traps

- **Parity drift is the milestone's core risk**: any reviewer seeing policy
  logic written twice (Rust + TS) must block. Table + goldens + vectors only.
- **Telemetry leakage**: every new rejection code declares ledger vs
  operational at design time; when in doubt, operational — promotion into
  the ledger requires a coverage-materiality argument in review.
- **Ledger vocabulary creep**: proposal/rejection event kinds are additive;
  M22's discipline applies unchanged.
- The MCP tool schemas/descriptions are agent-facing prompt surface, but M24
  must not register them early merely to test them. Exercise the internal
  boundary; M26 owns one explicit live+mock registration phase.
- mockIpc may serve fixed review/revert UI fixtures and table verdicts; CAS and
  logical-batch semantics stay Rust-only by declaration, not omission.
- Gates: `pnpm test:run`, full Rust gate, `PORT=5273 pnpm e2e` including the
  new review/revert specs, never `--no-verify`.

## Exit criteria

Synthetic proposals exercise the full logical-batch skeleton with agents OFF
· acceptance matrix green · goldens green on both suites from one shared
artifact · tripwire green · proposal lifecycle and review/revert UI survive
reload · proposal tools remain unregistered · AGENTS.md re-scope and eval
fixtures land · full gates and new e2e specs green.
