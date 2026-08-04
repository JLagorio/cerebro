import { describe, expect, it } from 'vitest';
import { agentRunPrompt } from './prompts';

/**
 * What an unattended run is actually told.
 *
 * These prompts are the only thing standing between "an agent record" and "a
 * process writing to your vault while you are asleep", so the parts that are
 * load-bearing are asserted rather than assumed: the permission to do nothing,
 * the scope stated up front, and — M18.5 — a per-trigger instruction that adds
 * to the standing ones instead of replacing them.
 */
const base = () =>
  agentRunPrompt(
    'records/agents/scout.md',
    'Release scout',
    'process:release-scout',
    { recent: '', preferences: '' },
    'STANDING INSTRUCTIONS BODY',
  );

describe('agentRunPrompt', () => {
  it('says nobody is watching, so nothing lands in a chat reply', () => {
    expect(base()).toContain('Nobody is watching');
  });

  it('states the scope up front rather than leaving it to be discovered', () => {
    const prompt = agentRunPrompt(
      'records/agents/scout.md',
      'Release scout',
      'process:release-scout',
      { recent: '', preferences: '' },
      'body',
      null,
      ['records/risks'],
    );
    expect(prompt).toContain('records/risks');
    expect(prompt).toContain('enforced');
  });

  it('says an empty scope means every record write will be refused', () => {
    const prompt = agentRunPrompt('p', 't', 'a', { recent: '', preferences: '' }, 'b', null, []);
    expect(prompt).toContain('scoped to no folder at all');
  });

  it('gives the model gate an explicit permission to do nothing', () => {
    // Without it, a model asked "is this important?" finds a way to say yes —
    // the whole point of the gate is that most wakings end here.
    const prompt = agentRunPrompt('p', 't', 'a', { recent: '', preferences: '' }, 'b', {
      subject: 'records/risks/r.md',
      because: 'status becomes at-risk',
      ask: 'Does this threaten the release?',
    });
    expect(prompt).toContain('Does this threaten the release?');
    expect(prompt).toContain('write nothing and stop');
  });

  it('ranks the human’s corrections above the agent’s own notes', () => {
    const prompt = agentRunPrompt(
      'p',
      't',
      'a',
      { recent: 'MY OWN NOTES', preferences: 'HUMAN CORRECTION' },
      'body',
    );
    expect(prompt.indexOf('HUMAN CORRECTION')).toBeLessThan(prompt.indexOf('MY OWN NOTES'));
    expect(prompt).toContain('This outranks your own notes');
  });
});

describe('per-trigger instructions (M18.5)', () => {
  const withDo = () =>
    agentRunPrompt(
      'records/agents/scout.md',
      'Release scout',
      'process:release-scout',
      { recent: '', preferences: '' },
      'STANDING INSTRUCTIONS BODY',
      {
        subject: 'records/risks/r.md',
        because: 'status becomes at-risk',
        do: 'Check the release date before writing anything.',
      },
    );

  it('carries the trigger’s own instruction into the run', () => {
    expect(withDo()).toContain('Check the release date before writing anything.');
  });

  it('says out loud that it ADDS to the standing instructions', () => {
    // The failure mode of per-trigger prose is a model that reads it as a
    // replacement and drops the agent's own rules — including the "never
    // delete" ones, which are the reason an unattended run is safe at all.
    const prompt = withDo();
    expect(prompt).toContain('on top of your standing instructions');
    expect(prompt).toContain('it does not replace them');
    expect(prompt).toContain('STANDING INSTRUCTIONS BODY');
  });

  it('puts it before the standing instructions, which arrive as the general case', () => {
    const prompt = withDo();
    expect(prompt.indexOf('Check the release date')).toBeLessThan(
      prompt.indexOf('STANDING INSTRUCTIONS BODY'),
    );
  });

  it('changes nothing for a trigger that declares none', () => {
    const prompt = agentRunPrompt('p', 't', 'a', { recent: '', preferences: '' }, 'body', {
      subject: 'records/risks/r.md',
      because: 'status becomes at-risk',
    });
    expect(prompt).not.toContain('on top of your standing instructions');
  });

  it('keeps the gate ahead of the instruction, so a "no" run never reads it', () => {
    // Order is the design: decide whether to act, then how. Reversed, the
    // model has already planned the work before being asked to skip it.
    const prompt = agentRunPrompt('p', 't', 'a', { recent: '', preferences: '' }, 'body', {
      subject: 's',
      because: 'b',
      ask: 'SHOULD I?',
      do: 'HOW TO.',
    });
    expect(prompt.indexOf('SHOULD I?')).toBeLessThan(prompt.indexOf('HOW TO.'));
  });
});
