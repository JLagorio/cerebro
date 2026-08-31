/**
 * Recursive structural equality (M45.3) — the ONE deep compare, hoisted from
 * three former copies: `navStore.sameSelection`'s inner `equal`,
 * `LayoutEditorDialog.draftDirty`'s inner `equal`, and
 * `trigger/evaluation.ts`'s private `deepEqual`.
 *
 * Structural rather than `JSON.stringify` because a stringify compare makes
 * the answer depend on key order, and callers compare objects built by
 * different code paths. Arrays compare positionally — a reorder is a
 * difference — and never equal an index-keyed plain object. Key SETS must
 * match exactly (an explicitly-undefined key is still a key), and `null` is
 * never `undefined`. `NaN` stays unequal to itself: the `===` base case every
 * former copy shared, kept deliberately.
 *
 * The trigger ledger's byte-equal alias check rides on this being a deep
 * equality over exactly what Rust compares (`trigger/evaluation.rs`) — loosen
 * nothing here without re-reading that parity contract.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (!deepEqual(ka, kb)) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
