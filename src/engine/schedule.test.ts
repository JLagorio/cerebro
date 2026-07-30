import { describe, expect, it } from 'vitest';
import {
  axisSpan,
  axisTicks,
  axisWidth,
  barGeometry,
  dateFieldOptions,
  dayCount,
  dayOffset,
  dependenciesOf,
  eachDay,
  isSameMonth,
  isSlipping,
  monthEnd,
  monthGrid,
  monthLabel,
  monthStart,
  onDay,
  overlaps,
  PX_PER_DAY,
  resolveDateField,
  spanBounds,
  spanOf,
  unscheduled,
  weekdayLabels,
} from './schedule';
import { makeEntry } from './testHelpers';
import type { FieldKind, Presentation } from './types';

/** Minimal presentation — only the axis keys matter here. */
const pres = (patch: Partial<Presentation> = {}): Presentation => ({
  type: 'calendar',
  group: [],
  sort: [],
  columns: [],
  ...patch,
});

const field = (name: string, kind: FieldKind) => ({ name, kind });

describe('resolveDateField', () => {
  const fields = [field('title', 'text'), field('due', 'date'), field('window', 'daterange')];

  it('honours an explicit dateField over any inference', () => {
    expect(resolveDateField(pres({ dateField: 'due' }), fields)).toBe('due');
  });

  it('prefers a daterange when inferring, because it carries both endpoints', () => {
    expect(resolveDateField(pres(), fields)).toBe('window');
  });

  it('falls back to a plain date', () => {
    expect(resolveDateField(pres(), [field('due', 'date'), field('n', 'number')])).toBe('due');
  });

  it('is null when the type carries no dates at all', () => {
    expect(resolveDateField(pres(), [field('n', 'number')])).toBeNull();
  });

  it('ignores an empty explicit field rather than keying on ""', () => {
    expect(resolveDateField(pres({ dateField: '' }), fields)).toBe('window');
  });

  it('offers both date kinds to the settings picker', () => {
    expect(dateFieldOptions(fields).map((f) => f.name)).toEqual(['due', 'window']);
  });
});

describe('spanOf', () => {
  it('reads a plain date as a single inclusive day', () => {
    const e = makeEntry({ properties: { due: '2026-07-29' } });
    expect(spanOf(e, 'due')).toEqual({ start: '2026-07-29', end: '2026-07-29' });
  });

  it('strips a time component', () => {
    const e = makeEntry({ properties: { due: '2026-07-29 16:00' } });
    expect(spanOf(e, 'due')).toEqual({ start: '2026-07-29', end: '2026-07-29' });
  });

  it('reads a daterange from the nested mapping the parser passes through', () => {
    const e = makeEntry({ properties: { window: { start: '2026-07-01', end: '2026-07-10' } } });
    expect(spanOf(e, 'window')).toEqual({ start: '2026-07-01', end: '2026-07-10' });
  });

  it('treats an open-ended range as a one-day milestone, not a dropped record', () => {
    const e = makeEntry({ properties: { window: { start: '2026-07-01', end: null } } });
    expect(spanOf(e, 'window')).toEqual({ start: '2026-07-01', end: '2026-07-01' });
  });

  it('treats a backwards range the same way rather than rendering a negative bar', () => {
    const e = makeEntry({ properties: { window: { start: '2026-07-10', end: '2026-07-01' } } });
    expect(spanOf(e, 'window')).toEqual({ start: '2026-07-10', end: '2026-07-10' });
  });

  it('is null for a missing field, a null field, and an unparseable value', () => {
    expect(spanOf(makeEntry(), 'due')).toBeNull();
    expect(spanOf(makeEntry({ properties: { due: null } }), 'due')).toBeNull();
    expect(spanOf(makeEntry({ properties: { due: 'someday' } }), 'due')).toBeNull();
    expect(spanOf(makeEntry({ properties: { due: '2026-07-29' } }), null)).toBeNull();
  });

  it('reports what it cannot place', () => {
    const dated = makeEntry({ path: 'a.md', properties: { due: '2026-07-01' } });
    const bare = makeEntry({ path: 'b.md' });
    expect(unscheduled([dated, bare], 'due').map((e) => e.path)).toEqual(['b.md']);
  });
});

