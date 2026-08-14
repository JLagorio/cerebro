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
