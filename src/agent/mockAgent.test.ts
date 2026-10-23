import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachRun, onAgentEvent, readCliTranscript, runAgent } from './agentIpc';
import {
  editedText,
  MOCK_FAILURES,
  MOCK_MEETING_SUMMARY,
  releaseHeldMockRuns,
  resetMockGrants,
  runMockAgent,
} from './mockAgent';
import { applyEvent, endLiveTurn, findCall, replayTranscript } from './transcript';
import type { AgentEvent, AgentStreamEvent, ChatMessage, UiAction } from './types';
import { parseStackTrace } from '@/engine/ai/stackFrames';
import { testReportOf } from '@/engine/ai/testReport';
import { notesPrompt, type ReviewNote } from '@/engine/reviewNotes';
import { makeEntry } from '@/engine/testHelpers';
import { organizePrompt } from '@/lib/prompts';
import { agentCreate, pendingWrites, queueAgentWrite, resetMockFs } from '@/lib/mockIpc';
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

/** A people page for the meeting asks; the mock reads only the links. */
const PAGE = makeEntry({ path: 'people/marcus-webb.md', title: 'Marcus Webb' });

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

  // M64.7 — the meeting ask names an inbox/ path, and gets its own filing.
  it('files a meeting ask as one proposal for its path, with the links the ask names', async () => {
    const ask = organizePrompt('inbox/phoenix-cutover-standup.md', {
      title: 'Phoenix cutover standup',
      speakers: [
        { label: 'Marcus Webb', kind: 'matched', page: PAGE, link: '[[marcus-webb]]' },
        { label: 'Priya Nair', kind: 'matched', page: PAGE, link: '[[priya-nair]]' },
        { label: 'Jo Nobody', kind: 'none' },
      ],
    });
    const { events, actions } = await drain(ask);
    expect(toolNames(events)).toEqual(['get_note', 'propose_organize']);
    expect(actions).toEqual([
      {
        action: 'propose_organize',
        path: 'inbox/phoenix-cutover-standup.md',
        type: 'Meeting',
        title: 'Meeting: Phoenix cutover standup',
        properties: {
          summary: MOCK_MEETING_SUMMARY,
          attendees: ['[[marcus-webb]]', '[[priya-nair]]'],
        },
        reasoning: expect.any(String) as string,
      },
    ]);
  });

  it('files a meeting that names no speakers with a summary and no attendees', async () => {
    const ask = organizePrompt('inbox/call.md', { title: 'Call', speakers: [] });
    const { actions } = await drain(ask);
    const [action] = actions;
    if (action?.action !== 'propose_organize') throw new Error('no proposal');
    expect(action.properties).toEqual({ summary: MOCK_MEETING_SUMMARY });
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

  describe('the sheet edit script', () => {
    const path = 'notes/budget.md';
    const args = {
      ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ address: 'B4', value: '=SUM(B2:B3)' }] }],
    };
    const report = JSON.stringify({ path, wrote: true, changed: [{ value: 1500 }] });
    const gated = globalThis as { __cerebroAgentWriteGate?: Promise<void> };
    afterEach(() => {
      delete gated.__cerebroAgentWriteGate;
    });
    function runSheet(
      json: string,
      onEditSheet?: (path: string, args: Record<string, unknown>) => Promise<string>,
    ) {
      const events: AgentStreamEvent[] = [];
      const actions: UiAction[] = [];
      const done = new Promise<void>((resolve) => {
        runMockAgent(
          `edit sheet in ${path}: ${json}`,
          (event) => {
            events.push(event);
            if (event.kind === 'Done') resolve();
          },
          { delayMs: 0, onEditSheet, onUiAction: (action) => void actions.push(action) },
        );
      });
      return done.then(() => ({ events, actions }));
    }
    it('passes source inputs through the writer and announces the page after its report', async () => {
      const writer = vi.fn(async () => report);
      const { events, actions } = await runSheet(JSON.stringify(args), writer);
      expect(toolNames(events)).toEqual(['edit_sheet']);
      expect(JSON.parse(toolInputs(events)[0])).toEqual({ path, ...args });
      expect(writer).toHaveBeenCalledWith(path, args);
      expect(actions).toEqual([{ action: 'vault_changed', paths: [path] }]);
      expect(events.find((e) => e.kind === 'ToolDone')).toMatchObject({ output: report });
      expect(replyOf(events)).toBe(`I edited the sheets on ${path}.`);
    });
    it('waits for the write gate before calling the writer', async () => {
      let release = () => {};
      gated.__cerebroAgentWriteGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = vi.fn(async () => report);
      const run = runSheet(JSON.stringify(args), writer);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(writer).not.toHaveBeenCalled();
      release();
      await run;
      expect(writer).toHaveBeenCalledOnce();
    });
    it('reports the first refusal line, preserves the full tool error and announces nothing', async () => {
      const refusal =
        'edit_sheet takes at most 25 ops in one call; this call has 26.\nNothing was written.';
      const { events, actions } = await runSheet(JSON.stringify(args), async () => {
        throw new Error(refusal);
      });
      expect(actions).toEqual([]);
      expect(events.find((e) => e.kind === 'ToolDone')).toMatchObject({
        is_error: true,
        output: refusal,
      });
      expect(replyOf(events)).toBe(
        `I could not edit the sheets on ${path}: ${refusal.split('\n')[0]}`,
      );
    });
    it('refuses without a writer', async () => {
      const { events, actions } = await runSheet(JSON.stringify(args));
      expect(actions).toEqual([]);
      expect(replyOf(events)).toBe(
        `I could not edit the sheets on ${path}: edit_sheet is not available here`,
      );
    });
    it.each(['not json', 'null', '[]', '"text"'])(
      'refuses malformed arguments %s without a write',
      async (json) => {
        const writer = vi.fn(async () => report);
        const { events, actions } = await runSheet(json, writer);
        expect(writer).not.toHaveBeenCalled();
        expect(actions).toEqual([]);
        expect(replyOf(events)).toContain('edit_sheet needs `ops`, a list of operations');
      },
    );
  });

  // M60.4 — the set script: set_fields through its handler, which writes
  // the record's frontmatter and announces a rescan, as Rust does.
  describe('the set script', () => {
    const PAGE = 'records/objectives/obj-launch-pipeline.md';
    const REPORT = `Set fields on ${PAGE}.\nquarter: set to 2026-q4 (from "2026 Q4")\nHash: abc`;
    const gated = globalThis as { __cerebroAgentWriteGate?: Promise<void> };

    afterEach(() => {
      delete gated.__cerebroAgentWriteGate;
    });

    function runSet(
      ask: string,
      onSetFields?: (path: string, args: Record<string, unknown>) => Promise<string>,
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
          { delayMs: 0, onUiAction: (action) => void actions.push(action), onSetFields },
        );
      });
      return done.then(() => ({ events, actions }));
    }

    it('calls set_fields with the field and value, announces a rescan, and reports', async () => {
      const onSetFields = vi.fn(async () => REPORT);
      const { events, actions } = await runSet(`set quarter to "2026 Q4" on ${PAGE}`, onSetFields);
      expect(toolNames(events)).toEqual(['set_fields']);
      expect(JSON.parse(toolInputs(events)[0])).toEqual({
        path: PAGE,
        set: { quarter: '2026 Q4' },
      });
      expect(onSetFields).toHaveBeenCalledWith(PAGE, { set: { quarter: '2026 Q4' } });
      expect(actions).toEqual([{ action: 'vault_changed' }]);
      expect(events.find((e) => e.kind === 'ToolDone')).toMatchObject({ output: REPORT });
      expect(replyOf(events)).toBe(`I set quarter on ${PAGE}.`);
    });

    it('reports a refusal, announcing nothing', async () => {
      const refusal = `schema_invalid: nothing was written to ${PAGE}.\n- progress is computed and can't be edited`;
      const { events, actions } = await runSet(`set progress to "50" on ${PAGE}`, async () => {
        throw new Error(refusal);
      });
      expect(actions).toEqual([]);
      expect(events.find((e) => e.kind === 'ToolDone')).toMatchObject({
        is_error: true,
        output: refusal,
      });
      expect(replyOf(events)).toBe(`I could not set progress on ${PAGE}: ${refusal}`);
    });

    it('refuses when nothing can carry out the set', async () => {
      const { events, actions } = await runSet(`set quarter to "x" on ${PAGE}`);
      expect(actions).toEqual([]);
      expect(replyOf(events)).toBe(
        `I could not set quarter on ${PAGE}: set_fields is not available here`,
      );
    });

    it('waits for the write gate', async () => {
      let open = () => {};
      gated.__cerebroAgentWriteGate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const onSetFields = vi.fn(async () => REPORT);
      const run = runSet(`set quarter to "2026 Q4" on ${PAGE}`, onSetFields);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(onSetFields).not.toHaveBeenCalled();
      open();
      const { actions } = await run;
      expect(onSetFields).toHaveBeenCalledOnce();
      expect(actions).toEqual([{ action: 'vault_changed' }]);
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

  it('counts nothing on its result: only the M91 scripts carry a count (M92.2)', async () => {
    const result = (await run(SESSION)).find((e) => e.kind === 'Result');
    expect(result).toBeDefined();
    expect(result !== undefined && 'duration_ms' in result).toBe(false);
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

describe('what a mock run reaches (M92.8)', () => {
  const plan = (narrowing: string[] | null = null, askFirst = false) =>
    planApproval({
      kind: 'attended',
      shell: 'ask',
      web: 'on',
      askFirst,
      readScoped: false,
      narrowing: narrowing === null ? null : (tool) => narrowing.includes(tool),
    });

  function run(message: string, opts: Parameters<typeof runMockAgent>[2]) {
    const events: AgentStreamEvent[] = [];
    return new Promise<AgentStreamEvent[]>((resolve) => {
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

  it('says it right after its init, once, from the plan its calls decide through', async () => {
    const approval = plan();
    const events = await run('What is at risk right now?', { approval });
    expect(events.map((e) => e.kind).slice(0, 3)).toEqual(['Init', 'Reach', 'ModelChanged']);
    const reaches = events.filter((e) => e.kind === 'Reach');
    expect(reaches).toHaveLength(1);
    const [said] = reaches;
    if (said.kind !== 'Reach') throw new Error('a Reach');
    expect(said.reach).toMatchObject({
      connectors: [],
      missing: [],
      missing_more: 0,
      inherits: false,
      permission_mode: approval.permission_mode,
      cerebro: true,
    });
    // Each family's decisions once, as the plan decided its tools.
    for (const row of approval.decisions) {
      expect(said.reach.families[row.family], row.tool).toContain(row.decision);
    }
    const decided = Object.values(said.reach.families);
    expect(decided.every((words) => new Set(words).size === words.length)).toBe(true);
    expect(said.reach.families.shell).toEqual(['ask']);
    expect(said.reach.families.web).toEqual(['allow']);
    // Ask-first page writes ask, and say so.
    const asking = await run('What is at risk right now?', { approval: plan(null, true) });
    const reach = asking.find((e) => e.kind === 'Reach');
    expect(reach?.kind === 'Reach' && reach.reach.families.confirmable).toEqual(['ask']);
  });

  it('holds Cerebro’s tools unless its declared tools leave every one out', async () => {
    const said = async (allowedTools: string[] | null) => {
      const events = await run('hello', { approval: plan(allowedTools ?? null), allowedTools });
      const reach = events.find((e) => e.kind === 'Reach');
      if (reach?.kind !== 'Reach') throw new Error('a Reach');
      return reach.reach.cerebro;
    };
    expect(await said(null)).toBe(true);
    expect(await said(['get_note'])).toBe(true);
    expect(await said([])).toBe(false);
  });

  it('says nothing of its reach without a plan', async () => {
    const events = await run('What is at risk right now?', {});
    expect(events.some((e) => e.kind === 'Reach')).toBe(false);
  });

  it('says it after a failure script’s init too, as an admitted init does', async () => {
    const events = await run('fail: usage-limit', { approval: plan() });
    expect(events.map((e) => e.kind)).toEqual(['Init', 'Reach', 'Error', 'TurnEnded', 'Done']);
  });

  it('shows once on a re-attach, and never in the run’s transcript (CV-30)', async () => {
    const session = '00000000-0000-4000-8000-0000000092a8';
    const start = await runAgent('/demo-vault', {
      message: 'What is at risk right now?',
      sessionId: session,
      shell: 'off',
      connectors: false,
      attended: true,
    });
    if ('deferred' in start || 'settled' in start) throw new Error('an attended run starts');
    const live: AgentEvent[] = [];
    await new Promise<void>((resolve) => {
      const stop = onAgentEvent((event) => {
        live.push(event);
        if (event.kind === 'Done') {
          stop();
          resolve();
        }
      }, start.run);
    });
    const said = live.filter((e) => e.kind === 'Reach');
    expect(said).toHaveLength(1);
    expect(live[live.indexOf(said[0]) - 1].kind).toBe('Init');
    // From the start, the journal hands it over once; from its own seq, not
    // again.
    const replay = async (after: number) => {
      const seen: AgentEvent[] = [];
      const attached = await attachRun(start, after, (event) => seen.push(event));
      if (attached.state !== 'unknown') attached.detach();
      return seen.filter((e) => e.kind === 'Reach');
    };
    expect(await replay(0)).toEqual(said);
    expect(await replay(said[0].seq)).toEqual([]);
    const read = await readCliTranscript('/demo-vault', session, null);
    if (read.state !== 'read') throw new Error(`expected a read, got ${read.reason}`);
    expect(read.events.some((e) => e.kind === 'Reach')).toBe(false);
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

  // M57.7: the fetch script calls WebFetch, which the web ceiling decides.
  it('fetches a page under Web access On, and reads WebFetch as unavailable Off', async () => {
    const web = (kind: 'attended' | 'unattended', ceiling: 'off' | 'on') =>
      planApproval({ kind, shell: 'off', web: ceiling, readScoped: false, narrowing: null });
    for (const kind of ['attended', 'unattended'] as const) {
      const on = await run('fetch "https://example.com"', { approval: web(kind, 'on') });
      expect(on.find((e) => e.kind === 'ToolStart')).toMatchObject({ tool_name: 'WebFetch' });
      expect(doneOf(on)).toMatchObject({
        output: '(mock) The page at https://example.com says hello.',
      });
      expect(doneOf(on)?.is_error).toBeUndefined();
      expect(replyOf(on)).toBe('I fetched https://example.com.');
      const off = await run('fetch "https://example.com"', { approval: web(kind, 'off') });
      expect(doneOf(off)).toMatchObject({
        output: 'WebFetch is not available in this run.',
        is_error: true,
      });
      expect(replyOf(off)).toBe('WebFetch is not available in this run.');
    }
    // A plan with no web named reads off.
    const absent = await run('fetch "https://example.com"', { approval: plan('attended', 'on') });
    expect(doneOf(absent)?.is_error).toBe(true);
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
            const path = `${args.folder}/${args.slug}.md`;
            return { path, reply: `Created ${path}` };
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

  it('"if new" passes refuse, and replies with the tool text (M61.6b)', async () => {
    resetMockFs();
    const stamp = { actor: 'process:release-scout', runId: 'r' };
    const onCreate = (args: Parameters<typeof agentCreate>[1] & { if_exists?: string }) =>
      agentCreate('/demo-vault', args, stamp, args.if_exists ?? null);
    const message = 'create "Vendor delay" in records/risks if new';
    const first = (await run({ onCreate }, message)).events;
    const start = first.find(
      (e): e is Extract<AgentStreamEvent, { kind: 'ToolStart' }> => e.kind === 'ToolStart',
    );
    expect(JSON.parse(String(start?.input))).toEqual({ ...ARGS, if_exists: 'refuse' });
    expect(doneOf(first)).toMatchObject({ output: 'Created records/risks/vendor-delay.md' });
    expect(first).toContainEqual(
      expect.objectContaining({ kind: 'Text', text: 'Created records/risks/vendor-delay.md' }),
    );
    const second = (await run({ onCreate }, message)).events;
    const refusal =
      'note_exists: records/risks/vendor-delay.md already exists, so nothing was written. ' +
      'Read it and change it there, or call again with if_exists "suffix" for a numbered copy ' +
      'beside it.';
    expect(doneOf(second)).toMatchObject({ output: refusal, is_error: true });
    expect(second).toContainEqual(expect.objectContaining({ kind: 'Text', text: refusal }));
    // Without "if new", the same create numbers a copy, as before.
    const plain = (await run({ onCreate }, MESSAGE)).events;
    expect(String(doneOf(plain)?.output)).toMatch(
      /^Created records\/risks\/vendor-delay-2\.md \(records\/risks\/vendor-delay\.md was taken/,
    );
    resetMockFs();
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

it('suggests a checked view with a tool result and no UI action or write', async () => {
  const suggestion = {
    database: 'Work',
    view: { name: 'Board', presentation: { type: 'board', group: [{ field: 'status' }] } },
  };
  const output = JSON.stringify({
    suggested: suggestion,
    note: 'The user sees this view as a card with a live preview. Nothing is written unless they add it.',
  });
  const events: AgentStreamEvent[] = [],
    actions: UiAction[] = [];
  const onSuggestView = vi.fn(async () => output);
  await new Promise<void>((resolve) =>
    runMockAgent(
      'suggest view ' + JSON.stringify(suggestion),
      (event) => {
        events.push(event);
        if (event.kind === 'Done') resolve();
      },
      { delayMs: 0, onSuggestView, onUiAction: (action) => actions.push(action) },
    ),
  );
  expect(onSuggestView).toHaveBeenCalledWith(suggestion);
  expect(events).toContainEqual({ kind: 'ToolDone', tool_id: 't-1', output });
  expect(replyOf(events)).toBe('I suggested a view; it is on the card above.');
  expect(actions).toEqual([]);
});

it('reports a refused suggestion from its first problem and never claims a card', async () => {
  const events: AgentStreamEvent[] = [];
  await new Promise<void>((resolve) =>
    runMockAgent(
      'suggest view {}',
      (event) => {
        events.push(event);
        if (event.kind === 'Done') resolve();
      },
      {
        delayMs: 0,
        onSuggestView: async () =>
          'schema_invalid: this view of Work can\'t be shown, so no card was made.\n- presentation.group[0]: Work has no field "owenr". Did you mean "owner"?',
      },
    ),
  );
  expect(replyOf(events)).toBe(
    'I could not suggest that view: Work has no field "owenr". Did you mean "owner"?',
  );
  expect(events.find((event) => event.kind === 'ToolDone')).toMatchObject({ is_error: true });
  const missing = await drain('suggest view {}');
  expect(replyOf(missing.events)).toBe(
    'I could not suggest that view: suggest_view is not available here',
  );
  expect(missing.actions).toEqual([]);
});

describe('skill invocation dispatch', () => {
  const draftPrompt = (
    signature: string,
    request = 'https://mail.google.com/mail/u/0/#inbox/abc',
  ) =>
    `The user invoked the skill "Draft reply" (records/skills/draft-reply.md). Follow its instructions:\n## Signature\n\n\`\`\`text\n${signature}\n\`\`\`\n\nThe user's input for this run: ${request}`;
  it('leaves a signed plain-text draft with thread recipients and no vault action', async () => {
    const { events, actions } = await drain(draftPrompt('Thanks,\nAvery'));
    expect(toolNames(events)).toEqual(['mcp__gmail__get_thread', 'mcp__gmail__create_draft']);
    expect(JSON.parse(toolInputs(events)[0])).toEqual({
      threadId: 'abc',
      messageFormat: 'PLAIN_TEXT',
    });
    const input = JSON.parse(toolInputs(events)[1]);
    expect(input).toMatchObject({
      to: ['teammate@example.com'],
      subject: 'Re: Next steps',
      replyToMessageId: 'mock-newest-incoming',
    });
    expect(input.body).toMatch(/Thanks,\nAvery$/);
    expect(input).not.toHaveProperty('htmlBody');
    expect(input).not.toHaveProperty('bcc');
    expect(actions).toEqual([]);
    expect(replyOf(events)).toContain('https://mail.google.com/mail/u/0/#drafts/mock-draft');
    expect(replyOf(events)).toContain('Nothing was sent.');
  });
  it('omits an unedited signature and asks for a missing thread before any call', async () => {
    const placeholder = await drain(draftPrompt('YOUR SIGNATURE HERE'));
    expect(JSON.parse(toolInputs(placeholder.events)[1]).body).not.toContain('YOUR SIGNATURE');
    expect(replyOf(placeholder.events)).toContain('no signature');
    const missing = await drain(draftPrompt('Avery', ''));
    expect(toolNames(missing.events)).toEqual([]);
    expect(replyOf(missing.events)).toContain('Which Gmail thread');
  });
  it('reads a recipe that mentions the Inbox without proposing a filing', async () => {
    const { events, actions } = await drain(
      'The user invoked the skill "Catch me up" (records/skills/catch-me-up.md). Follow its instructions:\nRead the Inbox with list_inbox and read_activity.',
    );
    expect(actions).toEqual([]);
    expect(toolNames(events)).toEqual(expect.arrayContaining(['list_inbox', 'read_activity']));
    expect(toolNames(events)).not.toContain('propose_organize');
    expect(replyOf(events)).toContain('Catch me up');
  });
});

describe('follow-up booking script', () => {
  it('passes the exact quoted note and requested offset to its real handler', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const events: AgentStreamEvent[] = [];
    const onScheduleFollowup = vi.fn(async () => 'Booked a follow-up. Waiting now: 1 of 3.');
    runMockAgent(
      '@release-scout follow up "check [[reply]] <b>plain</b>" in 2 hours',
      (event) => events.push(event),
      { delayMs: 0, onScheduleFollowup },
    );
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    expect(onScheduleFollowup).toHaveBeenCalledWith({
      at: '2026-10-15T14:00:00.000Z',
      note: 'check [[reply]] <b>plain</b>',
    });
    expect(toolNames(events)).toEqual(['schedule_followup']);
    expect(replyOf(events)).toBe('Booked a follow-up. Waiting now: 1 of 3.');
  });
  it('never claims it booked a refused follow-up', async () => {
    const result = await drain('follow up "check later" in 1 minute');
    expect(result.events.find((event) => event.kind === 'ToolDone')).toMatchObject({
      is_error: true,
    });
    expect(replyOf(result.events)).toContain('I could not book that follow-up');
  });
});

describe('the canvas edit script', () => {
  const path = 'boards/risk.canvas';
  const ops = [{ op: 'update_node', id: 'goals', text: 'Organize the inbox' }];
  const gated = globalThis as { __cerebroAgentWriteGate?: Promise<void> };
  afterEach(() => {
    delete gated.__cerebroAgentWriteGate;
  });
  function edit(onEditCanvas?: NonNullable<Parameters<typeof runMockAgent>[2]>['onEditCanvas']) {
    const events: AgentStreamEvent[] = [],
      actions: UiAction[] = [];
    return new Promise<{ events: AgentStreamEvent[]; actions: UiAction[] }>((resolve) => {
      runMockAgent(
        `edit canvas ${path}: ${JSON.stringify(ops)}`,
        (event) => {
          events.push(event);
          if (event.kind === 'Done') resolve({ events, actions });
        },
        { delayMs: 0, onEditCanvas, onUiAction: (action) => actions.push(action) },
      );
    });
  }
  it('passes the raw operations through the write gate before announcing the board', async () => {
    let release = () => {};
    gated.__cerebroAgentWriteGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = vi.fn(async () => '{"wrote":true}');
    const result = edit(writer);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writer).not.toHaveBeenCalled();
    release();
    const { events, actions } = await result;
    expect(writer).toHaveBeenCalledWith(path, { ops });
    expect(toolNames(events)).toEqual(['edit_canvas']);
    expect(JSON.parse(toolInputs(events)[0])).toEqual({ path, ops });
    expect(actions).toEqual([{ action: 'vault_changed', paths: [path] }]);
    expect(replyOf(events)).toBe(`I edited the whiteboard ${path}.`);
  });
  it('reports the first refusal line, retaining the full error without announcing a change', async () => {
    const refusal = 'Op 1: no node with id "goals" on this board.\nNothing was written.';
    const { events, actions } = await edit(async () => {
      throw new Error(refusal);
    });
    expect(actions).toEqual([]);
    expect(events.find((event) => event.kind === 'ToolDone')).toMatchObject({
      is_error: true,
      output: refusal,
    });
    expect(replyOf(events)).toBe(
      `I could not edit the whiteboard ${path}: ${refusal.split('\n')[0]}`,
    );
  });
  it('never claims success when the canvas door is not held', async () => {
    const { events, actions } = await edit();
    expect(actions).toEqual([]);
    expect(replyOf(events)).toBe(
      `I could not edit the whiteboard ${path}: edit_canvas is not available here`,
    );
  });
});

describe('the Notion import script', () => {
  const page = '11111111111111111111111111111111';
  async function importPage(
    onImportNotion?: NonNullable<Parameters<typeof runMockAgent>[2]>['onImportNotion'],
  ) {
    const events: AgentStreamEvent[] = [];
    const actions: UiAction[] = [];
    await new Promise<void>((resolve) => {
      runMockAgent(
        `import notion ${page} to notion`,
        (event) => {
          events.push(event);
          if (event.kind === 'Done') resolve();
        },
        { delayMs: 0, onImportNotion, onUiAction: (action) => actions.push(action) },
      );
    });
    return { events, actions };
  }
  it('passes only the page identity and folder, and repeats the door’s honest outcome', async () => {
    const reply = 'Imported “Toy page” from Notion to notion/toy-page.md.';
    const write = vi.fn(async () => ({ path: 'notion/toy-page.md', reply, wrote: true }));
    const { events, actions } = await importPage(write);
    expect(write).toHaveBeenCalledWith({ page, folder: 'notion' });
    expect(toolNames(events)).toEqual(['import_notion_page']);
    expect(JSON.parse(toolInputs(events)[0])).toEqual({ page, folder: 'notion' });
    expect(replyOf(events)).toBe(reply);
    expect(actions).toEqual([{ action: 'vault_changed', paths: ['notion/toy-page.md'] }]);
  });
  it('an unchanged import announces no write and a refusal never claims success', async () => {
    const reply = 'notion/toy-page.md already holds this page, unchanged since its import.';
    const unchanged = await importPage(async () => ({
      path: 'notion/toy-page.md',
      reply,
      wrote: false,
    }));
    expect(unchanged.actions).toEqual([]);
    expect(replyOf(unchanged.events)).toBe(reply);
    const refused = await importPage(async () => {
      throw new Error('import_refused: database_first — Fetch one page. Nothing was written.');
    });
    expect(refused.actions).toEqual([]);
    expect(replyOf(refused.events)).toMatch(/^import_refused: database_first/);
    expect(refused.events.find((event) => event.kind === 'ToolDone')).toMatchObject({
      is_error: true,
    });
  });
});

describe('the canvas create script', () => {
  function create(
    onCreateCanvas?: NonNullable<Parameters<typeof runMockAgent>[2]>['onCreateCanvas'],
  ) {
    const events: AgentStreamEvent[] = [],
      actions: UiAction[] = [];
    return new Promise<{ events: AgentStreamEvent[]; actions: UiAction[] }>((resolve) =>
      runMockAgent(
        'create canvas plan in boards',
        (event) => {
          events.push(event);
          if (event.kind === 'Done') resolve({ events, actions });
        },
        { delayMs: 0, onCreateCanvas, onUiAction: (action) => actions.push(action) },
      ),
    );
  }
  it('announces the chosen name, including a suffix, only after the door lands', async () => {
    const writer = vi.fn(async () => ({
      path: 'boards/plan-2.canvas',
      reply: '{"path":"boards/plan-2.canvas"}',
    }));
    const { events, actions } = await create(writer);
    expect(writer).toHaveBeenCalledWith({ slug: 'plan', folder: 'boards' });
    expect(toolNames(events)).toEqual(['create_canvas']);
    expect(replyOf(events)).toBe('I created boards/plan-2.canvas.');
    expect(actions).toEqual([{ action: 'vault_changed', paths: ['boards/plan-2.canvas'] }]);
  });
  it('reports a refusal and makes no creation claim', async () => {
    const { events, actions } = await create(async () => {
      throw new Error('Op 1: bad.\nNothing was created.');
    });
    expect(actions).toEqual([]);
    expect(replyOf(events)).toBe('I could not create the whiteboard: Op 1: bad.');
    expect(events.find((event) => event.kind === 'ToolDone')).toMatchObject({ is_error: true });
  });
});

/**
 * The M91 scripts (M91.4): each emits only what Rust's fold emits, with the
 * fields its events carry, so the panel's reducer meets in the browser what
 * it meets from a real run. Rust's own vocabulary is read off the transcript
 * goldens fold.rs writes.
 */
describe('the M91 scripts (M91.4)', () => {
  const GOLDENS = join(__dirname, '../../conformance/transcript');
  const goldenEvents = readdirSync(GOLDENS)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const golden = JSON.parse(readFileSync(join(GOLDENS, name), 'utf8')) as {
        streams: { events: AgentStreamEvent[] }[];
        session: { events: AgentStreamEvent[] } | null;
      };
      return [...golden.streams.flatMap((s) => s.events), ...(golden.session?.events ?? [])];
    });
  /** Each kind Rust's goldens show, with every field they carry it with. */
  const RUST_FIELDS = new Map<string, Set<string>>();
  const RESULT_FIELDS = new Map<string, Set<string>>();
  for (const event of goldenEvents) {
    const fields = RUST_FIELDS.get(event.kind) ?? new Set<string>();
    for (const key of Object.keys(event)) fields.add(key);
    RUST_FIELDS.set(event.kind, fields);
    if (event.kind === 'ToolResult') {
      const data = RESULT_FIELDS.get(event.data.type) ?? new Set<string>();
      for (const key of Object.keys(event.data)) data.add(key);
      RESULT_FIELDS.set(event.data.type, data);
    }
  }
  /** What Rust's reader says that no fold golden holds: a run's end, a
   * stop's, and what the run reaches (M92.8). */
  const READER_KINDS = new Set(['Done', 'Cancelled', 'Changeset', 'Interaction', 'Reach']);

  const SCRIPTS = [
    'research the open risks with subagents',
    'think it through: which risk do I escalate?',
    'make a todo list for the risk review',
    'run the tests',
    'fail with a stack trace',
    'search the web for scanner lead times',
  ];

  const ofKind = <K extends AgentStreamEvent['kind']>(events: AgentStreamEvent[], kind: K) =>
    events.filter((e): e is Extract<AgentStreamEvent, { kind: K }> => e.kind === kind);

  /** A live turn reduced as the panel reduces it, in `session`. */
  const reduced = (
    events: AgentStreamEvent[],
    session = '00000000-0000-4000-8000-0000000091c1',
  ): ChatMessage => {
    let message: ChatMessage = { id: 'a', role: 'assistant', text: '', tools: [], streaming: true };
    for (const event of events) {
      message =
        event.kind === 'Done' ? endLiveTurn(message) : applyEvent(message, event, 'live', session);
    }
    return message;
  };

  it.each(SCRIPTS)('emits only what Rust emits, with its fields: %s', async (message) => {
    const { events } = await drain(message);
    for (const event of events) {
      if (READER_KINDS.has(event.kind)) continue;
      const fields = RUST_FIELDS.get(event.kind);
      expect(fields, event.kind).toBeDefined();
      for (const key of Object.keys(event))
        expect(fields?.has(key), `${event.kind}.${key}`).toBe(true);
      if (event.kind === 'ToolResult') {
        const data = RESULT_FIELDS.get(event.data.type);
        expect(data, event.data.type).toBeDefined();
        for (const key of Object.keys(event.data)) {
          expect(data?.has(key), `${event.data.type}.${key}`).toBe(true);
        }
      }
    }
    // The CLI's times on its lines, and a branch's anchor at the turn's end,
    // after its result, as Rust's fold ends a turn.
    for (const event of events) {
      if (['Thinking', 'ToolStart', 'ToolDone', 'Text'].includes(event.kind)) {
        expect((event as { at?: string }).at, event.kind).toMatch(/^\d{4}-\d\d-\d\dT/);
      }
    }
    expect(events.map((e) => e.kind).slice(-3)).toEqual(['Result', 'TurnEnded', 'Done']);
    expect(ofKind(events, 'TurnEnded')[0].last_uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // Reduced, it anchors and never reads interrupted.
    const reply = reduced(events);
    expect(reply.anchor?.uuid).toBe(ofKind(events, 'TurnEnded')[0].last_uuid);
    expect(reply.interrupted).toBeUndefined();
  });

  it.each(SCRIPTS)('counts on its result how long its run worked (M92.2): %s', async (message) => {
    const { events } = await drain(message);
    const [result] = ofKind(events, 'Result');
    const worked = result.duration_ms ?? Number.NaN;
    expect(Number.isSafeInteger(worked) && worked > 0).toBe(true);
    // On the run's own clock: from its start, before its first stamped line,
    // to its last.
    const times = events.flatMap((e) =>
      'at' in e && typeof e.at === 'string' ? [Date.parse(e.at)] : [],
    );
    expect(Math.max(...times) - worked).toBeLessThan(Math.min(...times));
    expect(reduced(events).workedMs).toBe(worked);
  });

  it('research with subagents: two researchers, their steps under each call, their reports', async () => {
    const { events } = await drain('research the open risks with subagents');
    const agents = ofKind(events, 'ToolStart').filter((e) => e.tool_name === 'Agent');
    expect(agents).toHaveLength(2);
    for (const agent of agents) {
      const input = JSON.parse(agent.input ?? '{}') as Record<string, string>;
      expect(input.subagent_type).toBe('cerebro-researcher');
      const started = ofKind(events, 'SubagentStarted').find((e) => e.tool_id === agent.tool_id);
      expect(started).toMatchObject({
        subagent_type: 'cerebro-researcher',
        description: input.description,
        background: false,
        depth: 1,
      });
      expect(ofKind(events, 'SubagentProgress').some((e) => e.tool_id === agent.tool_id)).toBe(
        true,
      );
      expect(ofKind(events, 'SubagentDone').find((e) => e.tool_id === agent.tool_id)).toMatchObject(
        { status: 'completed' },
      );
      const report = ofKind(events, 'ToolResult').find((e) => e.tool_id === agent.tool_id);
      expect(report?.data).toMatchObject({
        type: 'agent',
        agent_id: started?.agent_id,
        agent_type: 'cerebro-researcher',
        status: 'completed',
      });
      // Its steps name its call; the main thread's never do.
      expect(
        events.some(
          (e) => (e.kind === 'ToolStart' || e.kind === 'Text') && e.parent === agent.tool_id,
        ),
      ).toBe(true);
    }
    expect(agents.every((agent) => agent.parent === undefined)).toBe(true);
    // Its tokens never show, nor the trailer Claude Code writes for the model.
    const said = JSON.stringify(events);
    for (const leak of ['subagent_tokens', '<usage>', 'agentId:', 'total_tokens']) {
      expect(said).not.toContain(leak);
    }
    const reply = reduced(events);
    expect(reply.tools.map((t) => t.name)).toEqual(['Agent', 'Agent']);
    for (const agent of agents) {
      const run = findCall(reply.tools, agent.tool_id)?.subagent;
      expect(run?.status).toBe('done');
      expect(run?.summary).toBeTruthy();
      expect(run?.tools.length).toBeGreaterThan(0);
      expect(run?.parts.some((part) => part.kind === 'reasoning')).toBe(true);
      // Its time is the CLI's, never a guess.
      expect(run?.durationMs).toBeGreaterThan(0);
    }
    // The researchers' words are theirs; the reply is the main thread's.
    expect(reply.text).toBe(replyOf(events));
  });

  it('think it through: reasoning streamed, then settled once, and timed', async () => {
    const { events } = await drain('think it through: which risk do I escalate?');
    const thinking = ofKind(events, 'Thinking');
    expect(thinking).toHaveLength(2);
    expect(
      ofKind(events, 'ThinkingDelta')
        .map((e) => e.text)
        .join(''),
    ).toBe(thinking.map((e) => e.text).join(''));
    const reasoning = (reduced(events).parts ?? []).filter((part) => part.kind === 'reasoning');
    expect(reasoning.map((part) => part.kind === 'reasoning' && part.text)).toEqual(
      thinking.map((e) => e.text),
    );
    // The first block has no step before it to be timed from; the second is.
    expect(reasoning.map((part) => part.kind === 'reasoning' && part.durationMs)).toEqual([
      undefined,
      expect.any(Number),
    ]);
  });

  it('make a todo list: each item goes pending, in progress, completed', async () => {
    const { events } = await drain('make a todo list for the risk review');
    const lists = ofKind(events, 'ToolResult').flatMap((e) =>
      e.data.type === 'todos' ? [e.data.todos] : [],
    );
    expect(lists.length).toBeGreaterThanOrEqual(3);
    const order = ['pending', 'in_progress', 'completed'];
    for (let item = 0; item < lists[0].length; item++) {
      const seen = lists.map((todos) => order.indexOf(todos[item].status));
      expect(seen.every((rank) => rank >= 0)).toBe(true);
      expect([...seen].sort()).toEqual(seen);
      expect(seen.at(-1)).toBe(2);
    }
    expect(lists[0].some((todo) => todo.status === 'pending')).toBe(true);
    // Each result follows its TodoWrite's ToolDone, as the fold sends it.
    const kinds = events.map((e) => e.kind);
    for (const result of ofKind(events, 'ToolResult')) {
      const at = events.indexOf(result);
      expect(kinds[at - 1]).toBe('ToolDone');
    }
  });

  it('run the tests: a failed command whose output reads as one failing test', async () => {
    const { events } = await drain('run the tests');
    const bash = ofKind(events, 'ToolStart').find((e) => e.tool_name === 'Bash');
    expect(ofKind(events, 'ToolDone').find((e) => e.tool_id === bash?.tool_id)?.is_error).toBe(
      true,
    );
    const shell = ofKind(events, 'ToolResult').find((e) => e.tool_id === bash?.tool_id)?.data;
    if (shell?.type !== 'shell') throw new Error('no shell result');
    const report = testReportOf(shell);
    expect(report?.runner).toBe('vitest');
    expect(report?.totals).toMatchObject({ passed: 18, failed: 1, total: 19 });
    expect(report?.failures.map((f) => f.name)).toEqual([
      expect.stringContaining('flags a risk with no mitigation'),
    ]);
    expect(shell.stdout.length).toBeLessThanOrEqual(2000);
    expect(shell.stderr.length).toBeLessThanOrEqual(2000);
  });

  it('fail with a stack trace: Node’s trace, with a frame in a vault page', async () => {
    const { events } = await drain('fail with a stack trace');
    const result = ofKind(events, 'ToolResult')[0]?.data;
    if (result?.type !== 'shell') throw new Error('no shell result');
    expect(ofKind(events, 'ToolDone')[0].is_error).toBe(true);
    const trace = parseStackTrace(result.stderr);
    expect(trace?.language).toBe('javascript');
    expect(trace?.message).toContain('ReferenceError: owner is not defined');
    const relative = trace?.frames.filter((frame) => frame.origin === 'relative') ?? [];
    expect(relative.map((frame) => frame.file)).toContain('records/risks/risk-scanner-delivery.md');
    expect(trace?.frames.some((frame) => frame.origin === 'url')).toBe(true);
  });

  it('search the web: a search and a fetch, each with its result, cited in the reply', async () => {
    const { events } = await drain('search the web for scanner lead times');
    expect(toolNames(events)).toEqual(['WebSearch', 'WebFetch']);
    const [search, fetched] = ofKind(events, 'ToolResult').map((e) => e.data);
    if (search.type !== 'web_search' || fetched.type !== 'web_fetch') {
      throw new Error('expected a search, then a fetch');
    }
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results.every((r) => /^https:\/\//.test(r.url))).toBe(true);
    expect(fetched).toMatchObject({ url: search.results[0].url, code: 200 });
    expect(replyOf(events)).toContain(search.results[0].url);
  });

  it('decides each script’s calls by the run’s plan: Bash under Off is unavailable', async () => {
    const events: AgentStreamEvent[] = [];
    await new Promise<void>((resolve) => {
      runMockAgent(
        'run the tests',
        (event) => {
          events.push(event);
          if (event.kind === 'Done') resolve();
        },
        {
          delayMs: 0,
          approval: planApproval({
            kind: 'attended',
            shell: 'off',
            readScoped: false,
            narrowing: null,
          }),
        },
      );
    });
    expect(ofKind(events, 'ToolDone')[0]).toMatchObject({ is_error: true });
    expect(ofKind(events, 'ToolResult')).toEqual([]);
    expect(replyOf(events)).toBe('Bash is not available in this run.');
  });

  it('streams the default reply’s reasoning, then settles it once', async () => {
    const { events } = await drain('What does this vault hold?');
    const [thinking] = ofKind(events, 'Thinking');
    expect(thinking.text).toBe('Reading the vault context first.');
    expect(
      ofKind(events, 'ThinkingDelta')
        .map((e) => e.text)
        .join(''),
    ).toBe(thinking.text);
    expect(reduced(events).parts?.[0]).toEqual({
      kind: 'reasoning',
      id: 'reasoning-1',
      text: 'Reading the vault context first.',
    });
  });

  it('records a replay with the subagents’ steps and nothing only the stream says', async () => {
    const session = '00000000-0000-4000-8000-0000000091c2';
    let done: () => void = () => {};
    const finished = new Promise<void>((resolve) => (done = resolve));
    const live: AgentStreamEvent[] = [];
    const start = await runAgent('/demo-vault', {
      message: 'research the open risks with subagents',
      sessionId: session,
      shell: 'off',
      connectors: false,
      attended: true,
    });
    if ('deferred' in start || 'settled' in start) throw new Error('an attended run starts');
    const stop = onAgentEvent((event) => {
      live.push(event);
      if (event.kind === 'Done') done();
    }, start.run);
    await finished;
    stop();
    const read = await readCliTranscript('/demo-vault', session, null);
    if (read.state !== 'read') throw new Error(`expected a read, got ${read.reason}`);
    const kinds = new Set(read.events.map((e) => e.kind));
    for (const liveOnly of [
      'Init',
      'Reach',
      'TextDelta',
      'ThinkingDelta',
      'SubagentStarted',
      'SubagentProgress',
      'SubagentDone',
      'ToolDenied',
      'Result',
      'Changeset',
      'Done',
    ]) {
      expect(kinds.has(liveOnly as AgentStreamEvent['kind']), liveOnly).toBe(false);
    }
    expect(read.events.some((e) => e.kind === 'ToolStart' && e.parent !== undefined)).toBe(true);
    // Replayed, the reply is the live one's: its parts, its runs, its anchor.
    const replayed = replayTranscript(read.events, session).messages.at(-1);
    const watched = reduced(live, session);
    expect(replayed?.parts).toEqual(watched.parts);
    expect(replayed?.anchor).toEqual(watched.anchor);
    expect(replayed?.tools.map((t) => t.subagent?.summary)).toEqual(
      watched.tools.map((t) => t.subagent?.summary),
    );
  });
});
