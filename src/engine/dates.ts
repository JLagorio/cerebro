/**
 * Rich date values (M2.x docs polish — Notion-style date picker). A date in
 * a note body stays plain, readable markdown:
 *
 *   📅 2026-07-26
 *   📅 2026-07-26 → 2026-08-01
 *   📅 2026-07-26 16:00 → 2026-08-01 16:00
 *   📅 2026-07-26 ((relative|remind:1d))
 *
 * The trailing `((…))` block carries non-default display/reminder flags and
 * is omitted entirely for a bare default date, so existing `📅 YYYY-MM-DD`
 * due dates (tasks engine, Obsidian-Tasks habit) parse and serialize
 * unchanged.
 */

export type DateDisplayFormat = 'full' | 'short' | 'mdy' | 'dmy' | 'ymd' | 'relative';
export type TimeDisplayFormat = '12' | '24' | 'hidden';
/** Days before the start date that the reminder fires. */
export type RemindOffset = '0d' | '1d' | '2d' | '1w';

export interface DateValue {
  start: string; // YYYY-MM-DD
  end: string | null; // YYYY-MM-DD — range when set
  startTime: string | null; // HH:MM, 24h storage
  endTime: string | null;
  format: DateDisplayFormat;
  timeFormat: TimeDisplayFormat;
  remind: RemindOffset | null;
}

export const DEFAULT_FORMAT: DateDisplayFormat = 'full';
export const DEFAULT_TIME_FORMAT: TimeDisplayFormat = '12';

export function makeDateValue(start: string): DateValue {
  return {
    start,
    end: null,
    startTime: null,
    endTime: null,
    format: DEFAULT_FORMAT,
    timeFormat: DEFAULT_TIME_FORMAT,
    remind: null,
  };
}

/** Local-machine date parts → ISO date string (never UTC-shifted). */
export function toIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DD' → local Date at midnight. Safe for calendar math. */
export function fromIsoDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso: string, days: number): string {
  const d = fromIsoDate(iso);
  d.setDate(d.getDate() + days);
  return toIsoDate(d);
}

// --- Token grammar ---------------------------------------------------------

const DATE = String.raw`\d{4}-\d{2}-\d{2}`;
const TIME = String.raw`\d{2}:\d{2}`;
/** Full date-token pattern (no capture groups; embed in larger regexes). */
export const DATE_TOKEN_SOURCE = String.raw`📅\s*${DATE}(?:\s${TIME})?(?:\s*→\s*${DATE}(?:\s${TIME})?)?(?:\s*\(\([a-z0-9|:]+\)\))?`;

const TOKEN_RE = new RegExp(
  String.raw`^📅\s*(${DATE})(?:\s(${TIME}))?(?:\s*→\s*(${DATE})(?:\s(${TIME}))?)?(?:\s*\(\(([a-z0-9|:]+)\)\))?$`,
);

const FORMAT_FLAGS: Record<string, DateDisplayFormat> = {
  full: 'full',
  short: 'short',
  mdy: 'mdy',
  dmy: 'dmy',
  ymd: 'ymd',
  relative: 'relative',
};
const TIME_FLAGS: Record<string, TimeDisplayFormat> = {
  '12h': '12',
  '24h': '24',
  notime: 'hidden',
};
const REMIND_OFFSETS: RemindOffset[] = ['0d', '1d', '2d', '1w'];

/** Parse a serialized date token (with or without the leading 📅 spacing
 * variations). Returns null when the text isn't a date token. */
export function parseDateToken(text: string): DateValue | null {
  const m = TOKEN_RE.exec(text.trim());
  if (m === null) return null;
  const value = makeDateValue(m[1]);
  value.startTime = m[2] ?? null;
  value.end = m[3] ?? null;
  value.endTime = m[4] ?? null;
  for (const flag of (m[5] ?? '').split('|')) {
    if (flag === '') continue;
    if (flag in FORMAT_FLAGS) value.format = FORMAT_FLAGS[flag];
    else if (flag in TIME_FLAGS) value.timeFormat = TIME_FLAGS[flag];
    else if (flag.startsWith('remind:')) {
      const offset = flag.slice('remind:'.length);
      if ((REMIND_OFFSETS as string[]).includes(offset)) value.remind = offset as RemindOffset;
    }
  }
  return value;
}

export function serializeDateValue(v: DateValue): string {
  let out = `📅 ${v.start}`;
  if (v.startTime !== null) out += ` ${v.startTime}`;
  if (v.end !== null) {
    out += ` → ${v.end}`;
    if (v.endTime !== null) out += ` ${v.endTime}`;
  }
  const flags: string[] = [];
  if (v.format !== DEFAULT_FORMAT) {
    const flag = Object.entries(FORMAT_FLAGS).find(([, f]) => f === v.format)?.[0];
    if (flag !== undefined) flags.push(flag);
  }
  if (v.timeFormat !== DEFAULT_TIME_FORMAT) {
    const flag = Object.entries(TIME_FLAGS).find(([, f]) => f === v.timeFormat)?.[0];
    if (flag !== undefined) flags.push(flag);
  }
  if (v.remind !== null) flags.push(`remind:${v.remind}`);
  if (flags.length > 0) out += ` ((${flags.join('|')}))`;
  return out;
}

