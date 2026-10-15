import { DATE_GRAMMAR, parseDateText } from './dateGrammar';
import type { BandContext } from './dateBuckets';

export type RelativeDate =
  { unit: 'day'; offset: number } | { unit: 'week' | 'month'; offset: number };

const rule = DATE_GRAMMAR.relative;

/** The artifact owns both the tokens and their words; these are filter values. */
export const RELATIVE_PRESETS = [...rule.days, ...rule.periods].map(({ token, words }) => ({
  token,
  label: words,
}));

/** Relative reads trim but never fold case or accept approximate spellings. */
export function parseRelative(value: unknown): RelativeDate | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const day = rule.days.find((day) => day.token === text);
  if (day !== undefined) return { unit: 'day', offset: day.offset };
  const period = rule.periods.find((period) => period.token === text);
  if (period !== undefined) return { unit: period.unit, offset: period.offset };
  if (!text.startsWith(rule.offsets.prefix)) return null;
  const suffix = text.slice(rule.offsets.prefix.length);
  const direction = rule.offsets.signs[suffix[0]];
  const digits = suffix.slice(1);
  if (
    direction === undefined ||
    !/^[0-9]+$/.test(digits) ||
    (!rule.offsets.leading_zero && digits.startsWith('0'))
  )
    return null;
  const count = Number(digits);
  return count >= rule.offsets.min && count <= rule.offsets.max
    ? { unit: 'day', offset: direction * count }
    : null;
}

/** Words for a chip, without changing the token written in its view file. */
export function relativeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const preset = RELATIVE_PRESETS.find((preset) => preset.token === text);
  if (preset !== undefined) return preset.label;
  const parsed = parseRelative(value);
  if (parsed === null) return null;
  const n = Math.abs(parsed.offset);
  const key = `${parsed.offset < 0 ? 'past' : 'future'}_${n === 1 ? 'one' : 'many'}` as const;
  return rule.words[key].replace('{n}', String(n));
}

function utcDay(day: string): Date | null {
  if (parseDateText(day)?.date !== day) return null;
  const [year, month, date] = day.split('-').map(Number);
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(year, month - 1, date);
  return value;
}

function isoDay(day: Date): string | null {
  const year = day.getUTCFullYear();
  if (year < 0 || year > 9999) return null;
  return `${String(year).padStart(4, '0')}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
}

/** Inclusive calendar days; no clock or machine zone enters the arithmetic. */
export function resolveRelative(value: unknown, ctx: BandContext): [string, string] | null {
  const parsed = parseRelative(value);
  const start = utcDay(ctx.today);
  if (parsed === null || start === null || !rule.week_starts.includes(ctx.weekStart)) return null;
  if (parsed.unit === 'day') start.setUTCDate(start.getUTCDate() + parsed.offset);
  else if (parsed.unit === 'week') {
    start.setUTCDate(
      start.getUTCDate() - ((start.getUTCDay() - ctx.weekStart + 7) % 7) + parsed.offset * 7,
    );
  } else {
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() + parsed.offset);
  }
  const end = new Date(start.getTime());
  if (parsed.unit === 'week') end.setUTCDate(end.getUTCDate() + 6);
  else if (parsed.unit === 'month') {
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
  }
  const from = isoDay(start);
  const to = isoDay(end);
  return from === null || to === null ? null : [from, to];
}
