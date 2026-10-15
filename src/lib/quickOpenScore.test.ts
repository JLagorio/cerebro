import { describe, expect, it } from 'vitest';
import { quickOpenScore, quickOpenTier } from './quickOpenScore';

describe('quickOpenScore', () => {
  it('returns 0 when there is no match', () => {
    expect(quickOpenScore('xyz', 'Flight deck')).toBe(0);
  });

  it('returns 0 for an empty or whitespace query and for an empty candidate', () => {
    expect(quickOpenScore('', 'Flight deck')).toBe(0);
    expect(quickOpenScore('   ', 'Flight deck')).toBe(0);
    expect(quickOpenScore('a', '')).toBe(0);
  });

  it('ranks exact prefix above word-boundary above substring', () => {
    const prefix = quickOpenScore('fli', 'Flight deck');
    const boundary = quickOpenScore('fli', 'Board flight');
    const substring = quickOpenScore('light', 'Flight deck');
    expect(prefix).toBeGreaterThan(boundary);
    expect(boundary).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(0);
  });

  it('treats a hyphen as a word boundary', () => {
    expect(quickOpenScore('deck', 'flight-deck')).toBeGreaterThan(
      quickOpenScore('eck', 'flight-deck'), // substring only
    );
  });

  it('is case-insensitive', () => {
    expect(quickOpenScore('FLI', 'flight deck')).toBe(quickOpenScore('fli', 'FLIGHT DECK'));
    expect(quickOpenScore('FLI', 'flight deck')).toBeGreaterThan(0);
  });

  it('matches key-style candidates, with and without the hyphen in the query', () => {
    expect(quickOpenScore('fld-7', 'FLD-7')).toBeGreaterThan(0);
    expect(quickOpenScore('fld7', 'FLD-7')).toBeGreaterThan(0);
    expect(quickOpenScore('fld', 'FLD-7')).toBeGreaterThan(0);
    expect(quickOpenScore('7', 'FLD-7')).toBeGreaterThan(0); // after the hyphen: a word boundary
  });

  it('does not apply hyphen-less matching to non-key candidates', () => {
    // 'ab' is not a prefix, boundary, or substring of 'A Better World'
    expect(quickOpenScore('ab', 'A Better World')).toBe(0);
  });

  it('breaks ties deterministically by shorter candidate', () => {
    expect(quickOpenScore('doc', 'Docs')).toBeGreaterThan(
      quickOpenScore('doc', 'Documentation hub'),
    );
  });
});

// M59.3: the tier alone, the step nameRank ranks by before the open log.
describe('quickOpenTier', () => {
  it.each([
    ['fli', 'Flight deck', 3],
    ['FLI', 'flight deck', 3],
    ['fli', 'Board flight', 2],
    ['deck', 'flight-deck', 2],
    ['deck', 'notes/deck.md', 2],
    ['light', 'Flight deck', 1],
    ['fld7', 'FLD-7', 3],
    ['fld-7', 'FLD-7', 3],
    ['7', 'FLD-7', 2],
    ['ab', 'A Better World', 0],
    ['a world', 'A Better World', 0],
    ['', 'Flight deck', 0],
    ['a', '', 0],
  ] as const)('%j in %j is tier %i', (query, candidate, tier) => {
    expect(quickOpenTier(query, candidate)).toBe(tier);
  });

  it('is the score divided back out', () => {
    expect(Math.floor((quickOpenScore('fli', 'Board flight') + 999) / 1000)).toBe(
      quickOpenTier('fli', 'Board flight'),
    );
  });
});
