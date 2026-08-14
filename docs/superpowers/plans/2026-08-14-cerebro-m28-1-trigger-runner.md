# M28.1 — The runner: gates can actually be asked

**Brief for the agent picking this up cold.** Written 2026-08-14. M28.0 shipped
the whole governance substrate — registry artifact, twin loaders, V11 tables,
read-only evaluators for every measurable gate, evidence-pack validator,
tripwires — and then stopped, deliberately, at a named seam: **no caller runs
any evaluator.** The substrate is a pure function of persisted history that
nothing asks a question. M28.1 closes that seam and nothing else.

**The boundary does not move.** The runner authorizes nothing. It evaluates
measurable gates and records results into the two governance tables through
`runtime::triggers` — the same two tables, the same replay-or-refuse writes.
A fired result still licenses exactly a dated plan doc plus matrix-row update,
never code. The M28.0 tripwires (capability-surface scan, protected-name scan,
no-clock scan) extend to cover the runner's source file; they are not relaxed
anywhere.

## The one design decision: no daemon

Every measurable gate is a pure function of persisted primitives over complete
past days. The primitives accumulate whether or not anyone evaluates —
`assembly_metrics` rows land when assemblies run, `discovery_plan_runs` when
plans emit, `catchup_outcomes` when catch-up resolves. Evaluating at look-time
therefore loses **nothing**: the answer at 9am and the answer at 5pm differ
only when the local day rolled over, and rerunning inside one day is a
byte-identical `Replayed`. A background scheduler would add clock reads,
nondeterminism, and a place for evaluations nobody asked for to pile up — and
would buy no earlier firing, because a gate "fires" with consequence only when
a human reads the result and writes the dated plan.

So: **the runner runs when the status surface opens and when the owner clicks
evaluate.** No cron, no launch hook, no background thread. If a future
milestone wants a nudge ("R13 fired while you were away"), that is a new
decision for that milestone to argue.

## What each evaluator demands (measured from the code, not remembered)

All six share `(conn, registry, scope, evaluated_at, timezone)`; `evaluate_r1`
is subscription-global and takes no scope. Two extras:

- `evaluate_r7` also needs the reduced `EpistemicState` and a **declared**
  `VerificationScope`. The runner must never invent one — a synthesized scope
  is the runner choosing the question it will be measured by. Undeclared scope
  means R7 reports "not evaluated: no verification scope declared", said out
  loud, distinct from `not_ready`.
- R2 is hybrid; its `r2_headroom` leg is pure and its assembly waits for the
  first owner evidence pack (M28.0 seam #2, which this milestone does NOT
  close). The runner reports R2 as `awaiting owner evidence pack`.

Clock and timezone are read at the Tauri shell exactly as M25 budget does:
`chrono::Utc::now()` in the `lib.rs` command, `runtime::budget::system_timezone()`
for the IANA zone. The runner itself takes both as parameters and carries its
own `nothing_here_reads_a_clock` scan, same as every trigger file.

## Sub-phases

### M28.1a — what the first caller found (two M28.0 defects, fixed first)

Running two gates against one database — the runner's very first pass —
surfaced two collisions the no-caller seam had been hiding:

1. **The snapshot id hashed only the payload bytes**, but the stored row
   carries `registry_id`. R3 and R6 over an empty store collect
   byte-identical payloads, so the second gate's put refused as an amended
   snapshot. The same collision recurs for one gate across two quiet days
   (same bytes, different window). Fix: the snapshot id hashes gate key,
   scope, rule version, and window alongside the payload — the id names the
   question, not only the bytes.
2. **A later ask of an answered question refused instead of replaying.** The
   evaluation id deliberately hashes inputs, not the instant of asking, but
   the record carries `evaluated_at` — so a 9am ask followed by a 5pm ask of
   the same window differed in exactly the field the id does not cover, and
   the put refused. M28.0's tests only ever reran at the identical instant.
   Fix: `persist` adopts the stored stamps on an id-hit — the first
   observation of the fact stands, the rerun replays byte-identically, and
   any other divergence under the same id still refuses in the store.

Regression tests pin both: two gates sharing bytes insert two snapshots; a
17:30 ask replays the 09:30 record with the 09:30 stamp; the next local day
inserts a fresh evaluation even when the store was quiet.

### M28.1b — `trigger::runner`

`src-tauri/src/trigger/runner.rs`, added to the tripwire's `TRIGGER_SOURCES`.

- `run_measurable(conn, registry, scope, r7: Option<(&EpistemicState, &VerificationScope)>, evaluated_at, timezone) -> RunReport`
  runs R1, R3, R6, R7 (when declared), R10, R13. **Per-gate error isolation:**
  one evaluator's failure becomes that gate's row (`error: <message>`), never a
  veto on the rest — a broken R1 query must not hide that R13 fired. The
  report row carries gate key, disposition (result | replayed | error |
  not-evaluated-with-reason), and evaluation id where one was recorded.
- `status(conn, registry, scope) -> Vec<GateStatus>` enumerates **all
  fourteen roots** — measurable roots with their latest recorded evaluation
  (or "never evaluated"), R2 as hybrid-awaiting-pack, discretionary roots as
  discretionary-awaiting-pack. A gate absent from the board because nobody
  built its row is exactly the silence this project refuses; the board is
  closed over `REGISTRY_IDS`.
- Tests: fixture DB → run_all records rows and a rerun is all-`Replayed`;
  a poisoned gate (dropped table) errors alone while others record; R7
  undeclared is reported not-evaluated, R7 declared evaluates; status board
  lists 14 rows before any evaluation exists and reflects the latest row
  after; clock scan; tripwire lists runner.rs.

### M28.1c — declaration + commands

- R7's verification scope is **operational configuration** → runtime.db, per
  the two-records rule: a vault-scoped `runtime_settings` key holding the
  canonical `VerificationScope` JSON. Stored only after `validate()` passes;
  the digest is recomputed at read time, never stored (one source of truth).
- `lib.rs` commands, thin shells in the house pattern (`open_existing` +
  `open_vault`): `trigger_status(vault)`, `trigger_run(vault)`,
  `trigger_declare_r7_scope(vault, scope_json) -> digest`. `trigger_run`
  reduces the ledger via `ledger::shadow::with_writer` only when a scope is
  declared — R7 absent, no reduction cost.
- Tests: declaration refuses invalid scopes with the validator's message;
  declared scope round-trips and its digest matches `VerificationScope::digest`.

### M28.1d — the surface

- `ipc.ts` wrappers + `mockIpc.ts` parity (the mock mirrors shapes AND
  refusals: an invalid scope declaration refuses with the same message
  in-browser; status returns the closed 14-row board with nothing evaluated).
- `EpistemicStatusPage` grows a "Deferral gates" section on the existing
  `useFeed`/`Section` pattern — 14 rows, mode, latest result, evaluate action.
  `section-unavailable` vs `section-empty` semantics already distinguish a
  runtime DB that cannot answer from a board with nothing recorded; reuse
  them.
- e2e: extend the status-page spec via `e2e/boot.ts` (never a hand-rolled
  boot); port-free check before running.
- Handoff seam list updated: seam #1 (no caller) closes; seams #2 (R2
  assembly) and #4 (evidence dir on first pack) remain.

## What this milestone must NOT do

No evaluation on a timer or at launch. No R2 assembly. No discretionary
record persistence. No new capability surface, agent launch, proposal, flag,
or protected-name declaration — the tripwires enforce all of this and they
run over the runner too. A fired gate on the board renders as a fact with a
link-to-nothing: the dated plan it licenses is written by a human, not by
this code.
