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

function drain(message: string): Promise<{ events: AgentStreamEvent[]; actions: UiAction[] }> {
  const events: AgentStreamEvent[] = [];
  const actions: UiAction[] = [];
  return new Promise((resolve) => {
    runMockAgent(
      message,
      (event) => {
        events.push(event);
        if (event.kind === 'Done') resolve({ events, actions });
      },
      { delayMs: 0, onUiAction: (action) => actions.push(action) },
    );
  });
}

const toolNames = (events: AgentStreamEvent[]): string[] =>
  events.flatMap((e) => (e.kind === 'ToolStart' ? [e.tool_name] : []));

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
