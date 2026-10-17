import { splitFrontmatter } from './frontmatter';
import { slugify } from '@/lib/slug';
import { declaredSlug, recordIdentity } from './identity';
import { libraryKind, SKILL_TYPE } from './library';
import { holds, type PromptGrant } from './toolGrant';
import type { Entry } from './types';

/**
 * Skills (M13.1): a skill is a record.
 *
 * A record of `type: Skill` whose BODY is a reusable instruction set. The
 * catalog rides in every system prompt as one line per skill — name and
 * description only — and the body is read from disk at the moment of
 * invocation, so a vault full of skills costs a conversation almost nothing
 * until one is actually used.
 *
 * Two ways in, deliberately:
 * - the user types `/name` in the panel — the app expands it (see
 *   matchSkillInvocation/skillPrompt) and the transcript shows what was typed;
 * - the agent recognizes a request that matches a skill's description and
 *   reads the note itself with get_note, on a run that holds it (M54.7).
 *   Same file either way.
 */

// The name moved to engine/library when skills stopped being a record type
// (M18); re-exported here so every existing import keeps working.
export { SKILL_TYPE };

/**
 * One declared input for a skill (M17.8).
 *
 * Declared so that three surfaces can agree on what a skill wants: the `/`
 * completion hints it, the prompt names it, and a Skills screen can show it.
 * Optional throughout — a skill with no `arguments:` is exactly what it was.
 */
export interface SkillArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface SkillRef {
  /**
   * Slash name the user types.
   *
   * The declared `slug:` when there is one, else the slugified title, made
   * unique within the list. Declaring one is how a skill survives being
   * renamed — see engine/identity.ts.
   */
  name: string;
  /** Ledger key: stable across renames when the record declares a `slug:`. */
  id: string;
  title: string;
  path: string;
  /** The `description:` property, one line; '' when the record has none. */
  description: string;
  /** Declared inputs, in order; empty when the record declares none. */
  arguments: SkillArgument[];
  /**
   * Tools this skill may use, or null for "whatever the turn already had".
   *
   * A NARROWING only. The run it belongs to has already been granted a policy
   * by Settings and by the record that started it; this can subtract from that
   * and never add to it, which is enforced in Rust rather than asked for in a
   * prompt (M17.13).
   */
  allowedTools: string[] | null;
  /** Attended invocations may narrow connector servers; scheduled skills
   * never read this grant. Null leaves the current grant, [] withdraws it. */
  connectors: string[] | null;
  /** Connector denials add to an addressed agent's; they never remove one. */
  disallowedTools: string[] | null;
}

/** One invocation's three subtractive grants, frozen with queued turns. */
export interface SkillNarrowing {
  allowedTools?: string[] | null;
  connectors?: string[] | null;
  disallowedTools?: string[] | null;
}

/**
 * Parse `arguments:` frontmatter, tolerantly.
 *
 * Two shapes, because a frontmatter block a person hand-writes should not need
 * a manual: a bare string is a name, and an object carries a description and
 * `required`. Anything else in the list is skipped rather than failing the
 * whole record — the same read-through discipline as every other property.
 */
export function parseArguments(raw: unknown): SkillArgument[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillArgument[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const name = item.trim();
      if (name !== '') out.push({ name, description: '', required: false });
      continue;
    }
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (name === '') continue;
    out.push({
      name,
      description: typeof record.description === 'string' ? record.description.trim() : '',
      required: record.required === true,
    });
  }
  return out;
}

/** Parse `allowed-tools:`. Null when undeclared — which means "do not
 * narrow", NOT "narrow to nothing". An empty list IS a narrowing to nothing
 * and is honoured, because a skill that wants a read-only turn should be able
 * to say so. */
export function parseAllowedTools(raw: unknown): string[] | null {
  if (typeof raw === 'string') {
    const names = raw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t !== '');
    return names;
  }
  if (!Array.isArray(raw)) return null;
  return raw
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    .map((t) => t.trim());
}

