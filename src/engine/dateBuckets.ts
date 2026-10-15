import { todayIso } from '@/lib/templates';
import { readDateValue, parseDateText } from './dateGrammar';
import { addDays, fromIsoDate, parseDateProperty, serializeDateProperty } from './dates';
import type { DateBucketing, Entry, FieldKind, Schema } from './types';

export interface BandContext {
  today: string;
  weekStart: 0 | 1;
}

/** The only clock read in date banding; callers may pin the entire tree. */
export function bandContext(): BandContext {
  return { today: todayIso(), weekStart: 0 };
}

export function isDateKind(kind: FieldKind | undefined): boolean {
  return (
    kind === 'date' ||
    kind === 'daterange' ||
    kind === 'created_time' ||
    kind === 'last_edited_time'
  );
}

/** The shared grammar reads range starts and converts instants to local days. */
export type BandEndpoint = 'start' | 'end';

/** A declared range deadline is when the range ends; an open range uses its start. */
export function bandEndpoint(entry: Entry, field: string, schema: Schema): BandEndpoint {
  return entry.type !== null && schema.types.get(entry.type)?.deadline === field ? 'end' : 'start';
}

export function bandDayOf(raw: unknown, endpoint: BandEndpoint = 'start'): string | null {
  const value = readDateValue(raw);
  return (endpoint === 'end' ? (value?.end ?? value?.start) : value?.start)?.date ?? null;
}

export interface DateBand {
  key: string;
  label: string;
  start: string | null;
  end: string | null;
  seedable?: false;
  /** Future timestamps are unusual enough to show only when present. */
  filledOnly?: true;
  color?: string;
}

const earlier = (a: string, b: string) => (a < b ? a : b);
const later = (a: string, b: string) => (a > b ? a : b);

function weekOf(day: string, weekStart: 0 | 1): string {
  return addDays(day, -((fromIsoDate(day).getDay() - weekStart + 7) % 7));
}

function monthAfter(start: string): string {
  const year = Number(start.slice(0, 4));
  const month = Number(start.slice(5, 7));
  return `${String(month === 12 ? year + 1 : year).padStart(4, '0')}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`;
}

/** Disjoint intervals, in reading order. A covered interval never emits an
 * empty column: Tomorrow can consume this week's last day, and Past 7 days
 * can consume the opening days of a month. */
export function dateScale(kind: FieldKind, ctx: BandContext, deadline = false): DateBand[] {
  const { today } = ctx;
  const day = (key: string, label: string): DateBand => ({ key, label, start: key, end: key });
  const interval = (
    key: string,
    label: string,
    start: string | null,
    end: string | null,
  ): DateBand => ({
    key: `rel:${key}`,
    label,
    start,
    end,
    seedable: false,
  });
  let bands: DateBand[];
  if (kind === 'created_time' || kind === 'last_edited_time') {
    const month = `${today.slice(0, 7)}-01`;
    const lastEnd = addDays(month, -1);
    const recentEnd = addDays(today, -7);
    bands = [
      { ...interval('later', 'Later', addDays(today, 1), null), filledOnly: true },
      day(today, 'Today'),
      day(addDays(today, -1), 'Yesterday'),
      interval('past-7-days', 'Past 7 days', addDays(today, -6), addDays(today, -2)),
      interval('earlier-this-month', 'Earlier this month', month, recentEnd),
      interval(
        'last-month',
        'Last month',
        `${lastEnd.slice(0, 7)}-01`,
        earlier(lastEnd, recentEnd),
      ),
      interval('older', 'Older', null, addDays(`${lastEnd.slice(0, 7)}-01`, -1)),
    ];
  } else {
    const nextStart = addDays(weekOf(today, ctx.weekStart), 7);
    const afterTomorrow = addDays(today, 2);
    bands = [
      ...(deadline
        ? [
            {
              ...interval('overdue', 'Overdue', null, addDays(today, -1)),
              color: 'var(--danger-600)',
            },
            {
              ...interval('earlier', 'Earlier', null, addDays(today, -1)),
              filledOnly: true as const,
            },
          ]
        : [interval('earlier', 'Earlier', null, addDays(today, -1))]),
      day(today, 'Today'),
      day(addDays(today, 1), 'Tomorrow'),
      interval('this-week', 'This week', afterTomorrow, addDays(nextStart, -1)),
      interval('next-week', 'Next week', later(nextStart, afterTomorrow), addDays(nextStart, 6)),
      interval('later', 'Later', addDays(nextStart, 7), null),
    ];
  }
  return bands.filter((b) => b.start === null || b.end === null || b.start <= b.end);
}

const dayLabel = (day: string) =>
  fromIsoDate(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** Calendar keys encode their immutable bounds, so a saved chart drilldown
 * means the same interval after tomorrow's relative bands move. */
export function calendarBandBounds(key: string, unit: DateBucketing): [string, string] | null {
  if (unit === 'day') return parseDateText(key)?.date === key ? [key, key] : null;
  if (unit === 'week' && key.startsWith('week:')) {
    const start = key.slice(5);
    return parseDateText(start)?.date === start ? [start, addDays(start, 6)] : null;
  }
  if (unit === 'month' && /^month:\d{4}-\d{2}$/.test(key)) {
    const start = `${key.slice(6)}-01`;
    return bandDayOf(start) === start ? [start, addDays(monthAfter(start), -1)] : null;
  }
  if (unit === 'year' && /^year:\d{4}$/.test(key)) {
    const year = key.slice(5);
    return [`${year}-01-01`, `${year}-12-31`];
  }
  return null;
}

export function dateBandFor(
  day: string,
  kind: FieldKind,
  unit: DateBucketing | undefined,
  ctx: BandContext,
  options: { deadline?: boolean; finished?: boolean } = {},
): DateBand {
  if (unit === undefined && options.deadline && day < ctx.today) {
    return dateScale(kind, ctx, true).find(
      (band) => band.key === (options.finished ? 'rel:earlier' : 'rel:overdue'),
    )!;
  }
  if (unit === undefined)
    return dateScale(kind, ctx).find(
      (b) => (b.start === null || day >= b.start) && (b.end === null || day <= b.end),
    )!;
  if (unit === 'day') return { key: day, label: dayLabel(day), start: day, end: day };
  const key =
    unit === 'week'
      ? `week:${weekOf(day, ctx.weekStart)}`
      : unit === 'month'
        ? `month:${day.slice(0, 7)}`
        : `year:${day.slice(0, 4)}`;
  const [start, end] = calendarBandBounds(key, unit)!;
  const label =
    unit === 'week'
      ? `Week of ${dayLabel(start)}`
      : unit === 'month'
        ? fromIsoDate(start).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
        : day.slice(0, 4);
  return { key, label, start, end, seedable: false };
}

/** Move calendar days, preserving local wall time and both range endpoints
 * across DST. A range with no end remains open. */
export function dropDateValue(
  raw: unknown,
  day: string,
  kind: 'date' | 'daterange',
  endpoint: BandEndpoint = 'start',
): unknown {
  const current = parseDateProperty(raw);
  if (current === null) return kind === 'daterange' ? { start: day, end: null } : day;
  const delta = Math.round(
    (fromIsoDate(day).getTime() -
      fromIsoDate(endpoint === 'end' ? (current.end ?? current.start) : current.start).getTime()) /
      86_400_000,
  );
  return serializeDateProperty(
    {
      ...current,
      start: addDays(current.start, delta),
      end: current.end === null ? null : addDays(current.end, delta),
    },
    kind,
  );
}
