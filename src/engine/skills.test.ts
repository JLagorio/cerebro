import type { Entry } from './types';
import { localTimeLine } from './skills';
import { describe, expect, it } from 'vitest';
import {
  fireKeyDate,
  lastFireKey,
  parseSchedule,
  formatSchedule,
  parseScheduleSet,
  scheduleItems,
  scheduleText,
  describeSchedule,
  describeScheduleSet,
  nextFire,
  lastSetFireKey,
  nextSetFire,
  listSkills,
  matchSkillInvocation,
  skillIndex,
  skillPrompt,
} from './skills';
import { makeEntry } from './testHelpers';
import { grantedTools, mentionedTools, type PromptGrant } from './toolGrant';

/** A panel turn that holds every tool. */
const FULL: PromptGrant = { tools: grantedTools(null), shell: true, attended: true };

const skill = (title: string, patch: Parameters<typeof makeEntry>[0] = {}) =>
  makeEntry({
    path: `records/skills/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    title,
    type: 'Skill',
    properties: { description: `Run ${title}.` },
    ...patch,
  });

describe('listSkills', () => {
  it('lists Skill records and nothing else', () => {
    const entries = [
      skill('Weekly review'),
      makeEntry({ path: 'items/a.md', title: 'A task', type: 'Work item' }),
      makeEntry({ path: 'docs/a.md', title: 'A doc', type: null }),
      makeEntry({ path: 'types/skill.md', title: 'Skill', type: 'Type' }),
    ];
    expect(listSkills(entries).map((s) => s.name)).toEqual(['weekly-review']);
  });

  it('skips unparseable records and knowledge-bundle files', () => {
    const entries = [
      skill('Broken', { parseError: 'bad yaml' }),
      skill('Shadow', { path: 'knowledge/systems/shadow.md' }),
    ];
    expect(listSkills(entries)).toEqual([]);
  });

  it('defaults a missing description to empty and collapses whitespace', () => {
    const entries = [
      skill('Bare', { properties: {} }),
      skill('Wrapped', { properties: { description: 'two\n  lines  here' } }),
    ];
    const skills = listSkills(entries);
    expect(skills.find((s) => s.name === 'bare')?.description).toBe('');
    expect(skills.find((s) => s.name === 'wrapped')?.description).toBe('two lines here');
  });

  it('suffixes colliding slash names, bumping past names already taken', () => {
    // 'Review 2' owns `review-2` outright, so the colliding 'Review!' must
    // land on `review-3` — never on a handle that already invokes another
    // skill, or clicking one row would run a different skill's body.
    const entries = [
      skill('Review!', { path: 'records/skills/review-a.md' }),
      skill('Review', { path: 'records/skills/review-b.md' }),
      skill('Review 2', { path: 'records/skills/review-c.md' }),
    ];
    const names = listSkills(entries).map((s) => s.name);
    expect([...names].sort()).toEqual(['review', 'review-2', 'review-3']);
    expect(new Set(names).size).toBe(3);
  });

  it('drops punctuation-only titles entirely instead of minting ghost handles', () => {
    // Two empty base slugs used to leave the second one invocable as `/-2`.
    const entries = [
      skill('!!!', { path: 'records/skills/a.md' }),
      skill('???', { path: 'records/skills/b.md' }),
    ];
    expect(listSkills(entries)).toEqual([]);
  });

  it('recovers a wikilink-valued description from relationships', () => {
    // The scanner files wikilink-valued fields under `relationships`, which
    // silently blanked the description in the catalog and the system prompt.
    const entries = [
      skill('Scoped', {
        properties: {},
        relationships: { description: ['Phoenix warehouse rollout'] },
      }),
    ];
    expect(listSkills(entries)[0].description).toBe('[[Phoenix warehouse rollout]]');
  });
});

describe('matchSkillInvocation', () => {
  const skills = listSkills([skill('Weekly review')]);

  it('matches the slash token and carries the rest as the request', () => {
    const hit = matchSkillInvocation('/weekly-review focus on Phoenix', skills);
    expect(hit?.skill.name).toBe('weekly-review');
    expect(hit?.request).toBe('focus on Phoenix');
  });

  it('matches with no request, case-insensitively', () => {
    expect(matchSkillInvocation('/Weekly-Review', skills)?.request).toBe('');
  });

  it('returns null for plain text and unknown names', () => {
    expect(matchSkillInvocation('weekly review please', skills)).toBeNull();
    expect(matchSkillInvocation('/unknown-skill do it', skills)).toBeNull();
  });
});

describe('skillPrompt', () => {
  const [ref] = listSkills([skill('Weekly review')]);
  const raw = '---\ntype: Skill\ndescription: d\n---\n\n# Weekly review\n\n1. Read the boards.\n';

  it('sends the body without frontmatter and names the source note', () => {
    const prompt = skillPrompt(ref, raw, '');
    expect(prompt).toContain('records/skills/weekly-review.md');
    expect(prompt).toContain('1. Read the boards.');
    expect(prompt).not.toContain('type: Skill');
    expect(prompt).not.toContain("The user's input");
  });

  it('appends the request when there is one', () => {
    expect(skillPrompt(ref, raw, 'focus on Phoenix')).toContain(
      "The user's input for this run: focus on Phoenix",
    );
  });
});

describe('skillIndex', () => {
  it('is null when the vault defines no skills', () => {
    expect(skillIndex([], FULL)).toBeNull();
  });

  it('lists each skill as /name — description', () => {
    const line = skillIndex(
      listSkills([skill('Weekly review'), skill('Bare', { properties: {} })]),
      FULL,
    );
    expect(line).toContain('/weekly-review — Run Weekly review.');
    expect(line).toContain('/bare;');
  });
});

/**
 * M54.7 — how to reach a skill names a tool, so the catalogue follows the
 * run's grant. A run that holds both readers reads what every run read before.
 */
describe('the catalogue names only the tools the run holds', () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    skill(`Skill ${String(i).padStart(2, '0')}`, {
      path: `records/skills/s${i}.md`,
      properties: { description: 'A reasonably wordy description of what this skill does.' },
    }),
  );
  const holding = (...tools: string[]): PromptGrant => ({
    tools: new Set(tools),
    shell: false,
    attended: true,
  });

  it('reads byte for byte as before under a full grant, the overflow aside', () => {
    expect(skillIndex(listSkills([skill('Weekly review')]), FULL)).toBe(
      'This vault defines skills: records of type Skill whose body is a reusable instruction set. ' +
        "The user runs one by typing /name in this panel. When a request matches a skill's purpose, " +
        'read its note with get_note and follow it. Skills: /weekly-review — Run Weekly review..',
    );
  });

  it('sends a run holding list_notes to list every Skill (M59.5)', () => {
    const index = skillIndex(listSkills(many), FULL)!;
    expect(index).toMatch(
      / \d+ more skills are defined but not listed here — call list_notes with type Skill to see them all\.$/,
    );
    const listing = skillIndex(listSkills(many), holding('list_notes', 'search_notes'))!;
    expect(mentionedTools(listing)).toEqual(['list_notes']);
  });

  it('sends a run holding only search_notes to search for type Skill', () => {
    const index = skillIndex(listSkills(many), holding('search_notes'))!;
    expect(index).toMatch(
      / \d+ more skills are defined but not listed here — search_notes for type Skill to find them\.$/,
    );
    expect(mentionedTools(index)).toEqual(['search_notes']);
  });

  it('offers no read of a skill’s note to a run without get_note', () => {
    const index = skillIndex(listSkills(many), holding('search_notes'))!;
    expect(index).not.toContain('read its note with get_note');
    expect(index).toContain('The user runs one by typing /name in this panel. Skills: /');
  });

  it('says the unlisted skills exist, and names no tool, to a run holding neither lister', () => {
    const index = skillIndex(listSkills(many), holding('get_note'))!;
    expect(index).toMatch(/ \d+ more skills are defined but not listed here\.$/);
    expect(mentionedTools(index)).toEqual(['get_note']);
    expect(mentionedTools(skillIndex(listSkills(many), holding())!)).toEqual([]);
  });
});

/**
 * M17.8 — a skill that can be renamed.
 *
 * Nothing about a skill was stable before this: the handle came from the
 * title, and the run ledger came from the path. Renaming one record therefore
 * retired a handle the user had written down AND, because handles are
 * de-duplicated in title order, could hand a DIFFERENT skill's `-2` suffix to
 * somebody else.
 */
describe('a declared slug is the skill’s identity', () => {
  it('keeps the handle across a rename', () => {
    const before = skill('Risk sweep', { properties: { slug: 'sweep' } });
    const after = skill('Risk review', {
      path: 'records/skills/risk-review.md',
      properties: { slug: 'sweep' },
    });
    expect(listSkills([before])[0].name).toBe('sweep');
    expect(listSkills([after])[0].name).toBe('sweep');
  });

  it('keeps the ledger key across a rename, so no catch-up run is owed', () => {
    // Renaming a record renames its FILE, so a path-keyed ledger forgot every
    // fire the schedule had answered and ran one catch-up for the privilege.
    const before = skill('Risk sweep', { properties: { slug: 'sweep' } });
    const after = skill('Risk review', {
      path: 'records/skills/risk-review.md',
      properties: { slug: 'sweep' },
    });
    expect(listSkills([before])[0].id).toBe(listSkills([after])[0].id);
  });

  it('falls back to the path when nothing is declared, so no vault is migrated', () => {
    const plain = skill('Weekly review');
    expect(listSkills([plain])[0].id).toBe('records/skills/weekly-review.md');
  });

  it('never lets a title-derived name steal a handle somebody declared', () => {
    // Claimed in a first pass, before any title is slugified: "Audit" sorts
    // first, so a single pass would hand it `audit` and suffix the record that
    // asked for that handle by name.
    const entries = [skill('Audit'), skill('Zed', { properties: { slug: 'audit' } })];
    const byTitle = Object.fromEntries(listSkills(entries).map((s) => [s.title, s.name]));
    expect(byTitle.Zed).toBe('audit');
    expect(byTitle.Audit).toBe('audit-2');
  });

  it('gives a duplicate declaration to the first in title order rather than suffixing', () => {
    // Suffixing would silently rewrite a handle the author wrote down. The
    // duplicate is their mistake, and it stays visible as one.
    const entries = [
      skill('Alpha', { properties: { slug: 'dup' } }),
      skill('Beta', { properties: { slug: 'dup' } }),
    ];
    const byTitle = Object.fromEntries(listSkills(entries).map((s) => [s.title, s.name]));
    expect(byTitle.Alpha).toBe('dup');
    expect(byTitle.Beta).toBe('beta');
  });
});

describe('declared arguments', () => {
  const withArgs = skill('Sweep', {
    properties: {
      description: 'Sweep it.',
      arguments: [
        { name: 'project', description: 'Which project', required: true },
        'since',
        { nonsense: true },
        { name: '   ' },
      ],
    },
  });

  it('parses both shapes and skips what it cannot read', () => {
    expect(listSkills([withArgs])[0].arguments).toEqual([
      { name: 'project', description: 'Which project', required: true },
      { name: 'since', description: '', required: false },
    ]);
  });

  it('shows required and optional differently in the catalogue', () => {
    expect(skillIndex(listSkills([withArgs]), FULL)).toContain('/sweep <project> [since]');
  });

  it('names them in the prompt, and asks rather than inventing when required input is missing', () => {
    const [ref] = listSkills([withArgs]);
    const prompt = skillPrompt(ref, '---\ntype: Skill\n---\nBody.', '');
    expect(prompt).toContain('project (required) — Which project');
    expect(prompt).toContain('ask for what you need');
  });

  it('says nothing about inputs when a skill declares none', () => {
    const [ref] = listSkills([skill('Plain')]);
    expect(skillPrompt(ref, '---\ntype: Skill\n---\nBody.', '')).not.toContain('declares inputs');
  });
});

describe('allowed-tools is a narrowing, and only a narrowing', () => {
  it('is null when undeclared — undeclared means "do not narrow"', () => {
    expect(listSkills([skill('Plain')])[0].allowedTools).toBeNull();
  });

  it('accepts a list or a comma-separated string', () => {
    const asList = skill('A', { properties: { 'allowed-tools': ['search_notes', 'get_note'] } });
    const asText = skill('B', { properties: { 'allowed-tools': 'search_notes, get_note' } });
    expect(listSkills([asList])[0].allowedTools).toEqual(['search_notes', 'get_note']);
    expect(listSkills([asText])[0].allowedTools).toEqual(['search_notes', 'get_note']);
  });

  it('honours an EMPTY declaration as "narrow to nothing"', () => {
    // Distinct from undeclared on purpose: a skill that wants a read-only turn
    // has to be able to say so, and [] is how it says it.
    expect(
      listSkills([skill('C', { properties: { 'allowed-tools': [] } })])[0].allowedTools,
    ).toEqual([]);
  });
});

describe('the catalogue is budgeted', () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    skill(`Skill ${String(i).padStart(2, '0')}`, {
      path: `records/skills/s${i}.md`,
      properties: { description: 'A reasonably wordy description of what this skill does.' },
    }),
  );

  it('stops well short of spending the context window on skills it is not running', () => {
    const index = skillIndex(listSkills(many), FULL)!;
    expect(index.length).toBeLessThan(2_000);
  });

  it('says how many it dropped instead of reading as the complete set', () => {
    // A silently truncated catalogue makes the agent tell the user a skill
    // does not exist.
    const index = skillIndex(listSkills(many), FULL)!;
    expect(index).toMatch(/\d+ more skills are defined but not listed here/);
    expect(index).toContain('list_notes with type Skill');
  });

  it('always ships at least one, however long its description', () => {
    const wordy = skill('Verbose', { properties: { description: 'x'.repeat(5_000) } });
    expect(skillIndex(listSkills([wordy]), FULL)).toContain('/verbose');
  });
});

describe('fireKeyDate (M34.2)', () => {
  // The runKey IS the due stamp — lastFireKey mints it, so only this module
  // may parse it back. Round-tripping is the whole contract: a late run's
  // "was due" must be the exact moment the ledger key names.
  it('round-trips a dated key through the local clock', () => {
    const now = new Date(2026, 6, 31, 10, 30);
    const key = lastFireKey({ kind: 'daily', hour: 9, minute: 0 }, now);
    expect(fireKeyDate(key!)?.getTime()).toBe(new Date(2026, 6, 31, 9, 0).getTime());
  });

  it('round-trips an hourly key through UTC', () => {
    const now = new Date(Date.UTC(2026, 6, 31, 14, 45));
    const key = lastFireKey({ kind: 'hourly' }, now);
    expect(fireKeyDate(key!)?.getTime()).toBe(Date.UTC(2026, 6, 31, 14, 0));
  });

  it('returns null for an event runKey rather than inventing a due time', () => {
    expect(fireKeyDate('event:changed:records/r.md@2026-07-31')).toBeNull();
  });
});

describe('skill local clock', () => {
  it.each([
    [240, '2026-07-28 08:30 (UTC-04:00)'],
    [0, '2026-07-28 12:30 (UTC+00:00)'],
    [-330, '2026-07-28 18:00 (UTC+05:30)'],
  ])('states the wall time at offset %i', (offset, expected) => {
    expect(localTimeLine(new Date('2026-07-28T12:30:00Z'), Number(offset))).toBe(
      `The user's local time is ${expected}.`,
    );
  });
  it('crosses the date boundary with the stated offset', () => {
    expect(localTimeLine(new Date('2026-07-28T00:30:00Z'), 420)).toContain(
      '2026-07-27 17:30 (UTC-07:00)',
    );
  });
});

