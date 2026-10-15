import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  editedText,
  MOCK_FAILURES,
  releaseHeldMockRuns,
  resetMockGrants,
  runMockAgent,
} from './mockAgent';
import type { AgentStreamEvent, UiAction } from './types';
import { notesPrompt, type ReviewNote } from '@/engine/reviewNotes';
import { pendingWrites, queueAgentWrite, resetMockFs } from '@/lib/mockIpc';
import { APPROVAL_MESSAGES, plan as planApproval } from '@/lib/policy/toolApproval';

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

    it('chains two appends with " then ", each its own call and its own file (M58.3)', async () => {
      const appended: [string, string][] = [];
      const events: AgentStreamEvent[] = [];
      await new Promise<void>((resolve) => {
        runMockAgent(
          'append "One." to notes/a.md then append "Two." to notes/b.md',
          (event) => {
            events.push(event);
            if (event.kind === 'Done') resolve();
          },
          {
            delayMs: 0,
            onAppend: async (path, content) => {
              appended.push([path, content]);
            },
          },
        );
      });
      expect(toolNames(events)).toEqual(['append_to_note', 'append_to_note']);
      expect(appended).toEqual([
        ['notes/a.md', 'One.'],
        ['notes/b.md', 'Two.'],
      ]);
      expect(replyOf(events)).toBe('I appended that to notes/a.md and notes/b.md.');
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

  // M70.3 — the comment scripts: a comment tool through its handler, which
  // posts beside the page and announces only its comments.
  describe('the comment scripts', () => {
    const PAGE = 'records/decisions/dec-conflict-resolution-is-manual.md';
    const ID = '0123456789abcdef';
    type Handler = (args: Record<string, unknown>) => Promise<string>;

    function runComment(
      ask: string,
      handlers: { onComment?: Handler; onReply?: Handler; onResolve?: Handler } = {},
    ) {
      const events: AgentStreamEvent[] = [];
      const actions: UiAction[] = [];
      const done = new Promise<void>((resolve) => {
        runMockAgent(
          ask,
          (event) => {
            events.push(event);
            if (event.kind === 'Done') resolve();
          },
          { delayMs: 0, onUiAction: (action) => void actions.push(action), ...handlers },
        );
      });
      return done.then(() => ({ events, actions }));
    }

    it('comments on a quoted passage, with an occurrence, and says which thread', async () => {
      const onComment = vi.fn(
        async () => `Commented on ${PAGE} as thread ${ID}, on line 12: "…conflict…"`,
      );
      const { events, actions } = await runComment(
        `comment "Detect the conflict" #2 on ${PAGE}: Who decides?`,
        { onComment },
      );
      expect(toolNames(events)).toEqual(['comment_on_note']);
      const args = {
        path: PAGE,
        quote: 'Detect the conflict',
        text: 'Who decides?',
        occurrence: 2,
      };
      expect(JSON.parse(toolInputs(events)[0])).toEqual(args);
      expect(onComment).toHaveBeenCalledWith(args);
      expect(actions).toEqual([{ action: 'comments_changed', path: PAGE }]);
      expect(replyOf(events)).toBe(`I commented on ${PAGE} as thread ${ID}.`);
    });

    it('comments on the whole page', async () => {
      const onComment = vi.fn(
        async () => `Commented on ${PAGE} as thread ${ID}, about the whole page.`,
      );
      const { events } = await runComment(`comment on ${PAGE}: Looks right, mostly risky.`, {
        onComment,
      });
      expect(onComment).toHaveBeenCalledWith({ path: PAGE, text: 'Looks right, mostly risky.' });
      expect(replyOf(events)).toBe(`I commented on ${PAGE} as thread ${ID}.`);
    });

    it('replies, and resolves with or without a closing reply', async () => {
      const onReply = vi.fn(async () => `Replied in thread ${ID} on ${PAGE}.`);
      const onResolve = vi.fn(async () => `Resolved thread ${ID} on ${PAGE}.`);
      let run = await runComment(`reply to ${ID} on ${PAGE}: The crew lead.`, { onReply });
      expect(onReply).toHaveBeenCalledWith({ path: PAGE, thread: ID, text: 'The crew lead.' });
      expect(replyOf(run.events)).toBe(`I replied in ${ID} on ${PAGE}.`);
      run = await runComment(`resolve ${ID} on ${PAGE}`, { onResolve });
      expect(onResolve).toHaveBeenLastCalledWith({ path: PAGE, thread: ID });
      expect(replyOf(run.events)).toBe(`I resolved ${ID} on ${PAGE}.`);
      run = await runComment(`resolve ${ID} on ${PAGE}: Done in the plan.`, { onResolve });
      expect(onResolve).toHaveBeenLastCalledWith({
        path: PAGE,
        thread: ID,
        text: 'Done in the plan.',
      });
      expect(run.actions).toEqual([{ action: 'comments_changed', path: PAGE }]);
    });

    it('a refusal is an error result, announces nothing, and says why', async () => {
      const refusal = 'The quoted text appears 2 times.';
      const refuse = async () => {
        throw new Error(refusal);
      };
      for (const [ask, said] of [
        [`comment "conflict" on ${PAGE}: x`, `I could not comment on ${PAGE}: ${refusal}`],
        [`reply to ${ID} on ${PAGE}: x`, `I could not reply in ${ID} on ${PAGE}: ${refusal}`],
        [`resolve ${ID} on ${PAGE}`, `I could not resolve ${ID} on ${PAGE}: ${refusal}`],
      ]) {
        const { events, actions } = await runComment(ask, {
          onComment: refuse,
          onReply: refuse,
          onResolve: refuse,
        });
        expect(actions, ask).toEqual([]);
        expect(
          events.find((e) => e.kind === 'ToolDone'),
          ask,
        ).toMatchObject({
          is_error: true,
          output: refusal,
        });
        expect(replyOf(events), ask).toBe(said);
      }
    });

    it('refuses when nothing can carry out the call', async () => {
      for (const [ask, said] of [
        [
          `comment on ${PAGE}: x`,
          `I could not comment on ${PAGE}: comment_on_note is not available here`,
        ],
        [
          `reply to ${ID} on ${PAGE}: x`,
          `I could not reply in ${ID} on ${PAGE}: reply_to_comment is not available here`,
        ],
        [
          `resolve ${ID} on ${PAGE}`,
          `I could not resolve ${ID} on ${PAGE}: resolve_comment is not available here`,
        ],
      ]) {
        const { events, actions } = await runComment(ask);
        expect(actions, ask).toEqual([]);
        expect(replyOf(events), ask).toBe(said);
      }
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

  it('emits Cancelled then Done when cancelled, once each (M57.5)', async () => {
    const events: AgentStreamEvent[] = [];
    const mock = runMockAgent('What is at risk right now?', (e) => events.push(e), {
      delayMs: 50,
      sessionId: SESSION,
    });
    mock.cancel();
    mock.cancel();
    await new Promise((r) => setTimeout(r, 80));
    expect(events.map((e) => e.kind)).toEqual(['Cancelled', 'Done']);
    // A failure script's run closes the same way.
    const failed: AgentStreamEvent[] = [];
    const failure = runMockAgent('fail: unknown', (e) => failed.push(e), { delayMs: 50 });
    failure.cancel();
    expect(failed.map((e) => e.kind)).toEqual(['Cancelled', 'Done']);
  });
});

describe('a held run: `wait for me` (M57.5)', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  afterEach(() => releaseHeldMockRuns());

  it('holds mid-tool until released, then finishes', async () => {
    const events: AgentStreamEvent[] = [];
    const done = new Promise<void>((resolve) => {
      runMockAgent(
        'wait for me',
        (event) => {
          events.push(event);
          if (event.kind === 'Done') resolve();
        },
        { delayMs: 0 },
      );
    });
    await pause(30);
    expect(events.map((e) => e.kind)).toEqual(['Init', 'ModelChanged', 'ToolStart']);
    expect(toolNames(events)).toEqual(['get_vault_context']);
    releaseHeldMockRuns();
    await done;
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('ToolDone');
    expect(kinds.slice(-4)).toEqual(['Text', 'TurnEnded', 'Result', 'Done']);
    expect(replyOf(events)).toBe('Done waiting.');
    // The browser's handle on the same gate.
    expect((window as { __cerebroReleaseMockRuns?: unknown }).__cerebroReleaseMockRuns).toBe(
      releaseHeldMockRuns,
    );
  });

  it('a run cancelled while held emits nothing after release', async () => {
    const events: AgentStreamEvent[] = [];
    const run = runMockAgent('wait for me', (e) => events.push(e), { delayMs: 0 });
    await pause(30);
    run.cancel();
    expect(events.map((e) => e.kind).slice(-2)).toEqual(['Cancelled', 'Done']);
    const closed = events.length;
    releaseHeldMockRuns();
    await pause(30);
    expect(events).toHaveLength(closed);
  });
});

describe('a held call (M57.1)', () => {
  const ASK = 'append "- call the vendor" to notes/inbox.md';
  const card = {
    id: 'c'.repeat(32),
    kind: 'permission',
    tool_name: 'append_to_note',
    tool_id: 't-1',
    session_id: 's-1',
    summary: 'append to note · notes/inbox.md',
    input: '{}',
    asked_at: '2026-10-14T12:00:00.000Z',
  };

  /** Run to Done with `opts` and collect what it emitted and wrote. */
  function run(
    opts: Parameters<typeof runMockAgent>[2],
  ): Promise<{ events: AgentStreamEvent[]; appended: string[] }> {
    const events: AgentStreamEvent[] = [];
    const appended: string[] = [];
    return new Promise((resolve) => {
      runMockAgent(
        ASK,
        (event) => {
          events.push(event);
          if (event.kind === 'Done') resolve({ events, appended });
        },
        {
          delayMs: 0,
          onAppend: (path, content) => {
            appended.push(`${path}: ${content}`);
            return Promise.resolve();
          },
          ...opts,
        },
      );
    });
  }

  it('emits Interaction, ToolDeferred and Done, and writes nothing', async () => {
    const onDefer = vi.fn(() => card);
    const { events, appended } = await run({ asks: (name) => name === 'append_to_note', onDefer });
    expect(onDefer).toHaveBeenCalledWith({
      toolId: 't-1',
      toolName: 'append_to_note',
      input: JSON.stringify({ path: 'notes/inbox.md', content: '- call the vendor' }),
    });
    expect(events.slice(-3)).toEqual([
      { kind: 'Interaction', interaction: card },
      { kind: 'ToolDeferred', tool_id: 't-1', tool_name: 'append_to_note' },
      { kind: 'Done' },
    ]);
    expect(events.some((e) => e.kind === 'ToolDone' || e.kind === 'TurnEnded')).toBe(false);
    expect(appended).toEqual([]);
    // A deferral no book registered shows no card.
    const foreign = await run({ asks: () => true, onDefer: () => null });
    expect(foreign.events.some((e) => e.kind === 'Interaction')).toBe(false);
    expect(foreign.events.some((e) => e.kind === 'ToolDeferred')).toBe(true);
  });

  it('allow resumes with the write', async () => {
    const { events, appended } = await run({
      resume: { toolId: 't-1', answer: { kind: 'allow' } },
    });
    expect(appended).toEqual(['notes/inbox.md: - call the vendor']);
    expect(toolNames(events)).toEqual([]);
    expect(events).toContainEqual({
      kind: 'ToolDone',
      tool_id: 't-1',
      output: 'Appended to notes/inbox.md',
    });
    expect(replyOf(events)).toBe('I appended that to notes/inbox.md.');
    expect(events.some((e) => e.kind === 'TurnEnded')).toBe(true);
  });

  it('deny returns the reason and claims no write', async () => {
    const { events, appended } = await run({
      resume: { toolId: 't-1', answer: { kind: 'deny', message: 'not this week' } },
    });
    expect(appended).toEqual([]);
    expect(events).toContainEqual({
      kind: 'ToolDone',
      tool_id: 't-1',
      output: 'The person declined this call, so it did not run. They said: not this week',
      is_error: true,
    });
    expect(replyOf(events)).not.toContain('appended');
  });
});

describe('the CLI-tool scripts decide through the tool-approval table (M57.2)', () => {
  const plan = (kind: 'attended' | 'unattended', shell: 'off' | 'ask' | 'on') =>
    planApproval({ kind, shell, readScoped: false, narrowing: null });

  function run(
    message: string,
    opts: Parameters<typeof runMockAgent>[2],
  ): Promise<AgentStreamEvent[]> {
    const events: AgentStreamEvent[] = [];
    return new Promise((resolve) => {
      runMockAgent(
        message,
        (event) => {
          events.push(event);
          if (event.kind === 'Done') resolve(events);
        },
        { delayMs: 0, ...opts },
      );
    });
  }

  const doneOf = (events: AgentStreamEvent[]) =>
    events.find((e): e is Extract<AgentStreamEvent, { kind: 'ToolDone' }> => e.kind === 'ToolDone');

  afterEach(() => resetMockGrants());

  it('runs a command under On', async () => {
    const events = await run('run "git status"', { approval: plan('attended', 'on') });
    expect(doneOf(events)).toMatchObject({ output: '$ git status\n(mock) done' });
    expect(doneOf(events)?.is_error).toBeUndefined();
    expect(replyOf(events)).toBe('I ran git status.');
  });

  it('reads Bash as unavailable under Off', async () => {
    const events = await run('run "git status"', { approval: plan('attended', 'off') });
    expect(doneOf(events)).toMatchObject({
      output: 'Bash is not available in this run.',
      is_error: true,
    });
  });

  it('defers under attended Ask, naming the exact subject', async () => {
    const onDefer = vi.fn(() => null);
    const events = await run('run "git status"', {
      approval: plan('attended', 'ask'),
      sessionId: 's-ask',
      onDefer,
    });
    expect(onDefer).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Bash', family: 'shell', subject: 'git status' }),
    );
    expect(events.some((e) => e.kind === 'ToolDeferred')).toBe(true);
    expect(doneOf(events)).toBeUndefined();
  });

  it('never defers an unattended Ask run: the shell is withheld', async () => {
    const onDefer = vi.fn(() => null);
    const message = 'Check the tree.';
    const system = `sys\n\nYour standing instructions, from records/agents/shell-probe.md:\n\nrun "git status"`;
    const events = await run(message, {
      approval: plan('unattended', 'ask'),
      systemPrompt: system,
      onDefer,
    });
    expect(onDefer).not.toHaveBeenCalled();
    expect(doneOf(events)).toMatchObject({
      output: 'Bash is not available in this run.',
      is_error: true,
    });
  });

  // M57.3: `ask me "<question>"` offers no options, so no card can show it.
  it('refuses a question set no card can show, in Rust’s words, and shows no card', async () => {
    const onDefer = vi.fn(() => null);
    const events = await run('ask me "Which release?"', {
      approval: plan('attended', 'ask'),
      onDefer,
    });
    expect(onDefer).not.toHaveBeenCalled();
    const refusal =
      'Cerebro couldn\'t show this question ("Which release?" offers 0 options; a question offers 2 to 4). Ask again with 1 to 4 questions, each with 2 to 4 distinct options.';
    expect(doneOf(events)).toMatchObject({ output: refusal, is_error: true });
    expect(replyOf(events)).toBe(refusal);
  });

  it('asks me which format with both questions, on a question card', async () => {
    const card = {
      id: 'q'.repeat(32),
      kind: 'permission',
      tool_name: 'AskUserQuestion',
      tool_id: 't-1',
      session_id: 's-q',
      summary: 'AskUserQuestion',
      input: '{}',
      asked_at: '2026-10-14T12:00:00.000Z',
    };
    const onDefer = vi.fn(() => card);
    const events = await run('ask me which format', {
      approval: plan('attended', 'off'),
      sessionId: 's-q',
      onDefer,
    });
    expect(events.find((e) => e.kind === 'ToolStart')).toMatchObject({
      tool_name: 'AskUserQuestion',
    });
    expect(onDefer).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'AskUserQuestion', family: 'question' }),
    );
    const shown = events.find((e) => e.kind === 'Interaction');
    expect(shown).toMatchObject({ interaction: { kind: 'question' } });
    const questions = shown?.kind === 'Interaction' ? shown.interaction.questions : null;
    expect(questions?.map((q) => [q.question, q.multiSelect])).toEqual([
      ['Which format?', false],
      ['Which sections?', true],
    ]);
    expect(questions?.[1].options.map((o) => o.label)).toEqual(['Summary', 'Risks', 'Next steps']);
    expect(events.some((e) => e.kind === 'ToolDeferred')).toBe(true);
  });

  it('returns the answers as the tool result, and the reply goes on', async () => {
    const events = await run('ask me which format', {
      approval: plan('attended', 'off'),
      resume: {
        toolId: 't-1',
        answer: {
          kind: 'answers',
          answers: [
            { question: 'Which format?', picked: ['Markdown'], other: null },
            { question: 'Which sections?', picked: ['Summary', 'Risks'], other: null },
          ],
        },
      },
    });
    expect(doneOf(events)).toMatchObject({
      output:
        'User has answered your questions: "Which format?"="Markdown", "Which sections?"="Summary, Risks".',
    });
    expect(doneOf(events)?.is_error).toBeUndefined();
    expect(replyOf(events)).toBe('Got it: Markdown; Summary, Risks.');
  });

  it('a Don’t answer tells the model to decide, and the reply says it went ahead', async () => {
    const events = await run('ask me which format', {
      approval: plan('attended', 'off'),
      resume: { toolId: 't-1', answer: { kind: 'deny', message: 'your call' } },
    });
    expect(doneOf(events)).toMatchObject({
      output:
        'The person chose not to answer, so decide yourself and say what you assumed. They said: your call',
      is_error: true,
    });
    expect(replyOf(events)).toContain('went ahead');
  });

  it('never offers an unattended run a question', async () => {
    const onDefer = vi.fn(() => null);
    const events = await run('ask me which format', {
      approval: plan('unattended', 'ask'),
      onDefer,
    });
    expect(onDefer).not.toHaveBeenCalled();
    expect(doneOf(events)).toMatchObject({
      output: 'AskUserQuestion is not available in this run.',
      is_error: true,
    });
  });

  it('a This conversation answer skips the next ask for the same command, and only it', async () => {
    const approval = plan('attended', 'ask');
    const resumed = await run('run "git status"', {
      approval,
      sessionId: 's-grant',
      resume: { toolId: 't-1', answer: { kind: 'allow', remember: 'conversation' } },
    });
    expect(doneOf(resumed)).toMatchObject({ output: '$ git status\n(mock) done' });
    const onDefer = vi.fn(() => null);
    const again = await run('run "git status"', { approval, sessionId: 's-grant', onDefer });
    expect(onDefer).not.toHaveBeenCalled();
    expect(doneOf(again)).toMatchObject({ output: '$ git status\n(mock) done' });
    // Another command, or another conversation, asks again.
    await run('run "git push"', { approval, sessionId: 's-grant', onDefer });
    await run('run "git status"', { approval, sessionId: 's-other', onDefer });
    expect(onDefer).toHaveBeenCalledTimes(2);
  });

  it('a deny says the person said no', async () => {
    const events = await run('run "rm -rf build"', {
      approval: plan('attended', 'ask'),
      sessionId: 's-deny',
      resume: { toolId: 't-1', answer: { kind: 'deny' } },
    });
    expect(doneOf(events)).toMatchObject({
      output:
        "The person said no, so this did not run. Don't try it again this turn; carry on without it, or say what you needed it for.",
      is_error: true,
    });
  });
});

