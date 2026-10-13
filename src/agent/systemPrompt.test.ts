import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './systemPrompt';

/**
 * M34.1.3 — the OKF contract is a capability, not the weather. An agent that
 * never declared `knowledge` must not be told it maintains the bundle,
 * because an agent told to write concepts will write concepts.
 */
describe('buildSystemPrompt capabilities', () => {
  it('emits the knowledge fragment only when the capability is declared', () => {
    const declared = buildSystemPrompt({ kind: 'none' }, { capabilities: ['knowledge'] });
    const undeclared = buildSystemPrompt({ kind: 'none' }, {});
    expect(declared).toContain('knowledge/ bundle');
    expect(declared).toContain('Never write `verified`');
    expect(undeclared).not.toContain('knowledge/ bundle');
    expect(undeclared).not.toContain('supersededBy');
  });

  // M52.3 — the snapshot carries learned-from concepts beside anchored ones,
  // and `relation` is the only thing telling the two apart.
  it('says how to read a knowledge note’s relation', () => {
    const declared = buildSystemPrompt({ kind: 'none' }, { capabilities: ['knowledge'] });
    expect(declared).toContain('`relation`');
    expect(declared).toContain('`learned from`');
    expect(declared).not.toContain('reached by `about:` anchor');
  });

  it('keeps everything that is not the knowledge fragment for everyone', () => {
    const undeclared = buildSystemPrompt({ kind: 'none' }, {});
    expect(undeclared).toContain('assistant inside cerebro');
    expect(undeclared).toContain('propose_organize');
    expect(undeclared).toContain('Be concise.');
  });

  it('still names where the user is standing, capability or not', () => {
    const prompt = buildSystemPrompt({ kind: 'inbox' }, {});
    expect(prompt).toContain('the Inbox');
  });
});
