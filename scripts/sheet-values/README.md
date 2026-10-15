# Cached sheet values

This project-owned facade reads the cached values in `@ironcalc/wasm` 0.8.3's
`Model.toBytes()` carrier. It uses the same **unchanged** `ironcalc_base =0.8.3`
crate and that crate's `Workbook` and `Cell::value`, decoded by its pinned
`bitcode` dependency. It constructs no model and never evaluates a formula.
The browser still calculates exclusively through the pinned npm engine.

Why it exists: the upstream JS binding exposes cell content and formatted
text, but not a formula's raw value. Parsing display text loses precision:
`1/3` displays `0.333333333`; even a custom 17-digit number format produced
`0.333333333333332`. A scratch worksheet also changes `SHEETS()`, and rewriting
that function changes `FORMULATEXT`. This reader leaves the workbook intact.

Only `src/lib/mockSheet.ts` loads the facade; it is browser-mock code, never
the packaged calculation path. Its four C ABI functions exchange bounded
buffers, owned by Rust vectors, without unsafe Rust memory accesses. The host
copies a snapshot into the input span, reads a JSON answer from the output span,
and releases both buffers in `finally`. Inputs are limited to 64 MiB and come
only from the just-calculated model. Malformed carriers return unavailable.

Upstream's wasm-bindgen descriptor exports retain four unused import stubs in
the artifact. The host binds them to throw: no reader ABI function calls them,
and an unexpected call fails closed. No timezone, clock or JavaScript value is
consulted by the reader.

To regenerate, install the repository's pinned official Rust toolchain and its
wasm target, then run:

```sh
rustup target add wasm32-unknown-unknown --toolchain 1.95.0
./scripts/sheet-values/build.sh
```

The script uses the locked dependencies and records compiler, source, lockfile,
and artifact SHA-256 in `src/lib/sheetValues/provenance.json`. `RUSTC` may point
to an isolated official compiler; Homebrew's Rust has different crate metadata
and cannot use the official target component despite the same version number.
The native crate tests can also run with `cargo test --manifest-path
scripts/sheet-values/Cargo.toml`.

`scripts/ironcalc.test.ts` checks provenance and pins; the real wasm tests in
`src/lib/mockSheetEdit.ironcalc.test.ts` replay the shared Rust report cases,
including exact fractional values, dates, percentages, spills, `SHEETS()` and
`FORMULATEXT`. An upstream engine upgrade must rebuild and replay this reader
alongside the existing npm/native compatibility gate. The carrier is internal,
not a file format the vault stores or imports.
