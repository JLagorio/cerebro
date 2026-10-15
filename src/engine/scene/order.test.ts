import { describe, expect, it } from 'vitest';
import { compareKeys, isOrderKey, keyBetween, keysAt, orderKeys } from './order';

const ascending = (keys: readonly string[]) =>
  keys.every((key, i) => i === 0 || compareKeys(keys[i - 1], key) < 0);

describe('order keys', () => {
  it('gives n keys in order', () => {
    const keys = orderKeys(5);
    expect(keys).toHaveLength(5);
    expect(ascending(keys)).toBe(true);
    expect(keys.every(isOrderKey)).toBe(true);
    expect(orderKeys(0)).toEqual([]);
  });

  it('finds a key between two, in either direction', () => {
    const [a, b] = orderKeys(2);
    const forward = keyBetween(a, b);
    const backward = keyBetween(b, a);
    for (const mid of [forward, backward]) {
      expect(mid).not.toBeNull();
      expect(compareKeys(a, mid as string)).toBe(-1);
      expect(compareKeys(mid as string, b)).toBe(-1);
    }
    expect(keyBetween(a, a)).toBeNull();
  });

  it('inserts at the front, the back, and before and after a key', () => {
    const keys = orderKeys(3);
    const front = keysAt(keys, 3, 2) as string[];
    const back = keysAt(keys, 0, 2) as string[];
    const middle = keysAt(keys, 1, 1) as string[];
    expect(ascending([...keys, ...front])).toBe(true);
    expect(ascending([...back, ...keys])).toBe(true);
    expect(ascending([keys[0], ...middle, keys[1]])).toBe(true);
    expect((keyBetween(null, keys[0]) as string) < keys[0]).toBe(true);
    expect((keyBetween(keys[2], null) as string) > keys[2]).toBe(true);
    expect(keysAt(keys, 1, 0)).toEqual([]);
    expect(keysAt(keys, 4, 1)).toBeNull();
  });

  it('refuses a malformed key, and never throws', () => {
    for (const bad of ['', 'a', 'a00', 'b0', '!!', 'a0 ', 'A00000000000000000000000000']) {
      expect(isOrderKey(bad)).toBe(false);
      expect(keyBetween(bad, null)).toBeNull();
    }
    expect(keysAt(['a1', 'a0'], 1, 1)).toBeNull();
    expect(keysAt(['a1', 'a1'], 1, 1)).toBeNull();
  });

  it('compares by code unit, so digits sort before capitals before lower case', () => {
    expect(compareKeys('a0', 'aA')).toBe(-1);
    expect(compareKeys('aA', 'aa')).toBe(-1);
    expect(compareKeys('Zz', 'a0')).toBe(-1);
    expect(compareKeys('a1', 'a1')).toBe(0);
  });
});
