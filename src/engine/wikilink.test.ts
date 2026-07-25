import { describe, expect, it } from 'vitest';
import { formatWikilink, parseWikilinks, resolveTarget } from './wikilink';
import { makeEntry } from './testHelpers';

describe('parseWikilinks', () => {
  const cases: [string, unknown, string[] | null][] = [
    ['single wikilink string', '[[fld-7]]', ['fld-7']],
    ['piped alias keeps the target only', '[[ana-marte|Ana]]', ['ana-marte']],
    ['multiple wikilinks in one string', '[[a]] blocks [[b]]', ['a', 'b']],
    ['array of wikilink strings', ['[[a]]', '[[b]]'], ['a', 'b']],
    ['array with piped aliases', ['[[a|A]]', '[[b|B]]'], ['a', 'b']],
    ['mixed array keeps only wikilink targets', ['[[a]]', 'plain'], ['a']],
    ['whitespace inside brackets is trimmed', '[[ flight-deck ]]', ['flight-deck']],
    ['plain string is not a wikilink', 'plain', null],
    ['number is not a wikilink', 42, null],
    ['boolean is not a wikilink', true, null],
    ['null is not a wikilink', null, null],
    ['array without wikilinks', ['x', 'y'], null],
    ['object is not a wikilink', { a: 1 }, null],
    ['empty brackets are not a wikilink', '[[]]', null],
    // Parity with mockParse.extractWikilinks / entry.rs collect_targets:
    ['targets containing brackets are rejected', '[[a[b]]', null],
    ['nested arrays are scanned recursively', [['[[a]]'], '[[b]]'], ['a', 'b']],
  ];

  it.each(cases)('%s', (_name, value, expected) => {
    expect(parseWikilinks(value)).toEqual(expected);
  });
});

describe('formatWikilink', () => {
  it('wraps the target in double brackets', () => {
    expect(formatWikilink('fld-7')).toBe('[[fld-7]]');
  });
});

describe('resolveTarget', () => {
  const ana = makeEntry({
    path: 'people/ana-marte.md',
    filename: 'ana-marte.md',
    title: 'Ana Marte',
  });
  const deck = makeEntry({
    path: 'projects/flight-deck.md',
    filename: 'flight-deck.md',
    title: 'Flight deck',
  });
  // decoy: its *title* collides with deck's filename stem — stem match must win
  const decoy = makeEntry({
    path: 'items/misc.md',
    filename: 'misc.md',
    title: 'flight-deck',
  });
  const entries = [decoy, ana, deck];

  it('matches by filename stem, case-insensitive', () => {
    expect(resolveTarget('Flight-Deck', entries)).toBe(deck);
  });

  it('prefers a stem match over a title match regardless of array order', () => {
    expect(resolveTarget('flight-deck', entries)).toBe(deck);
  });

  it('falls back to exact title match, case-insensitive', () => {
    expect(resolveTarget('ana marte', entries)).toBe(ana);
  });

  it('trims the target before matching', () => {
    expect(resolveTarget('  ana-marte  ', entries)).toBe(ana);
  });

  it('returns null when nothing matches', () => {
    expect(resolveTarget('nobody', entries)).toBeNull();
  });
});
