import { scheduleValue } from './schedule';
import * as upstream from 'rrule';
import { parseDocument } from 'yaml';
import { createTarget } from './createRecord';
import { composeNote, splitFrontmatter } from './frontmatter';
import { kindFacts } from './fieldKindTable';
import { nextItemKey } from './itemKeys';
import { PAGE_CHROME_KEYS } from './pageChrome';
import { isReservedTypeName } from './typeCatalog';
import { itemKeyOf, linkTargetOf } from './wikilink';
import type { BatchOp } from './batch';

// Vite loads upstream's ESM build; Node reads its CommonJS build. Both stay
// behind this one adapter, including the timezone replay tests.
const { RRule } = (Reflect.get(upstream, 'default') as typeof upstream | undefined) ?? upstream;
import { isDateText } from './dateGrammar';
import { parseDateProperty, serializeDateProperty, type DateValue } from './dates';
import type { Entry, FieldDef, Schema } from './types';

export const REPEAT_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type RepeatDay = (typeof REPEAT_DAYS)[number];
export type RepeatFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export interface RepeatRule {
  freq: RepeatFrequency;
  interval: number;
  byDay: string[];
  byMonthDay: number[];
  byMonth: number[];
  count: number | null;
  until: string | null;
  weekStart: 'MO' | 'SU';
  exceptions: string[];
}
export type ParsedRepeat =
  | { kind: 'rule'; rule: RepeatRule }
  | { kind: 'unknown'; raw: string; reason: string; exceptions: string[] };
