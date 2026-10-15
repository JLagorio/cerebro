import { addDays, parseDateProperty, type DateValue } from './dates';
import { readDateValue } from './dateGrammar';
import { scheduleValue, spanOfValue, type Span } from './schedule';
import type { Entry, Schema } from './types';

/**
 * Placing records on the HOURS of a day (M61.8): what the Week and Day
 * calendars draw under their all-day row.
 *
 * `schedule.ts` answers which DAYS a record covers; this answers where in a
 * day it sits, and whether it sits in the hours at all. Pure, and it never
 * reads the clock: "now" is the renderer's business, passed in.
 *
 * Stored placement is held to Rust's agenda reader (M62.3) by
 * src-tauri/fixtures/agenda-cases.json, replayed in agendaCases.test.ts (D3).
 */

export const MINUTES_PER_DAY = 1440;

/**
 * The shortest stretch two items pack as. A point, or a five-minute meeting,
 * draws as a chip of minimum height; packing it by its true length would let
 * two such chips overlap on screen while the arithmetic says they do not.
 */
export const PACK_FLOOR = 30;

const pad = (n: number) => String(n).padStart(2, '0');

/** `'HH:MM'` → minutes since midnight. */
export function minuteOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** Minutes since midnight → `'HH:MM'`. 1440 (the midnight a day ends at)
 * reads as `00:00`, the clock face it shows. */
export function clockOf(minute: number): string {
  const m = ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/**
 * Where a record goes on a Week or Day calendar.
 *
 * - `allDay` — the all-day row, over the days `span` covers.
 * - `timed` — a block in one day's column, `start` to `end` in minutes
 *   (`end` may be 1440: a range that stops at midnight).
 * - `point` — a chip at one minute: a start time with nothing usable after it.
 *
 * `fixed` is true when either stored endpoint is an INSTANT: a moment, shown at
 * this machine's wall time, as opposed to a floating time that means the same
 * clock face everywhere.
 */
export type Placement =
  | { kind: 'allDay'; span: Span }
  | { kind: 'timed'; day: string; start: number; end: number; fixed: boolean }
  | { kind: 'point'; day: string; at: number; fixed: boolean };

/**
 * A parsed date value's placement.
 *
 * - No start time → all day, by `spanOfValue`'s rule.
 * - A start time and no usable end (none, a same-day end with no time, or an
 *   end at or before the start) → a point.
 * - A timed range inside one day → timed; one ending 00:00 the next day →
 *   timed, ending at 1440.
 * - Any other range across days → all day.
 */
export function placementOfValue(value: DateValue, fixed: boolean): Placement {
  if (value.startTime === null) return { kind: 'allDay', span: spanOfValue(value) };
  const day = value.start;
  const start = minuteOf(value.startTime);
  const point: Placement = { kind: 'point', day, at: start, fixed };
  if (value.end === null || value.end < day) return point;
  if (value.end === day) {
    if (value.endTime === null) return point;
    const end = minuteOf(value.endTime);
    return end <= start ? point : { kind: 'timed', day, start, end, fixed };
  }
  if (value.endTime === '00:00' && value.end === addDays(day, 1)) {
    return { kind: 'timed', day, start, end: MINUTES_PER_DAY, fixed };
  }
  return { kind: 'allDay', span: spanOfValue(value) };
}

/** A record's placement by `field`, or null when it carries no usable date. */
export function placementOf(entry: Entry, field: string | null, schema?: Schema): Placement | null {
  if (field === null) return null;
  const raw: unknown = scheduleValue(entry, field, schema);
  const value = parseDateProperty(raw);
  if (value === null) return null;
  // The endpoint form the shared grammar read (M60.3) — never a second regex.
  const read = readDateValue(raw);
  return placementOfValue(value, read?.start.instant === true || read?.end?.instant === true);
}

/** One item a day column packs: minutes, `end` exclusive. */
export interface PackItem {
  key: string;
  start: number;
  end: number;
}

/** Which of `cols` side-by-side columns an item draws in. */
export interface PackSlot {
  col: number;
  cols: number;
}

/**
 * Side-by-side columns for one day's blocks.
 *
 * Earliest first, longest first on a tie. Items that overlap, directly or
 * through a chain of others, form one cluster; each takes the first column
 * in its cluster that is free at its start, and every item in the cluster
 * shares the cluster's column count, so their widths agree. Items shorter
 * than PACK_FLOOR (points included, at length 0) pack as PACK_FLOOR.
 */
export function packDay(items: PackItem[]): Map<string, PackSlot> {
  const out = new Map<string, PackSlot>();
  const sized = items
    .map((it) => ({ key: it.key, start: it.start, end: Math.max(it.end, it.start + PACK_FLOOR) }))
    .sort((a, b) => (a.start === b.start ? b.end - a.end : a.start - b.start));
  let cluster: { key: string; col: number }[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -Infinity;
  const close = () => {
    for (const { key, col } of cluster) out.set(key, { col, cols: colEnds.length });
    cluster = [];
    colEnds = [];
  };
  for (const it of sized) {
    if (it.start >= clusterEnd) {
      close();
      clusterEnd = it.end;
    }
    let col = colEnds.findIndex((end) => end <= it.start);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(it.end);
    } else {
      colEnds[col] = it.end;
    }
    cluster.push({ key: it.key, col });
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  close();
  return out;
}

/** A half-open interval of wall-clock minutes within one day. */
export interface TimeSlot {
  start: number;
  end: number;
}

/** Round a gesture's minute change to its nearest snap, symmetrically. */
export function snapDelta(minutes: number, snap = PACK_FLOOR): number {
  return Math.sign(minutes) * Math.round(Math.abs(minutes) / snap) * snap;
}

/** Move the whole interval, preserving its duration at the day's bounds. */
export function moveTimed(slot: TimeSlot, minutes: number): TimeSlot {
  const duration = slot.end - slot.start;
  const start = Math.max(0, Math.min(MINUTES_PER_DAY - duration, slot.start + minutes));
  return { start, end: start + duration };
}

/** Move one edge, leaving at least a half hour between the endpoints. */
export function resizeTimed(slot: TimeSlot, edge: 'start' | 'end', minutes: number): TimeSlot {
  return edge === 'start'
    ? { start: Math.max(0, Math.min(slot.end - PACK_FLOOR, slot.start + minutes)), end: slot.end }
    : {
        start: slot.start,
        end: Math.min(MINUTES_PER_DAY, Math.max(slot.start + PACK_FLOOR, slot.end + minutes)),
      };
}

/** Points have no duration; retain room for their minimum drawing height. */
export function movePoint(at: number, minutes: number): number {
  return Math.max(0, Math.min(MINUTES_PER_DAY - PACK_FLOOR, at + minutes));
}
