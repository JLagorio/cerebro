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