describe('an ask-first agent’s page write (M57.4)', () => {
  const MESSAGE = '@release-scout create "Vendor delay" in records/risks';
  const ARGS = { folder: 'records/risks', slug: 'vendor-delay', body: '# Vendor delay\n' };
  const plan = (kind: 'attended' | 'unattended', askFirst: boolean) =>
    planApproval({ kind, shell: 'off', askFirst, readScoped: false, narrowing: null });

  function run(opts: Parameters<typeof runMockAgent>[2], message = MESSAGE) {
    const events: AgentStreamEvent[] = [];
    const created: unknown[] = [];
    return new Promise<{ events: AgentStreamEvent[]; created: unknown[] }>((resolve) => {
      runMockAgent(
        message,
        (event) => {
          events.push(event);
          if (event.kind === 'Done') resolve({ events, created });
        },
        {
          delayMs: 0,
          onCreate: async (args) => {
            created.push(args);
            return `Created ${args.folder}/${args.slug}.md`;
          },
          ...opts,
        },
      );
    });
  }

  const doneOf = (events: AgentStreamEvent[]) =>
    events.find((e): e is Extract<AgentStreamEvent, { kind: 'ToolDone' }> => e.kind === 'ToolDone');

  it('asks under an attended ask-first grant, with a write card', async () => {
    const onDefer = vi.fn(() => null);
    const { events, created } = await run({ approval: plan('attended', true), onDefer });
    expect(onDefer).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'create_note',
        family: 'confirmable',
        write: { title: 'Create a note', target: 'records/risks' },
      }),
    );
    expect(events.some((e) => e.kind === 'ToolDeferred')).toBe(true);
    expect(created).toEqual([]);
  });

  it('Allow creates the page', async () => {
    const { events, created } = await run({
      approval: plan('attended', true),
      resume: { toolId: 't-1', answer: { kind: 'allow', remember: 'once' } },
    });
    expect(created).toEqual([ARGS]);
    expect(doneOf(events)).toMatchObject({ output: 'Created records/risks/vendor-delay.md' });
  });

  it('an Allow with the person’s edit creates their version and names the change (M57.4b)', async () => {
    const updatedInput = { ...ARGS, body: '# Vendor delay risk\n' };
    const { events, created } = await run({
      approval: plan('attended', true),
      resume: { toolId: 't-1', answer: { kind: 'allow', remember: 'once', updatedInput } },
    });
    expect(created).toEqual([updatedInput]);
    const sentence = editedText(['body']);
    expect(sentence).toBe(
      'The person changed your draft before allowing it (body); what landed is their version.',
    );
    expect(doneOf(events)).toMatchObject({
      output: `Created records/risks/vendor-delay.md\n${sentence}`,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'Text',
        text: 'I created records/risks/vendor-delay.md with your changes to body.',
      }),
    );
    // mcp.rs words it the same.
    const rust = readFileSync(join(__dirname, '../../src-tauri/src/mcp.rs'), 'utf8');
    expect(rust).toContain('"The person changed your draft before allowing it ({}); what landed');
  });

  it('Deny gives the deny text as an error, with the reason', async () => {
    const { events, created } = await run({
      approval: plan('attended', true),
      resume: { toolId: 't-1', answer: { kind: 'deny', message: 'not yet' } },
    });
    expect(created).toEqual([]);
    expect(doneOf(events)).toEqual({
      kind: 'ToolDone',
      tool_id: 't-1',
      output: 'The person declined this write, so nothing was written. Their reason: "not yet"',
      is_error: true,
    });
  });

  it('an unattended ask-first create queues for Review and reports the queued text (M57.4c)', async () => {
    const onDefer = vi.fn(() => null);
    const onQueue = vi.fn(async () => APPROVAL_MESSAGES.queued.replace('{id}', 'a'.repeat(32)));
    const { events, created } = await run({ approval: plan('unattended', true), onDefer, onQueue });
    expect(onDefer).not.toHaveBeenCalled();
    expect(onQueue).toHaveBeenCalledWith('create_note', ARGS);
    expect(created).toEqual([]);
    const queued = `Queued for the person's review as ${'a'.repeat(32)}; nothing is written until they allow it. Your next run will be told whether it was applied or rejected, so do not queue it again.`;
    expect(doneOf(events)).toEqual({ kind: 'ToolDone', tool_id: 't-1', output: queued });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'Text', text: queued }));
  });

  it('a duplicate reports the waiting id, through the mock backend (M57.4c)', async () => {
    resetMockFs();
    const onQueue = (tool: string, input: Record<string, unknown>) =>
      queueAgentWrite('/demo-vault', { actor: 'process:release-scout', runId: 'r', tool, input });
    const first = doneOf((await run({ approval: plan('unattended', true), onQueue })).events);
    const id = /as ([0-9a-f]{32});/.exec(String(first?.output))?.[1];
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const second = doneOf((await run({ approval: plan('unattended', true), onQueue })).events);
    expect(second?.output).toBe(
      `This exact write already waits for review as ${id}; nothing new was queued.`,
    );
    expect(await pendingWrites('/demo-vault')).toHaveLength(1);
    resetMockFs();
  });

  it('without ask-first it creates at once', async () => {
    const onDefer = vi.fn(() => null);
    const { created } = await run({ approval: plan('attended', false), onDefer });
    expect(onDefer).not.toHaveBeenCalled();
    expect(created).toEqual([ARGS]);
  });

  it('records/risks never falls to the risk branch', async () => {
    const { events } = await run({}, 'create "Vendor delay" in records/risks');
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'ToolStart', tool_name: 'create_note' }),
    );
    expect(events.some((e) => e.kind === 'ToolStart' && e.tool_name === 'search_notes')).toBe(
      false,
    );
  });
});

