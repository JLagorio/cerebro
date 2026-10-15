import { describeSchedule, formatSchedule, nextFire, parseSchedule, type Schedule } from './skills';

export type SchedulePhrase =
  { ok: true; schedule: string; words: string } | { ok: false; reason: string };

const UNREADABLE =
  "Cerebro couldn't read that. Try “weekdays at 9am”, “mondays and thursdays at 5pm”, “the last day of the month at 6pm” or “once on Oct 20 at 3pm”.";
const ADD_TIME = 'Add a time, like “at 9am”.';
const PAST = 'That time has already passed — pick a later one.';
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
type Clock = { hour: number; minute: number };
type Shape =
  | { kind: 'hourly' | 'daily' | 'weekdays' }
  | { kind: 'days'; days: number[] }
  | { kind: 'monthly'; day: number | 'last' }
  | { kind: 'once'; date: string };

const refused = (reason = UNREADABLE): SchedulePhrase => ({ ok: false, reason });
const pad = (n: number) => String(n).padStart(2, '0');
const dateText = (date: Date) =>
  `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const dayNumber = (word: string) => {
  const single = word.replace(/s$/, '');
  return DAYS.findIndex((day) => single === day || single === day.slice(0, 3));
};

function readClock(text: string, bare: boolean): Clock | null {
  if (text === 'noon') return { hour: 12, minute: 0 };
  if (text === 'midnight') return { hour: 0, minute: 0 };
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (match === null) return null;
  const [, h, m, period] = match;
  let hour = Number(h);
  const minute = Number(m ?? 0);
  if ((!bare && m === undefined && period === undefined) || minute > 59) return null;
  if (period !== undefined) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (period === 'pm' ? 12 : 0);
  } else if (hour > 23) return null;
  return { hour, minute };
}

function splitClock(text: string): { phrase: string; time: string | null; bare: boolean } {
  const at = text.lastIndexOf(' at ');
  if (at >= 0) return { phrase: text.slice(0, at), time: text.slice(at + 4), bare: true };
  const trailing = /\s+(noon|midnight|\d{1,2}:\d{2}(?:\s*[ap]m)?|\d{1,2}\s*[ap]m)$/.exec(text);
  return trailing === null
    ? { phrase: text, time: null, bare: false }
    : { phrase: text.slice(0, trailing.index), time: trailing[1], bare: false };
}

function ordinal(text: string): number | null {
  if (text === 'first') return 1;
  const match = /^(\d{1,2})(st|nd|rd|th)?$/.exec(text);
  if (match === null) return null;
  const day = Number(match[1]);
  const ending =
    day >= 11 && day <= 13
      ? 'th'
      : day % 10 === 1
        ? 'st'
        : day % 10 === 2
          ? 'nd'
          : day % 10 === 3
            ? 'rd'
            : 'th';
  return match[2] === undefined || match[2] === ending ? day : null;
}

function readShape(phrase: string): Shape | null {
  if (/^(hourly|every hour)$/.test(phrase)) return { kind: 'hourly' };
  if (/^(daily|every day)$/.test(phrase)) return { kind: 'daily' };
  if (/^(weekdays|every weekday)$/.test(phrase)) return { kind: 'weekdays' };
  if (/^(weekends|every weekend)$/.test(phrase)) return { kind: 'days', days: [0, 6] };
  const once = /^(?:once(?: on)?|on) (.+)$/.exec(phrase);
  if (once !== null) return { kind: 'once', date: once[1] };
  // Relative dates also read naturally without "once on".
  if (/^(today|tomorrow|(?:this|next) \w+)$/.test(phrase)) return { kind: 'once', date: phrase };
  const monthly =
    /^(?:monthly|every month)(?: on)? (?:the )?(.+)$/.exec(phrase) ??
    /^(?:the )?(.+) of (?:every|the) month$/.exec(phrase) ??
    /^every (.+)$/.exec(phrase);
  if (monthly !== null) {
    if (/^(last(?: day)?|end)$/.test(monthly[1])) return { kind: 'monthly', day: 'last' };
    const day = ordinal(monthly[1]);
    if (day !== null) return { kind: 'monthly', day };
  }
  const names = phrase
    .replace(/^(?:every|weekly) /, '')
    .split(/\s*(?:,\s*(?:and\s+)?|\band\b|&)\s*/);
  const days = names.map(dayNumber);
  if (days.some((day) => day < 0) || new Set(days).size !== days.length) return null;
  return { kind: 'days', days: days.sort((a, b) => a - b) };
}

/** Construct locally without Date.parse's UTC interpretation of YYYY-MM-DD. */
function localDate(year: number, month: number, day: number, clock: Clock): Date | null {
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(clock.hour, clock.minute, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    ? date
    : null;
}

function readDate(text: string, clock: Clock, now: Date): { date: string } | { reason: string } {
  const missing = { reason: `There is no ${text}.` };
  if (text === 'today' || text === 'tomorrow' || /^(this|next) \w+$/.test(text)) {
    const at = new Date(now);
    at.setHours(12, 0, 0, 0);
    if (text === 'tomorrow') at.setDate(at.getDate() + 1);
    else if (text !== 'today') {
      const [when, name] = text.split(' ');
      const day = dayNumber(name ?? '');
      if (day < 0) return { reason: UNREADABLE };
      const distance = (day - now.getDay() + 7) % 7;
      at.setDate(at.getDate() + (distance === 0 && when === 'next' ? 7 : distance));
    }
    return { date: dateText(at) };
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso !== null) {
    const [, year, month, day] = iso;
    const at = localDate(Number(year), Number(month) - 1, Number(day), clock);
    return at === null ? missing : { date: dateText(at) };
  }
  const named = /^([a-z]+) (\d{1,2}(?:st|nd|rd|th)?)(?:,? (\d{4}))?$/.exec(text);
  const reversed = /^(\d{1,2}(?:st|nd|rd|th)?) ([a-z]+)(?: (\d{4}))?$/.exec(text);
  if (named === null && reversed === null) return { reason: UNREADABLE };
  const monthText = named?.[1] ?? reversed![2];
  const month = MONTHS.findIndex((name) => monthText === name || monthText === name.slice(0, 3));
  const day = ordinal(named?.[2] ?? reversed![1]);
  if (month < 0 || day === null) return { reason: UNREADABLE };
  const yearText = named?.[3] ?? reversed?.[3];
  if (yearText !== undefined) {
    const at = localDate(Number(yearText), month, day, clock);
    return at === null ? missing : { date: dateText(at) };
  }
  // Eight years spans the longest gap between Gregorian leap days (a century).
  for (let year = now.getFullYear(); year <= now.getFullYear() + 8; year++) {
    const at = localDate(year, month, day, clock);
    if (at !== null && at > now) return { date: dateText(at) };
  }
  return missing;
}

function answer(schedule: Schedule, now: Date): SchedulePhrase {
  const canonical = formatSchedule(schedule);
  const parsed = parseSchedule(canonical);
  if (parsed === null) return refused();
  if (parsed.kind === 'once' && nextFire(parsed, now) === null) return refused(PAST);
  return { ok: true, schedule: canonical, words: describeSchedule(parsed) };
}

/** Phrases become validated file grammar before the editor may write them. */
export function parseSchedulePhrase(input: string, now: Date): SchedulePhrase {
  if (!Number.isFinite(now.getTime())) return refused();
  const parsed = parseSchedule(input);
  if (parsed !== null) return answer(parsed, now);
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ');
  const { phrase, time, bare } = splitClock(text);
  const shape = readShape(phrase);
  if (shape === null) return refused();
  if (shape.kind === 'hourly')
    return time === null
      ? answer({ kind: 'hourly' }, now)
      : refused('Hourly runs start on the hour, so leave the time out.');
  if (shape.kind === 'monthly' && shape.day !== 'last') {
    if (shape.day > 28)
      return refused(
        `Not every month has a ${shape.day}th, so Cerebro takes days 1 to 28 — or say “the last day of the month”.`,
      );
    if (shape.day < 1) return refused();
  }
  if (time === null) return refused(ADD_TIME);
  const clock = readClock(time, bare);
  if (clock === null) return refused();
  if (shape.kind === 'once') {
    const date = readDate(shape.date, clock, now);
    return 'reason' in date
      ? refused(date.reason)
      : answer({ kind: 'once', ...date, ...clock }, now);
  }
  if (shape.kind === 'days' && shape.days.length === 1)
    return answer({ kind: 'weekly', day: shape.days[0], ...clock }, now);
  // The hourly arm above has already returned; preserve each remaining shape's data.
  if (shape.kind === 'daily' || shape.kind === 'weekdays')
    return answer({ kind: shape.kind, ...clock }, now);
  return answer({ ...shape, ...clock }, now);
}