describe('span arithmetic', () => {
  it('counts a single day as 1, inclusive', () => {
    expect(dayCount({ start: '2026-07-29', end: '2026-07-29' })).toBe(1);
    expect(dayCount({ start: '2026-07-01', end: '2026-07-10' })).toBe(10);
  });

  it('counts inclusively across a month boundary', () => {
    expect(dayCount({ start: '2026-07-30', end: '2026-08-02' })).toBe(4);
  });

  it('survives a DST transition — days are calendar days, not 24h blocks', () => {
    // US DST springs forward 2026-03-08; a UTC-millisecond count would give 89.
    expect(dayCount({ start: '2026-03-01', end: '2026-03-31' })).toBe(31);
  });

  it('offsets from the span start, negative before it', () => {
    const span = { start: '2026-07-10', end: '2026-07-20' };
    expect(dayOffset(span, '2026-07-10')).toBe(0);
    expect(dayOffset(span, '2026-07-13')).toBe(3);
    expect(dayOffset(span, '2026-07-08')).toBe(-2);
  });

  it('enumerates every day inclusively', () => {
    expect(eachDay({ start: '2026-07-29', end: '2026-08-01' })).toEqual([
      '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-01',
    ]);
  });

  it('bounds a set of spans to the tightest cover', () => {
    expect(
      spanBounds([
        { start: '2026-07-10', end: '2026-07-12' },
        { start: '2026-07-01', end: '2026-07-05' },
        { start: '2026-08-01', end: '2026-08-01' },
      ]),
    ).toEqual({ start: '2026-07-01', end: '2026-08-01' });
    expect(spanBounds([])).toBeNull();
  });

  it('treats touching spans as overlapping (both inclusive)', () => {
    expect(overlaps({ start: '2026-07-01', end: '2026-07-05' }, { start: '2026-07-05', end: '2026-07-09' })).toBe(true);
    expect(overlaps({ start: '2026-07-01', end: '2026-07-04' }, { start: '2026-07-05', end: '2026-07-09' })).toBe(false);
  });
});

describe('month grid', () => {
  it('finds the month bounds', () => {
    expect(monthStart('2026-07-29')).toBe('2026-07-01');
    expect(monthEnd('2026-07-29')).toBe('2026-07-31');
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
    // Leap year — the day count must come from the calendar, not from a table.
    expect(monthEnd('2028-02-10')).toBe('2028-02-29');
  });

  it('is always 42 days so paging months does not resize the page', () => {
    for (const iso of ['2026-02-01', '2026-07-15', '2026-08-31', '2028-02-01']) {
      expect(monthGrid(iso)).toHaveLength(42);
    }
  });

  it('starts on the requested weekday and covers the whole month', () => {
    // 2026-07-01 is a Wednesday, so a Sunday-start grid leads with Jun 28.
    const sunday = monthGrid('2026-07-15', 0);
    expect(sunday[0]).toBe('2026-06-28');
    expect(sunday).toContain('2026-07-01');
    expect(sunday).toContain('2026-07-31');

    const monday = monthGrid('2026-07-15', 1);
    expect(monday[0]).toBe('2026-06-29');
    expect(monday).toContain('2026-07-31');
  });

  it('labels months and weekdays', () => {
    expect(monthLabel('2026-07-29')).toBe('July 2026');
    expect(isSameMonth('2026-07-01', '2026-07-31')).toBe(true);
    expect(isSameMonth('2026-07-31', '2026-08-01')).toBe(false);
    expect(weekdayLabels(0)[0]).toBe('Sun');
    expect(weekdayLabels(1)[0]).toBe('Mon');
  });

  it('places a multi-day record on every day it covers', () => {
    const e = makeEntry({ path: 'a.md', properties: { w: { start: '2026-07-01', end: '2026-07-03' } } });
    const other = makeEntry({ path: 'b.md', properties: { w: '2026-07-03' } });
    expect(onDay([e, other], 'w', '2026-07-02').map((x) => x.path)).toEqual(['a.md']);
    expect(onDay([e, other], 'w', '2026-07-03').map((x) => x.path)).toEqual(['a.md', 'b.md']);
    expect(onDay([e, other], 'w', '2026-07-04')).toEqual([]);
  });
});

