import { describe, expect, it } from 'vitest';
import { deepEqual } from '@/lib/deepEqual';

describe('deepEqual', () => {
  it('compares primitives by value', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual('a', 'b')).toBe(false);
    expect(deepEqual(true, false)).toBe(false);
  });

  it('never coerces across types', () => {
    expect(deepEqual(1, '1')).toBe(false);
    expect(deepEqual(0, false)).toBe(false);
    expect(deepEqual('', 0)).toBe(false);
    expect(deepEqual([], '')).toBe(false);
  });

  it('treats the same reference as equal', () => {
    const o = { a: [1, { b: 2 }] };
    expect(deepEqual(o, o)).toBe(true);
  });

  it('distinguishes null from undefined and from empty shapes', () => {
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(undefined, undefined)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
    expect(deepEqual(undefined, {})).toBe(false);
  });

  // Inherited from every former copy's `===` base case; documented so a
  // future Object.is swap is a deliberate change, not a drive-by.
  it('keeps NaN unequal to itself', () => {
    expect(deepEqual(NaN, NaN)).toBe(false);
  });

  it('compares arrays positionally — order and length both count', () => {
    expect(deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEqual([1, 2, 3], [1, 2])).toBe(false);
    expect(deepEqual([], [])).toBe(true);
    expect(deepEqual([[1], [2]], [[1], [2]])).toBe(true);
    expect(deepEqual([[1], [2]], [[2], [1]])).toBe(false);
  });

  it('never conflates an array with an index-keyed object', () => {
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(deepEqual({ 0: 1, 1: 2 }, [1, 2])).toBe(false);
    expect(deepEqual([], {})).toBe(false);
  });

  it('compares nested objects structurally, ignoring key order', () => {
    expect(deepEqual({ a: 1, b: { c: [2, 3] } }, { b: { c: [2, 3] }, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1, b: { c: [2, 3] } }, { a: 1, b: { c: [2, 4] } })).toBe(false);
    expect(deepEqual({ a: { b: {} } }, { a: { b: {} } })).toBe(true);
  });

  it('fails on key-count asymmetry in either direction', () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it('counts an explicitly-undefined key as a key', () => {
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(deepEqual({ a: undefined }, { a: undefined })).toBe(true);
  });
});