export function isSkillEntry(entry: Entry): boolean {
  // Was `isRecordEntry(entry) && …`, which stopped being true of a skill the
  // moment skills stopped being records (M18). Both exclusions that clause was
  // actually buying now live in libraryKind, as one rule rather than two
  // copies: a template stamps `type: Skill` on the page it makes and is not
  // one itself, and a knowledge-bundle file must never become invocable.
  return libraryKind(entry) === 'skill' && entry.parseError === null;
}

/**
 * Every invocable skill, sorted by title.
 *
 * A DECLARED `slug:` wins the handle outright and is claimed first, before any
 * title-derived name is assigned (M17.8). Both halves of that matter: the
 * declaration is the whole point of declaring, and claiming them in a first
 * pass stops a title-derived name from taking a handle some other skill has
 * asked for by name.
 *
 * Title-derived names still collide when two titles slugify identically;
 * later ones get `-2`, `-3`, bumped until the name is actually free — "Review
 * 2" already owning `review-2` must not hand a second skill the same handle,
 * or clicking one would invoke the other.
 */
export function listSkills(entries: Entry[]): SkillRef[] {
  const skills = entries
    .filter((e) => isSkillEntry(e) && (declaredSlug(e) !== '' || slugify(e.title) !== ''))
    .sort((a, b) => a.title.localeCompare(b.title));

  // First pass: declared slugs, which are not negotiable. A duplicate
  // declaration is the author's mistake and the first one in title order
  // keeps it — the alternative is suffixing a handle somebody wrote down.
  const taken = new Set<string>();
  const declared = new Map<string, string>();
  for (const e of skills) {
    const slug = declaredSlug(e);
    if (slug === '' || taken.has(slug)) continue;
    taken.add(slug);
    declared.set(e.path, slug);
  }

  return skills.map((e) => {
    let name = declared.get(e.path);
    if (name === undefined) {
      const base = slugify(e.title);
      name = base;
      for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
      taken.add(name);
    }
    // The Rust scanner files any wikilink-valued field under
    // `relationships`, so a description like "review of [[Phoenix]]" is
    // absent from `properties`. The link names are most of its meaning —
    // better in the catalog than a silent blank.
    const description =
      typeof e.properties.description === 'string'
        ? e.properties.description.replace(/\s+/g, ' ').trim()
        : (e.relationships.description ?? []).map((t) => `[[${t}]]`).join(' ');
    return {
      name,
      id: recordIdentity(e),
      title: e.title,
      path: e.path,
      description,
      arguments: parseArguments(e.properties.arguments),
      allowedTools: parseAllowedTools(e.properties['allowed-tools']),
      connectors: parseAllowedTools(e.properties.connectors),
      disallowedTools: parseAllowedTools(e.properties['disallowed-tools']),
    };
  });
}

export interface SkillInvocation {
  skill: SkillRef;
  /** Whatever followed the slash token — the input for this run; '' if none. */
  request: string;
}

/**
 * Parse a composer message as a skill invocation: `/name rest of message`.
 * Null when it is not one — including an unknown name, which sends as typed
 * rather than erroring; the agent sees the slash and can say so.
 */
export function matchSkillInvocation(text: string, skills: SkillRef[]): SkillInvocation | null {
  const match = /^\/(\S+)([\s\S]*)$/.exec(text.trim());
  if (match === null) return null;
  const name = match[1].toLowerCase();
  const skill = skills.find((s) => s.name === name);
  if (skill === undefined) return null;
  return { skill, request: match[2].trim() };
}

/** A reproducible local wall clock, using Date.getTimezoneOffset's sign. */
export function localTimeLine(now: Date, offsetMinutes: number): string {
  const local = new Date(now.getTime() - offsetMinutes * 60_000);
  const date = local.toISOString().slice(0, 16).replace('T', ' ');
  const minutes = Math.abs(offsetMinutes);
  const offset = `${offsetMinutes > 0 ? '-' : '+'}${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  return `The user's local time is ${date} (UTC${offset}).`;
}

