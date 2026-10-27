# M99.4 disposable storage comparison

These are actual Rust test-harness results for temporary Markdown-plus-sidecar
and Markdown-plus-SQLite stores. The stores are `cfg(test)` prototypes; the app
still uses its existing Markdown/YAML authority and guarded writers. No migration
or storage choice follows from these results.

The machine was heavily loaded by concurrent work. All timings are raw debug
samples, explicitly classified `contended_samples_only`. They cannot establish a
performance winner. A quiet-machine repeat and an owner decision remain required.

## Retained reports

| Artifact | Source snapshot | Functional evidence | Status |
| --- | --- | --- | --- |
| [1k-historical.json](1k-historical.json) | Exact pre-final-hardening source digests in the report | 1,000 requested and converted records; both stores agree; originals unchanged; actual backup/restore, restart, CRUD/query, external-edit refusal and interruption exercises | Complete historical sample |
| [adversarial-initial-historical.json](adversarial-initial-historical.json) | Same historical implementation | 138 requested, 132 converted, six retained; both stores agree; originals unchanged | Initial fixture; does not establish missing-link coverage |
| [adversarial-final.json](adversarial-final.json) | Frozen review source digests in the report | 138 requested, 130 converted, eight retained; missing and moved-Agent references explicitly retained as unresolved; both stores agree; originals unchanged | Complete final-source functional sample |
| [5k-final.json](5k-final.json) | Frozen review source digests; repaired acceptance checker | 5,000 requested and converted records; zero semantic differences; originals unchanged; both stores query all 5,000 records and pass backup/restore, external-edit refusal and all three recovery boundaries | Complete final-source functional sample |

The initial adversarial fixture used `[[Missing]]` beside a page titled
`Missing`, so the existing resolver correctly resolved that link. The corrected
fixture uses `[[Uninventoried target]]` for the missing relation and moved Agent
reference. The initial report is retained rather than relabeled as evidence for
a case it did not exercise. The corrected adversarial run passed with both
unresolved references retained unchanged. The earlier 5k attempt became unavailable:
its process session no longer exists and no completed report was produced. The
partial fixture is preserved, and no result is asserted for that attempt. The
fresh root-owned 5k run subsequently completed against a separate disposable
fixture. Its raw report passed the repaired checker, was copied byte-for-byte,
and passed complete outcome/source-digest validation again at its tracked path.
Both stores recovered old coherent state after intent/visible publication and
new coherent state after metadata publication. The report explicitly retains its
machine contention and unavailable performance-decision labels.

The historical 1k report passed the wrapper's compiled-source digest check before
the fixture correction and bounded malformed-SQLite-column hardening. Exact
matching source preimages were verified and retained in the local review packet
`m99-4-1k-source/`. The exact
[historical-to-review source patch](1k-source-to-final.diff) records the only two
changed source files: the corrected adversarial targets and new malformed-column
regression in the harness, and the bounded SQLite column projection. All other
listed source hashes still match. These samples do not claim to come from the
final source snapshot. Each raw report is retained byte-for-byte, including its own hashes,
workload outcomes, dispositions, requested-path coverage and context.

## Reproduction

Build the pinned offline native test executable through the coordinated Cargo
slot. Create a new temporary directory containing only a `fixture.json` marker:

```json
{ "format": 1, "count": 1000, "scenario": "ordinary" }
```

Ordinary counts are 1,000 and 5,000. The adversarial marker uses `count: 128` and
`scenario: "adversarial"`; the harness adds ten explicitly named compatibility
or malformed carriers. Every run requires a fresh fixture directory and output
path because the sources and stores are create-only.

```sh
node --import tsx scripts/workspace-store-report.ts \
  --fixture /tmp/cerebro-m99-example \
  --out /tmp/cerebro-m99-example-report.json \
  --native-binary src-tauri/target/debug/deps/cerebro_lib-<artifact-hash>
```

The wrapper invokes the actual ignored Rust `write_report` test, checks both
backend outcomes, exact recovery boundaries, unchanged originals, consistent
record/path/disposition/archive counts, finite recorded measurements and the
required contention/context qualifiers. It requires the exact 11-source inventory
emitted by the version-1 harness and compares every digest with current files;
that declared inventory is not a claim to cover every transitive crate input.
Tests use the actual native artifact to hold emitter/validator shape and inventory
agreement. Missing, failed or unavailable exercise evidence cannot pass acceptance. It does not implement a surrogate
store or generate timings. An unavailable or failed run is an error, never a
zero measurement. The native process is bounded to 60 minutes. Later reports
also record `rustc` and `cargo` found on the launcher path; those observations do
not retroactively certify which compiler produced an existing binary.

## What the experiment establishes

Both stores use visible Markdown body paths, persisted stable IDs and tagged
metadata. The same tests exercise real revisions, scoped reads/writes/queries,
100-row cursor pages, schema changes, explicit null versus removal, exact decimal
text, duplicate metadata refusal, missing parts, external edits, and copying a
body without its metadata. An advisory file lock and operation journal coordinate
visible body bytes with the metadata commit. The tested interruption points are
after durable intent, visible bytes and metadata publication.

Conversion retains exact originals with checksums and per-source dispositions.
Governed concepts, CLI definitions, sheet YAML and ambiguous or unsupported
sources remain compatibility carriers. Knowledge verification, ledger projection
bytes and historical ledger/runtime identity are not rewritten.

## Limits that remain acceptance gates

- Query/schema behavior reuses the legacy evaluator; unsupported exact-value
  predicates refuse instead of rounding. This is not a new indexed query engine.
- Both adapters currently load canonical metadata as a whole. SQLite writes a
  whole metadata transaction; no incremental-query performance claim is made.
- Recovery evidence covers the named process interruption points on the tested
  temporary filesystem. Power loss, arbitrary I/O failures, hostile same-user
  races and other filesystem behavior remain unproven.
- Backups cover the inventoried metadata, visible bodies, retained sources and
  originals. They omit unscoped attachments, comments, the complete canonical
  ledger and app-global operational history. They are not production backups.
- External edits are detected and refused. A production reconciliation flow,
  reader/writer cutover matrix, client format guard, production authorization and
  receipts, rollback/export policy and authority decision remain later phases.

Raw artifact SHA-256 values:

```text
3eede50e2689d00c920e1bea6060a5effef4e8b568b2a6180754f014f28e920f  1k-historical.json
47f2c9fcd10333ea255df28dd696e79249ff6ff07d76da4460d8efe4f75c66fc  adversarial-initial-historical.json
f64442372a93ca27de9ae1039b3d1ccc92ffb816185c9e621971297b2817cb77  adversarial-final.json
ff8051588d2c754981ba0104579e84b9ad487e022c094560f73d47dbf6da3040  5k-final.json
```
