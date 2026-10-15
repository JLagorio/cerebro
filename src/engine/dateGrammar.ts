/**
 * The date grammar every stored date property is read and written by
 * (M60.3): `shared/calendar/dates.v1.json`, which Rust's
 * `src-tauri/src/vault/dates.rs` reads too. Neither language holds the rule;
 * both interpret the same file and replay its `cases` (D3).
 *
 * Three forms: a floating day (`2026-07-28`), a floating day and wall time
 * (`2026-07-28 14:30`, or a `T`), and an instant (`2026-07-28T09:20:00Z`,
 * what Rust and the scanner write). Floating values mean the same thing in
 * every zone; an instant reads as the wall time in this machine's zone. Reads
 * are lenient (trimmed, and an unreadable end is an open range); writes are
 * strict (exact text, and a range never runs backwards or ends without
 * starting).
 *
 * An instant reaches an epoch through `setUTCFullYear`/`setUTCHours` and its
 * wall time through the local getters: never `Date.parse` or
 * `new Date(string)`, whose heuristics are the browser's, not the grammar's.
 */

import RAW from '../../shared/calendar/dates.v1.json';

export const DATES_PATH = 'shared/calendar/dates.v1.json';
export const DATES_DIGEST_PATH = 'shared/calendar/dates.v1.sha256';
export const DATES_FORMAT = 1;

const FORMS = ['date', 'date_time', 'instant'] as const;
const ZONES = ['Z', '+HH:MM', '-HH:MM'] as const;

export interface DateGrammar {
  format: number;
  artifact_version: number;
  rule_version: string;
  forms: string[];
  time_separators: string[];
  written_separator: string;
  date_time: { seconds: string };
  instant: { seconds: string; fraction_digits: { min: number; max: number }; zones: string[] };
  calendar: string;
  read: string;
  write: string;
  backwards: string;
  cases: unknown[];
}

/** One endpoint as a reader sees it: a day, an optional `HH:MM` wall time,
 * and whether it was written as an instant (then both are local). */
export interface DateEndpoint {
  date: string;
  time: string | null;
  instant: boolean;
}

/** A date value read leniently: a scalar has no end. */
export interface DateRead {
  start: DateEndpoint;
  end: DateEndpoint | null;
}

/** Why a range may not be written. */
export type DateRangeFault = 'shape' | 'endpoint' | 'backwards';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function word(key: string, got: unknown, known: readonly string[]): void {
  if (typeof got !== 'string' || !known.includes(got)) {
    throw new Error(`dates: ${key} has an unknown word ${String(got)}`);
  }
}

/** Parse and check a grammar, refusing in the words `dates.rs` uses. */
export function parseDateGrammar(value: unknown): DateGrammar {
  if (!isRecord(value)) throw new Error('dates: the grammar is not an object');
  const g = value as unknown as DateGrammar;
  if (g.format !== DATES_FORMAT) {
    throw new Error(`dates: format must be ${DATES_FORMAT}, not ${String(g.format)}`);
  }
  if (typeof g.rule_version !== 'string' || g.rule_version.trim() === '') {
    throw new Error('dates: rule_version is empty');
  }
  for (const form of g.forms) {
    if (!(FORMS as readonly string[]).includes(form))
      throw new Error(`dates: unknown form ${form}`);
  }
  if (!Array.isArray(g.time_separators) || g.time_separators.length === 0) {
    throw new Error('dates: time_separators is empty');
  }
  for (const sep of g.time_separators) {
    if (sep.length !== 1 || sep.charCodeAt(0) > 0x7f) {
      throw new Error(`dates: time separator ${JSON.stringify(sep)} is not one character`);
    }
  }
  if (!g.time_separators.includes(g.written_separator)) {
    throw new Error('dates: written_separator is not a time separator');
  }
  word('date_time.seconds', g.date_time.seconds, ['never']);
  word('instant.seconds', g.instant.seconds, ['optional', 'required']);
  for (const zone of g.instant.zones) word('instant.zones', zone, ZONES);
  const digits = g.instant.fraction_digits;
  if (digits.min === 0 || digits.min > digits.max || digits.max > 9) {
    throw new Error('dates: instant.fraction_digits must run from 1 to at most 9');
  }
  word('calendar', g.calendar, ['proleptic_gregorian']);
  word('read', g.read, ['lenient']);
  word('write', g.write, ['strict']);
  word('backwards', g.backwards, ['same_form']);
  if (!Array.isArray(g.cases) || g.cases.length === 0) throw new Error('dates: no cases');
  return g;
}

/** The shipped grammar, checked on load (its digest is held by the tests). */
export const DATE_GRAMMAR: DateGrammar = parseDateGrammar(RAW);

/** Exactly what the text says, before any zone is applied. */
type Parsed =
  | { form: 'floating'; date: string; time: string | null }
  /** The UTC moment: whole seconds as epoch milliseconds, plus nanoseconds. */
  | { form: 'instant'; epochMs: number; nanos: number };

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

function digitsAt(text: string, at: number, len: number): number | null {
  if (at + len > text.length) return null;
  let n = 0;
  for (let i = at; i < at + len; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return null;
    n = n * 10 + (c - 0x30);
  }
  return n;
}

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const daysIn = (y: number, m: number): number => (m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1]);

