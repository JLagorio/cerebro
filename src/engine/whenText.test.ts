import { describe, expect, it } from 'vitest';
import { localStamp, relativeWhen } from './whenText';

/**
 * The three cases that are not arithmetic (M33b.3): a stamp nothing can
 * parse, a stamp ahead of the clock, and a stamp old enough that a count of
 * days stops being readable. The rest is arithmetic and gets one example
 * each.
 */

const NOW = new Date('2026-07-28T12:00:00Z');

describe('relativeWhen', () => {
  it('says how long ago, at every scale a run can be', () => {
    expect(relativeWhen('2026-07-28T11:59:30Z', NOW)).toBe('just now');
    expect(relativeWhen('2026-07-28T11:59:00Z', NOW)).toBe('1 minute ago');
    expect(relativeWhen('2026-07-28T11:42:00Z', NOW)).toBe('18 minutes ago');
    expect(relativeWhen('2026-07-28T09:00:00Z', NOW)).toBe('3 hours ago');
    expect(relativeWhen('2026-07-27T09:00:00Z', NOW)).toBe('yesterday');
    expect(relativeWhen('2026-07-20T12:00:00Z', NOW)).toBe('8 days ago');
  });

  it('prints the date once a count of days stops being readable', () => {
    // "47 days ago" is a number nobody converts back into a day.
    expect(relativeWhen('2026-06-11T12:00:00Z', NOW)).toBe('2026-06-11');
  });

  it('shows a stamp ahead of the clock as itself rather than as "just now"', () => {
    // Skew, or a machine whose time moved. Rounding it to zero would be the
    // surface covering for the database.
    expect(relativeWhen('2026-07-28T13:30:00Z', NOW)).toBe('2026-07-28 13:30 UTC');
  });

  it('returns an unparseable stamp verbatim rather than guessing at it', () => {
    expect(relativeWhen('not a time', NOW)).toBe('not a time');
  });
});

describe('localStamp', () => {
  it('reads the clock the person is on, which is the clock a schedule is written in', () => {
    const at = new Date(2026, 6, 28, 9, 5);
    expect(localStamp(at)).toBe('2026-07-28 09:05');
  });
});
