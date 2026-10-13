import { describe, expect, it, vi } from 'vitest';
import { runMockAgent } from './mockAgent';
import type { AgentStreamEvent, UiAction } from './types';

/**
 * The mock is what browser dev, vitest, and Playwright see instead of the real
 * agent, so its scripts are load-bearing: anything the reply CLAIMS to have
 * done has to actually happen through the same channel production uses.
 *
 * The regression this guards: the inbox script said "I have proposed a filing
 * for it" and emitted no proposal, which left the whole propose-and-review
 * path with no test running through it and made the panel's own transcript
 * the least trustworthy thing on screen.
 */

function drain(
  message: string,
  systemPrompt?: string,
): Promise<{ events: AgentStreamEvent[]; actions: UiAction[] }> {
  const events: AgentStreamEvent[] = [];
  const actions: UiAction[] = [];
  return new Promise((resolve) => {
    runMockAgent(
      message,
      (event) => {
        events.push(event);
        if (event.kind === 'Done') resolve({ events, actions });
      },
      { delayMs: 0, onUiAction: (action) => actions.push(action), systemPrompt },
    );
  });
}

const toolNames = (events: AgentStreamEvent[]): string[] =>
  events.flatMap((e) => (e.kind === 'ToolStart' ? [e.tool_name] : []));

const toolInputs = (events: AgentStreamEvent[]): string[] =>
  events.flatMap((e) => (e.kind === 'ToolStart' ? [e.input ?? ''] : []));

const replyOf = (events: AgentStreamEvent[]): string =>
  events.flatMap((e) => (e.kind === 'Result' ? [e.text] : [])).join('');

const PHOENIX = 'records/projects/phoenix-warehouse-rollout.md';

/** A system prompt as the panel builds one: prose, then `renderSnapshot`'s block. */
const withSnapshot = (knowledge: unknown[] | undefined): string =>
  [
    'You are the assistant inside cerebro.',
    '',
    '## Context snapshot',
    'What the user is looking at right now.',
    '```json',
    JSON.stringify(
      { vault: { types: [], projects: 1, notes: 1 }, ...(knowledge ? { knowledge } : {}) },
      null,
      2,
    ),
    '```',
  ].join('\n');

const note = (path: string, title: string, extra: Record<string, unknown> = {}) => ({
  path,
  title,
  claim: `${title}.`,
  review: 'unreviewed',
  reviewedBy: null,
  about: PHOENIX,
  relation: 'about',
  ...extra,
});

