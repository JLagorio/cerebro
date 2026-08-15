# `shared/runtime/` — versioned operational artifacts (M25)

`shared/policy/` holds **governance** as data, dual-loaded by Rust and
TypeScript so no rule is hand-mirrored. This directory is its operational
sibling and the distinction is deliberate:

| | `shared/policy/` | `shared/runtime/` |
| --- | --- | --- |
| What it decides | whether a mutation may touch the record | how much the subscription may spend today |
| Destiny of a refusal | the vault ledger, mostly | `runtime.db`, always |
| Who loads it | Rust **and** TypeScript, byte-identity tested | Rust only |

**Rust only, on purpose.** The budget engine is server-side by construction:
the gate, the reservation, the scheduler claim, the run row, and the ambient
lease all commit in one SQLite transaction, and TypeScript cannot hold that
transaction open across an `await`. The browser mock therefore serves fixed
runtime-DB SHAPES for Playwright and holds no budget logic at all — a second
budget engine in the mock would be the twin-implementation defect
`shared/policy/README.md` exists to prevent, arrived at from the other
direction.

## The files

| File | What it is |
| --- | --- |
| `budget-defaults.v1.json` | The shipped v1 ambient ceilings. They initialize the FIRST `budget_settings_versions` row and are never read again — an owner edit appends a new immutable version, and a `budget_days` row copies whichever version was effective when its window opened. |
| `budget-defaults.v1.sha256` | SHA-256 of that file's bytes. The build compiles the JSON in with `include_str!` and hashes what it loaded, so an edit that forgets to regenerate the digest fails loudly instead of silently changing what tomorrow costs. |

The directory is `.prettierignore`d for the same reason `shared/policy/` is:
the bytes are hashed, and a formatter that reflowed them would break the
anchor.

## Regenerating

A deliberate act, so it is an `#[ignore]`d test rather than something the
suite does on its own:

```sh
cd src-tauri
cargo test --lib runtime::budget::tests::write_defaults_digest -- --ignored
```

## Why the defaults are these numbers

They are the design's, and they are a **shipping** default rather than a
recommendation: 20 ambient runs, 200,000 total tokens, and 40,000 output
tokens a day against one personal CLI subscription that the owner is also
using for their own chat. Per-run caps of 20,000/4,000 exist so one runaway
item cannot eat the day in a single dispatch. `warning_ppm: 800000` is 80% —
the point at which the meter starts saying so and the lowest-priority lanes
begin to shed.

Changing them is a settings edit, not a code change, and it takes effect at
the next local-day window. That delay is not friction for its own sake: an
edit that took effect immediately would let today's ceiling be raised after
today's spending, and every gate decision this morning would have been
evaluated against a rule that no longer exists.

## agent_proposals_enabled has no writer (M31.4, 2026-08-14)

M26.3c shipped the switch OFF and deliberately; no UI or command sets it,
so today it is permanently false. M31.4 does NOT add a writer — it makes
the false state honest: the maintenance pass skips before claiming a lease
(Scheduled::SkippedNoProposalSurface) and records the skip operationally
under the existing `capability_unavailable` code, surface
"maintenance_schedule" (a new dedicated code was considered and rejected:
this is a capability gap, exactly what capability_unavailable declares,
and a one-per-skip row is distinguishable by surface — zero policy-table
churn).

Flipping the switch remains M26.9's decision, as the switch's own doc
comment in app_config.rs says (M26.3c registers, M26.9 flips). This note
does not move that ownership.

One boundedness difference from the meter precedent, weighed and accepted
deliberately (per the plan's one-row-per-skip instruction): the meter's
`capability_unavailable` row is ACTION-bounded — one per run somebody
started. This one is CLOCK-bounded — one per 300 s tick while unsaid
findings exist on an ambient-armed, proposals-off vault, and those
findings cannot drain through the pass itself while the surface is off,
so the steady state is ~288 rows/day per affected vault until M26.9
flips the switch or the findings resolve another way. If that proves
noisy, the named follow-up is transition-dedup: record only on state
change, or once per supervisor session.

## ledger/index.rs's epistemic tables have no production reader (M31.7, 2026-08-14)

The index materializes epistemic state into app-data SQLite on activation.
Zero production readers — the only SELECT over the epistemic tables is the
index's own rebuild-agreement dump helper (`dump_epistemic`), which tests
use to prove replay and rebuild-from-zero agree. (The `events` and `meta`
tables are different and stay: the replay cursor and the remembered head
that anchors divergence classification are real production reads.) M31.7
cached the in-memory fold instead, which is what the read paths actually
needed. The epistemic materialization is retained because a query surface
at a size the fold cannot hold is a real future need. It is a snapshot as
of last activation and MUST NOT be treated as current: appends update the
index's meta head only on the vault-file shadow path (`shadow::record`);
ledger-first appends through `with_writer` leave the whole index untouched
until the next such write or the next activation, and the epistemic tables
themselves refresh only at activation.

If M32 has not given the epistemic tables a reader, delete the
materialization (not the meta anchor).