/** Strict: the whole text must be one form the grammar admits. */
function parseExact(text: string, g: DateGrammar = DATE_GRAMMAR): Parsed | null {
  if (text.length < 10 || text[4] !== '-' || text[7] !== '-') return null;
  const year = digitsAt(text, 0, 4);
  const month = digitsAt(text, 5, 2);
  const day = digitsAt(text, 8, 2);
  if (year === null || month === null || day === null) return null;
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) return null;
  const date = text.slice(0, 10);
  const has = (form: string) => g.forms.includes(form);
  if (text.length === 10) return has('date') ? { form: 'floating', date, time: null } : null;
  if (!g.time_separators.includes(text[10]) || text[13] !== ':') return null;
  const hour = digitsAt(text, 11, 2);
  const minute = digitsAt(text, 14, 2);
  if (hour === null || minute === null || hour > 23 || minute > 59) return null;
  if (text.length === 16) {
    return has('date_time')
      ? { form: 'floating', date, time: `${pad(hour)}:${pad(minute)}` }
      : null;
  }
  if (!has('instant')) return null;
  let at = 16;
  let second = 0;
  let nanos = 0;
  if (text[at] === ':') {
    const s = digitsAt(text, at + 1, 2);
    if (s === null || s > 59) return null;
    second = s;
    at += 3;
    if (text[at] === '.') {
      const start = at + 1;
      let end = start;
      while (end < text.length && text.charCodeAt(end) >= 0x30 && text.charCodeAt(end) <= 0x39) {
        end++;
      }
      const count = end - start;
      const rule = g.instant.fraction_digits;
      if (count < rule.min || count > rule.max) return null;
      nanos = Number(text.slice(start, end)) * 10 ** (9 - count);
      at = end;
    }
  } else if (g.instant.seconds === 'required') {
    return null;
  }
  const zone = text.slice(at);
  let offsetMinutes: number;
  if (zone === 'Z') {
    if (!g.instant.zones.includes('Z')) return null;
    offsetMinutes = 0;
  } else {
    if (zone.length !== 6 || zone[3] !== ':') return null;
    const sign =
      zone[0] === '+' && g.instant.zones.includes('+HH:MM')
        ? 1
        : zone[0] === '-' && g.instant.zones.includes('-HH:MM')
          ? -1
          : 0;
    if (sign === 0) return null;
    const oh = digitsAt(zone, 1, 2);
    const om = digitsAt(zone, 4, 2);
    if (oh === null || om === null || oh > 23 || om > 59) return null;
    offsetMinutes = sign * (oh * 60 + om);
  }
  // `Date.UTC` reads a two-digit year as 19xx, so the epoch is built field
  // by field; setUTCHours carries an out-of-range minute into the day.
  const epoch = new Date(0);
  epoch.setUTCFullYear(year, month - 1, day);
  epoch.setUTCHours(hour, minute - offsetMinutes, second, 0);
  return { form: 'instant', epochMs: epoch.getTime(), nanos };
}

function toEndpoint(parsed: Parsed): DateEndpoint {
  if (parsed.form === 'floating') return { date: parsed.date, time: parsed.time, instant: false };
  const local = new Date(parsed.epochMs);
  return {
    date: `${pad(local.getFullYear(), 4)}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`,
    time: `${pad(local.getHours())}:${pad(local.getMinutes())}`,
    instant: true,
  };
}

/** Lenient: one endpoint out of text that may carry padding. An instant
 * reads as its wall time in this machine's zone. */
export function parseDateText(text: string): DateEndpoint | null {
  const parsed = parseExact(text.trim());
  return parsed === null ? null : toEndpoint(parsed);
}

/** Strict: a string that is exactly date text, as a write must store it. */
export function isDateText(value: unknown): value is string {
  return typeof value === 'string' && parseExact(value) !== null;
}

/** Lenient: a stored `date` or `daterange` value, or null when it holds no
 * readable start. A junk end reads as an open range; a backwards range reads
 * as written. */
export function readDateValue(value: unknown): DateRead | null {
  if (typeof value === 'string') {
    const start = parseDateText(value);
    return start === null ? null : { start, end: null };
  }
  if (!isRecord(value) || typeof value.start !== 'string') return null;
  const start = parseDateText(value.start);
  if (start === null) return null;
  const end = typeof value.end === 'string' ? parseDateText(value.end) : null;
  return { start, end };
}

/** The `same_form` rule: two instants compare as moments; two floating
 * values by day, then by time only when both have one; mixed forms are not
 * compared. */
function runsBackwards(start: Parsed, end: Parsed): boolean {
  if (start.form === 'instant' && end.form === 'instant') {
    return (
      end.epochMs < start.epochMs || (end.epochMs === start.epochMs && end.nanos < start.nanos)
    );
  }
  if (start.form === 'floating' && end.form === 'floating') {
    if (end.date !== start.date) return end.date < start.date;
    return start.time !== null && end.time !== null && end.time < start.time;
  }
  return false;
}

/** Strict: why a `daterange` value may not be written, or null when it may. */
export function dateRangeFault(value: unknown): DateRangeFault | null {
  if (!isRecord(value)) return 'shape';
  const endpoint = (raw: unknown): Parsed | null | 'fault' => {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') return 'fault';
    return parseExact(raw) ?? 'fault';
  };
  const start = endpoint(value.start);
  if (start === 'fault') return 'endpoint';
  const end = endpoint(value.end);
  if (end === 'fault') return 'endpoint';
  if (start === null && end !== null) return 'endpoint';
  if (start !== null && end !== null && runsBackwards(start, end)) return 'backwards';
  return null;
}
