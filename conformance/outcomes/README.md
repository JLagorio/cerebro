# Offline outcome cases

These twelve versioned cases exercise Cerebro's existing source-location resolver,
ledger conformance reducer, transcript reducer, and optional M96 broker observer.
They contain synthetic inputs. Expected sources/artifacts are assertion inputs,
never observation producers. No ordinary vault, live CLI, account, or real provider
is part of an offline run.

The source cases reuse the raw inputs in
`shared/knowledge/source-location-cases.json`, with deleted, moved, imported-text,
and cross-vault variants. The ledger case replays Rust's committed
`conformance/contradiction.json` through the production TS reducer. Synthetic folded
child events go through `src/agent/transcript.ts`; there is no additional CLI parser.

Run the baseline into a fresh disposable directory:

```sh
pnpm exec tsx scripts/outcomes/run.ts --mode offline \
  --manifest conformance/outcomes/manifest.v1.json --out /absolute/new/report-directory
```

Exit codes are 0 for passed, 1 for a hard assertion failure, 2 for invalid input or
an operational error, and 3 for unavailable required capabilities. A report may
contain passed dimensions while its overall outcome remains unavailable. Model
answer quality, real save recovery, historical native dispatch scope, queued MCP
writes, authentication repair, and mail drafts need their actual producers; this
baseline does not invent observations for them. Missing cost, CLI, and model
observations remain null with an explanation.

`native.rs` is an ignored test observer for M96's existing broker and deterministic
provider. Its registration is test-only. Explicit capture requires
`CEREBRO_OUTCOMES_NATIVE_OUT` to name a new file inside an empty, canonical,
disposable directory. It refuses fixture database/process-gate overrides, records
the actual unknown-outcome/reconcile path, and never registers a production route.
The native broker's wall clock is disclosed separately from the injected evaluation
clock. Retained reports contain finite typed observations and source-byte digests,
without opaque reasoning or raw provider output.

Native captures bind the complete declared repository input set through a compiled
aggregate digest, file count, and byte count. This inventory covers Rust sources,
shared artifacts, compiled synthetic fixtures, Cargo manifest/lock, the toolchain
pin, build/configuration files, and the capture/import inventory code. It does not
claim the actual compiler, Cargo cache, environment, system dependencies, installed
CLI, or packaging-resource identity. The importer checks changed bytes and exact
path additions/removals against the current generated inventory before accepting a
capture. `conformance/contradiction.json` also appears in the normal offline report's
source identity because the ledger adapter actually reads its events.

After source changes have stopped, explicitly regenerate the paired inventory:

```sh
pnpm exec tsx scripts/outcomes/native-inputs.ts --write
pnpm exec tsx scripts/outcomes/native-inputs.ts --check
```

The generated `native-inputs.v1.json` and `native-inputs.generated.rs` contain only
paths and compile-time include expressions. Both include their own paths without
embedding their own hashes. Their exact generation parity is tested; regenerate
them together and do not independently format them. Generation checks all bounds
before replacing either artifact: 2,048 input files, 4 MiB per file, 64 MiB total,
512 bytes per path, path depth 16, and 8,192 visited entries. Input discovery uses
fixed roots and refuses symlinks, secret-like/hidden paths, and escapes. Reports
retain only the bounded aggregate identity, not the input contents or file list.

The six causal negative controls must reject forbidden effects, source disclosure,
false human verification, stale exact-source claims, failed-child contamination,
and unacknowledged retry after an unknown remote outcome. Quality judgments cannot
override those hard gates.
