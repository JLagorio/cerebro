import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { backSection, forwardSection, sectionize } from './homeSections';
import { dateEpoch } from './dateGrammar';
import { toIsoDate } from './dates';
const timezone = process.env.TZ;
afterEach(() => {
  if (timezone === undefined) delete process.env.TZ;
  else process.env.TZ = timezone;
});
for (const zone of ['America/Los_Angeles', 'Australia/Sydney'])
  describe(zone, () => {
    it('keeps rolling minute/hour boundaries even across midnight', () => {
      process.env.TZ = zone;
      const now = new Date(dateEpoch('2026-07-28 00:03')!);
      const ctx = { today: toIsoDate(now), weekStart: 0 as const };
      for (const [seconds, label] of [
        [-60, 'Last few minutes'],
        [299, 'Last few minutes'],
        [300, 'Last hour'],
        [3599, 'Last hour'],
        [3600, 'Yesterday'],
      ] as const)
        expect(
          backSection(new Date(now.getTime() - seconds * 1000).toISOString(), now, ctx).label,
        ).toBe(label);
    });
    it('sections the local day at six, noon and six in the evening', () => {
      process.env.TZ = zone;
      const now = new Date(dateEpoch('2026-07-28 23:00')!);
      const ctx = { today: '2026-07-28', weekStart: 0 as const };
      for (const [time, label] of [
        ['05:59', 'Earlier today'],
        ['06:00', 'Morning'],
        ['11:59', 'Morning'],
        ['12:00', 'Afternoon'],
        ['17:59', 'Afternoon'],
        ['18:00', 'Evening'],
      ])
        expect(backSection(`2026-07-28 ${time}`, now, ctx).label).toBe(label);
      for (const at of [null, undefined, 'junk', '2026-02-30T10:00:00Z'])
        expect(backSection(at, now, ctx).label).toBe('When not recorded');
    });
    it('shares the forward deadline scale, keeping ongoing ranges first', () => {
      process.env.TZ = zone;
      const now = new Date(dateEpoch('2026-07-28 12:00')!);
      const ctx = { today: '2026-07-28', weekStart: 0 as const };
      for (const [at, label] of [
        ['2026-07-27', 'Overdue'],
        ['2026-07-28', 'Today'],
        ['2026-07-29', 'Tomorrow'],
        ['2026-07-31', 'This week'],
        ['2026-08-04', 'Next week'],
        ['2026-08-15', 'Later'],
        ['junk', 'Not a date'],
        ['', 'No date'],
      ])
        expect(forwardSection(at, now, ctx).label).toBe(label);
      expect(forwardSection({ start: '2026-07-27', end: '2026-07-29' }, now, ctx).label).toBe(
        'Now',
      );
    });
  });
it('sorts sections then equal subjects, without reading a clock or changing the input', () => {
  const rows = [
    { subject: 'b', order: 1 },
    { subject: 'a', order: 1 },
    { subject: 'c', order: 0 },
  ];
  expect(
    sectionize(rows, (row) => ({ key: String(row.order), label: '', order: row.order })).flatMap(
      (section) => section.rows.map((row) => row.subject),
    ),
  ).toEqual(['c', 'a', 'b']);
  expect(rows[0].subject).toBe('b');
  for (const file of ['homeSections', 'homeLanes'])
    expect(readFileSync(`src/engine/${file}.ts`, 'utf8')).not.toMatch(
      /Date\.now\(|new Date\(\)|todayIso\(/,
    );
});
