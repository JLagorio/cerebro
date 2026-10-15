import { afterEach, describe, expect, it } from 'vitest';
import { parseDateProperty } from './dates';
import {
  clockOf,
  MINUTES_PER_DAY,
  minuteOf,
  packDay,
  PACK_FLOOR,
  placementOf,
  placementOfValue,
  type Placement,
} from './timeGrid';
import { makeEntry } from './testHelpers';
import type { Entry } from './types';

const placed = (raw: unknown, fixed = false): Placement => {
  const value = parseDateProperty(raw);
  if (value === null) throw new Error(`not a date: ${JSON.stringify(raw)}`);
  return placementOfValue(value, fixed);
};

describe('minuteOf / clockOf', () => {
  it('round-trips a wall time, and 1440 reads as the midnight it is', () => {
    expect(minuteOf('10:30')).toBe(630);
    expect(clockOf(630)).toBe('10:30');
    expect(clockOf(MINUTES_PER_DAY)).toBe('00:00');
  });
});

/** The placement table (M61.8): where a value goes on a Week or Day grid. */
describe('placementOfValue', () => {
  it.each<[string, unknown, Placement]>([
    [
      'a date only is all day',
      '2026-07-28',
      { kind: 'allDay', span: { start: '2026-07-28', end: '2026-07-28' } },
    ],
    [
      'a date-only range is all day across its days',
      { start: '2026-07-28', end: '2026-07-30' },
      { kind: 'allDay', span: { start: '2026-07-28', end: '2026-07-30' } },
    ],
    [
      'a timed range inside one day is a block',
      { start: '2026-07-28 10:00', end: '2026-07-28 11:00' },
      { kind: 'timed', day: '2026-07-28', start: 600, end: 660, fixed: false },
    ],
    [
      'an open end is a point',
      { start: '2026-07-28 10:00', end: null },
      { kind: 'point', day: '2026-07-28', at: 600, fixed: false },
    ],
    [
      'a scalar with a time is a point',
      '2026-07-28 09:15',
      { kind: 'point', day: '2026-07-28', at: 555, fixed: false },
    ],
    [
      'an end without a time on the same day is a point',
      { start: '2026-07-28 10:00', end: '2026-07-28' },
      { kind: 'point', day: '2026-07-28', at: 600, fixed: false },
    ],
    [
      'an end equal to the start is a point',
      { start: '2026-07-28 10:00', end: '2026-07-28 10:00' },
      { kind: 'point', day: '2026-07-28', at: 600, fixed: false },
    ],
    [
      'a backwards end is a point',
      { start: '2026-07-28 10:00', end: '2026-07-28 09:00' },
      { kind: 'point', day: '2026-07-28', at: 600, fixed: false },
    ],
    [
      'a backwards end on an earlier day is a point',
      { start: '2026-07-28 10:00', end: '2026-07-27 12:00' },
      { kind: 'point', day: '2026-07-28', at: 600, fixed: false },
    ],
    [
      '00:00 the next day ends at 1440',
      { start: '2026-07-28 22:00', end: '2026-07-29 00:00' },
      { kind: 'timed', day: '2026-07-28', start: 1320, end: 1440, fixed: false },
    ],
    [
      'a timed range across days is all day',
      { start: '2026-07-28 22:00', end: '2026-07-30 09:00' },
      { kind: 'allDay', span: { start: '2026-07-28', end: '2026-07-30' } },
    ],
    [
      'a timed range ending at a later midnight is all day, short of that midnight',
      { start: '2026-07-28 22:00', end: '2026-07-30 00:00' },
      { kind: 'allDay', span: { start: '2026-07-28', end: '2026-07-29' } },
    ],
  ])('%s', (_name, raw, expected) => {
    expect(placed(raw)).toEqual(expected);
  });

  it('carries fixed through', () => {
    expect(placed('2026-07-28 09:15', true)).toMatchObject({ kind: 'point', fixed: true });
  });
});

/**
 * An instant is a moment (dates.v1.json): it lands at the wall time this
 * machine's clock said, and says so (`fixed`). vitest pins no zone, so each
 * case sets one and puts it back (the KnowledgePanel.test precedent).
 */
