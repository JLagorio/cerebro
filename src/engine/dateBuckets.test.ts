import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bandContext,
  bandDayOf,
  calendarBandBounds,
  dateBandFor,
  dateScale,
  dropDateValue,
  type BandContext,
} from './dateBuckets';

const ctx: BandContext = { today: '2026-07-28', weekStart: 0 };
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('relative date bands', () => {
  it('uses one explicit local clock and Sunday weeks by default', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 28, 12));
    expect(bandContext()).toEqual(ctx);
    const source = readFileSync('src/engine/dateBuckets.ts', 'utf8');
    expect(source).not.toMatch(/Date\.now|new Date\(\s*\)/);
    expect(source.match(/todayIso\(\)/g)).toHaveLength(1);
  });

  it.each([0, 1] as const)('partitions forward dates with weekStart %i', (weekStart) => {
    const context = { ...ctx, weekStart };
    const days = [
      '2026-07-27',
      '2026-07-28',
      '2026-07-29',
      '2026-07-31',
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-10',
    ];
    expect(days.map((day) => dateBandFor(day, 'date', undefined, context).key)).toEqual([
      'rel:earlier',
      '2026-07-28',
      '2026-07-29',
      'rel:this-week',
      'rel:this-week',
      weekStart === 0 ? 'rel:next-week' : 'rel:this-week',
      'rel:next-week',
      'rel:later',
    ]);
    expect(dateScale('date', context).map((b) => b.label)).toEqual([
      'Earlier',
      'Today',
      'Tomorrow',
      'This week',
      'Next week',
      'Later',
    ]);
  });

  it.each([
    ['2026-07-31', 0, false],
    ['2026-08-01', 0, false],
    ['2026-08-02', 0, true],
    ['2026-07-31', 1, true],
    ['2026-08-01', 1, false],
    ['2026-08-02', 1, false],
  ] as const)(
    'omits a consumed This week interval on %s with weekStart %i',
    (today, weekStart, hasThisWeek) => {
      const bands = dateScale('date', { today, weekStart });
      expect(bands.some((b) => b.key === 'rel:this-week')).toBe(hasThisWeek);
      for (let i = -10; i < 25; i++) {
        const d = new Date(2026, 6, 31 + i);
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        expect(
          bands.filter(
            (b) => (b.start === null || day >= b.start) && (b.end === null || day <= b.end),
          ),
        ).toHaveLength(1);
      }
    },
  );

  it('keeps back intervals disjoint on the first of a month, and names future stamps', () => {
    const context = { ...ctx, today: '2026-08-01' };
    const bands = dateScale('created_time', context);
    expect(bands.map((b) => b.label)).toEqual([
      'Later',
      'Today',
      'Yesterday',
      'Past 7 days',
      'Last month',
      'Older',
    ]);
    expect(bands[0].filledOnly).toBe(true);
    expect(
      [
        '2026-08-02',
        '2026-08-01',
        '2026-07-31',
        '2026-07-30',
        '2026-07-26',
        '2026-07-25',
        '2026-06-30',
      ].map((day) => dateBandFor(day, 'last_edited_time', undefined, context).key),
    ).toEqual([
      'rel:later',
      '2026-08-01',
      '2026-07-31',
      'rel:past-7-days',
      'rel:past-7-days',
      'rel:last-month',
      'rel:older',
    ]);
    expect(
      dateScale('created_time', ctx).find((b) => b.key === 'rel:earlier-this-month'),
    ).toMatchObject({ start: '2026-07-01', end: '2026-07-21' });
  });
});

it('names calendar bands and their immutable bounds', () => {
  const day = '2026-07-28';
  expect(dateBandFor(day, 'date', 'day', ctx)).toMatchObject({ key: day, label: 'Jul 28, 2026' });
  expect(dateBandFor(day, 'date', 'week', ctx)).toMatchObject({
    key: 'week:2026-07-26',
    label: 'Week of Jul 26, 2026',
    seedable: false,
  });
  expect(dateBandFor(day, 'date', 'month', ctx)).toMatchObject({
    key: 'month:2026-07',
    label: 'July 2026',
    seedable: false,
  });
  expect(dateBandFor(day, 'date', 'year', ctx)).toMatchObject({
    key: 'year:2026',
    label: '2026',
    seedable: false,
  });
  expect(calendarBandBounds('month:2028-02', 'month')).toEqual(['2028-02-01', '2028-02-29']);
  expect(calendarBandBounds('month:2026-12', 'month')).toEqual(['2026-12-01', '2026-12-31']);
  expect(calendarBandBounds('rel:this-week', 'week')).toBeNull();
  expect(calendarBandBounds('2026-02-30', 'day')).toBeNull();
});

it('reads starts and Los Angeles wall dates through the shared grammar', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  expect(bandDayOf('2026-07-28T00:30:00Z')).toBe('2026-07-27');
  expect(bandDayOf({ start: '2026-07-28 14:30', end: '2026-08-01' })).toBe('2026-07-28');
  expect(bandDayOf('2026-02-30')).toBeNull();
  expect(bandDayOf('tomorrow')).toBeNull();
});

it('shifts days while keeping wall time, range length, and an open end', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  expect(dropDateValue('2026-07-29 14:30', '2026-07-28', 'date')).toBe('2026-07-28 14:30');
  expect(
    dropDateValue(
      { start: '2026-03-07 14:30', end: '2026-03-10 16:00' },
      '2026-03-08',
      'daterange',
    ),
  ).toEqual({ start: '2026-03-08 14:30', end: '2026-03-11 16:00' });
  expect(
    dropDateValue({ start: '2026-07-29 14:30', end: null }, '2026-07-28', 'daterange'),
  ).toEqual({ start: '2026-07-28 14:30', end: null });
  expect(dropDateValue(null, '2026-07-28', 'daterange')).toEqual({
    start: '2026-07-28',
    end: null,
  });
});

it('separates unfinished overdue work from earlier finished deadlines', () => {
  expect(dateBandFor('2026-07-27', 'date', undefined, ctx, { deadline: true }).key).toBe(
    'rel:overdue',
  );
  expect(
    dateBandFor('2026-07-27', 'date', undefined, ctx, { deadline: true, finished: true }).key,
  ).toBe('rel:earlier');
  expect(dateScale('date', ctx, true).slice(0, 2)).toMatchObject([
    { key: 'rel:overdue', color: 'var(--danger-600)' },
    { key: 'rel:earlier', filledOnly: true },
  ]);
  expect(bandDayOf({ start: '2026-07-20', end: '2026-07-29' }, 'end')).toBe('2026-07-29');
  expect(
    dropDateValue(
      { start: '2026-07-20 14:30', end: '2026-07-29 16:00' },
      '2026-07-28',
      'daterange',
      'end',
    ),
  ).toEqual({ start: '2026-07-19 14:30', end: '2026-07-28 16:00' });
});
