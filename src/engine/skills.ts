import { splitFrontmatter } from '@/lib/mockParse';
import { slugify } from '@/lib/slug';
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

export interface SkillRef {
  /** Slash name the user types: the slugified title, unique in the list. */
  name: string;
  title: string;
  path: string;
  /** The `description:` property, one line; '' when the record has none. */
  description: string;
}

export function isSkillEntry(entry: Entry): boolean {
  return isRecordEntry(entry) && entry.type === SKILL_TYPE && entry.parseError === null;
}

/**
 * Every invocable skill, sorted by title. Slash names collide when two titles
 * slugify identically; later ones get `-2`, `-3`, bumped until the name is
 * actually free — "Review 2" already owning `review-2` must not hand a second
 * skill the same handle, or clicking one would invoke the other.
 */
export function listSkills(entries: Entry[]): SkillRef[] {
  const taken = new Set<string>();
  return entries
    .filter((e) => isSkillEntry(e) && slugify(e.title) !== '')
    .sort((a, b) => a.title.localeCompare(b.title))
    .map((e) => {
      const base = slugify(e.title);
      let name = base;
      for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
      taken.add(name);
      // The Rust scanner files any wikilink-valued field under
      // `relationships`, so a description like "review of [[Phoenix]]" is
      // absent from `properties`. The link names are most of its meaning —
      // better in the catalog than a silent blank.
      const description = typeof e.properties.description === 'string'
        ? e.properties.description.replace(/\s+/g, ' ').trim()
        : (e.relationships.description ?? []).map((t) => `[[${t}]]`).join(' ');
      return { name, title: e.title, path: e.path, description };
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
  if (request !== '') {
    lines.push('', `The user's input for this run: ${request}`);
  }
  return lines.join('\n');
}

/**
 * The system-prompt catalog: what exists and how to reach it, in one line per
 * skill. Null when the vault defines none — a paragraph explaining an empty
 * feature is noise in every conversation.
 */
export function skillIndex(skills: SkillRef[]): string | null {
  if (skills.length === 0) return null;
  const listing = skills
    .map((s) => `/${s.name}${s.description === '' ? '' : ` — ${s.description}`}`)
    .join('; ');
  return (
    'This vault defines skills: records of type Skill whose body is a reusable instruction set. ' +
    'The user runs one by typing /name in this panel. When a request matches a skill\'s purpose, ' +
    `read its note with get_note and follow it. Skills: ${listing}.`
  );
}
