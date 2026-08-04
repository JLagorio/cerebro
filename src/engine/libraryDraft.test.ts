import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import {
  agentActive,
  agentDraft,
  agentPatch,
  parseList,
  skillDraft,
  skillPatch,
  templateDraft,
  templatePatch,
  type SkillDraft,
} from './libraryDraft';
import { parseAllowedTools, parseArguments } from './skills';
import { parseTriggers } from './triggers';

/**
 * M18 — the form is a file, and the difference between ABSENT and EMPTY is the
 * whole game. Most of these tests exist because a generic property table got
 * that difference wrong, which is why these records needed their own editor.
 */
const entry = (properties: Record<string, unknown>) =>
  makeEntry({ path: 'records/skills/s.md', type: 'Skill', properties: properties as never });

describe('skillDraft / skillPatch', () => {
  it('round-trips a fully declared skill', () => {
    const before = entry({
      slug: 'risk-sweep',
      description: 'Find unwritten risks',
      arguments: [{ name: 'scope', description: 'A project', required: true }],
      'allowed-tools': ['search_notes', 'get_note'],
      schedule: 'weekly fri 17:00',
    });
    const patch = skillPatch(skillDraft(before, '# Risk sweep\n'));
    expect(patch.slug).toBe('risk-sweep');
    expect(patch.description).toBe('Find unwritten risks');
    expect(parseArguments(patch.arguments)).toEqual([
      { name: 'scope', description: 'A project', required: true },
    ]);
    expect(parseAllowedTools(patch['allowed-tools'])).toEqual(['search_notes', 'get_note']);
    expect(patch.schedule).toBe('weekly fri 17:00');
  });

  it('REMOVES a key that was emptied instead of writing a blank one', () => {
    // `description: ''` is a declared empty description: it rides into every
    // system prompt as a dangling dash, and reads as deliberate.
    const patch = skillPatch({
      slug: '',
      description: '   ',
      arguments: [],
      allowedTools: null,
      schedule: '',
      instructions: '',
    });
    expect(patch.slug).toBe(null);
    expect(patch.description).toBe(null);
    expect(patch.arguments).toBe(null);
    expect(patch.schedule).toBe(null);
  });

  it('keeps an EMPTY allowed-tools, which is the opposite of an absent one', () => {
    // [] is "narrow this turn to nothing" and is honoured by Rust. Collapsing
    // it to null would silently hand a locked-down skill the full tool policy.
    expect(skillPatch(draft({ allowedTools: [] }))['allowed-tools']).toEqual([]);
    expect(skillPatch(draft({ allowedTools: null }))['allowed-tools']).toBe(null);
  });

  it('slugifies a handle typed with spaces, because the handle is typed', () => {
    expect(skillPatch(draft({ slug: 'Risk Sweep' })).slug).toBe('risk-sweep');
  });

  const base: SkillDraft = {
    slug: '',
    description: '',
    arguments: [],
    allowedTools: null,
    schedule: '',
    instructions: '',
  };
  function draft(patch: Partial<SkillDraft>): SkillDraft {
    return { ...base, ...patch };
  }
});

describe('agentDraft / agentPatch', () => {
  const agentEntry = (properties: Record<string, unknown>) =>
    makeEntry({ path: 'records/agents/a.md', type: 'Agent', properties: properties as never });

  it('round-trips scope, triggers and the memory tiers', () => {
    const before = agentEntry({
      slug: 'release-scout',
      scope: ['records/risks'],
      tools: 'shell',
      when: [{ event: 'changed', field: 'status', to: 'blocked', in: 'records' }],
      preferences: 'Never file a risk without an owner.',
      recent: 'Last run found two.',
    });
    const drafted = agentDraft(before, 'body');
    expect(drafted.recent).toBe('Last run found two.');
    const patch = agentPatch(drafted);
    expect(patch.scope).toEqual(['records/risks']);
    expect(patch.tools).toBe('shell');
    expect(parseTriggers(patch.when)).toEqual([
      { event: 'changed', field: 'status', to: 'blocked', in: 'records' },
    ]);
    expect(patch.preferences).toBe('Never file a risk without an owner.');
  });

  it('never writes `recent:` — the agent owns its own notes', () => {
    // Overwriting it from a form would erase what the last run learned, and
    // the field is the one the agent rewrites at the end of every run.
    const patch = agentPatch(agentDraft(agentEntry({ recent: 'x' }), ''));
    expect('recent' in patch).toBe(false);
    expect('memory' in patch).toBe(false);
  });

  it('keeps an EMPTY scope, which scopes the agent to nothing', () => {
    const drafted = agentDraft(agentEntry({ scope: [] }), '');
    expect(drafted.scope).toEqual([]);
    expect(agentPatch(drafted).scope).toEqual([]);
  });

  it('says `tools: safe` out loud rather than leaving the default implied', () => {
    expect(agentPatch(agentDraft(agentEntry({}), '')).tools).toBe('safe');
  });
});

describe('agentActive', () => {
  it('is derived, so there is no flag to fall out of step with the record', () => {
    expect(agentActive({ schedule: '', triggers: [] })).toBe(false);
    expect(agentActive({ schedule: 'daily 09:00', triggers: [] })).toBe(true);
    expect(agentActive({ schedule: '', triggers: [{ event: 'created' }] })).toBe(true);
  });
});

describe('templateDraft / templatePatch', () => {
  it('carries the type it stamps and the fill prompt', () => {
    const before = makeEntry({
      path: 'templates/prd.md',
      folder: 'templates',
      type: 'Spec',
      properties: { fill: 'Draft the risks.' } as never,
    });
    const patch = templatePatch(templateDraft(before, 'body'));
    expect(patch.type).toBe('Spec');
    expect(patch.fill).toBe('Draft the risks.');
  });

  it('clears `fill:` back to an ordinary template', () => {
    // A template that fills itself starts an agent run on page creation, so
    // turning it off has to actually remove the key.
    expect(templatePatch({ type: 'Spec', fill: '', body: '' }).fill).toBe(null);
  });

  it('allows an untyped template, which makes plain docs', () => {
    expect(templatePatch({ type: '', fill: '', body: '' }).type).toBe(null);
  });
});

describe('parseList', () => {
  it('takes commas or newlines and drops the blanks between them', () => {
    expect(parseList('a, b\nc,,  \n d ')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseList('   ')).toEqual([]);
  });
});
