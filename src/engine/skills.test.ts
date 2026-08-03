import { describe, expect, it } from 'vitest';
import { listSkills, matchSkillInvocation, skillIndex, skillPrompt } from './skills';
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
