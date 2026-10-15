# Upstream Excel workbook

`ironcalc-example.xlsx` is the unmodified `tests/example.xlsx` from crates.io
`ironcalc` 0.8.3 (gitHead `9bed9ec023e645101df6b6ac5aebbe0708b259fb`),
MIT OR Apache-2.0, Copyright 2023 EqualTo GmbH and Nicolás Hatcher.
Source: https://github.com/ironcalc/IronCalc/blob/9bed9ec023e645101df6b6ac5aebbe0708b259fb/xlsx/tests/example.xlsx

SHA-256: `35010189f3dbd9ec1881749cb1995d55fe35b7f3a9c07d6198abc55218bbc445`

The native importer records the UTC decode for browser previews, which never
parse XLSX. To regenerate after reviewing the native import changes:

```sh
cd src-tauri
cargo test sheet::xlsx::tests::writes_the_recorded_decode -- --ignored --exact
cargo test sheet::xlsx::tests::the_recorded_decode_is_current -- --exact
```

The second test compares the exact JSON bytes; do not format the generated file.