/**
 * The message actually sent for an invocation. `raw` is the note as read from
 * disk; the frontmatter is the catalog's business, not the run's. An optional
 * clock states the local time and offset so relative windows are explicit.
 */
export function skillPrompt(
  skill: SkillRef,
  raw: string,
  request: string,
  clock?: { now: Date; offsetMinutes: number },
): string {
  const body = splitFrontmatter(raw).body.trim();
  const lines = [
    `The user invoked the skill "${skill.title}" (${skill.path}). Follow its instructions:`,
    '',
    body,
  ];
  if (skill.arguments.length > 0) {
    // Named so the agent can read one line of input as the fields the skill
    // actually wants, rather than guessing which half of a sentence was which.
    lines.push('', `This skill declares inputs: ${describeArguments(skill.arguments)}.`);
    if (request === '' && skill.arguments.some((a) => a.required)) {
      // Asking beats inventing. A skill whose required input is missing is the
      // one case where a clarifying question is cheaper than a wrong run.
      lines.push('The user supplied none — ask for what you need before acting.');
    }
  }
  if (request !== '') {
    lines.push('', `The user's input for this run: ${request}`);
  }
  if (clock) lines.push('', localTimeLine(clock.now, clock.offsetMinutes));
  return lines.join('\n');
}

function describeArguments(args: SkillArgument[]): string {
  return args
    .map(
      (a) =>
        `${a.name}${a.required ? ' (required)' : ''}${a.description === '' ? '' : ` — ${a.description}`}`,
    )
    .join('; ');
}

/** `<required> [optional]`, for the composer's completion hint. */
export function argumentHint(skill: SkillRef): string {
  return skill.arguments.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(' ');
}

// --- Schedules -------------------------------------------------------------
// Files declare closed shapes; the queue derives their newest passed fire.
// A launch owes one catch-up. In-app activation stamps that boundary so a
// resume or edited schedule waits for its next time instead.

export type Schedule =
  | { kind: 'hourly' }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; day: number; hour: number; minute: number }
  | { kind: 'days'; days: number[]; hour: number; minute: number }
  | { kind: 'monthly'; day: number | 'last'; hour: number; minute: number }
  | { kind: 'once'; date: string; hour: number; minute: number };
export const MAX_SCHEDULE_ITEMS = 8;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number): string => String(n).padStart(2, '0');
const clockText = (schedule: Exclude<Schedule, { kind: 'hourly' }>) =>
  `${pad(schedule.hour)}:${pad(schedule.minute)}`;
