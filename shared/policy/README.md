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
| `policy.v1.json` | The table: target classes, predicates, transitions, rejection destinies, escalators, capability gates, silence/absence/high-stakes rules, the risk ladder, and one row per op. |
| `policy.v1.sha256` | SHA-256 of `policy.v1.json`'s bytes. Rust and TS each hash what they loaded and compare against this file — the only way two processes in two languages assert the *same* bytes rather than each asserting self-consistency. |
| `authority-routes.v1.json` | The current predicate- and stage-specific authority routes (D11). |
| `authority-routes/<hash>.json` | Immutable content-addressed snapshots. A queued proposal pins `(route_id, rule_version, artifact_hash)`, so an approval tomorrow is evaluated against the rule the agent was actually shown. |
| `goldens/*.json` | Proposal + preconditions → expected verdict + destiny. Replayed by `cargo test` and `pnpm test:run` from these same files. A fixture may declare `signals` (server-derived escalators) and `versions` (`"<class>/<id>": n`, the M22 `state_versions` its expected-version CAS runs against). Declaring `versions` requires `rust_only: true` — CAS is out of the mock's scope by declaration, so the TS runner skips it loudly rather than the directory quietly missing the case. |

The whole directory is `.prettierignore`d: the bytes are hashed, and a
formatter that reflowed them would break the anchor.

## Regenerating

Both are deliberate acts, so both are `#[ignore]`d tests rather than something
the suite does on its own:

```sh
cd src-tauri
# after ANY edit to policy.v1.json
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

- In `policy.v1.json`, canonical means **sorted**.
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

## What is deliberately NOT here yet

`self_ancestry` is registered in the destiny registry (so the registry is
closed from birth) but has no binding predicate: M26 adds `no_self_ancestry` to
the same versioned schema. `conflict_classification` and `contradiction_edges`
are declared unavailable until M27 ships their bodies, reducers, and vectors —
the ops are typed-unavailable rather than emitting an unnamed mutation.
