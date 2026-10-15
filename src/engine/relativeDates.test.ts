import { describe, expect, it } from 'vitest';
import { DATE_GRAMMAR } from './dateGrammar';
import { parseRelative, relativeLabel, resolveRelative } from './relativeDates';

describe('relative dates replay shared/calendar/dates.v1.json', () => {
  it('replays the relative date cases', () => {
    for (const raw of DATE_GRAMMAR.relative_cases) {
      const c = raw as {
        name: string;
        input: string;
        today: string;
        week_start: 0 | 1;
        expect: unknown;
      };
      expect(resolveRelative(c.input, { today: c.today, weekStart: c.week_start }), c.name).toEqual(
        c.expect,
      );
    }
  });

  it.each([
    ['today', 'today'],
    ['this_week', 'this week'],
    ['next_month', 'next month'],
    ['today-1', '1 day ago'],
    ['today-7', '7 days ago'],
    ['today+1', '1 day from now'],
    ['today+999', '999 days from now'],
  ])('labels %s without changing its stored token', (value, words) => {
    expect(relativeLabel(value)).toBe(words);
  });

  it.each([
    undefined,
    1,
    [],
    'Today',
    'today+0',
    'today-00',
    'today+1000',
    'today+1e2',
    'today+1.5',
    'today+１',
    'today++1',
    'tomorrow+1',
  ])('refuses %j', (value) => {
    expect(parseRelative(value)).toBeNull();
    expect(relativeLabel(value)).toBeNull();
  });

  it('uses the injected clock and rejects an invalid clock date', () => {
    expect(resolveRelative('today', { today: '2026-07-28', weekStart: 0 })).toEqual([
      '2026-07-28',
      '2026-07-28',
    ]);
    expect(resolveRelative('today', { today: '2026-07-29', weekStart: 0 })).toEqual([
      '2026-07-29',
      '2026-07-29',
    ]);
    expect(resolveRelative('today', { today: '2026-02-30', weekStart: 0 })).toBeNull();
  });
});
