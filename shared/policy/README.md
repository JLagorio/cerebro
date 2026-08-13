# `shared/policy/` — mutation governance as data (M24)

These files are **the** policy. Rust compiles them in with `include_str!`
(`src-tauri/src/policy/`); TypeScript imports the identical files through vite
(`src/lib/policy/`). Neither language holds a rule the other has to be trusted
to have copied correctly.

**The house rule: a policy rule implemented as twin Rust and TS code is a
review-blocking defect.** If a rule cannot be expressed in the table, the table
format grows. Parity is the shared artifact plus the shared goldens — never
review of two hand-mirrored implementations. (Escape hatch if interpreter drift
ever appears: compile the Rust policy crate to WASM for the mock. Not
preemptively.)

## The files

| File | What it is |
| --- | --- |
| `policy.v3.json` | **The table** (`format: 3`, M27.4): target classes, predicates, transitions, rejection destinies, escalators, capability gates, silence/absence/high-stakes/preventive-ancestry/contradiction-addressing rules, the risk ladder, and one row per op. |
| `policy.v3.sha256` | SHA-256 of `policy.v3.json`'s bytes. Rust and TS each hash what they loaded and compare against this file — the only way two processes in two languages assert the *same* bytes rather than each asserting self-consistency. |
| `policy.v2.json` + `.sha256` | **Frozen** (`format: 2`, M26). The negative control for M27.4's contradiction-preservation gate: a table that parses cleanly, binds `open_contradictions_addressed` to the same five ops, and simply predates `contradiction_edges` being available. Registration against it refuses BY NAME. |
| `policy.v1.json` + `.sha256` | **Frozen** (`format: 1`, M24–M25). Not history for its own sake: it is the negative control for M26.3's live-registration gate — a table that parses cleanly and simply predates `no_self_ancestry`. All loaders still read it, and nothing edits it. |
| `authority-routes.v1.json` | The current predicate- and stage-specific authority routes (D11). |
| `authority-routes/<hash>.json` | Immutable content-addressed snapshots. A queued proposal pins `(route_id, rule_version, artifact_hash)`, so an approval tomorrow is evaluated against the rule the agent was actually shown. |
| `independence-rules.v1.json` + `.sha256` | The two deterministic positive-independence predicates (M25.5), loaded by `src-tauri/src/ingest/independence.rs`. `rule_version` is bumped by ANY predicate change and pinned into every event the producer emits. |
| `goldens/*.json` | Proposal + preconditions → expected verdict + destiny. Replayed by `cargo test` and `pnpm test:run` from these same files. A fixture may declare `signals` (server-derived escalators), `versions` (`"<class>/<id>": n`, the M22 `state_versions` its expected-version CAS runs against), `ancestry` (the support graph M26.3's preventive walk runs over), and `table` (a FROZEN table to replay against — `"v1"` or `"v2"` — for a refusal the shipped table can no longer produce; M27.4 made every shipped capability available, so `capability_unavailable` lives on against v2 rather than losing its shared fixture). Declaring either state field requires `rust_only: true` — both read reducer state that is out of the mock's scope by declaration, so the TS runner skips the *verdict replay* loudly rather than the directory quietly missing the case. It still asserts the artifact half of every such file: that the op declares the code possible, and that the code declares a destiny. |

The whole directory is `.prettierignore`d: the bytes are hashed, and a
formatter that reflowed them would break the anchor.

## Regenerating

Both are deliberate acts, so both are `#[ignore]`d tests rather than something
the suite does on its own:

```sh
cd src-tauri
# after ANY edit to policy.v3.json
cargo test --lib policy::table::tests::write_policy_digest -- --ignored
# after an edit to authority-routes.v1.json (bump artifact_version and every
# changed route's authority_rule_version first; the prior snapshot stays)
cargo test --lib policy::authority::tests::write_authority_snapshot -- --ignored
```

A new snapshot must also be added to `RESOLVABLE_ARTIFACTS` in
`src-tauri/src/policy/authority.rs`, or `snapshots_on_disk_are_all_compiled_in`
fails — a snapshot no build can read is a rule a proposal can pin and nothing
can evaluate.

## Ordering is canonical, not cosmetic

Every closed list is non-empty, duplicate-free, and in canonical order, because
two artifacts that mean the same thing must not be able to differ.

- In `policy.v3.json`, canonical means **sorted**. `unbound_rejections` is the
  one list allowed to be *empty*, and format 2 emptied it (see below).
- In `authority-routes.v1.json`, canonical means the **enum declaration order**
  the M22 schema fixes: `planned … shipping` reads as reality moving forward,
  `project_owner … unknown` as authority descending. Load reports the expected
  order when it refuses.

`evaluation_order` is the exception — it *is* an order. Precedence between
refusals is policy ("does an unavailable capability outrank an understated
risk?"), so it lives in the artifact rather than in whichever `if` happens to
come first in each language.

## Judgment calls recorded here

- **`thresholds.lineage_fan_in_high = 5`.** The design fixes the *mechanism*
  (fan-in above a named threshold floors risk at HIGH) and leaves the number
  open. Five is the line at which a belief is load-bearing enough that editing
  it deserves a person's eyes. It is data precisely so it can be retuned
  without touching either interpreter — but retuning it changes what
  auto-applies, so move it deliberately and re-run the goldens.
- **`silence.allowed_transitions` is an allowlist**, not a forbidden list, so a
  transition added in a later milestone is forbidden under silence *by default*.
  "Quiet for 30 days → probably resolved" is the easiest regression a future
  maintenance pass can introduce; the safe direction is the one where
  forgetting to think about it refuses.
- **Operational vs ledger destiny.** `capability_unavailable` is operational:
  an agent asking for something this build cannot do yet is not epistemic
  history. When in doubt the answer is operational — promoting a code into the
  ledger requires a coverage-materiality argument in review, because the
  alternative is an append-only ledger that fills with "Claude forgot a
  required field 92,000 times."

- **`lineage_fan_in` counts INCOMING live relations.** The design fixes the
  mechanism and leaves the measure to the server. Incoming edges are the ones
  a reader actually follows, so they are what "much depends on this" means;
  outgoing edges are the record's own claims about others and say nothing
  about who would be surprised by a change. Written once, in
  `policy/interpreter.rs`.
- **Precondition precedence is the op's `requires` order.** Which
  state-dependent predicates run, and in what order, comes off the table row
  rather than out of whichever `if` an interpreter writes first — the same
  reasoning that put `evaluation_order` in the artifact. `requires` is sorted,
  so "sorted" is the declared precedence until someone has a reason to make it
  something else.
- **A predicate the table requires and nothing evaluates is a rule that looks
  like protection.** `PREDICATE_OWNERS` in `policy/preconditions.rs` names
  every predicate and the phase that implements it, and a tripwire proves that
  list and the table's `predicates` are the same set. Gaps are written down,
  not inferred from a missing branch.

- **A qualification profile's required roles come off the TYPE DOC, never off
  the proposal.** The proposal carries a `QualificationProfileRef`, but it is a
  claim: the server derives the real profile from the type doc at the current
  head and refuses `policy_precondition_stale` unless the two agree exactly.
  Trusting the submitted `required_roles` would let a proposal name a weaker
  gate than the one that exists, and the ledger event would then record a rule
  nobody applied. Implemented once, in `policy/qualification.rs`.
- **`type_schema_hash` covers the role assignment, not the whole type doc.**
  The pin exists so a type-doc edit cannot retroactively re-decide a promotion,
  which means it must cover which field carries which role — and nothing else.
  Hashing the whole doc would make recolouring a status option invalidate every
  promotion in flight, and a gate that cries stale for cosmetic edits is one
  people learn to route around.
- **An unknown `role:` annotation refuses rather than being ignored.**
  `role: onwer` silently reading as "no role here" is the worst outcome
  available: the type doc still *looks* like it protects something. The gate
  fails closed for that type and names the annotation.
- **Parked promotions are operational.** Every column is recomputable from the
  vault's records plus the type docs, so by the standing when-in-doubt rule the
  worklist lives in `runtime.db`, not the ledger. The refusal itself is
  ledger-destined — "this item is not ready" is epistemic history; "here is the
  worklist" is a cache.
- **A refusal names the predicate that refused.** `Rejection.rule` takes the
  failing predicate's own name (a `RuleCode` may be a predicate) instead of the
  code→rule fallback, so a card says `qualification_roles_present` rather than
  `commit_set`. The fallback remains for table-decidable refusals, which have
  no predicate to name.

- **A candidate receipt's id digests the SEARCH, never the dispositions.**
  What the server found is the server's and is sealed; what it means
  (`update | qualify | distinct`) is the proposer's and must stay free to
  change. An id covering the judgement could not survive a proposer
  disagreeing with a default, and one covering less than the legs would let a
  fabricated search wear a real one's id. It is also what makes
  `candidate_unconsidered` distinguishable from
  `candidate_receipt_caller_authored`: stripping the judgement leaves the
  search intact.
- **`candidate_receipt_missing` and `candidate_unconsidered` are POLICY
  refusals, not schema errors.** Both were checked in
  `ledger/schema/proposal.rs` until M24.7 and therefore surfaced as
  `schema_invalid` — operational — which put "the agent created without
  searching" in the log with the typos instead of in the epistemic record.
  The schema layer checks a receipt's SHAPE; the policy layer checks it
  against the world. A create with no receipt now becomes a durable proposal
  and is refused in the ledger, because a ledger refusal needs a proposal to
  point at.
- **The scoped/temporal leg is "every live Belief about this subject."**
  Tombstoned ones are excluded — they are not something a create could have
  been an update to — but superseded and archived ones are not: "there is
  already a retired belief about this" is exactly the context a reviewer
  wants. `scope` and `valid_interval` stay empty because a create's payload
  carries no scope to search within; writing a guess would make the receipt
  claim a narrower search than it ran.
- **The receipt rules have no goldens.** They are decided against reducer
  state and a vault index, which the mock has no counterpart for — the same
  boundary the CAS fixtures declared with `rust_only`. Unlike CAS there is no
  TS-side receipt validation at all to drift from, so the honest artifact is
  the Rust test set, not a fixture the mock would skip.

- **The high-stakes rule's queue is a VERDICT, its refusals are
  preconditions.** `high_stakes_route_satisfied` is the one rule with three
  outcomes, and the table fixes which shape gets which: absent or
  insufficient coverage/authority queues with `queue_rejection`, a malformed
  reference rejects with `malformed_rejection`, a resolved-then-moved one
  rejects with `stale_rejection`. The refusals run in `preconditions::check`
  like every other predicate; the queue is applied where verdicts are
  decided, so "structurally valid but unverified" cannot become a rejection
  at one call site and a queue at another.
- **`proposal.queued` carries `queued_for`.** A card that cannot say why it
  is waiting is a card nobody can act on, and the answer is not recomputable
  — the world moves, and "why was this queued" is a question about the world
  as it was. Effective risk alone does not carry it either: a HIGH card from
  lineage fan-in and a MEDIUM card held by the stopping rule ask a human for
  different things.
- **Unverifiable is not verified.** Route criteria are matched over what the
  reducer exposes today (observation kind, authority capability, assertion
  basis, source registration kind). A criterion that also demands a
  relationship ROLE, a cached artifact hash, or a raw pointer cannot be
  settled until M25 registers those, so it does not match and the proposal
  queues. The opposite default would make the rule decorative in exactly the
  cases it exists for.
- **`coverage_assessments` ships empty on purpose.** M24.8's rules are
  written and tested against the real M25 record shape rather than a
  `todo!()`, which is what makes "no coverage" a resolvable question. For the
  whole of M24 the map is empty, so every high-stakes proposal queues — the
  behaviour the spec asks for, arrived at by the rule rather than by a
  special case.

- **The REDUCER does not load `independence-rules.v1.json`.** It validates
  that a proof carries a non-empty `rule_version` and nothing more. Making
  reducer validation depend on the artifact's CONTENTS would make every
  conformance vector's expected refusals artifact-version-dependent, so a
  rule-version bump would rewrite the parity contract for reasons that have
  nothing to do with parity. The artifact governs PRODUCTION; the vectors
  govern agreement. This is the one place a shared artifact is deliberately
  read by one side only, and it is why.
- **A missing independence domain is unknown, not "probably different".**
  Both distinctness predicates require the field present on BOTH endpoints
  and different. Two exports of one upstream system are two files and one
  observation; letting an absent domain pass would let a copy vouch for its
  original, which is the failure independence exists to prevent.
- **`human_confirmed` stays refused, for a new reason.** M22 wrote "reserved
  until M24 ships"; M24 shipped. What makes the proof true is that a specific
  HIGH proposal was APPROVED by a person, and that is reducer state rather
  than body shape — so the body-level validator refuses it and says why,
  rather than accepting two ids as evidence that somebody agreed.

- **The absence rule's required dimensions stayed at five.** M25.4 gave
  assessments all seven dimensions, and the table still requires
  `index_current, retention_known, retrieval_attempted, scope_accessible,
  scope_known` for a formal absence claim. Connection and health are about
  whether the source could be reached AT ALL, which the other five already
  fail without; adding them would refuse absence claims that are genuinely
  complete. What DID change is the meaning of "established": a dimension
  counts only when it says `yes`, because `unknown` is an answer and it is
  not "we checked and it holds".

## Format 2 — the preventive anti-self-ancestry binding (M26.3)

- **`no_self_ancestry` binds to exactly the two ops that carry a
  `BeliefBasis`** — `create_belief` and `update_belief`. Those are the only
  payloads that can introduce a support Observation, so they are the only ones
  the walk can ever refuse. Binding it to `split_belief` or
  `merge_beliefs_exact` would read as broader protection and provide none:
  those redistribute evidence a Belief already rests on. `ancestry.rs`'s
  `basis_target` is an exhaustive match with no wildcard arm, so an op variant
  added later that *does* carry a basis cannot reach the table without the
  compiler asking about this list first.
- **Which ops run the gate is DATA, in a `preventive_ancestry` block.** The
  walk is code — it reads reducer state — but "an op that changes what a
  Belief rests on must run it" is a policy statement, and one hand-listed
  inside the registration gate would be the second inventory the parity rules
  forbid. The block is shaped like `contradiction_addressing`, and load proves
  the three facts agree in both directions: every listed op `requires` the
  predicate and declares the rejection, and no unlisted op requires it. So "is
  the gate bound?" is one question with one answer.
- **Format 2 without the block fails the load.** A version bump whose whole
  content is optional would let a v2 table look modern and gate nothing.
- **`unbound_rejections` may now be empty, and is.** It names the codes
  registered in the destiny registry that no op can yet produce; format 2
  bound the last one. Refusing an empty list would mean keeping a fake
  reservation alive to satisfy a validator.
- **Both loaders read formats 1 *and* 2.** v1 is not kept for nostalgia: it is
  the negative control proving M26.3's registration gate refuses for the right
  reason. Pointed at v1, `ancestry::table_binding` must fail on the *absent
  binding*, not on an unknown code — the wrong-reason failure would evaporate
  the day somebody registered the code without wiring the walk. A hand-written
  stub could not prove that, because a stub is written by whoever wants the
  test to pass.
- **The self-ancestry goldens are `rust_only`, and that is not a gap.** The
  walk reads reducer state the mock has no counterpart for, so only Rust
  replays the verdict. What the TS runner still asserts over those files is
  the half parity is actually about: that the shared table declares
  `self_ancestry` possible for the ops that produce it, and routes it to the
  ledger. The fixtures pin the BINDING; the walk's own five vectors (direct,
  transitive, old-revision, cycle, unrelated control) live in `ancestry.rs`,
  where the graph can be built in code.

## Mint-time refusals (M26.2)

- **`mint_rejections` is a fourth registry beside transport and writer**, and
  it exists because `semantic_search_unavailable` fails at a fourth place. A
  transport code fails on the wire; a writer code fails at the ledger; an op's
  `possible_rejections` fail during policy evaluation. This one fails while
  the server is MINTING a candidate-search receipt — before any proposal
  exists — so no op may list it, and load enforces that alongside the other
  three.
- **Its destiny is operational, and that is not the timid default.** No
  proposal was ever built, so there is nothing for a ledger entry to point at.
  This is the same reasoning M24.7 applied in the other direction when it
  moved `candidate_receipt_missing` INTO the ledger: a create that reached the
  proposal stage without a receipt is epistemic history, and a create that
  never got that far is a capability gap.
- **The receipt this build mints is `search_version: 3`, and the design says
  2.** The design assumed M24 shipped v1; M24.7 had already bumped to 2 when
  it made the three deterministic legs real. Reusing 2 would leave an M24.7
  receipt (`semantic: not_available`) and an M26.2 receipt
  (`semantic: completed`) claiming the same version, and telling those apart
  is the version's only job.

## The live agent surface (M26.3c)

- **`agent_facing` defaults to TRUE, and the artifact says only where it is
  false.** A new op is offered to agents unless somebody argues otherwise,
  which is the right default for a table whose whole job is governing agent
  mutations — an op quietly excluded by omission would be a capability nobody
  could find the reasoning for. `revert_proposal` is the one false: it is
  MEDIUM, MEDIUM auto-applies, and an agent-facing revert would undo an
  applied mutation including one a human just approved, with no second card.
- **The live tool names are generated from this file.** `mcp.rs` builds one
  `propose_<op>` per agent-facing op; nothing types the list a second time.
  The `propose_` prefix keeps the namespace injective against the twelve
  hand-written tools — `cache_source` is both a tool and an op — and
  `the_live_proposal_inventory_is_the_policy_inventory` proves the served
  surface and this artifact agree in both directions.
- **Registration is gated on the safety machinery being BOUND here.** The
  server refuses to build any proposal tool unless `preventive_ancestry` binds
  the walk and `create_belief` still requires `candidate_receipt_current` and
  declares its four receipt codes. Editing either of those out of this file
  does not quietly widen the surface; it closes it.

## What is deliberately NOT here yet

`conflict_classification` and `contradiction_edges` are declared unavailable
until M27 ships their bodies, reducers, and vectors — the ops are
typed-unavailable rather than emitting an unnamed mutation.

The proposal tools are still absent from the live and mock MCP servers. The
gate above landed first ON PURPOSE: a predicate the table requires and nothing
evaluates is a rule that looks like protection, so the walk (M26.3a) shipped
with nothing depending on it, the binding (M26.3b) second, and registration —
which must also carry M26.2's semantic-receipt-v2 validator — last.