function dateAt(year: number, month: number, day: number, hour: number, minute: number): Date {
  const at = new Date(0);
  at.setFullYear(year, month, day);
  at.setHours(hour, minute, 0, 0);
  return at;
}
function realDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const at = dateAt(year, month - 1, day, 12, 0);
  return at.getFullYear() === year && at.getMonth() === month - 1 && at.getDate() === day;
}
function onceAt(schedule: Extract<Schedule, { kind: 'once' }>): Date {
  const [year, month, day] = schedule.date.split('-').map(Number);
  return dateAt(year, month - 1, day, schedule.hour, schedule.minute);
}
/** An invalid item never partly schedules a record. */
export function parseSchedule(raw: unknown): Schedule | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase();
  if (text === 'hourly') return { kind: 'hourly' };
  const match = /^(daily|weekdays|weekly|monthly|once)\s+(?:(\S+)\s+)?(\d{1,2}):(\d{2})$/.exec(
    text,
  );
  if (match === null) return null;
  const [, kind, detail, h, m] = match;
  const hour = Number(h),
    minute = Number(m);
  if (hour > 23 || minute > 59) return null;
  if (kind === 'daily' || kind === 'weekdays')
    return detail === undefined ? { kind, hour, minute } : null;
  if (kind === 'once')
    return detail !== undefined && realDate(detail) ? { kind, date: detail, hour, minute } : null;
  if (kind === 'monthly') {
    const day = detail === 'last' ? 'last' : Number(detail);
    return day === 'last' ||
      (detail !== undefined && /^\d{1,2}$/.test(detail) && day >= 1 && day <= 28)
      ? { kind, day, hour, minute }
      : null;
  }
  if (detail === undefined) return null;
  const days = detail
    .split(',')
    .map((name) =>
      DAY_NAMES.findIndex(
        (short, index) => name === short || name === DAY_LABELS[index].toLowerCase(),
      ),
    );
  if (days.some((day) => day < 0) || new Set(days).size !== days.length) return null;
  days.sort((a, b) => a - b);
  return days.length === 1
    ? { kind: 'weekly', day: days[0], hour, minute }
    : { kind: 'days', days, hour, minute };
}
export function formatSchedule(schedule: Schedule): string {
  if (schedule.kind === 'hourly') return 'hourly';
  const at = clockText(schedule);
  switch (schedule.kind) {
    case 'daily':
    case 'weekdays':
      return `${schedule.kind} ${at}`;
    case 'weekly':
      return `weekly ${DAY_NAMES[schedule.day]} ${at}`;
    case 'days':
      return `weekly ${[...schedule.days]
        .sort((a, b) => a - b)
        .map((day) => DAY_NAMES[day])
        .join(',')} ${at}`;
    case 'monthly':
      return `monthly ${schedule.day} ${at}`;
    case 'once':
      return `once ${schedule.date} ${at}`;
  }
}
/** Draft items preserve authored strings until a control explicitly changes one. */
export function scheduleItems(raw: unknown): string[] {
  if (typeof raw === 'string') return raw.trim() === '' ? [] : [raw];
  return Array.isArray(raw)
    ? raw.map((item) => (typeof item === 'string' ? item : (JSON.stringify(item) ?? String(item))))
    : [];
}
export function scheduleText(raw: unknown): string {
  return scheduleItems(raw).join('; ');
}
export function parseScheduleSet(raw: unknown): Schedule[] | null {
  if (typeof raw !== 'string' && !Array.isArray(raw)) return null;
  const items = typeof raw === 'string' ? [raw] : raw;
  if (items.length < 1 || items.length > MAX_SCHEDULE_ITEMS) return null;
  const parsed = items.map(parseSchedule);
  return parsed.some((item) => item === null) ? null : (parsed as Schedule[]);
}
const wordsList = (words: string[]) =>
  words.length < 3 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
const ordinal = (day: number) =>
  `${day}${day >= 11 && day <= 13 ? 'th' : day % 10 === 1 ? 'st' : day % 10 === 2 ? 'nd' : day % 10 === 3 ? 'rd' : 'th'}`;
