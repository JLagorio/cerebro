import { describe, expect, it } from 'vitest';
import { parseSchedulePhrase } from './schedulePhrase';

const NOW = new Date(2026, 9, 15, 10, 15); // Thursday, in this computer's local time.
const UNREADABLE =
  "Cerebro couldn't read that. Try “weekdays at 9am”, “mondays and thursdays at 5pm”, “the last day of the month at 6pm” or “once on Oct 20 at 3pm”.";

describe('parseSchedulePhrase', () => {
  it.each([
    ['hourly', 'hourly'],
    ['every hour', 'hourly'],
    [' DAILY 9:00 ', 'daily 09:00'],
    ['weekly Thursday,Monday 17:00', 'weekly mon,thu 17:00'],
    ['daily at 9am', 'daily 09:00'],
    ['every day 9 am', 'daily 09:00'],
    ['weekdays 9:30', 'weekdays 09:30'],
    ['every weekday at 9:30pm', 'weekdays 21:30'],
    ['weekends at 17:00', 'weekly sun,sat 17:00'],
    ['every weekend noon', 'weekly sun,sat 12:00'],
    ['every friday at 5:30pm', 'weekly fri 17:30'],
    ['mondays and thursdays at 5pm', 'weekly mon,thu 17:00'],
    ['mon, wed & fri at 9', 'weekly mon,wed,fri 09:00'],
    ['Mondays, Wednesdays, and Fridays at 09:00', 'weekly mon,wed,fri 09:00'],
    ['MONS & THUS AT 17', 'weekly mon,thu 17:00'],
    ['daily midnight', 'daily 00:00'],
    ['daily 12am', 'daily 00:00'],
    ['daily 12pm', 'daily 12:00'],
    ['daily at 0', 'daily 00:00'],
    ['monthly on the 15th at 9am', 'monthly 15 09:00'],
    ['monthly on the last day at 6pm', 'monthly last 18:00'],
    ['the 28th of every month at 17:00', 'monthly 28 17:00'],
    ['first of the month at noon', 'monthly 1 12:00'],
    ['the last day of the month at 6pm', 'monthly last 18:00'],
    ['end of the month 9:30pm', 'monthly last 21:30'],
    ['once on 2026-10-20 at 3pm', 'once 2026-10-20 15:00'],
    ['on oct 20 at 3pm', 'once 2026-10-20 15:00'],
    ['once october 20 2026 at 3pm', 'once 2026-10-20 15:00'],
    ['once on 20 oct at 3pm', 'once 2026-10-20 15:00'],
    ['once on 20 oct 2026 at noon', 'once 2026-10-20 12:00'],
    ['on October 20th, 2026 at 3pm', 'once 2026-10-20 15:00'],
    ['once on today at 11', 'once 2026-10-15 11:00'],
    ['on tomorrow at 9am', 'once 2026-10-16 09:00'],
    ['tomorrow at 9am', 'once 2026-10-16 09:00'],
    ['once on this thursday at 11', 'once 2026-10-15 11:00'],
    ['once on this friday at 9am', 'once 2026-10-16 09:00'],
    ['once on next thursday at 9am', 'once 2026-10-22 09:00'],
    ['once on next monday at 9am', 'once 2026-10-19 09:00'],
    ['once on oct 15 at 9am', 'once 2027-10-15 09:00'],
    ['once on oct 15 at 11am', 'once 2026-10-15 11:00'],
    ['once on feb 29 at 9am', 'once 2028-02-29 09:00'],
    ['once 2028-02-29 09:00', 'once 2028-02-29 09:00'],
  ])('turns %s into the validated schedule %s', (phrase, schedule) => {
    expect(parseSchedulePhrase(phrase, NOW)).toMatchObject({ ok: true, schedule });
  });

  it('describes the normalized result instead of echoing the input', () => {
    expect(parseSchedulePhrase('THURSDAYS & MONDAYS 5PM', NOW)).toEqual({
      ok: true,
      schedule: 'weekly mon,thu 17:00',
      words: 'Every Monday and Thursday at 17:00',
    });
  });

  it.each(['weekdays', 'mondays and thursdays', 'first of the month', 'once on 2026-10-20'])(
    'asks for a time in %s',
    (phrase) => {
      expect(parseSchedulePhrase(phrase, NOW)).toEqual({
        ok: false,
        reason: 'Add a time, like “at 9am”.',
      });
    },
  );

  it.each(['hourly at 9am', 'every hour 9:00', 'hourly at noon'])(
    'refuses a time added to %s',
    (phrase) => {
      expect(parseSchedulePhrase(phrase, NOW)).toEqual({
        ok: false,
        reason: 'Hourly runs start on the hour, so leave the time out.',
      });
    },
  );

  it.each([
    ['every 30th', 30],
    ['every 30th at 9am', 30],
    ['monthly 29 09:00', 29],
    ['the 31st of every month at noon', 31],
  ])('explains why %s cannot recur monthly', (phrase, day) => {
    expect(parseSchedulePhrase(phrase, NOW)).toEqual({
      ok: false,
      reason: `Not every month has a ${day}th, so Cerebro takes days 1 to 28 — or say “the last day of the month”.`,
    });
  });

  it.each([
    ['once 2026-02-29 09:00', '2026-02-29'],
    ['once on 2026-04-31 at 9am', '2026-04-31'],
    ['once on feb 30 at noon', 'feb 30'],
  ])('rejects an impossible date without rolling it into another month: %s', (phrase, date) => {
    expect(parseSchedulePhrase(phrase, NOW)).toEqual({
      ok: false,
      reason: `There is no ${date}.`,
    });
  });

  it.each([
    'once 2026-10-15 10:15',
    'once on today at 9am',
    'on this thursday at 9am',
    'once on october 15 2026 at 9am',
    'once on 2025-10-20 at 9am',
  ])('refuses a one-off that has already passed: %s', (phrase) => {
    expect(parseSchedulePhrase(phrase, NOW)).toEqual({
      ok: false,
      reason: 'That time has already passed — pick a later one.',
    });
  });

  it.each([
    '',
    'every couple of days at 9am',
    'daily 9',
    'daily at 24:00',
    'daily at 12:60',
    'daily at 0am',
    'daily at 13pm',
    'daily at 9:3',
    'daily at 9am at 10am',
    'daily at 9am and 10am',
    'daily 09:00; weekly mon 17:00',
    'mondays mondays at 9am',
    'mondays and mondays at 9am',
    'mondays, at 9am',
    'weekly fri,fri 09:00',
    'first and last of the month at 9am',
    'every 1th at 9am',
    'monthly 0 09:00',
    'once on this someday at 9am',
    'once on this thursday or friday at 9am',
    'once on next monday and wednesday at 9am',
    'once on 10/20 at 9am',
    'weekdays at 9am UTC',
  ])('refuses unsupported or ambiguous input: %s', (phrase) => {
    expect(parseSchedulePhrase(phrase, NOW)).toEqual({ ok: false, reason: UNREADABLE });
  });

  it('uses local year rollover for relative dates without mutating now', () => {
    const now = new Date(2026, 11, 31, 23, 59);
    const before = now.getTime();
    expect(parseSchedulePhrase('tomorrow at midnight', now)).toMatchObject({
      ok: true,
      schedule: 'once 2027-01-01 00:00',
    });
    expect(now.getTime()).toBe(before);
  });

  it('finds a leap day across the century that has none', () => {
    expect(parseSchedulePhrase('once on feb 29 at 9am', new Date(2096, 2, 1))).toMatchObject({
      ok: true,
      schedule: 'once 2104-02-29 09:00',
    });
  });

  it('refuses an unavailable clock', () => {
    expect(parseSchedulePhrase('daily at 9am', new Date(Number.NaN))).toEqual({
      ok: false,
      reason: UNREADABLE,
    });
  });
});
