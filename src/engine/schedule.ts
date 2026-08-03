import {
  addDays,
  fromIsoDate,
  makeDateValue,
  parseDateProperty,
  serializeDateProperty,
  toIsoDate,
} from './dates';
import { resolveTarget } from './wikilink';
import type { Entry, FieldKind, Presentation, Schema } from './types';

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
  // M16.23: this used to run its own `^\d{4}-\d{2}-\d{2}` scan over both the
  // scalar and the `{start,end}` mapping — a second date parser, written
  // before M16.14 gave dates a time component, and one that would have had to
  // learn every spelling `parseDateProperty` already knows.
  const value = parseDateProperty(entry.properties[field]);
  if (value === null) return null;
  // An open or backwards end is a one-day milestone rather than a dropped
  // record: the start date is a fact, and the missing end is not a reason to
  // hide it from the schedule.
  const end = value.end !== null && value.end >= value.start ? value.end : value.start;
  return { start: value.start, end };
}

/**
 * The frontmatter value that puts a record on `next` — what a drag writes.
 *
 * Times survive the move. A 9:00 standup dragged to Thursday is still at 9:00,
 * and dropping the time on the way through would silently reschedule the
 * meeting as well as the day. So would re-serializing through anything but
 * `serializeDateProperty`, which is the one place that knows a `date` field
 * stores a scalar and a `daterange` stores a mapping.
 */
export function rescheduleValue(raw: unknown, kind: 'date' | 'daterange', next: Span): unknown {
  const current = parseDateProperty(raw) ?? makeDateValue(next.start);
  // A range stored open (`end: null`) stays open when it is merely MOVED —
  // dragging a record does not claim to know when it finishes. Dragging its
  // right edge does, and that arrives here as an end past the start.
  const keepsEnd = current.end !== null || next.end !== next.start;
  return serializeDateProperty(
    {
      ...current,
      start: next.start,
      end: kind === 'daterange' && keepsEnd ? next.end : null,
    },
    kind,
  );
}

/** The same span `days` later (negative moves it earlier). Duration is kept. */
export function shiftSpan(span: Span, days: number): Span {
  return { start: addDays(span.start, days), end: addDays(span.end, days) };
}

/**
 * One endpoint moved by `days`, the other held.
 *
 * Clamped rather than allowed to invert: dragging a start past its own end
 * should bottom out at a one-day span, not produce a bar drawn backwards that
 * `spanOf` will then silently reinterpret as a milestone on the next read.
 */