describe('closed schedule shapes and sets (M63.6)', () => {
  const examples = [
    ['hourly', 'Every hour'],
    ['daily 09:00', 'Every day at 09:00'],
    ['weekdays 08:30', 'Every weekday at 08:30'],
    ['weekly fri 17:30', 'Every Friday at 17:30'],
    ['weekly mon,thu 17:00', 'Every Monday and Thursday at 17:00'],
    ['weekly mon,wed,fri 09:00', 'Every Monday, Wednesday and Friday at 09:00'],
    ['monthly 15 09:00', 'Monthly on the 15th at 09:00'],
    ['monthly last 18:00', 'Monthly on the last day at 18:00'],
    ['once 2026-10-20 15:00', 'Once, on 2026-10-20 at 15:00'],
  ];
  it.each(examples)('round-trips %s and describes its whole meaning', (text, words) => {
    const parsed = parseSchedule(text)!;
    expect(parsed).not.toBeNull();
    expect(formatSchedule(parsed)).toBe(text);
    expect(describeSchedule(parsed)).toBe(words);
  });
  it.each([
    'monthly 29 09:00',
    'monthly 30 09:00',
    'monthly 31 09:00',
    'monthly 0 09:00',
    'weekly fri,fri 09:00',
    'weekly mon,wat 09:00',
    'once 2026-02-29 09:00',
    'once 2026-04-31 09:00',
    'once 2026-13-01 09:00',
    'daily 24:00',
  ])('refuses %s', (text) => expect(parseSchedule(text)).toBeNull());
  it('accepts leap days, sorts day sets and keeps one weekday in the old shape', () => {
    expect(parseSchedule('once 2028-02-29 09:00')?.kind).toBe('once');
    expect(formatSchedule(parseSchedule('weekly thu,mon 17:00')!)).toBe('weekly mon,thu 17:00');
    expect(parseSchedule('weekly mon 17:00')).toEqual({
      kind: 'weekly',
      day: 1,
      hour: 17,
      minute: 0,
    });
  });
  it('preserves authored bytes, bounds lists, and never partially reads a list', () => {
    const raw = ['  Weekly Friday 9:00  ', 'monthly last 18:00'];
    expect(scheduleItems(raw)).toEqual(raw);
    expect(scheduleItems(raw[0])).toEqual([raw[0]]);
    expect(scheduleText(raw)).toBe(raw.join('; '));
    expect(scheduleItems(null)).toEqual([]);
    expect(parseScheduleSet(raw)).toHaveLength(2);
    expect(parseScheduleSet(Array(8).fill('hourly'))).toHaveLength(8);
    for (const bad of [null, [], ['hourly', 'no'], ['hourly', 2], Array(9).fill('hourly')])
      expect(parseScheduleSet(bad)).toBeNull();
    expect(describeScheduleSet(['daily 09:00', 'monthly last 18:00'])).toBe(
      'Every day at 09:00; Monthly on the last day at 18:00',
    );
    expect(describeScheduleSet(['bad'])).toBe('Schedule not understood');
  });
  it('walks weekday sets across the week and monthly last across short months and years', () => {
    const days = parseSchedule('weekly mon,thu 17:00')!;
    expect(lastFireKey(days, new Date(2026, 6, 29, 12))).toBe('2026-07-27 17:00');
    expect(nextFire(days, new Date(2026, 6, 29, 12))).toEqual(new Date(2026, 6, 30, 17));
    const monthly = parseSchedule('monthly last 18:00')!;
    expect(lastFireKey(monthly, new Date(2026, 1, 1, 12))).toBe('2026-01-31 18:00');
    expect(nextFire(monthly, new Date(2026, 0, 31, 19))).toEqual(new Date(2026, 1, 28, 18));
    expect(nextFire(monthly, new Date(2028, 0, 31, 19))).toEqual(new Date(2028, 1, 29, 18));
    expect(lastFireKey(monthly, new Date(2026, 0, 1))).toBe('2025-12-31 18:00');
    expect(nextFire(monthly, new Date(2026, 11, 31, 19))).toEqual(new Date(2027, 0, 31, 18));
  });
  it('a once has no past before its instant and no future at or after it', () => {
    const once = parseSchedule('once 2026-10-20 15:00')!;
    expect(lastFireKey(once, new Date(2026, 9, 20, 14))).toBeNull();
    expect(nextFire(once, new Date(2026, 9, 20, 14))).toEqual(new Date(2026, 9, 20, 15));
    expect(lastFireKey(once, new Date(2026, 9, 20, 15))).toBe('2026-10-20 15:00');
    expect(nextFire(once, new Date(2026, 9, 20, 15))).toBeNull();
    expect(nextFire(once, new Date(2027, 0, 1))).toBeNull();
  });
  it('a set takes the latest passed time and soonest future time, not its first item', () => {
    const set = parseScheduleSet(['monthly last 18:00', 'weekdays 08:30', 'daily 11:00'])!;
    expect(lastSetFireKey(set, new Date(2026, 6, 28, 12))).toBe('2026-07-28 11:00');
    expect(nextSetFire(set, new Date(2026, 6, 28, 12))).toEqual(new Date(2026, 6, 29, 8, 30));
    const future = parseScheduleSet(['once 2026-10-20 15:00'])!;
    expect(lastSetFireKey(future, new Date(2026, 6, 28, 12))).toBeNull();
    expect(nextSetFire(future, new Date(2027, 0, 1))).toBeNull();
  });
  it('keeps authored wall time over March DST for all new calendar shapes', () => {
    for (const text of [
      'weekly sun,tue 02:30',
      'monthly 8 02:30',
      'monthly last 02:30',
      'once 2026-03-08 02:30',
    ]) {
      const schedule = parseSchedule(text)!;
      for (let day = 7; day <= 10; day++) {
        const now = new Date(2026, 2, day, 12);
        const key = lastFireKey(schedule, now);
        if (key !== null) {
          expect(key).toMatch(/ 02:30$/);
          expect(fireKeyDate(key)!.getTime()).toBeLessThanOrEqual(now.getTime());
        }
        const next = nextFire(schedule, now);
        if (next !== null) expect(next.getTime()).toBeGreaterThan(now.getTime());
      }
    }
  });
});

