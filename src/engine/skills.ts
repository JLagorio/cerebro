import { splitFrontmatter } from '@/lib/mockParse';
import { slugify } from '@/lib/slug';
import { declaredSlug, recordIdentity } from './identity';
import { isRecordEntry } from './typeCatalog';
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
 *   reads the note itself with get_note. Same file either way.
 */

export const SKILL_TYPE = 'Skill';

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
  return isRecordEntry(entry) && entry.type === SKILL_TYPE && entry.parseError === null;
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

/**
 * The message actually sent for an invocation. `raw` is the note as read from
 * disk; the frontmatter is the catalog's business, not the run's.
 */
export function skillPrompt(skill: SkillRef, raw: string, request: string): string {
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

// --- Schedules (M13.2) ------------------------------------------------------
//
// A skill with a `schedule:` runs unattended. The grammar is deliberately
// small — `hourly`, `daily 09:00`, `weekdays 09:00`, `weekly fri 17:00` —
// and the derivation is the same shape as the rest of the knowledge layer:
// nothing stores a job list. The most recent fire time that has passed is
// computed from the wall clock, and the run ledger records which fire each
// skill has answered. An app that was closed all week owes ONE catch-up run,
// not seven.

export type Schedule =
  | { kind: 'hourly' }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; day: number; hour: number; minute: number };

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** `schedule:` frontmatter → a Schedule, or null for anything malformed —
 * a skill with a schedule nobody can parse is simply not scheduled. */
export function parseSchedule(raw: unknown): Schedule | null {
  if (typeof raw !== 'string') return null;
  const text = raw.trim().toLowerCase();
  if (text === 'hourly') return { kind: 'hourly' };

  const time = (t: string): { hour: number; minute: number } | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (m === null) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    return hour < 24 && minute < 60 ? { hour, minute } : null;
  };

  const daily = /^(daily|weekdays)\s+(\S+)$/.exec(text);
  if (daily !== null) {
    const at = time(daily[2]);
    return at === null ? null : { kind: daily[1] as 'daily' | 'weekdays', ...at };
  }

  const weekly = /^weekly\s+(\S+)\s+(\S+)$/.exec(text);
  if (weekly !== null) {
    const day = DAY_NAMES.findIndex((d) => weekly[1] === d || weekly[1].startsWith(d));
    const at = time(weekly[2]);
    return day === -1 || at === null ? null : { kind: 'weekly', day, ...at };
  }

  return null;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * The most recent fire time at or before `now`, as a key the run ledger
 * stores. A scheduled job is due exactly when the ledger holds a different
 * key than this — so the ONE property a key must have is stability: the same
 * fire must derive the same key from every tick that observes it.
 *
 * DST is where that property goes to die, so the two branches dodge it in
 * different ways. The hourly key is UTC: during fall-back the local clock
 * reads 01:xx twice and a local key would collide, silently swallowing one
 * run. Dated keys take their HH:MM from the SCHEDULE, never from the
 * walked-back Date: setHours on a spring-forward day normalizes a skipped
 * 02:30 to 03:30, and stamping that normalized time onto a previous day's
 * fire mints a phantom key no other derivation produces — one duplicate
 * unattended run per transition.
 */
export function lastFireKey(schedule: Schedule, now: Date): string {
  const at = new Date(now);
  if (schedule.kind === 'hourly') {
    return `${at.toISOString().slice(0, 13)}:00Z`;
  }
  at.setHours(schedule.hour, schedule.minute, 0, 0);
  if (at.getTime() > now.getTime()) at.setDate(at.getDate() - 1);
  if (schedule.kind === 'weekdays') {
    while (at.getDay() === 0 || at.getDay() === 6) at.setDate(at.getDate() - 1);
  }
  if (schedule.kind === 'weekly') {
    while (at.getDay() !== schedule.day) at.setDate(at.getDate() - 1);
  }
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(schedule.hour)}:${pad(schedule.minute)}`;
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
 */
export function skillIndex(skills: SkillRef[]): string | null {
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
    "The user runs one by typing /name in this panel. When a request matches a skill's purpose, " +
    `read its note with get_note and follow it. Skills: ${shown.join('; ')}.` +
    // Said, not hidden. A silently truncated catalogue reads as the complete
    // set, and the agent will tell the user a skill does not exist.
    (omitted > 0
      ? ` ${omitted} more ${omitted === 1 ? 'skill is' : 'skills are'} defined but not listed here — search_notes for type Skill to find them.`
      : '')
  );
}
