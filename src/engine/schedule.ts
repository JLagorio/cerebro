import { addDays, fromIsoDate, toIsoDate } from './dates';
import { resolveTarget } from './wikilink';
import type { Entry, FieldKind, Presentation } from './types';

/**
 * Placing records on a date axis (M10) — the one engine behind Calendar,
 * Timeline, and Gantt.
 *
 * Those three views differ in geometry, not in arithmetic: all of them need to
 * know which property carries a record's dates, what span that property means,
 * and how a span maps onto a row of day columns. Keeping that here is what lets
 * the three renderers be layout code and nothing else.
 *
 * Everything is inclusive ISO calendar dates in LOCAL time. Not timestamps: a
 * task due the 3rd is due the 3rd in the user's timezone, and routing that
 * through UTC is how a due date lands on the 2nd for half the world.
 */

export type Zoom = NonNullable<Presentation['zoom']>;

/** An inclusive date span. `end === start` is a single-day record. */
export interface Span {
  start: string;
  end: string;
}

const ISO = /^(\d{4}-\d{2}-\d{2})/;

/** The date part of a value that may carry a time, or null if it isn't a date. */
function isoDate(raw: string): string | null {
  const m = ISO.exec(raw.trim());
  return m === null ? null : m[1];
}

/**
 * Which property a date view places records by.
 *
 * An explicit `dateField` wins. Otherwise infer: a `daterange` first because it
 * carries both endpoints, then a plain `date`. Inferring matters — a calendar
 * that renders nothing until someone visits settings reads as broken, and the
 * overwhelmingly common case is a type with exactly one date on it.
 */
export function resolveDateField(
  presentation: Presentation,
  fields: { name: string; kind: FieldKind }[],
): string | null {
  if (presentation.dateField !== undefined && presentation.dateField !== '') {
    return presentation.dateField;
  }
  return (
    fields.find((f) => f.kind === 'daterange')?.name ??
    fields.find((f) => f.kind === 'date')?.name ??
    null
  );
}

/** Every field a date view could be keyed on, for the settings picker. */
export function dateFieldOptions(
  fields: { name: string; kind: FieldKind }[],
): { name: string; kind: FieldKind }[] {
  return fields.filter((f) => f.kind === 'date' || f.kind === 'daterange');
}

/**
 * A record's span, or null when it carries no usable date — which is not an
 * error. A calendar's job includes reporting how much of the collection it
 * cannot place (see `unscheduled`).
 */
export function spanOf(entry: Entry, field: string | null): Span | null {
  if (field === null) return null;
  const raw: unknown = entry.properties[field];

  if (typeof raw === 'string') {
    const day = isoDate(raw);
    return day === null ? null : { start: day, end: day };
  }

  // `daterange` arrives as nested YAML, which the parser passes through raw.
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as { start?: unknown; end?: unknown };
    const start = typeof r.start === 'string' ? isoDate(r.start) : null;
    if (start === null) return null;
    const end = typeof r.end === 'string' ? isoDate(r.end) : null;
    // An open or backwards end is a one-day milestone rather than a dropped
    // record: the start date is a fact, and the missing end is not a reason to
    // hide it from the schedule.
    return { start, end: end !== null && end >= start ? end : start };
  }

  return null;
}

/** The records a date view cannot place. */
export function unscheduled(entries: Entry[], field: string | null): Entry[] {
  return entries.filter((e) => spanOf(e, field) === null);
}

/** Tightest span covering all of them; null when none are dated. */
export function spanBounds(spans: Span[]): Span | null {
  if (spans.length === 0) return null;
  let { start, end } = spans[0];
  for (const s of spans) {
    if (s.start < start) start = s.start;
    if (s.end > end) end = s.end;
  }
  return { start, end };
}