describe('runMockAgent', () => {
  it('emits the proposal its inbox reply says it made', async () => {
    const { events, actions } = await drain('Help me clear the Inbox');

    expect(toolNames(events)).toEqual(['list_inbox', 'propose_organize']);
    expect(actions).toHaveLength(1);
    const [action] = actions;
    expect(action.action).toBe('propose_organize');
    if (action.action !== 'propose_organize') throw new Error('unreachable');
    // A real capture in the demo vault — a proposal for a path that does not
    // exist would render nowhere and prove nothing.
    expect(action.path).toBe('inbox/warehouse-cutover-thought.md');
    expect(action.type).toBe('Work item');
    expect(action.reasoning).not.toBe('');
  });

  it('fires the ui action only after its tools report done', async () => {
    const order: string[] = [];
    await new Promise<void>((resolve) => {
      runMockAgent(
        'organize the inbox',
        (event) => {
          if (event.kind === 'ToolDone') order.push('tool-done');
          if (event.kind === 'Done') resolve();
        },
        { delayMs: 0, onUiAction: () => order.push('ui-action') },
      );
    });
    expect(order).toEqual(['tool-done', 'tool-done', 'ui-action']);
  });

  it('drives no ui action for scripts that do not claim one', async () => {
    for (const prompt of ['What is at risk right now?', 'tell me about this vault']) {
      const { actions } = await drain(prompt);
      expect(actions).toEqual([]);
    }
  });

  // M52.3 — the catch-all answered every prompt that mentioned a concept or
  // a document with "Written to the knowledge bundle" and a write_concept to
  // knowledge/playbooks/x.md, a file that never existed.
  describe('answers about Knowledge name what they read and claim no write', () => {
    const ask = `What does the knowledge base know that bears on ${PHOENIX} ("Phoenix warehouse rollout")?\n\nCall knowledge_about with target: ${PHOENIX} FIRST.`;

    it('cites the concepts the turn carries, each as its page', async () => {
      const { events, actions } = await drain(
        ask,
        withSnapshot([
          note('knowledge/playbooks/warehouse-cutover.md', 'Warehouse cutover'),
          note('knowledge/systems/pick-queue-drain.md', 'Pick queue drain time', {
            review: 'current',
            reviewedBy: 'human',
          }),
          // In context, but about another record — not this question's.
          note('knowledge/metrics/other.md', 'Other', { about: 'records/other.md' }),
        ]),
      );
      expect(toolNames(events)).toEqual(['knowledge_about']);
      expect(toolInputs(events)).toEqual([JSON.stringify({ target: PHOENIX })]);
      const reply = replyOf(events);
      expect(reply).toContain('[[warehouse-cutover|Warehouse cutover]] — Warehouse cutover.');
      expect(reply).toContain('[[pick-queue-drain|Pick queue drain time]]');
      expect(reply).not.toContain('[[other');
      expect(reply).toContain('no person has verified it');
      expect(reply).not.toContain('x.md');
      expect(reply).not.toMatch(/written to/i);
      expect(actions).toEqual([]);
    });

    // M52.4 — a replaced concept listed under "Held" read as a belief the
    // base still holds; it is carried, apart, under what is not settled.
    it('keeps a replaced concept out of what Knowledge holds', async () => {
      const { events } = await drain(
        ask,
        withSnapshot([
          note('knowledge/systems/offline-window-pilot.md', 'The offline window', {
            supersededBy: 'knowledge/systems/offline-guarantee.md',
          }),
          note('knowledge/playbooks/warehouse-cutover.md', 'Warehouse cutover'),
        ]),
      );
      const reply = replyOf(events);
      const held = reply.indexOf('**Held**');
      const unsettled = reply.indexOf('**Unsettled**');
      const replaced = reply.indexOf('[[offline-window-pilot|The offline window]]');
      expect(held).toBeGreaterThanOrEqual(0);
      expect(reply).toContain('**Held** — one concept bears on "Phoenix warehouse rollout"');
      expect(reply.indexOf('[[warehouse-cutover|')).toBeGreaterThan(held);
      expect(reply.indexOf('[[warehouse-cutover|')).toBeLessThan(unsettled);
      expect(unsettled).toBeGreaterThan(held);
      expect(replaced).toBeGreaterThan(unsettled);
      expect(reply).toContain('replaced — not current');
    });

    it('says nothing is held when every concept is unsettled', async () => {
      const { events } = await drain(
        ask,
        withSnapshot([
          note('knowledge/playbooks/warehouse-cutover.md', 'Warehouse cutover', { stale: true }),
        ]),
      );
      const reply = replyOf(events);
      expect(reply).not.toContain('**Held**');
      expect(reply).toContain('**Unsettled** — one concept on it is');
    });

    it('says Knowledge holds nothing yet when the snapshot carries none', async () => {
      const { events } = await drain(ask, withSnapshot(undefined));
      expect(replyOf(events)).toBe('Knowledge holds nothing on "Phoenix warehouse rollout" yet.');
    });

    it('does not read a missing snapshot as an empty base', async () => {
      const { events } = await drain(ask);
      expect(replyOf(events)).toContain('could not read what Knowledge holds');
      expect(replyOf(events)).not.toContain('holds nothing');
    });

    it('answers a revise or a recheck with a verdict on the named concept, and no write', async () => {
      const path = 'knowledge/metrics/sync-error-rate.md';
      for (const verb of ['Revise', 'Recheck']) {
        const { events } = await drain(
          `${verb} the knowledge concept at ${path} ("Sync error rate"). Its recheck date has passed.`,
        );
        expect(toolNames(events)).toEqual(['get_note', 'knowledge_about']);
        expect(toolInputs(events)[0]).toBe(JSON.stringify({ path }));
        const reply = replyOf(events);
        expect(reply).toContain('"Sync error rate"');
        expect(reply).toContain('Verdict:');
        expect(reply).toContain('I have not changed the concept');
        expect(toolNames(events)).not.toContain('write_concept');
      }
    });

    it('names the note a distillation read — even under inbox/ — and writes nothing', async () => {
      const { events, actions } = await drain(
        'Learn from the note at inbox/phoenix-cutover-standup.md ("Phoenix cutover standup").',
      );
      expect(toolNames(events)).toEqual(['get_note', 'knowledge_about']);
      expect(replyOf(events)).toContain('"Phoenix cutover standup"');
      expect(replyOf(events)).toContain('I have not written a concept');
      // Not mistaken for an Inbox request by the path it names.
      expect(actions).toEqual([]);
    });

    it('reads a draft against what Knowledge holds without editing it', async () => {
      const { events } = await drain(
        `I am writing ${PHOENIX} ("Phoenix warehouse rollout").\n\nDo not edit the document.`,
        withSnapshot([note('knowledge/playbooks/warehouse-cutover.md', 'Warehouse cutover')]),
      );
      const reply = replyOf(events);
      expect(reply).toContain('**Established**');
      expect(reply).toContain('[[warehouse-cutover|Warehouse cutover]]');
      expect(reply).toContain('I have not edited the document.');
    });

    it('no longer claims a write for any prompt that says "concept" or "document"', async () => {
      const { events } = await drain('Explain the concept of a knowledge document');
      expect(toolNames(events)).not.toContain('write_concept');
      expect(replyOf(events)).not.toMatch(/written to the knowledge bundle/i);
    });
  });

  it('cancelling before the run finishes suppresses the proposal', async () => {
    const onUiAction = vi.fn();
    const run = runMockAgent('inbox', () => undefined, { delayMs: 5, onUiAction });
    run.cancel();
    await new Promise((r) => setTimeout(r, 40));
    // A cancelled run is the mock's kill-the-child-process equivalent; it must
    // not land a proposal the user stopped.
    expect(onUiAction).not.toHaveBeenCalled();
  });
});
