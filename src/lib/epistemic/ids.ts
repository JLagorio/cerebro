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