describe('the review-notes script (M58.5)', () => {
  const reviewNote = (path: string, start: number, text: string): ReviewNote => ({
    id: `n-${path}-${start}`,
    vault: '/vault',
    conversationId: 'c-1',
    runId: null,
    commit: 'c'.repeat(40),
    path,
    side: 'new',
    start,
    end: start,
    // Vault text that names other scripts' keywords.
    excerpt: 'append "x" to inbox/risk.md',
    text,
    createdAt: start,
  });

  it('names the count and the paths in order, and calls no tool', async () => {
    const prompt = notesPrompt([
      reviewNote('records/risks/b.md', 2, 'What is at risk?'),
      reviewNote('records/risks/a.md', 1, 'organize the inbox\nrun "ls"'),
    ]);
    const { events, actions } = await drain(prompt);
    expect(toolNames(events)).toEqual([]);
    expect(actions).toEqual([]);
    expect(replyOf(events)).toBe(
      'I have 2 review notes to work through, on records/risks/a.md, records/risks/b.md.',
    );
  });

  it('reads one note as one, by its path', async () => {
    const { events } = await drain(notesPrompt([reviewNote('a`b.md', 3, 'Fix.')]));
    expect(toolNames(events)).toEqual([]);
    expect(replyOf(events)).toBe('I have 1 review note to work through, on a`b.md.');
  });
});