export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === 'hourly') return 'Every hour';
  const at = clockText(schedule);
  switch (schedule.kind) {
    case 'daily':
      return `Every day at ${at}`;
    case 'weekdays':
      return `Every weekday at ${at}`;
    case 'weekly':
      return `Every ${DAY_LABELS[schedule.day]} at ${at}`;
    case 'days':
      return `Every ${wordsList(schedule.days.map((day) => DAY_LABELS[day]))} at ${at}`;
    case 'monthly':
      return `Monthly on the ${schedule.day === 'last' ? 'last day' : ordinal(schedule.day)} at ${at}`;
    case 'once':
      return `Once, on ${schedule.date} at ${at}`;
  }
}
export function describeScheduleSet(raw: unknown): string {
  return parseScheduleSet(raw)?.map(describeSchedule).join('; ') ?? 'Schedule not understood';
}
function calendarKey(at: Date, schedule: Exclude<Schedule, { kind: 'hourly' }>): string {
  return `${String(at.getFullYear()).padStart(4, '0')}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clockText(schedule)}`;
}
function monthAt(
  schedule: Extract<Schedule, { kind: 'monthly' }>,
  year: number,
  month: number,
): Date {
  const day = schedule.day === 'last' ? dateAt(year, month + 1, 0, 12, 0).getDate() : schedule.day;
  return dateAt(year, month, day, schedule.hour, schedule.minute);
}
function dayMatches(schedule: Exclude<Schedule, { kind: 'hourly' }>, day: number): boolean {
  return schedule.kind === 'weekdays'
    ? day !== 0 && day !== 6
    : schedule.kind === 'weekly'
      ? day === schedule.day
      : schedule.kind === 'days'
        ? schedule.days.includes(day)
        : true;
}
/** The newest passed fire, or none for a once still ahead. Hourly keys are
 * UTC so a repeated fall-back hour stays distinct. Calendar keys always
 * carry the authored HH:MM, even when spring-forward normalizes its instant. */
export function lastFireKey(schedule: Schedule, now: Date): string | null {
  if (schedule.kind === 'hourly') return `${now.toISOString().slice(0, 13)}:00Z`;
  if (schedule.kind === 'once') {
    const at = onceAt(schedule);
    return at > now ? null : calendarKey(at, schedule);
  }
  if (schedule.kind === 'monthly') {
    let at = monthAt(schedule, now.getFullYear(), now.getMonth());
    if (at > now) at = monthAt(schedule, now.getFullYear(), now.getMonth() - 1);
    return calendarKey(at, schedule);
  }
  const cursor = dateAt(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0);
  for (;;) {
    const at = dateAt(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate(),
      schedule.hour,
      schedule.minute,
    );
    if (at <= now && dayMatches(schedule, cursor.getDay())) return calendarKey(at, schedule);
    cursor.setDate(cursor.getDate() - 1);
  }
}

/**
 * The instant a fire key names (M34.2) — the run's DUE moment, parsed back
 * from the ledger key `lastFireKey` minted. Lives beside the mint because the
 * two formats are one contract: dated keys are local wall-clock, hourly keys
 * are UTC (the DST reasoning above), and nothing outside this module may
 * guess at either. Null for anything else — an event runKey has no due time,
 * and inventing one would let a triggered run claim it was "late".
 */
export function fireKeyDate(key: string): Date | null {
  const dated = key.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (dated !== null) {
    return dateAt(
      Number(dated[1]),
      Number(dated[2]) - 1,
      Number(dated[3]),
      Number(dated[4]),
      Number(dated[5]),
    );
  }
  const hourly = key.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):00Z$/);
  if (hourly !== null) {
    return new Date(
      Date.UTC(Number(hourly[1]), Number(hourly[2]) - 1, Number(hourly[3]), Number(hourly[4])),
    );
  }
  return null;
}

/** The next future instant; a once at or before now has no next firing. */
export function nextFire(schedule: Schedule, now: Date): Date | null {
  if (schedule.kind === 'hourly')
    return new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000 + 3_600_000);
  if (schedule.kind === 'once') {
    const at = onceAt(schedule);
    return at > now ? at : null;
  }
  if (schedule.kind === 'monthly') {
    const at = monthAt(schedule, now.getFullYear(), now.getMonth());
    return at > now ? at : monthAt(schedule, now.getFullYear(), now.getMonth() + 1);
  }
  const cursor = dateAt(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0);
  for (;;) {
    const at = dateAt(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate(),
      schedule.hour,
      schedule.minute,
    );
    if (at > now && dayMatches(schedule, cursor.getDay())) return at;
    cursor.setDate(cursor.getDate() + 1);
  }
}
export function lastSetFireKey(schedules: readonly Schedule[], now: Date): string | null {
  let newest: string | null = null;
  for (const schedule of schedules) {
    const key = lastFireKey(schedule, now);
    if (
      key !== null &&
      (newest === null ||
        fireKeyDate(key)!.getTime() > fireKeyDate(newest)!.getTime() ||
        (fireKeyDate(key)!.getTime() === fireKeyDate(newest)!.getTime() && key > newest))
    )
      newest = key;
  }
  return newest;
}
export function nextSetFire(schedules: readonly Schedule[], now: Date): Date | null {
  let next: Date | null = null;
  for (const schedule of schedules) {
    const at = nextFire(schedule, now);
    if (at !== null && (next === null || at < next)) next = at;
  }
  return next;
}