describe('placementOf an instant', () => {
  const tz = process.env.TZ;
  afterEach(() => {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  const meeting = (window: unknown): Entry =>
    makeEntry({
      path: 'records/meetings/sync.md',
      title: 'Sync',
      type: 'Meeting',
      properties: { window } as unknown as Entry['properties'],
    });

  it('lands at its Sydney wall time', () => {
    process.env.TZ = 'Australia/Sydney';
    // 23:00Z on the 27th is 09:00 AEST on the 28th.
    const entry = meeting({ start: '2026-07-27T23:00:00Z', end: '2026-07-28T00:00:00Z' });
    expect(placementOf(entry, 'window')).toEqual({
      kind: 'timed',
      day: '2026-07-28',
      start: 540,
      end: 600,
      fixed: true,
    });
  });

  it('lands at its Los Angeles wall time', () => {
    process.env.TZ = 'America/Los_Angeles';
    // 23:00Z on the 27th is 16:00 PDT on the 27th.
    const entry = meeting({ start: '2026-07-27T23:00:00Z', end: '2026-07-28T00:00:00Z' });
    expect(placementOf(entry, 'window')).toEqual({
      kind: 'timed',
      day: '2026-07-27',
      start: 960,
      end: 1020,
      fixed: true,
    });
  });

  it('a floating time is never fixed', () => {
    const entry = meeting('2026-07-28 09:00');
    expect(placementOf(entry, 'window')).toMatchObject({ fixed: false });
  });

  it('is null without a field or a date', () => {
    expect(placementOf(meeting('2026-07-28'), null)).toBeNull();
    expect(placementOf(meeting('soon'), 'window')).toBeNull();
  });
});

describe('packDay', () => {
  it('splits two overlapping items into halves', () => {
    const slots = packDay([
      { key: 'a', start: 600, end: 660 },
      { key: 'b', start: 630, end: 690 },
    ]);
    expect(slots.get('a')).toEqual({ col: 0, cols: 2 });
    expect(slots.get('b')).toEqual({ col: 1, cols: 2 });
  });

  it('makes one cluster of a chain of overlaps, reusing a freed column', () => {
    // a overlaps b, b overlaps c, a and c do not: two columns for all three.
    const slots = packDay([
      { key: 'a', start: 600, end: 660 },
      { key: 'b', start: 640, end: 720 },
      { key: 'c', start: 700, end: 760 },
    ]);
    expect(slots.get('a')).toEqual({ col: 0, cols: 2 });
    expect(slots.get('b')).toEqual({ col: 1, cols: 2 });
    expect(slots.get('c')).toEqual({ col: 0, cols: 2 });
  });

  it('leaves separate items full width', () => {
    const slots = packDay([
      { key: 'a', start: 600, end: 660 },
      { key: 'b', start: 660, end: 720 },
      { key: 'c', start: 900, end: 960 },
    ]);
    for (const key of ['a', 'b', 'c']) expect(slots.get(key)).toEqual({ col: 0, cols: 1 });
  });

  it('packs a point as PACK_FLOOR minutes', () => {
    expect(PACK_FLOOR).toBe(30);
    // A point at 10:00 covers 10:00–10:30 for packing: it collides with a
    // block at 10:20, and not with one at 10:30.
    const close = packDay([
      { key: 'p', start: 600, end: 600 },
      { key: 'b', start: 620, end: 700 },
    ]);
    expect(close.get('p')).toEqual({ col: 0, cols: 2 });
    const apart = packDay([
      { key: 'p', start: 600, end: 600 },
      { key: 'b', start: 630, end: 700 },
    ]);
    expect(apart.get('p')).toEqual({ col: 0, cols: 1 });
  });

  it('puts the longer item first on a shared start', () => {
    const slots = packDay([
      { key: 'short', start: 600, end: 630 },
      { key: 'long', start: 600, end: 720 },
    ]);
    expect(slots.get('long')).toEqual({ col: 0, cols: 2 });
    expect(slots.get('short')).toEqual({ col: 1, cols: 2 });
  });
});
