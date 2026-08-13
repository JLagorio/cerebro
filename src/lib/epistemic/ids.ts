/**
 * Domain-separated id derivations (M22.4) — the TS half of the formulas in
 * `src-tauri/src/ledger/schema/`. Every byte here is pinned by the shared
 * conformance vectors; never substitute an implementation-defined hash.
 *
 * All inputs are UTF-8 text plus `\0` separators, so the string-based
 * `sha256Hex` (already byte-pinned against Rust's sha2 crate) is exact.
 */

import { sha256Hex } from '../sha256';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Canonical JSON = key-order-preserving JSON.stringify, no spaces. */
export function canonicalJson(value: Json): string {
  return JSON.stringify(value);
}

export function deriveSourceKey(kind: string, identity: { [key: string]: Json }): string {
  const object: { [key: string]: Json } = { kind };
  for (const [k, v] of Object.entries(identity)) object[k] = v;
  return `${kind}:${sha256Hex(canonicalJson(object))}`;
}

export function deriveSourceId(storeUuid: string, sourceKey: string): string {
  return sha256Hex(`cerebro-source-v1\0${storeUuid}\0${sourceKey}`).slice(0, 32);
}

export function deriveRelationId(from: string, to: string, relation: string): string {
  return sha256Hex(`cerebro-relation-v1\0${canonicalJson([from, to, relation])}`).slice(0, 32);
}

export function migrateId(storeUuid: string, klass: string, identity: string): string {
  return sha256Hex(`cerebro-migrate-id-v1\0${storeUuid}\0${klass}\0${identity}`).slice(0, 32);
}

export function attestedContentHash(projected: string): string {
  return sha256Hex(`cerebro-attested-content-v1\0${projected}`);
}

const UTF8 = new TextEncoder();

/**
 * Lexicographic order over UTF-8 BYTES.
 *
 * Rust compares `String` byte-wise; JavaScript compares UTF-16 code units,
 * and the two DISAGREE above the BMP — a surrogate pair sorts below U+E000
 * in UTF-16 and above it in UTF-8. Everywhere else that would be pedantry;
 * here it decides which endpoint is `left`, so one emoji in a predicate
 * would be enough for the two implementations to mint different comparison
 * ids for the same pair.
 */
export function compareUtf8(a: string, b: string): number {
  const x = UTF8.encode(a);
  const y = UTF8.encode(b);
  const shared = Math.min(x.length, y.length);
  for (let i = 0; i < shared; i += 1) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return x.length - y.length;
}

/** The two conflict endpoints as canonical JSON, sorted (M26.7). */
export function orderedEndpoints(left: Json, right: Json): [string, string] {
  const a = canonicalJson(left);
  const b = canonicalJson(right);
  return compareUtf8(a, b) <= 0 ? [a, b] : [b, a];
}

export function deriveComparisonId(left: Json, right: Json): string {
  const [first, second] = orderedEndpoints(left, right);
  return sha256Hex(`cerebro-conflict-comparison-v1\0${first}\0${second}`).slice(0, 32);
}

export function deriveValueHash(value: Json): string {
  return sha256Hex(`cerebro-conflict-value-v1\0${canonicalJson(value)}`);
}
