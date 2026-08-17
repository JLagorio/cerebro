import { describe, expect, it } from 'vitest';
import { agentRunPrompt, askBasePrompt, currentStatePrompt, distillPrompt } from './prompts';
import { ALL_TOOLS } from '@/engine/tools';

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

describe('distillPrompt', () => {
  it('asks for the two fields a real vault came back empty on', () => {
    // Measured on ~/Documents/test: 30 concepts, description 0/30,
    // supersedes/refines/contradicts 0/30 — while the bodies narrated
    // supersession in prose.
    const prompt = distillPrompt('inbox/capture.md', 'A capture');
    expect(prompt).toContain('description');
    expect(prompt.toLowerCase()).toContain('in the body');
  });
});

describe('askBasePrompt (M33a.5)', () => {
  const prompt = () => askBasePrompt('records/reqs/rq-84b.md', 'RQ-84B Kestrel');

  it('names the tool that answers by anchor, and names it first', () => {
    // Told only to "see what you know", a model keyword-searches the bundle
    // and returns whatever shares words with the title — which is a different
    // question. The tool answers by `about:` anchor, which is this one.
    const text = prompt();
    expect(text).toContain('knowledge_about');
    expect(text.indexOf('knowledge_about')).toBeLessThan(text.indexOf('get_note'));
    expect(text).toContain('records/reqs/rq-84b.md');
    expect(text).toContain('RQ-84B Kestrel');
  });

  it('names a tool the server actually serves', () => {
    // A prompt naming a tool the catalog does not hold narrows the run to a
    // model improvising — the same drift `tools.test.ts` guards on the picker.
    expect(ALL_TOOLS.map((t) => t.name)).toContain('knowledge_about');
  });

  it('asks a question and forbids the answer arriving as writes', () => {
    // The user pressed a button that asks. An answer that lands as three new
    // concepts is not the thing they asked for.
    expect(prompt()).toContain('Do not write or revise anything');
  });

  it('makes "almost nothing yet" an available answer', () => {
    // Otherwise the model pads Held and Unsettled to look useful, which is
    // exactly how a knowledge surface stops being trusted.
    expect(prompt()).toContain('almost nothing yet');
    expect(prompt()).toContain('Not covered');
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

describe('currentStatePrompt (M33.8)', () => {
  it('leads with the superseding clause, verbatim', () => {
    // The clause is the whole point. An agent carrying notes it wrote weeks
    // ago has no way to tell which parts are still true, and "here is some
    // context" would not tell it which one wins.
    const block = currentStatePrompt({
      vaultName: 'demo-vault',
      today: '2026-07-28',
      lastOutcome: 'succeeded',
      openReviews: 2,
    });
    expect(block.startsWith('CURRENT STATE (supersedes anything you remember)')).toBe(true);
    expect(block).toContain('- Vault: demo-vault');
    expect(block).toContain('- Today: 2026-07-28');
    expect(block).toContain('- Your last run: succeeded');
    expect(block).toContain('- Proposals waiting on a person: 2');
  });

  it('says "none" for an agent that has never run, not "succeeded"', () => {
    const block = currentStatePrompt({
      vaultName: 'v',
      today: '2026-07-28',
      lastOutcome: null,
      openReviews: 0,
    });
    expect(block).toContain('- Your last run: none');
    // Zero IS a reading here — the queue was read and it was empty.
    expect(block).toContain('- Proposals waiting on a person: 0');
  });

  it('omits the review line entirely when the queue could not be read', () => {
    // Absent is never zero: telling an unattended agent nothing is waiting
    // when we do not know is the false calm this milestone exists to avoid.
    const block = currentStatePrompt({
      vaultName: 'v',
      today: '2026-07-28',
      lastOutcome: 'failed',
      openReviews: null,
    });
    expect(block).not.toContain('Proposals waiting');
    expect(block).toContain('- Your last run: failed');
  });
});