describe('horizontal axis', () => {
  const data = { start: '2026-07-10', end: '2026-07-20' };

  it('pads the data range, scaled to the zoom', () => {
    expect(axisSpan(data, 'day', '2026-07-15')).toEqual({ start: '2026-07-07', end: '2026-07-23' });
    // Zoomed out it snaps outward to whole months so ticks align.
    expect(axisSpan(data, 'month', '2026-07-15')).toEqual({ start: '2026-06-01', end: '2026-08-31' });
  });

  it('still produces an axis when nothing is dated, centred on today', () => {
    const span = axisSpan(null, 'day', '2026-07-15');
    expect(span.start < '2026-07-15').toBe(true);
    expect(span.end > '2026-07-15').toBe(true);
  });

  it('ticks daily at day zoom, marking Mondays major', () => {
    const span = { start: '2026-07-06', end: '2026-07-12' }; // Mon–Sun
    const ticks = axisTicks(span, 'day');
    expect(ticks).toHaveLength(7);
    expect(ticks[0]).toEqual({ iso: '2026-07-06', label: '6', major: true, days: 1 });
    expect(ticks[1].major).toBe(false);
  });

  it('ticks weekly at week zoom, aligned to Mondays', () => {
    const ticks = axisTicks({ start: '2026-07-08', end: '2026-07-28' }, 'week');
    // First tick snaps back to the Monday at or before the span start.
    expect(ticks[0].iso).toBe('2026-07-06');
    expect(ticks.every((t) => new Date(`${t.iso}T00:00:00`).getDay() === 1)).toBe(true);
  });

  it('ticks monthly at month zoom, sized by the days each month contributes', () => {
    const ticks = axisTicks({ start: '2026-07-01', end: '2026-09-30' }, 'month');
    expect(ticks.map((t) => t.iso)).toEqual(['2026-07-01', '2026-08-01', '2026-09-01']);
    expect(ticks.map((t) => t.days)).toEqual([31, 31, 30]);
    expect(ticks.map((t) => t.label)).toEqual(['Jul', 'Aug', 'Sep']);
  });

  it('clips the first and last tick to the axis rather than overhanging it', () => {
    const ticks = axisTicks({ start: '2026-07-15', end: '2026-08-10' }, 'month');
    expect(ticks[0].days).toBe(31); // Jul 1 → Jul 31, the month's own width
    expect(ticks[1].days).toBe(10); // Aug 1 → Aug 10, clipped at the axis end
  });

  it('labels only quarter starts at quarter zoom, where months would collide', () => {
    const ticks = axisTicks({ start: '2026-01-01', end: '2026-06-30' }, 'quarter');
    expect(ticks.map((t) => t.label)).toEqual(['Jan', '', '', 'Apr', '', '']);
    expect(ticks.filter((t) => t.major).map((t) => t.iso)).toEqual(['2026-01-01', '2026-04-01']);
  });

  it('positions a bar by day offset and inclusive width', () => {
    const axis = { start: '2026-07-01', end: '2026-07-31' };
    const geo = barGeometry({ start: '2026-07-03', end: '2026-07-05' }, axis, 'day');
    expect(geo.left).toBe(2 * PX_PER_DAY.day);
    expect(geo.width).toBe(3 * PX_PER_DAY.day);
  });

  it('keeps a one-day bar visible at the coarsest zoom', () => {
    const axis = { start: '2026-01-01', end: '2026-12-31' };
    const geo = barGeometry({ start: '2026-07-03', end: '2026-07-03' }, axis, 'quarter');
    // 1 day × 1.8px would round away to a sliver; the floor keeps it clickable.
    expect(geo.width).toBeGreaterThanOrEqual(3);
  });

  it('sizes the axis to its day count', () => {
    expect(axisWidth({ start: '2026-07-01', end: '2026-07-10' }, 'day')).toBe(10 * PX_PER_DAY.day);
  });
});

describe('dependencies', () => {
  const a = makeEntry({ path: 'items/a.md', filename: 'a.md', title: 'A' });
  const b = makeEntry({
    path: 'items/b.md', filename: 'b.md', title: 'B',
    relationships: { blocked_by: ['a'] },
  });
  const entries = [a, b];

  it('resolves an explicit dependency field', () => {
    expect(dependenciesOf(b, 'blocked_by', entries).map((e) => e.path)).toEqual(['items/a.md']);
  });

  it('never infers one — an unset field means no arrows', () => {
    expect(dependenciesOf(b, undefined, entries)).toEqual([]);
    expect(dependenciesOf(b, '', entries)).toEqual([]);
  });

  it('drops links that resolve to nothing instead of drawing an edge to null', () => {
    const dangling = makeEntry({ path: 'items/c.md', relationships: { blocked_by: ['ghost'] } });
    expect(dependenciesOf(dangling, 'blocked_by', entries)).toEqual([]);
  });

  it('flags an edge whose predecessor has not finished before its successor starts', () => {
    expect(
      isSlipping({ start: '2026-07-01', end: '2026-07-10' }, { start: '2026-07-05', end: '2026-07-20' }),
    ).toBe(true);
    expect(
      isSlipping({ start: '2026-07-01', end: '2026-07-04' }, { start: '2026-07-05', end: '2026-07-20' }),
    ).toBe(false);
  });
});