export interface RepeatWindow {
  start: string;
  end: string;
}
export const REPEAT_UNKNOWN = 'Repeat rule not understood';
const DAY_MS = 86_400_000;
const MAX_STEPS = 5_000;
const pad = (n: number) => String(n).padStart(2, '0');
const unique = <T>(values: T[]) => [...new Set(values)];
const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const months = [
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
const joinWords = (words: string[]) =>
  words.length < 3 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
const ordinal = (n: number): string =>
  n === -1
    ? 'last'
    : n < 0
      ? `${ordinal(-n)} to last`
      : `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th')}`;
const ordinalWord = (n: number): string =>
  n === -1
    ? 'last'
    : n < 0
      ? `${ordinalWord(-n)} to last`
      : ['', 'first', 'second', 'third', 'fourth', 'fifth'][n];
const isoOf = (d: Date) =>
  `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const timeOf = (d: Date) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const wallDate = (day: string, time: string | null = null) => {
  const [y, m, d] = day.split('-').map(Number);
  const [h, min] = (time ?? '00:00').split(':').map(Number);
  // setUTCFullYear also preserves years below 100, which Date.UTC treats as 1900-based.
  const date = new Date(Date.UTC(2000, m - 1, d, h, min));
  date.setUTCFullYear(y);
  return date;
};
const compactDay = (text: string) => `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
function validStamp(value: string): boolean {
  const match = /^(\d{8})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  return (
    match !== null &&
    isDateText(compactDay(match[1])) &&
    (match[2] === undefined || (+match[2] < 24 && +match[3] < 60 && +match[4] < 60))
  );
}
const stampDate = (value: string, endOfDay = false): Date => {
  const date = wallDate(
    compactDay(value),
    value.length > 8 ? `${value.slice(9, 11)}:${value.slice(11, 13)}` : null,
  );
  date.setUTCSeconds(value.length > 8 ? Number(value.slice(13, 15)) : endOfDay ? 59 : 0);
  if (value.length === 8 && endOfDay) date.setUTCHours(23, 59, 59, 999);
  return date;
};

/** Own the accepted grammar. Never hand untrusted RRULE text to upstream's
 * parser: unsupported parts stay visible and are not silently discarded. */
export function parseRepeat(raw: unknown): ParsedRepeat | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const original = typeof raw === 'string' ? raw : String(raw);
  const unknown = (reason: string): ParsedRepeat => ({
    kind: 'unknown',
    raw: original,
    reason,
    // An explicit replacement may change unsupported rule parts, but valid
    // hand-written exclusions still belong to the series.
    exceptions:
      typeof raw !== 'string'
        ? []
        : unique(
            raw
              .toUpperCase()
              .split(/\r?\n/)
              .slice(1)
              .flatMap((line) => {
                const match = /^EXDATE:(.+)$/.exec(line.trim());
                return match === null ? [] : match[1].split(',').filter(validStamp);
              }),
          ).sort(),
  });
  if (typeof raw !== 'string') return unknown('A repeat rule must be text.');
  const lines = raw
    .trim()
    .toUpperCase()
    .split(/\r?\n/)
    .map((line) => line.trim());
  const first = lines.shift()?.replace(/^RRULE:/, '') ?? '';
  if (first === '') return unknown('A frequency is required.');
  const parts = new Map<string, string>();
  const allowed = new Set([
    'FREQ',
    'INTERVAL',
    'BYDAY',
    'BYMONTHDAY',
    'BYMONTH',
    'COUNT',
    'UNTIL',
    'WKST',
  ]);
  for (const part of first.split(';')) {
    const pair = /^([A-Z]+)=([^=;]+)$/.exec(part);
    if (pair === null) return unknown('The rule contains an invalid part.');
    if (!allowed.has(pair[1])) return unknown(`${pair[1]} is not supported.`);
    if (parts.has(pair[1])) return unknown(`${pair[1]} occurs more than once.`);
    parts.set(pair[1], pair[2]);
  }
  const freq = parts.get('FREQ');
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq ?? ''))
    return unknown('FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY.');
  const integer = (value: string | undefined, min: number, max: number): number | null =>
    value !== undefined && /^\d+$/.test(value) && +value >= min && +value <= max ? +value : null;
  const interval = integer(parts.get('INTERVAL') ?? '1', 1, 999);
  if (interval === null) return unknown('INTERVAL must be between 1 and 999.');
  const count = parts.has('COUNT') ? integer(parts.get('COUNT'), 1, 1000) : null;
  if (parts.has('COUNT') && count === null) return unknown('COUNT must be between 1 and 1000.');
  const until = parts.get('UNTIL') ?? null;
  if (until !== null && !validStamp(until))
    return unknown('UNTIL must be a valid calendar date or date-time.');
  if (count !== null && until !== null) return unknown('COUNT and UNTIL cannot be combined.');
  const weekStart = parts.get('WKST') ?? 'MO';
  if (weekStart !== 'MO' && weekStart !== 'SU') return unknown('WKST must be MO or SU.');
  const byDay = parts.has('BYDAY') ? unique(parts.get('BYDAY')!.split(',')) : [];
  for (const day of byDay) {
    const match = /^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/.exec(day);
    if (match === null || (match[1] && freq !== 'MONTHLY' && freq !== 'YEARLY'))
      return unknown('BYDAY ordinals are 1–5 or −1–−5, only for monthly or yearly rules.');
  }
  const numbers = (key: string, min: number, max: number) => {
    if (!parts.has(key)) return [];
    const list = parts.get(key)!.split(',');
    return list.every((v) => /^[+-]?\d+$/.test(v) && +v !== 0 && +v >= min && +v <= max)
      ? unique(list.map(Number))
      : null;
  };
  const byMonthDay = numbers('BYMONTHDAY', -31, 31);
  if (byMonthDay === null) return unknown('BYMONTHDAY must be 1–31 or −1–−31.');
  const byMonth = numbers('BYMONTH', 1, 12);
  if (byMonth === null || (byMonth.length > 0 && freq !== 'YEARLY'))
    return unknown('BYMONTH must be 1–12 under YEARLY.');
  const exceptions: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('EXDATE:')) return unknown('Only EXDATE lines may follow the rule.');
    const values = line.slice(7).split(',');
    if (!values.every(validStamp))
      return unknown('EXDATE must contain valid calendar dates or date-times.');
    exceptions.push(...values);
  }
  return {
    kind: 'rule',
    rule: {
      freq: freq as RepeatFrequency,
      interval,
      byDay: byDay.map((v) => v.replace(/^\+/, '')),
      byMonthDay,
      byMonth,
      count,
      until,
      weekStart,
      exceptions: unique(exceptions).sort(),
    },
  };
}