// --- Display formatting ----------------------------------------------------

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
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** One date in the requested format; `today` anchors relative labels. */
export function formatDate(iso: string, format: DateDisplayFormat, today: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  switch (format) {
    case 'mdy':
      return `${pad2(m)}/${pad2(d)}/${y}`;
    case 'dmy':
      return `${pad2(d)}/${pad2(m)}/${y}`;
    case 'ymd':
      return `${y}/${pad2(m)}/${pad2(d)}`;
    case 'full':
      return `${MONTHS[m - 1]} ${d}, ${y}`;
    case 'short':
      return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`;
    case 'relative': {
      const diff = Math.round(
        (fromIsoDate(iso).getTime() - fromIsoDate(today).getTime()) / 86_400_000,
      );
      if (diff === 0) return 'Today';
      if (diff === 1) return 'Tomorrow';
      if (diff === -1) return 'Yesterday';
      if (diff > 1 && diff <= 7) return `Next ${WEEKDAYS[fromIsoDate(iso).getDay()]}`;
      if (diff < -1 && diff >= -7) return `Last ${WEEKDAYS[fromIsoDate(iso).getDay()]}`;
      return `${MONTHS[m - 1].slice(0, 3)} ${d}${y === Number(today.slice(0, 4)) ? '' : `, ${y}`}`;
    }
  }
}

/** 'HH:MM' in the requested clock ('' when hidden). */
export function formatTime(time: string, format: TimeDisplayFormat): string {
  if (format === 'hidden') return '';
  const [h, m] = time.split(':').map(Number);
  if (format === '24') return `${pad2(h)}:${pad2(m)}`;
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${pad2(m)} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Chip label, e.g. "Today 4:00 PM → Next Saturday 4:00 PM". */
export function formatDateValue(v: DateValue, today: string): string {
  const part = (date: string, time: string | null): string => {
    let out = formatDate(date, v.format, today);
    if (time !== null && v.timeFormat !== 'hidden') out += ` ${formatTime(time, v.timeFormat)}`;
    return out;
  };
  let label = part(v.start, v.startTime);
  if (v.end !== null) label += ` → ${part(v.end, v.endTime)}`;
  return label;
}

// --- Reminders -------------------------------------------------------------

export const REMIND_OPTIONS: { id: RemindOffset | 'none'; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: '0d', label: 'On day of event (9:00 AM)' },
  { id: '1d', label: '1 day before (9:00 AM)' },
  { id: '2d', label: '2 days before (9:00 AM)' },
  { id: '1w', label: '1 week before (9:00 AM)' },
];

const OFFSET_DAYS: Record<RemindOffset, number> = { '0d': 0, '1d': 1, '2d': 2, '1w': 7 };

/**
 * When the reminder fires, as a local 'YYYY-MM-DDTHH:MM'. Timed events
 * remind at the event's own time on the offset day; date-only events at
 * 9:00 AM (mirrors the picker's preset labels).
 */
export function remindAt(v: DateValue): string | null {
  if (v.remind === null) return null;
  const day = addDays(v.start, -OFFSET_DAYS[v.remind]);
  return `${day}T${v.startTime ?? '09:00'}`;
}

// --- Editor chip props -----------------------------------------------------
// BlockNote inline-content props must be flat strings with defaults; '' means
// "unset / default" so bare due chips keep serializing as `📅 YYYY-MM-DD`.

export interface DateChipProps {
  date: string;
  end: string;
  time: string;
  endTime: string;
  format: string;
  timeFormat: string;
  remind: string;
}

export function dateValueToChipProps(v: DateValue): DateChipProps {
  return {
    date: v.start,
    end: v.end ?? '',
    time: v.startTime ?? '',
    endTime: v.endTime ?? '',
    format: v.format === DEFAULT_FORMAT ? '' : v.format,
    timeFormat: v.timeFormat === DEFAULT_TIME_FORMAT ? '' : v.timeFormat,
    remind: v.remind ?? '',
  };
}

export function chipPropsToDateValue(p: Partial<DateChipProps>): DateValue {
  const value = makeDateValue(p.date ?? '');
  if (p.end !== undefined && p.end !== '') value.end = p.end;
  if (p.time !== undefined && p.time !== '') value.startTime = p.time;
  if (p.endTime !== undefined && p.endTime !== '') value.endTime = p.endTime;
  if (p.format !== undefined && p.format in FORMAT_FLAGS_BY_VALUE) {
    value.format = p.format as DateDisplayFormat;
  }
  if (p.timeFormat === '12' || p.timeFormat === '24' || p.timeFormat === 'hidden') {
    value.timeFormat = p.timeFormat;
  }
  if (p.remind !== undefined && (REMIND_OFFSETS as string[]).includes(p.remind)) {
    value.remind = p.remind as RemindOffset;
  }
  return value;
}

const FORMAT_FLAGS_BY_VALUE: Record<string, true> = {
  full: true,
  short: true,
  mdy: true,
  dmy: true,
  ymd: true,
  relative: true,
};

/** Local timezone name pair, e.g. { zone: 'America/Los_Angeles', short: 'PDT' }. */
export function localTimezone(): { zone: string; short: string } {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Local';
    const short =
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
        .formatToParts(new Date())
        .find((p) => p.type === 'timeZoneName')?.value ?? zone;
    return { zone, short };
  } catch {
    return { zone: 'Local', short: 'Local' };
  }
}
