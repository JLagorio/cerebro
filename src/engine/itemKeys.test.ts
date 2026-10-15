import { describe, expect, it } from 'vitest';
import { keyPrefixOf, nextItemKey } from './itemKeys';
import { makeEntry } from './testHelpers';

const withKeys = (...keys: (string | number)[]) =>
  keys.map((key, i) =>
    makeEntry({ path: `items/k${i}.md`, filename: `k${i}.md`, properties: { key } }),
  );

describe('nextItemKey', () => {
  it('returns PREFIX-1 for an empty entry set', () => {
    expect(nextItemKey('FLD', [])).toBe('FLD-1');
  });

  it('returns the max existing number plus one', () => {
    expect(nextItemKey('FLD', withKeys('FLD-3', 'FLD-7', 'FLD-2'))).toBe('FLD-8');
  });

  it('ignores keys with other prefixes', () => {
    expect(nextItemKey('FLD', withKeys('OPS-12', 'FLD-2'))).toBe('FLD-3');
  });

  it('matches keys case-insensitively and ignores malformed keys', () => {
    expect(nextItemKey('FLD', withKeys('FLD-', 'FLDX-4', 'fld-9', 'FLD-x'))).toBe('FLD-10');
  });

  it('ignores non-string keys and entries without keys', () => {
    expect(nextItemKey('FLD', [...withKeys(7), makeEntry({ path: 'items/nokey.md' })])).toBe(
      'FLD-1',
    );
  });

  it('escapes regex metacharacters in the prefix', () => {
    expect(nextItemKey('C++', withKeys('C++-4'))).toBe('C++-5');
  });
});

describe('keyPrefixOf', () => {
  it.each([
    ['FLD', 'FLD'],
    [' FLD ', 'FLD'],
    ['my-Team', 'my-Team'],
    ['\tFLD\n', 'FLD'],
    ['FLD-12', null],
    ['C++', null],
    ['', null],
    [7, null],
    [['FLD'], null],
    ['FLD-', null],
    [' FLD\u00a0', null],
    ['A--B', null],
  ])('reads %j as %j', (key, expected) => {
    expect(keyPrefixOf(makeEntry({ properties: { key } as never }))).toBe(expected);
  });

  it('preserves the host spelling when finding the next number', () => {
    expect(nextItemKey('my-Team', withKeys('MY-TEAM-4', 'my-team-9'))).toBe('my-Team-10');
  });
});