/** EXDATE follows the anchor's all-day or floating-time form. */
export function exceptionStamp(value: DateValue): string {
  return (
    value.start.replaceAll('-', '') +
    (value.startTime === null ? '' : `T${value.startTime.replace(':', '')}00`)
  );
}
function exceptionInForm(stamp: string, anchor?: DateValue): string {
  if (anchor === undefined) return stamp;
  return anchor.startTime === null
    ? stamp.slice(0, 8)
    : stamp.length > 8
      ? stamp.replace(/Z$/, '')
      : `${stamp}T${anchor.startTime.replace(':', '')}00`;
}
export function serializeRepeat(rule: RepeatRule, anchor?: DateValue): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay.length) parts.push(`BYDAY=${rule.byDay.join(',')}`);
  if (rule.byMonthDay.length) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(',')}`);
  if (rule.byMonth.length) parts.push(`BYMONTH=${rule.byMonth.join(',')}`);
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== null) parts.push(`UNTIL=${rule.until}`);
  if (rule.weekStart !== 'MO') parts.push(`WKST=${rule.weekStart}`);
  const exceptions = unique(rule.exceptions.map((v) => exceptionInForm(v, anchor))).sort();
  return parts.join(';') + (exceptions.length ? `\nEXDATE:${exceptions.join(',')}` : '');
}

export function describeRepeat(parsed: ParsedRepeat | null, anchor?: DateValue | null): string {
  if (parsed === null) return '';
  if (parsed.kind === 'unknown') return REPEAT_UNKNOWN;
  const r = parsed.rule;
  const dayWords = r.byDay.map((value) => {
    const day = days[REPEAT_DAYS.indexOf(value.slice(-2) as RepeatDay)];
    return value.length === 2 ? day : `the ${ordinalWord(Number(value.slice(0, -2)))} ${day}`;
  });
  let text: string;
  if (r.freq === 'DAILY') text = r.interval === 1 ? 'Daily' : `Every ${r.interval} days`;
  else if (r.freq === 'WEEKLY') {
    const selected = dayWords.length
      ? dayWords
      : anchor
        ? [days[(wallDate(anchor.start).getUTCDay() + 6) % 7]]
        : [];
    text = r.interval === 1 ? 'Weekly' : `Every ${r.interval} weeks`;
    if (r.interval === 1 && r.byDay.join(',') === 'MO,TU,WE,TH,FR') text = 'Every weekday';
    else if (selected.length) text += ` on ${joinWords(selected)}`;
  } else if (r.freq === 'MONTHLY') {
    text = r.interval === 1 ? 'Monthly' : `Every ${r.interval} months`;
    const selected = dayWords.length
      ? dayWords
      : (r.byMonthDay.length ? r.byMonthDay : anchor ? [Number(anchor.start.slice(8))] : []).map(
          (d) => (d === -1 ? 'the last day' : `the ${ordinal(d)}`),
        );
    if (selected.length) text += ` on ${joinWords(selected)}`;
  } else {
    text = r.interval === 1 ? 'Annually' : `Every ${r.interval} years`;
    const selectedMonths = (
      r.byMonth.length
        ? r.byMonth
        : anchor && !r.byDay.length && !r.byMonthDay.length
          ? [Number(anchor.start.slice(5, 7))]
          : []
    ).map((m) => months[m - 1]);
    if (dayWords.length)
      text += ` on ${joinWords(dayWords)}${selectedMonths.length ? ` of ${joinWords(selectedMonths)}` : ''}`;
    else if (r.byMonthDay.some((n) => n < 0) || (!selectedMonths.length && r.byMonthDay.length)) {
      text += ` on ${joinWords(r.byMonthDay.map((n) => (n === -1 ? 'the last day' : `the ${ordinal(n)}`)))} of ${selectedMonths.length ? joinWords(selectedMonths) : 'every month'}`;
    } else if (selectedMonths.length)
      text += ` on ${joinWords(selectedMonths)}${r.byMonthDay.length ? ` ${joinWords(r.byMonthDay.map(String))}` : anchor ? ` ${Number(anchor.start.slice(8))}` : ''}`;
  }
  if (r.freq === 'DAILY' && dayWords.length) text += ` on ${joinWords(dayWords)}`;
  if (r.byMonthDay.length && (r.freq === 'DAILY' || r.freq === 'WEEKLY' || r.byDay.length))
    text += ` · on month ${r.byMonthDay.length === 1 ? 'day' : 'days'} ${joinWords(r.byMonthDay.map((n) => (n === -1 ? 'last' : ordinal(n))))}`;
  if (r.count !== null) text += ` · ${r.count} times`;
  if (r.until !== null)
    text += ` · until ${months[Number(r.until.slice(4, 6)) - 1].slice(0, 3)} ${Number(r.until.slice(6, 8))}, ${r.until.slice(0, 4)}`;
  if (r.exceptions.length)
    text += ` · ${r.exceptions.length} ${r.exceptions.length === 1 ? 'exception' : 'exceptions'}`;
  return text;
}

/** Pairing replays src-tauri/fixtures/agenda-cases.json; Rust reads only the
 * stored occurrence and never expands rules (M62.3, Q41). */
export function repeatFieldFor(
  entry: Pick<Entry, 'type'>,
  schema: Schema,
): { repeat: FieldDef; date: FieldDef } | null {
  const fields = entry.type === null ? [] : (schema.types.get(entry.type)?.fields ?? []);
  const repeat = fields.find((f) => f.kind === 'repeat');
  const date = fields.find((f) => f.kind === 'daterange') ?? fields.find((f) => f.kind === 'date');
  return repeat && date ? { repeat, date } : null;
}
export const repeatAnchor = (entry: Entry, schema: Schema): DateValue | null => {
  const pair = repeatFieldFor(entry, schema);
  return pair === null ? null : parseDateProperty(entry.properties[pair.date.name]);
};
export function repeatPresets(anchor: DateValue): { label: string; value: string }[] {
  const day = REPEAT_DAYS[(wallDate(anchor.start).getUTCDay() + 6) % 7];
  const weekday = days[REPEAT_DAYS.indexOf(day)];
  const date = Number(anchor.start.slice(8));
  const month = Number(anchor.start.slice(5, 7));
  return [
    { label: 'Daily', value: 'FREQ=DAILY' },
    { label: `Weekly on ${weekday}`, value: `FREQ=WEEKLY;BYDAY=${day}` },
    { label: 'Every weekday (Monday to Friday)', value: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
    { label: `Monthly on the ${ordinal(date)}`, value: `FREQ=MONTHLY;BYMONTHDAY=${date}` },
    {
      label: `Annually on ${months[month - 1]} ${date}`,
      value: `FREQ=YEARLY;BYMONTHDAY=${date};BYMONTH=${month}`,
    },
  ];
}

/** Upstream receives checked structured options only. UTC fields are a
 * transport for floating wall time, never a zone conversion or a DST shift. */
export function occurrencesIn(
  rule: RepeatRule,
  anchor: DateValue,
  window: RepeatWindow,
): DateValue[] {
  const original = wallDate(anchor.start, anchor.startTime);
  const end = anchor.end === null ? null : wallDate(anchor.end, anchor.endTime ?? anchor.startTime);
  const duration = end === null ? 0 : Math.max(0, end.getTime() - original.getTime());
  const low = wallDate(window.start).getTime() - duration;
  const high = wallDate(window.end).getTime() + DAY_MS - 1;
  if (original.getTime() > high || high < low) return [];
  let start = original;
  // A daily series from 2000 must not walk twenty-six years to draw this week.
  // COUNT needs its original start; its admitted maximum is only 1,000.
  if (rule.count === null && (rule.freq === 'DAILY' || rule.freq === 'WEEKLY')) {
    const period = DAY_MS * rule.interval * (rule.freq === 'WEEKLY' ? 7 : 1);
    const skip = Math.max(0, Math.floor((low - original.getTime()) / period) - 1);
    start = new Date(original.getTime() + skip * period);
  }
  const byDay = rule.byDay.map((value) => {
    const day = RRule[value.slice(-2) as RepeatDay];
    return value.length === 2 ? day : day.nth(Number(value.slice(0, -2)));
  });
  const bounded = Math.min(
    high,
    start.getTime() +
      DAY_MS *
        MAX_STEPS *
        (rule.freq === 'DAILY'
          ? rule.interval
          : rule.freq === 'WEEKLY'
            ? 7 * rule.interval
            : rule.freq === 'MONTHLY'
              ? 31 * rule.interval
              : 366 * rule.interval),
  );
  const until =
    rule.until === null ? bounded : Math.min(bounded, stampDate(rule.until, true).getTime());
  const rr = new RRule(
    {
      freq: RRule[rule.freq],
      dtstart: start,
      interval: rule.interval,
      wkst: RRule[rule.weekStart],
      count: rule.count,
      until: new Date(until),
      ...(byDay.length
        ? { byweekday: byDay }
        : rule.freq === 'WEEKLY'
          ? { byweekday: [RRule[REPEAT_DAYS[(original.getUTCDay() + 6) % 7]]] }
          : {}),
      ...(rule.byMonthDay.length ? { bymonthday: rule.byMonthDay } : {}),
      ...(rule.byMonth.length ? { bymonth: rule.byMonth } : {}),
    },
    true,
  );
  const excluded = new Set(rule.exceptions.map((stamp) => exceptionInForm(stamp, anchor)));
  const values: DateValue[] = [];
  rr.all((date, index) => {
    if (index >= MAX_STEPS || date.getTime() > high) return false;
    if (date.getTime() < low) return true;
    const stop = new Date(date.getTime() + duration);
    const value: DateValue = {
      ...anchor,
      start: isoOf(date),
      startTime: anchor.startTime === null ? null : timeOf(date),
      end: anchor.end === null ? null : isoOf(stop),
      endTime: anchor.endTime === null ? null : timeOf(stop),
    };
    if (!excluded.has(exceptionStamp(value))) values.push(value);
    return true;
  });
  return values;
}

/** One visible calendar item; projected date bytes are for placement only,
 * while series retains the unchanged source record for opening/detaching. */
export interface CalendarItem {
  key: string;
  entry: Entry;
  series: Entry;
  value: DateValue | null;
  repeat: 'none' | 'unknown' | 'occurrence';
  rule: RepeatRule | null;
}
const expandedCache = new WeakMap<Entry[], WeakMap<Schema, Map<string, CalendarItem[]>>>();
export function expandForCalendar(
  entries: Entry[],
  field: string | null,
  schema: Schema,
  window: RepeatWindow,
): CalendarItem[] {
  let schemas = expandedCache.get(entries);
  if (schemas === undefined) {
    schemas = new WeakMap();
    expandedCache.set(entries, schemas);
  }
  let cache = schemas.get(schema);
  if (cache === undefined) {
    cache = new Map();
    schemas.set(schema, cache);
  }
  const key = JSON.stringify([field, window.start, window.end]);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const items = entries.flatMap((entry): CalendarItem[] => {
    const value = field === null ? null : parseDateProperty(scheduleValue(entry, field, schema));
    const pair = repeatFieldFor(entry, schema);
    const parsed =
      pair?.date.name === field ? parseRepeat(entry.properties[pair.repeat.name]) : null;
    const plain: CalendarItem = {
      key: entry.path,
      entry,
      series: entry,
      value,
      repeat: parsed?.kind === 'unknown' ? 'unknown' : 'none',
      rule: null,
    };
    if (parsed?.kind !== 'rule' || value === null || pair === null) return [plain];
    return occurrencesIn(parsed.rule, value, window).map((occurrence) => ({
      key: `${entry.path}@${exceptionStamp(occurrence)}`,
      series: entry,
      value: occurrence,
      entry: {
        ...entry,
        properties: {
          ...entry.properties,
          [field!]: serializeDateProperty(
            occurrence,
            pair.date.kind as 'date' | 'daterange',
          ) as Entry['properties'][string],
        },
      },
      repeat: 'occurrence',
      rule: parsed.rule,
    }));
  });
  // Paging through a large vault must not retain every visited month forever.
  if (cache.size >= 12) cache.delete(cache.keys().next().value!);
  cache.set(key, items);
  return items;
}

export interface DetachPlan {
  ops: BatchOp[];
  path: string;
  label: string;
}
const sameDateValue = (a: DateValue, b: DateValue) =>
  a.start === b.start && a.end === b.end && a.startTime === b.startTime && a.endTime === b.endTime;

/** The series patch and new page are one hash-checked batch. Everything
 * copied comes from the freshly read bytes; the selected occurrence must
 * still belong to those bytes, including its duration and exceptions. */
export function planDetach(
  series: Entry,
  source: { content: string; hash: string },
  occurrence: DateValue,
  entries: Entry[],
  schema: Schema,
): DetachPlan | null {
  if (
    series.type === null ||
    isReservedTypeName(series.type) ||
    /^(?:knowledge|templates)\//i.test(series.path)
  )
    return null;
  try {
    const yaml = splitFrontmatter(source.content).yaml;
    if (yaml === null) return null;
    const document = parseDocument(yaml);
    if (document.errors.length) return null;
    const raw: unknown = document.toJS({ maxAliasCount: 100 });
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const fields = raw as Record<string, unknown>;
    if (fields.type !== series.type) return null;
    const pair = repeatFieldFor(series, schema);
    if (pair === null) return null;
    const parsed = parseRepeat(fields[pair.repeat.name]);
    const anchor = parseDateProperty(fields[pair.date.name]);
    if (parsed?.kind !== 'rule' || anchor === null) return null;
    if (
      !occurrencesIn(parsed.rule, anchor, { start: occurrence.start, end: occurrence.start }).some(
        (value) => sameDateValue(value, occurrence),
      )
    )
      return null;
    const target = createTarget(series.type, { entries, schema });
    const frontmatter: Record<string, unknown> = { ...target.frontmatter };
    const declared = schema.types.get(series.type)?.fields ?? [];
    for (const field of declared) {
      if (
        field.kind === 'repeat' ||
        field.name === pair.date.name ||
        field.name === 'key' ||
        field.from !== undefined ||
        kindFacts(field.kind).computed
      )
        continue;
      if (Object.hasOwn(fields, field.name)) frontmatter[field.name] = fields[field.name];
    }
    for (const name of PAGE_CHROME_KEYS)
      if (Object.hasOwn(fields, name)) frontmatter[name] = fields[name];
    frontmatter[pair.date.name] = serializeDateProperty(
      occurrence,
      pair.date.kind as 'date' | 'daterange',
    );
    const sourceKey = typeof fields.key === 'string' ? fields.key.trim() : null;
    if (sourceKey !== null && itemKeyOf({ ...series, properties: { key: sourceKey } }) !== null)
      frontmatter.key = nextItemKey(sourceKey.replace(/-\d+$/, ''), entries);
    const stem = series.filename.replace(/\.md$/i, '');
    const base = `${target.folder}/${stem}-${occurrence.start}`;
    const occupied = new Set(entries.map((entry) => entry.path.toLowerCase()));
    let path = `${base}.md`;
    for (let n = 2; occupied.has(path.toLowerCase()); n++) path = `${base}-${n}.md`;
    const long = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(wallDate(occurrence.start));
    const short = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(wallDate(occurrence.start));
    const body = `# ${series.title}\n\nSplit from [[${linkTargetOf(series)}]]: the ${long} occurrence.\n`;
    const updated = {
      ...parsed.rule,
      exceptions: unique([...parsed.rule.exceptions, exceptionStamp(occurrence)]),
    };
    return {
      path,
      label: `Made ${short} of “${series.title}” its own page`,
      ops: [
        {
          op: 'patch',
          path: series.path,
          set: { [pair.repeat.name]: serializeRepeat(updated, anchor) },
          expectHash: source.hash,
        },
        { op: 'create', path, content: composeNote(frontmatter, body) },
      ],
    };
  } catch {
    return null;
  }
}
