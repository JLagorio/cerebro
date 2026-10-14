import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOCK_FAILURES, runMockAgent } from './mockAgent';
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
  model?: string | null,
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
      { delayMs: 0, onUiAction: (action) => actions.push(action), systemPrompt, model },
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

/** Rust's failure golden (M56.4): each failure fixture's notice. */
const NOTICES = (
  JSON.parse(readFileSync(join(__dirname, '../../conformance/failure/notices.json'), 'utf8')) as {
    notices: Record<string, unknown>;
  }
).notices;

describe('the model a mock run reports (M56.5)', () => {
  it('reports mock-<model> right after Init, once', async () => {
    const { events } = await drain('hello', undefined, 'opus');
    expect(events.slice(0, 2)).toEqual([
      { kind: 'Init', session_id: expect.any(String) },
      { kind: 'ModelChanged', model: 'mock-opus' },
    ]);
    expect(events.filter((e) => e.kind === 'ModelChanged')).toHaveLength(1);
  });

  it('reports mock-default when no model was asked for', async () => {
    const { events } = await drain('hello');
    expect(events.find((e) => e.kind === 'ModelChanged')).toEqual({
      kind: 'ModelChanged',
      model: 'mock-default',
    });
  });
});

describe('the failure scripts (M56.4)', () => {
  it.each([
    ['fail: not-signed-in', 'real/spike-not-signed-in.stream.jsonl'],
    ['fail: usage-limit', 'usage-limit-stream.json'],
  ])('%s emits exactly the notice Rust gives %s', async (message, fixture) => {
    expect(NOTICES[fixture]).toBeTruthy();
    const { events } = await drain(message);
    expect(events.map((e) => e.kind)).toEqual(['Init', 'Error', 'TurnEnded', 'Done']);
    const error = events.find((e) => e.kind === 'Error');
    expect(error?.kind === 'Error' && error.notice).toEqual(NOTICES[fixture]);
    expect(MOCK_FAILURES[message].notice).toEqual(NOTICES[fixture]);
  });

  it('fail: unknown fails with its raw words and no notice', async () => {
    const { events } = await drain('fail: unknown');
    const error = events.find((e) => e.kind === 'Error');
    expect(error).toEqual({
      kind: 'Error',
      message: MOCK_FAILURES['fail: unknown'].message,
      code: 'invalid_request',
    });
  });

  it('matches only the message as typed', async () => {
    const { events } = await drain('what happens if I fail: not-signed-in');
    expect(events.some((e) => e.kind === 'Error')).toBe(false);
  });
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

  it("'read five notes' calls get_note five times, on demo-vault notes (M56.8)", async () => {
    const { events, actions } = await drain('read five notes');
    expect(toolNames(events)).toEqual(Array.from({ length: 5 }, () => 'get_note'));
    const paths = toolInputs(events).map((input) => (JSON.parse(input) as { path: string }).path);
    expect(new Set(paths).size).toBe(5);
    for (const path of paths) {
      expect(
        () => readFileSync(join(__dirname, '../../demo-vault', path), 'utf8'),
        path,
      ).not.toThrow();
    }
    const done = events.flatMap((e) => (e.kind === 'ToolDone' ? [e] : []));
    expect(done).toHaveLength(5);
    expect(done.every((e) => typeof e.output === 'string' && e.output !== '' && !e.is_error)).toBe(
      true,
    );
    const reply = events.find((e) => e.kind === 'Text');
    expect(reply?.kind === 'Text' && reply.text).toBe('I read the five open risks.');
    expect(actions).toEqual([]);
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

  // M53.6 — a script that writes, so an e2e has an agent write landing
  // mid-turn on a page someone has open.
  describe('the append script', () => {
    const PAGE = 'delivery/how-we-schedule.md';
    const ASK = `append "Agent line one." to ${PAGE}`;

    /** Run it, recording the order of the append, its announcement and the tool's result. */
    function runAppend(onAppend?: (path: string, content: string) => Promise<void>) {
      const order: string[] = [];
      const events: AgentStreamEvent[] = [];
      const actions: UiAction[] = [];
      const done = new Promise<void>((resolve) => {
        runMockAgent(
          ASK,
          (event) => {
            events.push(event);
            if (event.kind === 'ToolDone') order.push(event.is_error ? 'tool-error' : 'tool-done');
            if (event.kind === 'Done') resolve();
          },
          {
            delayMs: 0,
            onUiAction: (action) => {
              actions.push(action);
              order.push(action.action);
            },
            onAppend:
              onAppend === undefined
                ? undefined
                : async (path, content) => {
                    order.push('append');
                    await onAppend(path, content);
                  },
          },
        );
      });
      return done.then(() => ({ order, events, actions }));
    }

    it('appends, announces the path it wrote, then reports the tool done', async () => {
      const onAppend = vi.fn(async () => undefined);
      const { order, events, actions } = await runAppend(onAppend);
      expect(toolNames(events)).toEqual(['append_to_note']);
      expect(onAppend).toHaveBeenCalledWith(PAGE, 'Agent line one.');
      expect(order).toEqual(['append', 'vault_changed', 'tool-done']);
      expect(actions).toEqual([{ action: 'vault_changed', paths: [PAGE] }]);
      expect(replyOf(events)).toBe(`I appended that to ${PAGE}.`);
    });

    it('a refused append is an error result, announces nothing, and claims no write', async () => {
      const { order, events, actions } = await runAppend(async () => {
        throw new Error('knowledge/ is written only through write_concept');
      });
      expect(order).toEqual(['append', 'tool-error']);
      expect(actions).toEqual([]);
      const done = events.find((e) => e.kind === 'ToolDone');
      expect(done).toMatchObject({ is_error: true, output: expect.stringContaining('knowledge/') });
      expect(replyOf(events)).toContain('I could not append');
    });

    it('refuses when nothing can carry out the append', async () => {
      const { order, actions } = await runAppend(undefined);
      expect(order).toEqual(['tool-error']);
      expect(actions).toEqual([]);
    });

    it('is only the script for exactly that shape', async () => {
      const { events } = await drain(`please append "x" to ${PAGE} and more`);
      expect(toolNames(events)).not.toContain('append_to_note');
    });
  });

  // M55.5 — the other script that writes: an edit_note through `onEdit`.
  describe('the edit script', () => {
    const PAGE = 'delivery/how-we-schedule.md';
    const REPORT = `Edited ${PAGE}: 1 edit; nothing outside the quoted text changed.`;

    /** Run `ask`, recording the order of the edit, its announcement and the tool's result. */
    function runEdit(ask: string, onEdit?: (path: string, edits: unknown[]) => Promise<string>) {
      const order: string[] = [];
      const events: AgentStreamEvent[] = [];
      const actions: UiAction[] = [];
      const done = new Promise<void>((resolve) => {
        runMockAgent(
          ask,
          (event) => {
            events.push(event);
            if (event.kind === 'ToolDone') order.push(event.is_error ? 'tool-error' : 'tool-done');
            if (event.kind === 'Done') resolve();
          },
          {
            delayMs: 0,
            onUiAction: (action) => {
              actions.push(action);
              order.push(action.action);
            },
            onEdit:
              onEdit === undefined
                ? undefined
                : async (path, edits) => {
                    order.push('edit');
                    return onEdit(path, edits);
                  },
          },
        );
      });
      return done.then(() => ({ order, events, actions }));
    }

    it('edits, announces the path it wrote, then reports the tool done with its report', async () => {
      const onEdit = vi.fn(async () => REPORT);
      const { order, events, actions } = await runEdit(
        `edit "after the freeze" to "after the Wednesday freeze" in ${PAGE}`,
        onEdit,
      );
      expect(toolNames(events)).toEqual(['edit_note']);
      expect(JSON.parse(toolInputs(events)[0])).toEqual({
        path: PAGE,
        edits: [{ old: 'after the freeze', new: 'after the Wednesday freeze' }],
      });
      expect(onEdit).toHaveBeenCalledWith(PAGE, [
        { old: 'after the freeze', new: 'after the Wednesday freeze' },
      ]);
      expect(order).toEqual(['edit', 'vault_changed', 'tool-done']);
      expect(actions).toEqual([{ action: 'vault_changed', paths: [PAGE] }]);
      expect(events.find((e) => e.kind === 'ToolDone')).toMatchObject({ output: REPORT });
      expect(replyOf(events)).toBe(`I edited ${PAGE}.`);
    });

    it('reads \\n inside the quotes as a line break, and takes an empty new', async () => {
      const onEdit = vi.fn(async () => REPORT);
      await runEdit(`edit "freeze.\\nThursdays" to "" in ${PAGE}`, onEdit);
      expect(onEdit).toHaveBeenCalledWith(PAGE, [{ old: 'freeze.\nThursdays', new: '' }]);
    });

    it('a refused edit is an error result, announces nothing, and says why', async () => {
      const refusal = 'Edit 1: the quoted text appears 2 times.';
      const { order, events, actions } = await runEdit(
        `edit "Thursdays" to "Fridays" in ${PAGE}`,
        async () => {
          throw new Error(refusal);
        },
      );
      expect(order).toEqual(['edit', 'tool-error']);
      expect(actions).toEqual([]);
      expect(events.find((e) => e.kind === 'ToolDone')).toMatchObject({
        is_error: true,
        output: refusal,
      });
      expect(replyOf(events)).toBe(`I could not edit ${PAGE}: ${refusal}`);
    });

    it('refuses when nothing can carry out the edit', async () => {
      const { order, events, actions } = await runEdit(`edit "a" to "b" in ${PAGE}`);
      expect(order).toEqual(['tool-error']);
      expect(actions).toEqual([]);
      expect(replyOf(events)).toBe(`I could not edit ${PAGE}: edit_note is not available here`);
    });

    it('matches only the exact shape', async () => {
      const onEdit = vi.fn(async () => REPORT);
      for (const ask of [
        `please edit "a" to "b" in ${PAGE}`,
        `edit "a" to "b" in ${PAGE} now`,
        `edit "a" into "b" in ${PAGE}`,
      ]) {
        const { events } = await runEdit(ask, onEdit);
        expect(toolNames(events)).not.toContain('edit_note');
      }
      expect(onEdit).not.toHaveBeenCalled();
    });
  });

  // M55.6 — a browser-mode seam: a spec holds the agent's write while it
  // types into the open page, then lets it land.
  describe('the write gate', () => {
    const PAGE = 'delivery/how-we-schedule.md';
    const gated = globalThis as { __cerebroAgentWriteGate?: Promise<void> };
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    function hold(): () => void {
      let open = () => {};
      gated.__cerebroAgentWriteGate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return open;
    }

    afterEach(() => {
      delete gated.__cerebroAgentWriteGate;
    });

    it('holds a write until the gate opens', async () => {
      const open = hold();
      const onEdit = vi.fn(async () => 'Edited.');
      const actions: UiAction[] = [];
      const done = new Promise<void>((resolve) => {
        runMockAgent(
          `edit "a" to "b" in ${PAGE}`,
          (event) => {
            if (event.kind === 'Done') resolve();
          },
          { delayMs: 0, onEdit, onUiAction: (action) => void actions.push(action) },
        );
      });
      await pause(30);
      expect(onEdit).not.toHaveBeenCalled();
      expect(actions).toEqual([]);
      open();
      await done;
      expect(onEdit).toHaveBeenCalledOnce();
      expect(actions).toEqual([{ action: 'vault_changed', paths: [PAGE] }]);
    });

    it('writes nothing for a run cancelled while held', async () => {
      const open = hold();
      const onAppend = vi.fn(async () => undefined);
      const actions: UiAction[] = [];
      const run = runMockAgent(`append "x" to ${PAGE}`, () => undefined, {
        delayMs: 0,
        onAppend,
        onUiAction: (action) => void actions.push(action),
      });
      await pause(30);
      run.cancel();
      open();
      await pause(30);
      expect(onAppend).not.toHaveBeenCalled();
      expect(actions).toEqual([]);
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

describe('the mock names its session and ends its turn as the fold does (M56.3)', () => {
  const SESSION = '00000000-0000-4000-8000-0000000000ab';
  const run = (sessionId?: string): Promise<AgentStreamEvent[]> =>
    new Promise((resolve) => {
      const events: AgentStreamEvent[] = [];
      runMockAgent(
        'What is at risk right now?',
        (event) => {
          events.push(event);
          if (event.kind === 'Done') resolve(events);
        },
        { delayMs: 0, sessionId },
      );
    });

  it('echoes the run’s session id in Init and Result', async () => {
    const events = await run(SESSION);
    expect(events[0]).toEqual({ kind: 'Init', session_id: SESSION });
    expect(events.find((e) => e.kind === 'Result')).toMatchObject({ session_id: SESSION });
    // Unnamed, it still reports a UUID, never a word Rust would refuse.
    const unnamed = await run();
    expect(unnamed[0]).toMatchObject({ kind: 'Init' });
    expect((unnamed[0] as { session_id: string }).session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('emits Text and TurnEnded before Result', async () => {
    const kinds = (await run(SESSION)).map((e) => e.kind);
    expect(kinds.slice(-4)).toEqual(['Text', 'TurnEnded', 'Result', 'Done']);
    const events = await run(SESSION);
    const text = events.find((e) => e.kind === 'Text');
    expect(text).toMatchObject({ message_id: 'msg_mock', text: replyOf(events) });
  });

  it('still emits only Done when cancelled', async () => {
    const events: AgentStreamEvent[] = [];
    const mock = runMockAgent('What is at risk right now?', (e) => events.push(e), {
      delayMs: 50,
      sessionId: SESSION,
    });
    mock.cancel();
    expect(events.map((e) => e.kind)).toEqual(['Done']);
  });
});
