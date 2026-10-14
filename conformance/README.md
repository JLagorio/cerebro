# Conformance vectors (M22.4)

The schema-v1 parity mechanism. Rust (`src-tauri/src/ledger/`) is the
reference implementation: `ledger::conformance` generates every top-level
`*.json` here and asserts the committed bytes match regeneration. The
minimal TS reducer (`src/lib/epistemic/`) replays the same files in
`conformance.test.ts`. No schema-v1 rule may be hand-mirrored a third
time (mockIpc consumes the TS reducer, not its own copy of the rules).

Each scenario file is `{ name, description, store_id, events,
expected_state, expected_refusals }` where `events` are complete frames
(the digest layer hashes their canonical lines). Refusal identity across
implementations is `(seq, event_id, batch_id, code)` — `detail` strings
are prose for humans and are not part of the contract.

`derivations.json` pins the pure functions both toolchains must compute
byte-for-byte: `normalize_alias_v1`, relation/source/migrate id
derivations, and the projection + attested-content hash.

To regenerate after an INTENTIONAL semantic change:

```
UPDATE_CONFORMANCE=1 cargo test --lib ledger::conformance
```

then re-run `pnpm test:run src/lib/epistemic` and commit both sides in
one change. A diff you did not intend is a bug in whichever side moved.

## Scan golden (M53.22)

`scan/entries.json` is the parser's parity rail. It sits in a subfolder
so the ledger replay above never reads it. A test in `vault::scan`
writes it: Rust's scan of `demo-vault/`, plus `build_entry` over the
`GOLDEN_FIXTURES` in `src-tauri/src/vault/scan.rs` (a new parser edge
case goes there, never into twin tests), and cargo fails when the
committed bytes are stale or missing. `src/lib/scanGolden.test.ts`
replays it through the mock backend's scan and parser, and holds
`engine/wikilink` to the same relationships and outgoing links. The
timestamps are left out, since they are a checkout's file times, and
`parseError` counts by presence, because its text is each YAML
library's own prose.

Every `demo-vault/` edit regenerates it. Each entry carries `hash`, the
SHA-256 of its bytes (M55.2), so any byte edit does, whitespace included.
From `src-tauri/`:

```
UPDATE_CONFORMANCE=1 cargo test --lib vault::scan::tests::scan_golden
```

then run `pnpm test:run src/lib/scanGolden`. An untracked file in
`demo-vault/` changes the scan too.

## Transcript goldens (M56.3)

`transcript/<case>.json` holds Claude Code's two formats folded:
`src-tauri/src/agent/fold.rs` folds each case's live stream fixtures and
its session file (from `src-tauri/fixtures/cli-stream/`) and writes the
events, the per-reason line counts, and each turn's content (the model
last in effect, then what the person reads). A test in `agent::fold`
fails when the committed bytes are stale or missing, and holds a turn's
stream and session-file content equal. `long-payload` (M56.8) is the case
whose input and result the previews cut, so its content carries the
`ToolPayload` events both formats must agree on. `src/agent/transcript.test.ts`
replays the same files through the one TS reducer, live and restored.
A new or re-recorded fixture regenerates them. From `src-tauri/`:

```
UPDATE_CONFORMANCE=1 cargo test --lib agent::fold::tests::transcript_goldens
```

then run `pnpm test:run src/agent/transcript`. `scripts/fixtures.test.ts`
scans them like the fixtures they come from.

## Failure golden (M56.4)

`failure/notices.json` maps each failure fixture under
`src-tauri/fixtures/cli-stream/` (and one good run that must stay quiet)
to the notice `src-tauri/src/agent/failure.rs` classifies it to: kind,
title, body, action, reset, window and the reporting CLI version, or null.
`agent::failure::tests::the_failure_notices_golden_is_current` compares
parsed values, since prettier formats the file. `src/agent/mockAgent.test.ts`
holds the mock's failure scripts to the same entries. A new fixture, or a
change to the classifier's words, regenerates it. From `src-tauri/`:

```
cargo test --lib agent::failure::tests::write_failure_notices -- --ignored
```

then `pnpm exec prettier --write conformance/failure/notices.json`.
`scripts/fixtures.test.ts` scans it like the fixtures it comes from.