/** Inclusive day count — a single-day span is 1, not 0. */
export function dayCount(span: Span): number {
  const ms = fromIsoDate(span.end).getTime() - fromIsoDate(span.start).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

/** Days from the span's start; negative before it. */
export function dayOffset(span: Span, iso: string): number {
  const ms = fromIsoDate(iso).getTime() - fromIsoDate(span.start).getTime();
  return Math.round(ms / 86_400_000);
}

export function eachDay(span: Span): string[] {
  const out: string[] = [];
  for (let i = 0; i < dayCount(span); i += 1) out.push(addDays(span.start, i));
  return out;
}

export function overlaps(a: Span, b: Span): boolean {
  return a.start <= b.end && b.start <= a.end;
}

// --- month grid (Calendar) -------------------------------------------------

/** First of the month `iso` falls in. */
export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function addMonths(iso: string, months: number): string {
  const d = fromIsoDate(monthStart(iso));
  d.setMonth(d.getMonth() + months);
  return toIsoDate(d);
}

/** Last day of the month `iso` falls in. */
export function monthEnd(iso: string): string {
  return addDays(addMonths(iso, 1), -1);
}

/**
 * The six-week grid a month is drawn on, always 42 days starting on the
 * `weekStart` weekday. Fixed height on purpose: a grid that grows to five rows
 * in February and six in March makes the whole page jump when you page months.
 */
export function monthGrid(iso: string, weekStart: 0 | 1 = 0): string[] {
  const first = fromIsoDate(monthStart(iso));
  const lead = (first.getDay() - weekStart + 7) % 7;
  const gridStart = addDays(monthStart(iso), -lead);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

export function isSameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function monthLabel(iso: string): string {
  return `${MONTHS[fromIsoDate(iso).getMonth()]} ${iso.slice(0, 4)}`;
}

export function weekdayLabels(weekStart: 0 | 1 = 0): string[] {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return Array.from({ length: 7 }, (_, i) => names[(i + weekStart) % 7]);
}

/** Records whose span covers `day`, in the order given. */
export function onDay(entries: Entry[], field: string | null, day: string): Entry[] {
  return entries.filter((e) => {
    const span = spanOf(e, field);
    return span !== null && span.start <= day && day <= span.end;
  });
}

// --- horizontal axis (Timeline, Gantt) ------------------------------------

/**
 * Column width per day at each zoom. Chosen so one screen holds roughly a
 * fortnight, a quarter, a year, and three years respectively — the four
 * questions people actually bring to a schedule.
 */
export const PX_PER_DAY: Record<Zoom, number> = {
  day: 34,
  week: 13,
  month: 4.2,
  quarter: 1.8,
};

export const ZOOM_LABELS: { value: Zoom; label: string }[] = [
  { value: 'day', label: 'Day' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
];

export interface AxisTick {
  iso: string;
  label: string;
  /** Wider rule and a bolder label — month starts, or quarter starts zoomed out. */
  major: boolean;
  /** Days this tick spans, so a renderer can size its header cell. */
  days: number;
}

/**
 * Padding around the data so bars never start flush against the first pixel,
 * scaled to the zoom: a day view padded by a month would be mostly empty.
 */
const PAD_DAYS: Record<Zoom, number> = { day: 3, week: 7, month: 21, quarter: 60 };

/** The axis span for a data range: padded, and snapped outward to whole units. */
export function axisSpan(data: Span | null, zoom: Zoom, today: string): Span {
  // Nothing dated yet — still draw an axis, centred on today, so the view
  // reads as "an empty schedule" rather than as a failure to render.
  const base = data ?? { start: today, end: today };
  const pad = PAD_DAYS[zoom];
  const start = addDays(base.start, -pad);
  const end = addDays(base.end, pad);
  if (zoom === 'day' || zoom === 'week') return { start, end };
  return { start: monthStart(start), end: monthEnd(end) };
}

export function axisTicks(span: Span, zoom: Zoom): AxisTick[] {
  const ticks: AxisTick[] = [];

  if (zoom === 'day') {
    for (const iso of eachDay(span)) {
      const d = fromIsoDate(iso);
      ticks.push({
        iso,
        label: String(d.getDate()),
        // Week boundaries are the readable rules at this zoom.
        major: d.getDay() === 1,
        days: 1,
      });
    }
    return ticks;
  }

  if (zoom === 'week') {
    // Start on the Monday at or before the span start so weeks line up.
    const first = fromIsoDate(span.start);
    let cursor = addDays(span.start, -((first.getDay() + 6) % 7));
    while (cursor <= span.end) {
      const next = addDays(cursor, 7);
      const visible = { start: cursor < span.start ? span.start : cursor, end: addDays(next, -1) };
      ticks.push({
        iso: cursor,
        label: `${MONTHS[fromIsoDate(cursor).getMonth()].slice(0, 3)} ${fromIsoDate(cursor).getDate()}`,
        major: fromIsoDate(cursor).getDate() <= 7,
        days: Math.min(dayCount(visible), dayCount({ start: cursor, end: span.end })),
      });
      cursor = next;
    }
    return ticks;
  }

  // month and quarter both tick monthly; they differ in what reads as major
  // and in how much room a month gets.
  let cursor = monthStart(span.start);
  while (cursor <= span.end) {
    const monthLast = monthEnd(cursor);
    const label = MONTHS[fromIsoDate(cursor).getMonth()].slice(0, 3);
    ticks.push({
      iso: cursor,
      label: zoom === 'quarter' && fromIsoDate(cursor).getMonth() % 3 !== 0 ? '' : label,
      major: fromIsoDate(cursor).getMonth() % (zoom === 'quarter' ? 3 : 12) === 0,
      days: dayCount({ start: cursor, end: monthLast < span.end ? monthLast : span.end }),
    });
    cursor = addMonths(cursor, 1);
  }
  return ticks;
}

/** Left offset and width in px for a record's bar on the axis. */
export function barGeometry(
  span: Span,
  axis: Span,
  zoom: Zoom,
): { left: number; width: number } {
  const px = PX_PER_DAY[zoom];
  return {
    left: dayOffset(axis, span.start) * px,
    // Minimum 3px so a one-day bar at quarter zoom is still visible rather
    // than rounding away to nothing.
    width: Math.max(dayCount(span) * px, 3),
  };
}

export function axisWidth(axis: Span, zoom: Zoom): number {
  return dayCount(axis) * PX_PER_DAY[zoom];
}

// --- dependencies (Gantt) -------------------------------------------------

/**
 * The records this one waits on, resolved to entries.
 *
 * Only ever an explicit `dependencyField` — never inferred. A guessed relation
 * would draw a critical path the data does not claim, and a schedule that
 * invents its own constraints is worse than one that draws none.
 */
export function dependenciesOf(
  entry: Entry,
  field: string | undefined,
  entries: Entry[],
): Entry[] {
  if (field === undefined || field === '') return [];
  return (entry.relationships[field] ?? [])
    .map((raw) => resolveTarget(raw, entries))
    .filter((e): e is Entry => e !== null);
}

/**
 * A dependency edge that is violated: the predecessor ends at or after the
 * successor starts. Surfacing these is the entire reason a Gantt draws arrows
 * rather than just bars.
 */
export function isSlipping(predecessor: Span, successor: Span): boolean {
  return predecessor.end >= successor.start;
}
