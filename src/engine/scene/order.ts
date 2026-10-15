import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/**
 * Order keys (M68.1): the scene's z-order within each kind. The one file that
 * loads fractional-indexing. Keys compare by UTF-16 code unit (plain `<`),
 * are derived when a board is read and are never saved, because array order
 * is the file's z-order. Nothing here throws: a malformed key gives null.
 */

const KEY_CHARS = /^[0-9A-Za-z]+$/;

/** Code-unit order, the order every key function here assumes. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isOrderKey(value: unknown): value is string {
  if (typeof value !== 'string' || !KEY_CHARS.test(value)) return false;
  try {
    generateKeyBetween(value, null);
    return true;
  } catch {
    return false;
  }
}

/** `n` ascending keys for a kind with nothing in it yet. */
export function orderKeys(n: number): string[] {
  if (!Number.isInteger(n) || n <= 0) return [];
  return generateNKeysBetween(null, null, n);
}

/**
 * A key strictly between `a` and `b`, in either order; null is the open end.
 * Null when a key is malformed or the two are equal.
 */
export function keyBetween(a: string | null, b: string | null): string | null {
  if ((a !== null && !isOrderKey(a)) || (b !== null && !isOrderKey(b))) return null;
  try {
    return generateKeyBetween(a, b);
  } catch {
    return null;
  }
}

/**
 * `count` ascending keys that sort at `index` in `sortedKeys`: after
 * `sortedKeys[index - 1]` and before `sortedKeys[index]`. Index 0 is the
 * back, `sortedKeys.length` the front. Null when the neighbours are malformed,
 * out of order or equal.
 */
export function keysAt(
  sortedKeys: readonly string[],
  index: number,
  count: number,
): string[] | null {
  if (!Number.isInteger(index) || index < 0 || index > sortedKeys.length) return null;
  if (!Number.isInteger(count) || count < 0) return null;
  if (count === 0) return [];
  const below = index > 0 ? sortedKeys[index - 1] : null;
  const above = index < sortedKeys.length ? sortedKeys[index] : null;
  if ((below !== null && !isOrderKey(below)) || (above !== null && !isOrderKey(above))) return null;
  if (below !== null && above !== null && !(below < above)) return null;
  try {
    return generateNKeysBetween(below, above, count);
  } catch {
    return null;
  }
}
