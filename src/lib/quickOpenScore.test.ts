import { describe, expect, it } from 'vitest';
import { quickOpenScore } from './quickOpenScore';

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
    expect(quickOpenScore('7', 'FLD-7')).toBeGreaterThan(0); // substring
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
