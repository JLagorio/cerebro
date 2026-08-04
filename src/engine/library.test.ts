import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import { isLibraryEntry, isLibraryType, libraryKind } from './library';
import { isRecordEntry, listTypes } from './typeCatalog';
import { isSkillEntry, listSkills } from './skills';
import { isAgentEntry, listAgents } from './agents';
import { buildSchema } from './schema';

const skill = () =>
  makeEntry({ path: 'records/skills/sweep.md', folder: 'records/skills', type: 'Skill' });
const agent = () =>
  makeEntry({ path: 'records/agents/scout.md', folder: 'records/agents', type: 'Agent' });
const template = () => makeEntry({ path: 'templates/prd.md', folder: 'templates', type: 'Spec' });
const risk = () =>
  makeEntry({ path: 'records/risks/r1.md', folder: 'records/risks', type: 'Risk' });

/**
 * M18 — skills, agents and templates stop being record types.
 *
 * The behaviour under test is a subtraction, so the tests are mostly about
 * what NO LONGER happens. Each one names the surface that was wrong.
 */
describe('libraryKind', () => {
  it('names each of the three', () => {
    expect(libraryKind(skill())).toBe('skill');
    expect(libraryKind(agent())).toBe('agent');
    expect(libraryKind(template())).toBe('template');
  });

  it('refuses to see a skill inside the knowledge bundle', () => {
    // A privilege-escalation path, not a tidiness rule. `knowledge/` is the
    // corpus the AGENT writes; a file it authors there that counted as a Skill
    // would be the agent minting itself a new capability, and the / menu would
    // then offer it to the user under a name the agent chose.
    const planted = makeEntry({ path: 'knowledge/systems/shadow.md', type: 'Skill' });
    expect(libraryKind(planted)).toBe(null);
    expect(isSkillEntry(planted)).toBe(false);
    expect(listSkills([planted])).toEqual([]);
  });

  it('is null for an ordinary record and for a doc', () => {
    expect(libraryKind(risk())).toBe(null);
    expect(libraryKind(makeEntry({ path: 'notes/a.md', type: null }))).toBe(null);
  });

  it('files a template by its FOLDER, not by the type it stamps', () => {
    // templates/skill.md confers `type: Skill` on pages made from it. Keyed on
    // `type:` it would file itself under Skills and offer to run.
    const stationery = makeEntry({
      path: 'templates/skill.md',
      folder: 'templates',
      type: 'Skill',
    });
    expect(libraryKind(stationery)).toBe('template');
    expect(isSkillEntry(stationery)).toBe(false);
  });
});

describe('isRecordEntry', () => {
  it('excludes all three, so they leave views, Lists and the detail panel', () => {
    expect(isRecordEntry(skill())).toBe(false);
    expect(isRecordEntry(agent())).toBe(false);
    expect(isRecordEntry(template())).toBe(false);
  });

  it('still admits an ordinary record — this is not a general narrowing', () => {
    expect(isRecordEntry(risk())).toBe(true);
  });
});

describe('listTypes', () => {
  it('does not list Skill or Agent as types the vault has', () => {
    const names = listTypes([skill(), agent(), risk()], buildSchema([])).map((t) => t.name);
    expect(names).toContain('Risk');
    expect(names).not.toContain('Skill');
    expect(names).not.toContain('Agent');
  });

  it('drops the row even when an old vault still declares types/skill.md', () => {
    // The migration case: the Type doc is harmless and deleting it should not
    // be a prerequisite for the sidebar being right.
    const declared = makeEntry({ path: 'types/skill.md', type: 'Type', title: 'Skill' });
    const names = listTypes([declared, skill()], buildSchema([declared])).map((t) => t.name);
    expect(names).not.toContain('Skill');
  });

  it('keeps Type itself, which is still the vault’s schema', () => {
    expect(listTypes([], buildSchema([])).map((t) => t.name)).toContain('Type');
  });
});

describe('the library still works after the subtraction', () => {
  // isSkillEntry and isAgentEntry both used to route through isRecordEntry —
  // which now returns false for them. Without this, the whole feature reads as
  // an empty vault: no /skills, no scheduled agents, no catalog line.
  it('still finds skills and agents', () => {
    expect(isSkillEntry(skill())).toBe(true);
    expect(isAgentEntry(agent())).toBe(true);
    expect(listSkills([skill(), risk()])).toHaveLength(1);
    expect(listAgents([agent(), risk()])).toHaveLength(1);
  });

  it('never treats a template as an invocable skill or a live agent', () => {
    const skillTemplate = makeEntry({
      path: 'templates/skill.md',
      folder: 'templates',
      type: 'Skill',
    });
    const agentTemplate = makeEntry({
      path: 'templates/agent.md',
      folder: 'templates',
      type: 'Agent',
    });
    expect(listSkills([skillTemplate])).toHaveLength(0);
    expect(listAgents([agentTemplate])).toHaveLength(0);
  });
});

describe('isLibraryType / isLibraryEntry', () => {
  it('answers by name for the two typed kinds', () => {
    expect(isLibraryType('Skill')).toBe(true);
    expect(isLibraryType('Agent')).toBe(true);
    expect(isLibraryType('Risk')).toBe(false);
    expect(isLibraryType(null)).toBe(false);
  });

  it('is not answerable by name for a template, which is a folder', () => {
    expect(isLibraryType('Spec')).toBe(false);
    expect(isLibraryEntry(template())).toBe(true);
  });
});