it('equal instants choose the larger key and hourly fires distinguish repeated local hours', () => {
  const now = new Date(2026, 6, 28, 12);
  expect(lastSetFireKey([{ kind: 'daily', hour: 12, minute: 0 }, { kind: 'hourly' }], now)).toBe(
    lastFireKey({ kind: 'hourly' }, now),
  );
  const first = new Date('2026-11-01T01:30:00-07:00');
  const second = new Date('2026-11-01T01:30:00-08:00');
  expect(lastFireKey({ kind: 'hourly' }, first)).not.toBe(lastFireKey({ kind: 'hourly' }, second));
  expect(nextFire({ kind: 'hourly' }, first)).toEqual(new Date('2026-11-01T09:00:00Z'));
});

describe('attended skill connector narrowings', () => {
  it('preserves undeclared, list, comma string and empty grants', () => {
    const read = (properties: Entry['properties']) =>
      listSkills([skill('Mail', { properties })])[0];
    expect(read({})).toMatchObject({ connectors: null, disallowedTools: null });
    expect(
      read({ connectors: ['gmail'], 'disallowed-tools': ['mcp__gmail__trash_thread'] }),
    ).toMatchObject({ connectors: ['gmail'], disallowedTools: ['mcp__gmail__trash_thread'] });
    expect(
      read({
        connectors: ' gmail, drive ',
        'disallowed-tools': 'mcp__gmail__trash_thread, mcp__drive__delete',
      }),
    ).toMatchObject({
      connectors: ['gmail', 'drive'],
      disallowedTools: ['mcp__gmail__trash_thread', 'mcp__drive__delete'],
    });
    expect(read({ connectors: [], 'disallowed-tools': [] })).toMatchObject({
      connectors: [],
      disallowedTools: [],
    });
  });
});