/**
 * Progressive disclosure, tier one (M17.8).
 *
 * The catalogue rides in EVERY system prompt, so it is the one part of the
 * skill system whose cost scales with how much the vault has rather than with
 * what the turn is doing. Three tiers, and only the first is unconditional:
 *
 *   1. name + inputs + description, here, in every prompt;
 *   2. the BODY, read from disk at the moment of invocation (skillPrompt);
 *   3. anything the body points at, fetched by the agent with its own tools.
 *
 * The budget is what makes tier one bounded. Without it a vault with two
 * hundred skills would spend its whole context describing skills it is not
 * running. Measured in characters rather than tokens on purpose: a token count
 * would need a tokenizer, and this is a ceiling, not an accounting.
 */
const CATALOG_BUDGET = 1_400;

/**
 * The system-prompt catalog: what exists and how to reach it, in one line per
 * skill. Null when the vault defines none — a paragraph explaining an empty
 * feature is noise in every conversation.
 *
 * How to reach a skill names a tool, so it follows the run's grant (M54.7):
 * reading one's note is offered only to a run that holds get_note, and the
 * way to the unlisted ones is the first of `OVERFLOW` the run holds.
 */
export function skillIndex(skills: SkillRef[], grant: PromptGrant): string | null {
  if (skills.length === 0) return null;
  const shown: string[] = [];
  let used = 0;
  for (const skill of skills) {
    const hint = argumentHint(skill);
    const line = `/${skill.name}${hint === '' ? '' : ` ${hint}`}${
      skill.description === '' ? '' : ` — ${skill.description}`
    }`;
    // At least one always ships, however long its description: a catalogue
    // that lists nothing is worse than one that overspends by a line.
    if (shown.length > 0 && used + line.length > CATALOG_BUDGET) break;
    shown.push(line);
    used += line.length + 2;
  }
  const omitted = skills.length - shown.length;
  return (
    'This vault defines skills: records of type Skill whose body is a reusable instruction set. ' +
    'The user runs one by typing /name in this panel.' +
    (holds(grant, 'get_note')
      ? " When a request matches a skill's purpose, read its note with get_note and follow it."
      : '') +
    ` Skills: ${shown.join('; ')}.` +
    // Said, not hidden. A silently truncated catalogue reads as the complete
    // set, and the agent will tell the user a skill does not exist.
    (omitted > 0
      ? ` ${omitted} more ${omitted === 1 ? 'skill is' : 'skills are'} defined but not listed here${
          OVERFLOW.find((way) => holds(grant, ...way.uses))?.text ?? '.'
        }`
      : '')
  );
}

/** One ending of the catalogue's line about the skills it did not list,
 * with the tools it names (M54.7's fragment shape). */
interface OverflowEnding {
  uses: readonly string[];
  text: string;
}

/**
 * The ways to the unlisted skills, best first (M59.5): list_notes lists every
 * Skill with no query, search_notes needs one, and a run holding neither is
 * told only that they exist. The last names no tool, so it always applies.
 */
const OVERFLOW: readonly OverflowEnding[] = [
  { uses: ['list_notes'], text: ' — call list_notes with type Skill to see them all.' },
  { uses: ['search_notes'], text: ' — search_notes for type Skill to find them.' },
  { uses: [], text: '.' },
];
