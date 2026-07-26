import { describe, expect, it } from 'vitest';
import {
  addDays,
  chipPropsToDateValue,
  dateValueToChipProps,
  formatDate,
  formatDateValue,
  formatTime,
  makeDateValue,
  parseDateToken,
  remindAt,
  serializeDateValue,
} from './dates';

const TODAY = '2026-07-26';

describe('date token round trip', () => {
  it('bare date serializes with no flags (tasks-engine compatible)', () => {
    expect(serializeDateValue(makeDateValue('2026-07-26'))).toBe('📅 2026-07-26');
  });

  it('parses a bare date', () => {
    const v = parseDateToken('📅 2026-07-26');
    expect(v).not.toBeNull();
    expect(v?.start).toBe('2026-07-26');
    expect(v?.end).toBeNull();
    expect(v?.format).toBe('full');
  });

  it('round-trips a full range with times and flags', () => {
    const token = '📅 2026-07-26 16:00 → 2026-08-01 16:00 ((relative|24h|remind:1d))';
    const v = parseDateToken(token);
    expect(v).not.toBeNull();
    expect(v?.end).toBe('2026-08-01');
    expect(v?.startTime).toBe('16:00');
    expect(v?.timeFormat).toBe('24');
    expect(v?.remind).toBe('1d');
    expect(serializeDateValue(v!)).toBe(token);
  });

  it('rejects non-token text', () => {
    expect(parseDateToken('no date here')).toBeNull();
    expect(parseDateToken('📅 not-a-date')).toBeNull();
  });

  it('ignores unknown flags instead of failing', () => {
    const v = parseDateToken('📅 2026-07-26 ((bogus|relative))');
    expect(v?.format).toBe('relative');
  });
});

describe('formatting', () => {
  it('formats every date style', () => {
    expect(formatDate('2026-07-26', 'full', TODAY)).toBe('July 26, 2026');
    expect(formatDate('2026-07-26', 'short', TODAY)).toBe('Jul 26, 2026');
    expect(formatDate('2026-07-26', 'mdy', TODAY)).toBe('07/26/2026');
    expect(formatDate('2026-07-26', 'dmy', TODAY)).toBe('26/07/2026');
    expect(formatDate('2026-07-26', 'ymd', TODAY)).toBe('2026/07/26');
  });

  it('relative labels: today, tomorrow, yesterday, next weekday', () => {
    expect(formatDate(TODAY, 'relative', TODAY)).toBe('Today');
    expect(formatDate('2026-07-27', 'relative', TODAY)).toBe('Tomorrow');
    expect(formatDate('2026-07-25', 'relative', TODAY)).toBe('Yesterday');
    // 2026-08-01 is the Saturday six days out.
    expect(formatDate('2026-08-01', 'relative', TODAY)).toBe('Next Saturday');
    expect(formatDate('2026-09-10', 'relative', TODAY)).toBe('Sep 10');
    expect(formatDate('2027-01-05', 'relative', TODAY)).toBe('Jan 5, 2027');
  });

  it('formats time in both clocks', () => {
    expect(formatTime('16:00', '12')).toBe('4:00 PM');
    expect(formatTime('16:00', '24')).toBe('16:00');
    expect(formatTime('00:30', '12')).toBe('12:30 AM');
    expect(formatTime('16:00', 'hidden')).toBe('');
  });

  it('formats the full Notion-style label', () => {
    const v = parseDateToken('📅 2026-07-26 16:00 → 2026-08-01 16:00 ((relative))');
    expect(formatDateValue(v!, TODAY)).toBe('Today 4:00 PM → Next Saturday 4:00 PM');
  });
});

describe('reminder computation', () => {
  it('date-only events remind at 9:00 on the offset day', () => {
    const v = { ...makeDateValue('2026-07-30'), remind: '1d' as const };
    expect(remindAt(v)).toBe('2026-07-29T09:00');
  });

  it('timed events remind at the event time', () => {
    const v = { ...makeDateValue('2026-07-30'), startTime: '14:30', remind: '1w' as const };
    expect(remindAt(v)).toBe('2026-07-23T14:30');
  });

  it('no reminder → null', () => {
    expect(remindAt(makeDateValue('2026-07-30'))).toBeNull();
  });
});

describe('chip props mapping', () => {
  it('defaults collapse to empty strings and back', () => {
    const props = dateValueToChipProps(makeDateValue('2026-07-26'));
    expect(props).toEqual({
      date: '2026-07-26', end: '', time: '', endTime: '', format: '', timeFormat: '', remind: '',
    });
    expect(chipPropsToDateValue(props)).toEqual(makeDateValue('2026-07-26'));
  });

  it('non-defaults survive the mapping', () => {
    const v = parseDateToken('📅 2026-07-26 09:00 → 2026-07-28 ((short|24h|remind:0d))')!;
    expect(chipPropsToDateValue(dateValueToChipProps(v))).toEqual(v);
  });
});

describe('date math', () => {
  it('addDays crosses month boundaries', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31');
  });
});
