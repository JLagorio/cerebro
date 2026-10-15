import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import {
  AGENT_KEYS,
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
    const patch = agentPatch(drafted, AGENT_KEYS);
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
    const patch = agentPatch(agentDraft(agentEntry({ recent: 'x' }), ''), AGENT_KEYS);
    expect('recent' in patch).toBe(false);
    expect('memory' in patch).toBe(false);
  });

  it('keeps an EMPTY scope, which scopes the agent to nothing', () => {
    const drafted = agentDraft(agentEntry({ scope: [] }), '');
    expect(drafted.scope).toEqual([]);
    expect(agentPatch(drafted, AGENT_KEYS).scope).toEqual([]);
  });

  it('says `tools: safe` out loud rather than leaving the default implied', () => {
    expect(agentPatch(agentDraft(agentEntry({}), ''), AGENT_KEYS).tools).toBe('safe');
  });

  it('reads `disallowed-tools:` and never writes it (M54.9)', () => {
    // The form shows what a record denies and does not edit it, so a save
    // must leave the key exactly as whoever wrote it left it — absent, empty
    // or a list.
    const listed = agentDraft(agentEntry({ 'disallowed-tools': ['mcp__gmail__trash_thread'] }), '');
    expect(listed.disallowedTools).toEqual(['mcp__gmail__trash_thread']);
    expect(agentDraft(agentEntry({ 'disallowed-tools': [] }), '').disallowedTools).toEqual([]);
    expect(agentDraft(agentEntry({}), '').disallowedTools).toBeNull();
    expect('disallowed-tools' in agentPatch(listed, AGENT_KEYS)).toBe(false);
    expect('disallowed-tools' in agentPatch({ ...listed, disallowedTools: null }, AGENT_KEYS)).toBe(
      false,
    );
  });
});

describe('agentPatch by key (M55.12)', () => {
  const d = agentDraft(
    makeEntry({
      path: 'records/agents/a.md',
      type: 'Agent',
      properties: {
        slug: 'release-scout',
        description: 'Watches risks',
        scope: ['records/risks'],
        'read-scope': ['records'],
        'allowed-tools': ['get_note'],
        connectors: ['gmail'],
        schedule: 'weekdays 08:30',
        when: [{ event: 'created' }],
        preferences: 'Never file a risk without an owner.',
        recent: 'Last run found two.',
      } as never,
    }),
    '# Release scout\n\nWatch the risks.\n',
  );

  it('patches ask-first alone: on writes true, off removes it (M57.4)', () => {
    expect(d.askFirst).toBe(false);
    expect(agentPatch({ ...d, askFirst: true }, ['askFirst'])).toEqual({ 'ask-first': true });
    expect(agentPatch({ ...d, askFirst: false }, ['askFirst'])).toEqual({ 'ask-first': null });
    // No other row carries it along.
    expect('ask-first' in agentPatch({ ...d, askFirst: true }, ['shell', 'scope'])).toBe(false);
  });

  it('drafts an odd ask-first value as neither, and writes it on (M57.4)', () => {
    const odd = (value: unknown) =>
      agentDraft(
        makeEntry({ path: 'a.md', type: 'Agent', properties: { 'ask-first': value } as never }),
        '',
      ).askFirst;
    expect(odd(true)).toBe(true);
    expect(odd(false)).toBe(false);
    expect(odd('yes')).toBeNull();
    expect(agentPatch({ ...d, askFirst: null }, ['askFirst'])).toEqual({ 'ask-first': true });
  });

  it('writes exactly the asked keys', () => {
    expect(agentPatch(d, ['scope'])).toEqual({ scope: ['records/risks'] });
    expect(agentPatch(d, ['readScope'])).toEqual({ 'read-scope': ['records'] });
    expect(agentPatch(d, ['allowedTools'])).toEqual({ 'allowed-tools': ['get_note'] });
    expect(agentPatch(d, ['connectors'])).toEqual({ connectors: ['gmail'] });
    expect(agentPatch(d, ['shell'])).toEqual({ tools: 'safe' });
    expect(agentPatch({ ...d, triggers: [] }, ['triggers'])).toEqual({ when: null });
    expect(agentPatch({ ...d, schedule: '' }, ['schedule'])).toEqual({ schedule: null });
    expect(agentPatch({ ...d, preferences: '  ' }, ['preferences'])).toEqual({ preferences: null });
    expect(agentPatch(d, [])).toEqual({});
  });

  it('writes model and effort each alone, and blank removes the key (M56.5)', () => {
    const picked = { ...d, model: 'sonnet', effort: 'high' };
    expect(agentPatch(picked, ['model'])).toEqual({ model: 'sonnet' });
    expect(agentPatch(picked, ['effort'])).toEqual({ effort: 'high' });
    expect(agentPatch({ ...picked, model: '  ' }, ['model'])).toEqual({ model: null });
    expect(agentPatch({ ...picked, effort: '' }, ['effort'])).toEqual({ effort: null });
    expect(AGENT_KEYS).toEqual(expect.arrayContaining(['model', 'effort']));
    // Read trimmed, '' when unset.
    const read = agentDraft(
      makeEntry({
        path: 'records/agents/a.md',
        type: 'Agent',
        properties: { model: ' opus ', effort: 3 } as never,
      }),
      '',
    );
    expect([read.model, read.effort]).toEqual(['opus', '']);
  });

  it('slugifies a typed handle, and an emptied one removes the key', () => {
    expect(agentPatch({ ...d, slug: 'Release Scout' }, ['slug'])).toEqual({
      slug: 'release-scout',
    });
    expect(agentPatch({ ...d, slug: '  ' }, ['slug'])).toEqual({ slug: null });
  });

  it('keeps [] apart from null on every list axis', () => {
    expect(agentPatch({ ...d, scope: [] }, ['scope'])).toEqual({ scope: [] });
    expect(agentPatch({ ...d, scope: null }, ['scope'])).toEqual({ scope: null });
    expect(agentPatch({ ...d, connectors: [] }, ['connectors'])).toEqual({ connectors: [] });
  });

  it('no key set writes recent, memory or the body', () => {
    const all = agentPatch(d, AGENT_KEYS);
    for (const key of ['recent', 'memory', 'instructions', 'body', 'disallowed-tools']) {
      expect(key in all).toBe(false);
    }
    expect(Object.values(all)).not.toContain('Last run found two.');
    expect(Object.values(all)).not.toContain(d.instructions);
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