export function resizeSpan(span: Span, edge: 'start' | 'end', days: number): Span {
  if (edge === 'start') {
    const start = addDays(span.start, days);
    return { start: start > span.end ? span.end : start, end: span.end };
  }
  const end = addDays(span.end, days);
  return { start: span.start, end: end < span.start ? span.start : end };
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
export function monthGrid(iso: string, weekStart: WeekStart = 0): string[] {
  const first = fromIsoDate(monthStart(iso));
  const lead = (first.getDay() - weekStart + 7) % 7;
  const gridStart = addDays(monthStart(iso), -lead);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

/** Sunday (0) or Monday (1) — the weekday a grid row begins on. */
export type WeekStart = 0 | 1;

/**
 * Which weekday the grid starts on, from the view's own setting.
 *
 * Stored as a NAME rather than an index. `weekStart: monday` is legible in a
 * vault someone edits by hand; `weekStart: 1` is a number you have to know the
 * convention for, and the two plausible conventions disagree.
 */
export function weekStartIndex(presentation: Presentation): WeekStart {
  return presentation.weekStart === 'monday' ? 1 : 0;
}

/** The seven days of the week `iso` falls in. */
export function weekGrid(iso: string, weekStart: WeekStart = 0): string[] {
  const lead = (fromIsoDate(iso).getDay() - weekStart + 7) % 7;
  const first = addDays(iso, -lead);
  return Array.from({ length: 7 }, (_, i) => addDays(first, i));
}

/**
 * The columns a week actually draws. Hiding weekends drops the two days rather
 * than shrinking them — a five-day work week is the whole point of the setting,
 * and a sliver of Saturday still reads as a column you could put something in.
 */
export function visibleDays(days: string[], showWeekends: boolean): string[] {
  if (showWeekends) return days;
  return days.filter((d) => {
    const wd = fromIsoDate(d).getDay();
    return wd !== 0 && wd !== 6;
  });
}

export function isSameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function monthLabel(iso: string): string {
  return `${MONTHS[fromIsoDate(iso).getMonth()]} ${iso.slice(0, 4)}`;
}

/** Heading for a week grid, e.g. "Aug 3 – 9, 2026" or "Aug 31 – Sep 6, 2026". */
export function weekLabel(days: string[]): string {
  if (days.length === 0) return '';
  const first = days[0];
  const last = days[days.length - 1];
  const month = (iso: string) => MONTHS[fromIsoDate(iso).getMonth()].slice(0, 3);
  const day = (iso: string) => Number(iso.slice(8, 10));
  const tail = `${isSameMonth(first, last) ? '' : `${month(last)} `}${day(last)}, ${last.slice(0, 4)}`;
  return `${month(first)} ${day(first)} – ${tail}`;
}

export function weekdayLabels(weekStart: WeekStart = 0, showWeekends = true): string[] {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const all = Array.from({ length: 7 }, (_, i) => (i + weekStart) % 7);
  return all.filter((i) => showWeekends || (i !== 0 && i !== 6)).map((i) => names[i]);
}

/** Records whose span covers `day`, in the order given. */
export function onDay(entries: Entry[], field: string | null, day: string): Entry[] {
  return entries.filter((e) => {
    const span = spanOf(e, field);
    return span !== null && span.start <= day && day <= span.end;
  });
}

/** A record with its span resolved once — the pairing every calendar layout wants. */
export interface Scheduled {
  entry: Entry;
  span: Span;
}

/** One multi-day span, clipped to the week that draws it. */
export interface Segment extends Scheduled {
  /** Index into the week's VISIBLE columns, inclusive. */
  startCol: number;
  endCol: number;
  lane: number;
  continuesLeft: boolean;
  continuesRight: boolean;
}

/**
 * Lay a week's multi-day spans out as continuous bars.
 *
 * Greedy lane packing: earliest start first, longest first on a tie, each bar
 * taking the first lane that is free at its start column.
 *
 * `week` is all seven days; `visible` is the subset actually drawn, which is
 * five of them when weekends are hidden. They are separate arguments because
 * columns and calendar days stopped being the same thing in M16.23: the old
 * version resolved a column with `days.indexOf(span.start)` and fell back to
 * column 0 on -1, so with weekends hidden a Saturday→Tuesday span was either
 * dropped entirely or redrawn as if it began on Monday morning.
 */
export function packWeek(spans: Scheduled[], week: string[], visible: string[]): Segment[] {
  if (visible.length === 0) return [];
  const first = week[0];
  const last = week[week.length - 1];
  const laneEnd: number[] = [];
  return spans
    .filter(({ span }) => span.end > span.start && span.start <= last && span.end >= first)
    .sort((a, b) =>
      a.span.start === b.span.start
        ? b.span.end.localeCompare(a.span.end)
        : a.span.start.localeCompare(b.span.start),
    )
    .flatMap(({ entry, span }) => {
      const startCol = visible.findIndex((d) => d >= span.start);
      // Last visible column at or before the end.
      let endCol = -1;
      for (let i = visible.length - 1; i >= 0; i -= 1) {
        if (visible[i] <= span.end) {
          endCol = i;
          break;
        }
      }
      // Entirely inside the hidden days — a Saturday-to-Sunday span in a
      // weekday-only grid has no column to occupy, and inventing one would put
      // it on a day it does not cover.
      if (startCol === -1 || endCol < startCol) return [];
      let lane = laneEnd.findIndex((end) => end < startCol);
      if (lane === -1) {
        lane = laneEnd.length;
        laneEnd.push(endCol);
      } else {
        laneEnd[lane] = endCol;
      }
      return [
        {
          entry,
          span,
          startCol,
          endCol,
          lane,
          continuesLeft: span.start < first,
          continuesRight: span.end > last,
        },
      ];
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

/**
 * What an unconfigured timeline or gantt opens at.
 *
 * ONE default, because there were three disagreeing (M16.24): TimelineView
 * defaulted to `week`, GanttView to `month`, and the settings panel rendered
 * `?? 'week'` for both — so a gantt nobody had configured showed a scale its
 * own Zoom control denied it was on.
 */
export const DEFAULT_ZOOM: Zoom = 'week';

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

/** First day of the calendar quarter `iso` falls in. */
export function quarterStart(iso: string): string {
  const month = fromIsoDate(iso).getMonth();
  return addMonths(iso, -(month % 3));
}

export function quarterEnd(iso: string): string {
  return monthEnd(addMonths(quarterStart(iso), 2));
}

/** e.g. "Q3 2026". */
export function quarterLabel(iso: string): string {
  return `Q${Math.floor(fromIsoDate(iso).getMonth() / 3) + 1} ${iso.slice(0, 4)}`;
}

/** The axis span for a data range: padded, and snapped outward to whole units. */
export function axisSpan(data: Span | null, zoom: Zoom, today: string): Span {
  // Nothing dated yet — still draw an axis, centred on today, so the view
  // reads as "an empty schedule" rather than as a failure to render.
  const base = data ?? { start: today, end: today };
  const pad = PAD_DAYS[zoom];
  const start = addDays(base.start, -pad);
  const end = addDays(base.end, pad);
  if (zoom === 'day' || zoom === 'week') return { start, end };
  // Quarter zoom snaps to whole QUARTERS, not whole months: its ticks are
  // quarters, and an axis beginning mid-quarter opens on a stub cell labelled
  // for three months that are not all on it.
  if (zoom === 'quarter') return { start: quarterStart(start), end: quarterEnd(end) };
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

  // Days of a unit that are actually ON the axis. Both ends have to clamp: a
  // `Math.min` of the two one-sided counts (the pre-M16.24 version) over-counts
  // a unit clipped at BOTH ends, and the header then draws wider than the axis
  // it heads.
  const visibleDayCount = (from: string, to: string) => {
    const start = from < span.start ? span.start : from;
    const end = to > span.end ? span.end : to;
    return end < start ? 0 : dayCount({ start, end });
  };

  if (zoom === 'week') {
    // Start on the Monday at or before the span start so weeks line up.
    const first = fromIsoDate(span.start);
    let cursor = addDays(span.start, -((first.getDay() + 6) % 7));
    while (cursor <= span.end) {
      const next = addDays(cursor, 7);
      ticks.push({
        iso: cursor,
        label: `${MONTHS[fromIsoDate(cursor).getMonth()].slice(0, 3)} ${fromIsoDate(cursor).getDate()}`,
        major: fromIsoDate(cursor).getDate() <= 7,
        days: visibleDayCount(cursor, addDays(next, -1)),
      });
      cursor = next;
    }
    return ticks;
  }

  // Quarter zoom ticks QUARTERLY. It used to tick monthly and blank the label
  // on two months in three, so two thirds of the header was empty cells and
  // the third that was labelled said "Jul" over a column three months wide.
  if (zoom === 'quarter') {
    let cursor = quarterStart(span.start);
    while (cursor <= span.end) {
      ticks.push({
        iso: cursor,
        label: quarterLabel(cursor),
        major: fromIsoDate(cursor).getMonth() === 0,
        days: visibleDayCount(cursor, quarterEnd(cursor)),
      });
      cursor = addMonths(cursor, 3);
    }
    return ticks;
  }

  let cursor = monthStart(span.start);
  while (cursor <= span.end) {
    ticks.push({
      iso: cursor,
      label: MONTHS[fromIsoDate(cursor).getMonth()].slice(0, 3),
      major: fromIsoDate(cursor).getMonth() === 0,
      days: visibleDayCount(cursor, monthEnd(cursor)),
    });
    cursor = addMonths(cursor, 1);
  }
  return ticks;
}

/**
 * The date at the middle of the scrolled viewport, and the scroll offset that
 * puts a date back there.
 *
 * Zoom used to leave `scrollLeft` alone, so changing the scale teleported you:
 * the same pixel offset means a different date at every zoom, and coming out
 * of Quarter you landed years away from what you were reading. `gutter` is the
 * table half, which is sticky and does not scroll with the axis.
 */
export function dateAtCentre(
  axis: Span,
  zoom: Zoom,
  scrollLeft: number,
  viewport: number,
  gutter: number,
): string {
  const px = scrollLeft + viewport / 2 - gutter;
  const day = Math.round(px / PX_PER_DAY[zoom]);
  const clamped = Math.min(Math.max(day, 0), dayCount(axis) - 1);
  return addDays(axis.start, clamped);
}

export function scrollToCentre(
  axis: Span,
  zoom: Zoom,
  iso: string,
  viewport: number,
  gutter: number,
): number {
  const left = gutter + dayOffset(axis, iso) * PX_PER_DAY[zoom] - viewport / 2;
  return Math.max(0, Math.round(left));
}

/**
 * Which shape a reschedule writes back into.
 *
 * The declared kind decides, because the schema is what the next read
 * validates against. An UNDECLARED field keeps whatever shape is already on
 * disk instead of being normalised to a scalar — a hand-written `{start, end}`
 * that nothing declares is still a range, and flattening it on a drag would
 * delete the end date as a side effect of moving the record by a day.
 */
export function dateKindOf(entry: Entry, field: string, schema: Schema): 'date' | 'daterange' {
  const declared = schema.resolveField(entry, field).def?.kind;
  if (declared === 'date' || declared === 'daterange') return declared;
  const raw: unknown = entry.properties[field];
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? 'daterange' : 'date';
}

/** Left offset and width in px for a record's bar on the axis. */
export function barGeometry(span: Span, axis: Span, zoom: Zoom): { left: number; width: number } {
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
export function dependenciesOf(entry: Entry, field: string | undefined, entries: Entry[]): Entry[] {
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
