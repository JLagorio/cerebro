import { describe, expect, it } from 'vitest';
import { endFromDuration, readIcsDuration, readIcsTime, resolveZone } from './icsTime';
import { isDateText } from './dateGrammar';
const read = (value: string, zone?: string) =>
  readIcsTime({ name: 'DTSTART', value, params: zone ? { TZID: [zone] } : {} });
describe('calendar time', () => {
  it.each([
    ['20260703T090000', 'Europe/Paris', '2026-07-03T09:00:00+02:00'],
    ['20261203T090000', 'Europe/Paris', '2026-12-03T09:00:00+01:00'],
    ['20260703T090000', 'America/Los_Angeles', '2026-07-03T09:00:00-07:00'],
    ['20260703T090000', 'Asia/Kolkata', '2026-07-03T09:00:00+05:30'],
    ['20260703T090000', 'W. Europe Standard Time', '2026-07-03T09:00:00+02:00'],
  ])('keeps the offset for %s in %s', (raw, zone, value) => {
    expect(read(raw, zone)).toMatchObject({ kind: 'zoned', value, issue: null });
    expect(isDateText(value)).toBe(true);
  });
  it('keeps UTC independent of a conflicting TZID', () => {
    expect(read('20260703T090013Z', 'Imaginary/Zone')).toMatchObject({
      kind: 'utc',
      value: '2026-07-03T09:00:13Z',
      zone: 'UTC',
      secondsDropped: false,
    });
  });
  it('keeps all-day dates and validates their calendar day', () => {
    expect(read('20260703')).toMatchObject({ kind: 'date', value: '2026-07-03', epoch: null });
    expect(read('20260230')).toBeNull();
    expect(read('20260703T250000')).toBeNull();
    expect(read('20260703T0900')).toBeNull();
  });
  it('keeps floating time and counts dropped nonzero seconds', () => {
    expect(read('20260703T090013')).toMatchObject({
      kind: 'floating',
      value: '2026-07-03T09:00',
      secondsDropped: true,
      issue: null,
    });
    expect(read('20260703T090000')?.secondsDropped).toBe(false);
  });
  it('keeps an unknown TZID and names the uncertainty', () => {
    expect(read('20260703T090000', 'Imaginary/Zone')).toMatchObject({
      kind: 'floating',
      value: '2026-07-03T09:00',
      issue: 'unknown_zone',
      zone: 'Imaginary/Zone',
    });
    expect(resolveZone('constructor')).toBeNull();
    expect(resolveZone('W. Europe Standard Time')).toBe('Europe/Berlin');
  });
  it.each([
    ['20260308T023000', 'gap'],
    ['20261101T013000', 'ambiguous'],
  ])('keeps %s floating across the Los Angeles %s', (value, issue) => {
    const start = read(value, 'America/Los_Angeles')!;
    expect(start).toMatchObject({ kind: 'floating', epoch: null, issue });
    expect(endFromDuration(start, 'PT2H')).toMatchObject({ kind: 'floating', epoch: null, issue });
  });
  it('adds calendar days before elapsed hours across DST', () => {
    const start = read('20260307T120000', 'America/Los_Angeles')!;
    const day = endFromDuration(start, 'P1D')!;
    const hours = endFromDuration(start, 'PT24H')!;
    expect(day.value).toBe('2026-03-08T12:00:00-07:00');
    expect(day.epoch! - start.epoch!).toBe(23 * 3600_000);
    expect(hours.value).toBe('2026-03-08T13:00:00-07:00');
    expect(endFromDuration(start, 'P1DT2H')?.value).toBe('2026-03-08T14:00:00-07:00');
  });
  it('an elapsed duration identifies its end even during a repeated hour', () => {
    const start = read('20261101T003000', 'America/Los_Angeles')!;
    expect(endFromDuration(start, 'PT2H')?.value).toBe('2026-11-01T01:30:00-08:00');
  });
  it('handles day-only durations without inventing wall times', () => {
    expect(endFromDuration(read('20261231')!, 'P1D')?.value).toBe('2027-01-01');
    expect(endFromDuration(read('20261231')!, 'PT1H')).toBeNull();
    expect(endFromDuration(read('20260703T090000Z')!, 'PT30M')?.value).toBe('2026-07-03T09:30:00Z');
  });
  it('rejects out-of-order, negative, incomplete and overflowing durations', () => {
    for (const raw of [
      'P',
      'PT',
      'P1DT',
      '-P1D',
      'PT1M1H',
      'P1W1D',
      'P1Y',
      'PT1.5H',
      'P999999999999999999999W',
    ])
      expect(readIcsDuration(raw), raw).toBeNull();
    expect(readIcsDuration('P2W')).toEqual({ days: 14, seconds: 0 });
    expect(readIcsDuration('+P1DT2H3M4S')).toEqual({ days: 1, seconds: 7384 });
    expect(readIcsDuration('PT0S')).toEqual({ days: 0, seconds: 0 });
  });
});
