import { dateEpoch, isDateText } from './dateGrammar';
import type { IcsProperty } from './ics';
import { WINDOWS_ZONES } from './windowsZones';

export interface IcsTime {
  kind: 'date' | 'utc' | 'zoned' | 'floating';
  value: string;
  /** Original local wall time, including seconds, for calendar-day durations. */
  wall: string;
  zone: string | null;
  epoch: number | null;
  issue: 'unknown_zone' | 'gap' | 'ambiguous' | 'offset_precision' | null;
  secondsDropped: boolean;
}
const DAY = 86_400_000;
const pad = (value: number) => String(value).padStart(2, '0');

export function resolveZone(raw: string): string | null {
  try {
    new Intl.DateTimeFormat('en', { timeZone: raw }).format(0);
    return raw;
  } catch {
    const mapped = Object.hasOwn(WINDOWS_ZONES, raw) ? WINDOWS_ZONES[raw] : null;
    if (!mapped) return null;
    try {
      new Intl.DateTimeFormat('en', { timeZone: mapped }).format(0);
      return mapped;
    } catch {
      return null;
    }
  }
}

function zoneWall(epoch: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(epoch);
  const get = (part: string) => parts.find((row) => row.type === part)?.value ?? '';
  return `${get('year').padStart(4, '0')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}
function withOffset(wall: string, offset: number): string | null {
  if (offset % 60_000 !== 0) return null;
  const minutes = Math.abs(offset / 60_000);
  const text = `${wall}${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  return isDateText(text) ? text : null;
}

/** Try both sides of a possible transition. A repeated hour or a missing
 * hour stays floating; choosing either silently would change the event. */
export function wallToInstant(
  wall: string,
  zone: string,
): { epoch: number; value: string } | { issue: 'gap' | 'ambiguous' | 'offset_precision' } {
  const naive = dateEpoch(`${wall}Z`);
  if (naive === null) return { issue: 'gap' };
  const offsets = new Set<number>();
  for (const delta of [-DAY, 0, DAY]) {
    const instant = naive + delta;
    const local = dateEpoch(`${zoneWall(instant, zone)}Z`);
    if (local !== null) offsets.add(local - instant);
  }
  const matches = [...offsets]
    .map((offset) => ({ epoch: naive - offset, offset }))
    .filter(({ epoch }) => zoneWall(epoch, zone) === wall);
  if (matches.length !== 1) return { issue: matches.length ? 'ambiguous' : 'gap' };
  const value = withOffset(wall, matches[0].offset);
  return value === null ? { issue: 'offset_precision' } : { epoch: matches[0].epoch, value };
}

export function readIcsTime(property: IcsProperty | undefined): IcsTime | null {
  if (!property) return null;
  const { value, params } = property;
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date) {
    const text = `${date[1]}-${date[2]}-${date[3]}`;
    if (!isDateText(text) || (params.VALUE && params.VALUE[0].toUpperCase() !== 'DATE'))
      return null;
    return {
      kind: 'date',
      value: text,
      wall: text,
      zone: null,
      epoch: null,
      issue: null,
      secondsDropped: false,
    };
  }
  if (params.VALUE && params.VALUE[0].toUpperCase() !== 'DATE-TIME') return null;
  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!time) return null;
  const wall = `${time[1]}-${time[2]}-${time[3]}T${time[4]}:${time[5]}:${time[6]}`;
  const epoch = dateEpoch(`${wall}Z`);
  if (epoch === null) return null;
  const base = { wall, issue: null, secondsDropped: false } as const;
  if (time[7]) return { ...base, kind: 'utc', value: `${wall}Z`, zone: 'UTC', epoch };
  const rawZone = params.TZID?.[0] ?? null;
  const zone = rawZone === null ? null : resolveZone(rawZone);
  const resolved = zone === null ? null : wallToInstant(wall, zone);
  if (resolved && 'epoch' in resolved) return { ...base, ...resolved, kind: 'zoned', zone };
  return {
    ...base,
    kind: 'floating',
    value: wall.slice(0, 16),
    zone: zone ?? rawZone,
    epoch: null,
    issue:
      resolved && 'issue' in resolved ? resolved.issue : rawZone === null ? null : 'unknown_zone',
    secondsDropped: time[6] !== '00',
  };
}

export function readIcsDuration(raw: string): { days: number; seconds: number } | null {
  const match = /^\+?P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/.exec(raw);
  if (!match || match.slice(1).every((value) => value === undefined) || raw.endsWith('T'))
    return null;
  const values = match.slice(1).map((value) => Number(value ?? 0));
  if (!values.every(Number.isSafeInteger)) return null;
  const days = values[0] * 7 + values[1],
    seconds = values[2] * 3600 + values[3] * 60 + values[4];
  return Number.isSafeInteger(days) && Number.isSafeInteger(seconds) ? { days, seconds } : null;
}

/** RFC 5545: advance calendar days first, then elapsed seconds. */
export function endFromDuration(start: IcsTime, raw: string): IcsTime | null {
  const duration = readIcsDuration(raw);
  if (!duration || (start.kind === 'date' && duration.seconds !== 0)) return null;
  const wallEpoch = dateEpoch(start.kind === 'date' ? `${start.wall}T00:00:00Z` : `${start.wall}Z`);
  if (wallEpoch === null) return null;
  const dayEnd = new Date(wallEpoch + duration.days * DAY);
  if (!Number.isFinite(dayEnd.getTime())) return null;
  const wall = dayEnd.toISOString().slice(0, 19);
  const fromWall = (text: string, zone: string | null, utc: boolean) =>
    readIcsTime({
      name: 'DTEND',
      params: zone === null || utc ? {} : { TZID: [zone] },
      value: text.replace(/[-:]/g, '') + (utc ? 'Z' : ''),
    });
  if (start.kind === 'date')
    return readIcsTime({
      name: 'DTEND',
      params: { VALUE: ['DATE'] },
      value: wall.slice(0, 10).replaceAll('-', ''),
    });
  if (start.kind === 'floating') {
    const end = new Date(dayEnd.getTime() + duration.seconds * 1000);
    if (!Number.isFinite(end.getTime())) return null;
    const read = fromWall(end.toISOString().slice(0, 19), null, false);
    return read === null ? null : { ...read, zone: start.zone, issue: start.issue };
  }
  const afterDays = fromWall(wall, start.zone, start.kind === 'utc');
  if (!afterDays) return null;
  if (afterDays.epoch !== null) {
    const epoch = afterDays.epoch + duration.seconds * 1000;
    if (!Number.isFinite(new Date(epoch).getTime())) return null;
    const nextWall =
      afterDays.kind === 'utc'
        ? new Date(epoch).toISOString().slice(0, 19)
        : zoneWall(epoch, afterDays.zone!);
    // An elapsed duration already identifies the instant, even when its
    // resulting wall time sits in a repeated hour.
    const offset = dateEpoch(`${nextWall}Z`)! - epoch;
    const value = afterDays.kind === 'utc' ? `${nextWall}Z` : withOffset(nextWall, offset);
    return value === null ? null : { ...afterDays, wall: nextWall, epoch, value };
  }
  const floatingEnd = new Date(dayEnd.getTime() + duration.seconds * 1000);
  if (!Number.isFinite(floatingEnd.getTime())) return null;
  const read = fromWall(floatingEnd.toISOString().slice(0, 19), null, false);
  return read === null ? null : { ...read, zone: afterDays.zone, issue: afterDays.issue };
}
