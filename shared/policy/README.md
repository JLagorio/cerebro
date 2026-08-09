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
| `goldens/*.json` | Proposal + preconditions → expected verdict + destiny. Replayed by `cargo test` and `pnpm test:run` from these same files. |

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

## What is deliberately NOT here yet

`self_ancestry` is registered in the destiny registry (so the registry is
closed from birth) but has no binding predicate: M26 adds `no_self_ancestry` to
the same versioned schema. `conflict_classification` and `contradiction_edges`
are declared unavailable until M27 ships their bodies, reducers, and vectors —
the ops are typed-unavailable rather than emitting an unnamed mutation.
