import { describe, expect, it } from 'vitest';
import { recordOpen, type OpenLog } from '@/engine/openLog';
import { quickOpenScore } from '@/lib/quickOpenScore';
import {
  NO_RECENCY,
  nameMatches,
  rankGroups,
  rankNames,
  recencyOf,
  type Recency,
} from './nameRank';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 14, 12);

/** A log with `path` opened `times` times, `daysAgo` days back. */
function opens(log: OpenLog, path: string, times: number, daysAgo: number): OpenLog {
  let next = log;
  for (let i = 0; i < times; i++) next = recordOpen(next, path, NOW - daysAgo * DAY + i);
  return next;
}

const names = (query: string, items: string[], recency: Recency = NO_RECENCY, limit?: number) =>
  rankNames({ query, items, texts: (t) => [t], path: (t) => t, recency, limit });

describe('rankNames', () => {
  it('never inverts a tier: an unopened prefix match beats a substring opened 100 times today', () => {
    const recency = recencyOf(opens([], 'Unflight', 100, 0), NOW);
    expect(names('flight', ['Unflight', 'Flight deck'], recency).items).toEqual([
      'Flight deck',
      'Unflight',
    ]);
  });

  it('within a tier, two opens today beat twenty opens sixty days ago', () => {
    let log = opens([], 'Plan old', 20, 60);
    log = opens(log, 'Plan new', 2, 0);
    // Opened in an order that would put 'Plan old' first on recency alone.
    log = recordOpen(log, 'Plan old', NOW - 60 * DAY + 50);
    expect(names('plan', ['Plan old', 'Plan new'], recencyOf(log, NOW)).items).toEqual([
      'Plan new',
      'Plan old',
    ]);
  });

  it('within a tier, equal weights fall back to the most recent open', () => {
    let log: OpenLog = [];
    log = recordOpen(log, 'Plan b', NOW);
    log = recordOpen(log, 'Plan a', NOW);
    expect(names('plan', ['Plan b', 'Plan a'], recencyOf(log, NOW)).items).toEqual([
      'Plan a',
      'Plan b',
    ]);
  });

  it('then the shorter matched text, then the input order', () => {
    expect(names('plan', ['Plan longer', 'Plan', 'Plan xx', 'Plan yy']).items).toEqual([
      'Plan',
      'Plan xx',
      'Plan yy',
      'Plan longer',
    ]);
  });

  it("'ab' does not match 'A Better World'; 'a world' does, at the TERMS tier", () => {
    expect(names('ab', ['A Better World']).total).toBe(0);
    expect(names('a world', ['A Better World']).items).toEqual(['A Better World']);
  });

  it('ranks a TERMS match below every substring match, however often it was opened', () => {
    const recency = recencyOf(opens([], 'A Better World', 50, 0), NOW);
    expect(
      names('a world', ['A Better World', 'Hold a world view', 'a worldly plan'], recency).items,
    ).toEqual(['a worldly plan', 'Hold a world view', 'A Better World']);
  });

  it('matches non-Latin names, one word or two', () => {
    expect(names('日本', ['日本語ノート']).items).toEqual(['日本語ノート']);
    expect(names('раб план', ['Рабочий план']).items).toEqual(['Рабочий план']);
  });

  it("finds 'FLD-7' from 'fld7' at the prefix tier", () => {
    expect(
      rankNames({
        query: 'fld7',
        items: [
          { title: 'Mid fld7 note', key: '' },
          { title: 'Wire the flags', key: 'FLD-7' },
        ],
        texts: (e) => [e.title, e.key],
      }).items.map((e) => e.key),
    ).toEqual(['FLD-7', '']);
  });

  it('matches nothing for a query with no letter or digit', () => {
    expect(names('-', ['flight-deck', 'a-b']).total).toBe(0);
    expect(names(' ./ ', ['a./b']).items).toEqual([]);
  });

  it('puts opened items first on an empty query, then the rest in input order', () => {
    let log = recordOpen([], 'c', NOW - DAY);
    log = recordOpen(log, 'd', NOW);
    const ranked = names('', ['a', 'b', 'c', 'd'], recencyOf(log, NOW));
    expect(ranked.items).toEqual(['d', 'c', 'a', 'b']);
    expect(ranked.total).toBe(4);
    expect(names('', ['a', 'b', 'c'], NO_RECENCY, 2).items).toEqual(['a', 'b']);
  });

  it('returns the same top k as a full sort, and counts every match', () => {
    // A seeded generator, so a failure replays.
    let seed = 7;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const words = ['plan', 'planet', 'roadmap', 'airplane', 'a plan b', 'notes', 'p-lan'];
    const items = Array.from(
      { length: 2000 },
      (_, i) =>
        `${words[Math.floor(rand() * words.length)]} ${words[Math.floor(rand() * words.length)]} ${i}`,
    );
    let log: OpenLog = [];
    for (let i = 0; i < 150; i++) {
      log = recordOpen(log, items[Math.floor(rand() * items.length)], NOW - rand() * 30 * DAY);
    }
    const recency = recencyOf(log, NOW);
    const full = names('plan', items, recency);
    const top = names('plan', items, recency, 25);
    expect(top.items).toEqual(full.items.slice(0, 25));
    expect(top.total).toBe(full.total);
    expect(full.total).toBe(items.filter((t) => quickOpenScore('plan', t) > 0).length);
  });
});

describe('rankGroups', () => {
  it('keeps groups contiguous in first-appearance order, each with its own cap', () => {
    const items = [
      { g: 'People', t: 'Ana plan' },
      { g: 'Pages', t: 'Plan one' },
      { g: 'People', t: 'Plan person' },
      { g: 'Pages', t: 'Plan two' },
      { g: 'Pages', t: 'Plan three' },
      { g: 'Dates', t: 'Due today' },
    ];
    const ranked = rankGroups({
      query: 'plan',
      items,
      texts: (i) => [i.t],
      group: (i) => i.g,
      perGroup: 2,
    });
    expect(ranked.map((i) => i.t)).toEqual(['Plan person', 'Ana plan', 'Plan one', 'Plan two']);
  });
});

describe('nameMatches', () => {
  it("keeps the Picker's old matches over the joined label and hint", () => {
    const texts = ['Read', 'files', 'Read files'];
    for (const q of ['read', 'files', 'read f', 'ead', '']) {
      expect(nameMatches(q, texts)).toBe(q === '' || quickOpenScore(q, 'Read files') > 0);
    }
  });

  it('matches two words apart, and nothing for punctuation alone', () => {
    expect(nameMatches('weekly sweep', ['Weekly risk sweep'])).toBe(true);
    expect(nameMatches('...', ['a...b'])).toBe(false);
  });
});
