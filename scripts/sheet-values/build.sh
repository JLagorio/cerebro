#!/usr/bin/env bash
# Rebuild only the project-owned cached-value facade. IronCalc is unchanged.
set -euo pipefail
sheet_repo=$(cd "$(dirname "$0")/../.." && pwd)
sheet_crate="$sheet_repo/scripts/sheet-values"
sheet_compiler=$("${RUSTC:-rustc}" --version)
case "$sheet_compiler" in
  'rustc 1.95.0 '*) ;;
  *) echo 'Build the sheet value facade with pinned Rust 1.95.0.' >&2; exit 1 ;;
esac
# rustup target add wasm32-unknown-unknown --toolchain 1.95.0
cargo build --manifest-path "$sheet_crate/Cargo.toml" --locked --release --target wasm32-unknown-unknown
cp "$sheet_crate/target/wasm32-unknown-unknown/release/cerebro_sheet_values.wasm" "$sheet_repo/src/lib/sheetValues/values.wasm"
SHEET_REPO="$sheet_repo" SHEET_COMPILER="$sheet_compiler" node --input-type=module <<'JS'
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const root=process.env.SHEET_REPO;
const hash=(path)=>createHash('sha256').update(readFileSync(join(root,path))).digest('hex');
const files=['scripts/sheet-values/Cargo.toml','scripts/sheet-values/Cargo.lock','scripts/sheet-values/src/lib.rs','src/lib/sheetValues/values.wasm'];
const manifest={format:1,engine:'ironcalc_base@0.8.3',carrier:'bitcode@0.6.9',compiler:process.env.SHEET_COMPILER,target:'wasm32-unknown-unknown',files:Object.fromEntries(files.map(path=>[path,hash(path)]))};
writeFileSync(join(root,'src/lib/sheetValues/provenance.json'),JSON.stringify(manifest,null,2)+'\n');
JS
