import { describe, expect, it } from 'vitest';
import {
  fireKeyDate,
  lastFireKey,
  listSkills,
  matchSkillInvocation,
  skillIndex,
  skillPrompt,
} from './skills';
import { makeEntry } from './testHelpers';

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
    expect(skillIndex([])).toBeNull();
  });

  it('lists each skill as /name — description', () => {
    const line = skillIndex(
      listSkills([skill('Weekly review'), skill('Bare', { properties: {} })]),
    );
    expect(line).toContain('/weekly-review — Run Weekly review.');
    expect(line).toContain('/bare;');
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
    expect(skillIndex(listSkills([withArgs]))).toContain('/sweep <project> [since]');
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
    const index = skillIndex(listSkills(many))!;
    expect(index.length).toBeLessThan(2_000);
  });

  it('says how many it dropped instead of reading as the complete set', () => {
    // A silently truncated catalogue makes the agent tell the user a skill
    // does not exist.
    const index = skillIndex(listSkills(many))!;
    expect(index).toMatch(/\d+ more skills are defined but not listed here/);
    expect(index).toContain('search_notes');
  });

  it('always ships at least one, however long its description', () => {
    const wordy = skill('Verbose', { properties: { description: 'x'.repeat(5_000) } });
    expect(skillIndex(listSkills([wordy]))).toContain('/verbose');
  });
});

describe('fireKeyDate (M34.2)', () => {
  // The runKey IS the due stamp — lastFireKey mints it, so only this module
  // may parse it back. Round-tripping is the whole contract: a late run's
  // "was due" must be the exact moment the ledger key names.
  it('round-trips a dated key through the local clock', () => {
    const now = new Date(2026, 6, 31, 10, 30);
    const key = lastFireKey({ kind: 'daily', hour: 9, minute: 0 }, now);
    expect(fireKeyDate(key)?.getTime()).toBe(new Date(2026, 6, 31, 9, 0).getTime());
  });

  it('round-trips an hourly key through UTC', () => {
    const now = new Date(Date.UTC(2026, 6, 31, 14, 45));
    const key = lastFireKey({ kind: 'hourly' }, now);
    expect(fireKeyDate(key)?.getTime()).toBe(Date.UTC(2026, 6, 31, 14, 0));
  });

  it('returns null for an event runKey rather than inventing a due time', () => {
    expect(fireKeyDate('event:changed:records/r.md@2026-07-31')).toBeNull();
  });
});
