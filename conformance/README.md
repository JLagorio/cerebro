# Conformance vectors (M22.4)

The schema-v1 parity mechanism. Rust (`src-tauri/src/ledger/`) is the
reference implementation: `ledger::conformance` generates every
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
