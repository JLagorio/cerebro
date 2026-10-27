// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { accept, highlight } = vi.hoisted(() => ({
  accept: vi.fn(),
  highlight: vi.fn(async () => null),
}));
vi.mock('@/app/viewSuggestionActions', () => ({ acceptViewSuggestion: accept }));
vi.mock('@/views/ViewCanvas', () => ({ ViewCanvas: () => <span>preview</span> }));
vi.mock('@/workspace/highlighter', () => ({ highlight }));

import { Message } from './ChatTurn';
import { applyEvent, endLiveTurn, replayTranscript } from './transcript';
import type { AgentStreamEvent, ChatMessage, ToolCall } from './types';
import { STEP_STATUS_WORDS, formatDuration } from '@/components/ai/StepLine';
import type { RunChangeset } from '@/engine/changeset';
import { makeEntry } from '@/engine/testHelpers';
import { answerText, type ViewSuggestion } from '@/engine/viewSuggestion';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * A turn drawn with the AI elements (M91.13): its pieces in order, one chain
 * of thought that folds only reads and reasoning, every other call a line of
 * its own, a subagent's steps inside its line, and every state in words.
 */

const SESSION = '0f8fad5b-d9cb-469f-a165-70867728950e';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

/** The CLI's line times, a second apart from a fixed start. */
const at = (second: number) => new Date(Date.UTC(2026, 9, 22, 9, 0, second)).toISOString();

/** A reply as the reducer builds it from a live stream. */
function live(events: AgentStreamEvent[], streaming = true): ChatMessage {
  let message: ChatMessage = { id: 'reply', role: 'assistant', text: '', tools: [], streaming };
  for (const event of events) message = applyEvent(message, event, 'live', SESSION);
  return streaming ? message : endLiveTurn(message);
}

const call = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  output: string,
  second: number,
  extra: Partial<Extract<AgentStreamEvent, { kind: 'ToolDone' }>> = {},
): AgentStreamEvent[] => [
  { kind: 'ToolStart', tool_name: name, tool_id: id, input: JSON.stringify(input), at: at(second) },
  { kind: 'ToolDone', tool_id: id, output, is_error: false, at: at(second + 1), ...extra },
];

const handlers = () => ({
  onOpen: vi.fn(),
  onOpenPath: vi.fn(),
  onViewDiff: vi.fn(),
});

/** Is `el` out of sight: inside something hidden or inert. */
const hidden = (el: Element) => el.closest('[hidden], [inert]') !== null;

/** What an element says to a screen reader, roughly as its name reads: its
 * text, piece by piece, without what is hidden from it. */
function spoken(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  for (const quiet of copy.querySelectorAll('[aria-hidden="true"]')) quiet.remove();
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  const pieces: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    pieces.push(node.textContent ?? '');
  }
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}

const suggestion: ViewSuggestion = {
  database: 'Reading',
  view: {
    name: 'High ratings',
    filters: { all: [{ field: 'rating', op: 'gte', value: 4 }] },
    presentation: { type: 'table' },
  },
  reasoning: 'Keep the most useful books in view.',
};

beforeEach(() => {
  accept.mockReset().mockResolvedValue('high-ratings');
  highlight.mockClear();
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entriesVault: '/demo-vault',
    status: 'ready',
    entries: [
      makeEntry({ path: 'notes/plan.md', title: 'Plan' }),
      makeEntry({ path: 'notes/risks.md', title: 'Risks' }),
      makeEntry({
        path: 'types/reading.md',
        title: 'Reading',
        type: 'Type',
        properties: { fields: { rating: 'number' } },
      }),
      makeEntry({ path: 'books/a.md', title: 'Alpha', type: 'Reading', properties: { rating: 5 } }),
    ],
  });
  useNavStore.setState({ selection: { kind: 'home' } });
});
afterEach(cleanup);

describe('a reply in order', () => {
  it('says it is thinking until a piece comes, then keeps working dots under them', () => {
    const { rerender } = render(<Message message={live([])} {...handlers()} />);
    const reply = screen.getByTestId('chat-message');
    expect(reply.dataset.role).toBe('assistant');
    expect(within(reply).getByText('Thinking…')).toBeTruthy();
    rerender(
      <Message
        message={live([
          {
            kind: 'ToolStart',
            tool_name: 'mcp__cerebro__search_notes',
            tool_id: 't1',
            input: '{"query":"risk"}',
          },
        ])}
        {...handlers()}
      />,
    );
    expect(within(reply).queryByText('Thinking…')).toBeNull();
    expect(reply.querySelector('.cb-chat-dots')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws its words where they came, the last one its answer', () => {
    const message = live(
      [
        { kind: 'Text', message_id: 'm1', text: 'Reading the risks first.', at: at(0) },
        ...call('t1', 'mcp__cerebro__edit_note', { path: 'notes/plan.md' }, 'Edited.', 1),
        { kind: 'Text', message_id: 'm2', text: 'I edited the plan.', at: at(3) },
        { kind: 'TurnEnded', last_uuid: '4f0b3f0e-3d55-4d7e-9a3c-2d1f1b8c2b10' },
      ],
      false,
    );
    render(<Message message={message} {...handlers()} />);
    const reply = screen.getByTestId('chat-message');
    const words = [...reply.querySelectorAll('.cb-chat-narration, .cb-chat-answer')];
    expect(words.map((w) => [w.className, w.textContent])).toEqual([
      ['cb-chat-narration', 'Reading the risks first.'],
      ['cb-chat-answer', 'I edited the plan.'],
    ]);
    const write = within(reply).getByTestId('action-card');
    // Narration, the call, the answer: in the order they came.
    expect(words[0].compareDocumentPosition(write) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(write.compareDocumentPosition(words[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws a reply saved before M91.4 as it was: its calls, then its words', () => {
    const tool: ToolCall = {
      id: 'old',
      name: 'mcp__cerebro__search_notes',
      input: '{"query":"risk"}',
      output: 'Two risks.',
      done: true,
      failed: false,
    };
    render(
      <Message
        message={{ id: 'old-reply', role: 'assistant', text: 'Two risks are open.', tools: [tool] }}
        {...handlers()}
      />,
    );
    const reply = screen.getByTestId('chat-message');
    const card = within(reply).getByTestId('action-card');
    expect(card.textContent).toContain('search notes');
    const answer = reply.querySelector('.cb-chat-answer') as HTMLElement;
    expect(answer.textContent).toBe('Two risks are open.');
    expect(card.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('the chain of thought', () => {
  const turn = () =>
    [
      { kind: 'Thinking', message_id: 'm0', text: 'Read both, then fix the plan.', at: at(0) },
      ...call('r1', 'mcp__cerebro__get_note', { path: 'notes/plan.md' }, '# Plan', 1),
      { kind: 'Thinking', message_id: 'm1', text: 'Now the risks.', at: at(4) },
      ...call('r2', 'mcp__cerebro__get_note', { path: 'notes/risks.md' }, '# Risks', 5),
      ...call('w1', 'mcp__cerebro__append_to_note', { path: 'notes/plan.md' }, 'Appended.', 7),
      ...call('f1', 'mcp__cerebro__get_note', { path: 'notes/gone.md' }, 'No such note.', 9, {
        is_error: true,
      }),
      { kind: 'Text', message_id: 'm2', text: 'The plan names the risk now.', at: at(12) },
      { kind: 'TurnEnded', last_uuid: '4f0b3f0e-3d55-4d7e-9a3c-2d1f1b8c2b10' },
    ] as AgentStreamEvent[];
  const changeset: RunChangeset = {
    state: 'committed',
    run_id: 'run-1',
    commit: COMMIT,
    files: [
      {
        path: 'notes/plan.md',
        previous_path: null,
        kind: 'modified',
        additions: 1,
        deletions: 0,
        also_by: [],
      },
    ],
    additions: 1,
    deletions: 0,
    binary: 0,
    shell_unrecorded: false,
  };

  it('folds only reads and reasoning; after TurnEnded the write and the failure stand visible', () => {
    const message = { ...live(turn(), false), changesets: [changeset] };
    const on = handlers();
    render(<Message message={message} latest={false} {...on} />);
    const chain = screen.getByTestId('turn-chain');
    // Two reasoning lines and one folded run of reads inside; the write and
    // the failed read are lines of their own.
    expect(within(chain).getByTestId('action-group').dataset.count).toBe('2');
    expect(chain.querySelectorAll('[data-slot="reasoning"]')).toHaveLength(2);
    const write = document.querySelector('[data-tool="mcp__cerebro__append_to_note"]')!;
    const failed = document.querySelector('[data-testid="action-card"][data-status="failed"]')!;
    for (const row of [write, failed]) {
      expect(chain.contains(row)).toBe(false);
      expect(hidden(row)).toBe(false);
    }
    // It counts every step the turn took, and opens since one failed.
    const header = within(chain).getAllByRole('button')[0];
    expect(header.textContent).toBe('5 steps, 1 failed');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    // Closed by the reader, the write and the failure are still in view.
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(hidden(write)).toBe(false);
    expect(hidden(failed)).toBe(false);
    // The write's View diff opens the file at the run's commit.
    fireEvent.click(within(write as HTMLElement).getAllByRole('button')[0]);
    fireEvent.click(screen.getByTestId('action-view-diff'));
    expect(on.onViewDiff).toHaveBeenCalledWith('notes/plan.md', COMMIT);
  });

  it('starts open on the latest turn, closed in history, and the reader’s choice wins', () => {
    const quiet = live(
      [
        { kind: 'Thinking', message_id: 'm0', text: 'Look first.', at: at(0) },
        { kind: 'Text', message_id: 'm1', text: 'Done.', at: at(1) },
        { kind: 'TurnEnded' },
      ],
      false,
    );
    render(<Message message={quiet} latest {...handlers()} />);
    const header = () => within(screen.getByTestId('turn-chain')).getAllByRole('button')[0];
    expect(header().getAttribute('aria-expanded')).toBe('true');
    cleanup();
    const { rerender } = render(<Message message={quiet} latest={false} {...handlers()} />);
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(hidden(document.querySelector('[data-slot="reasoning"]')!)).toBe(true);
    fireEvent.click(header());
    expect(header().getAttribute('aria-expanded')).toBe('true');
    rerender(<Message message={quiet} latest={false} {...handlers()} />);
    expect(header().getAttribute('aria-expanded')).toBe('true');
  });

  it('draws no chain and no line for thinking with no words', () => {
    render(
      <Message
        message={live(
          [
            { kind: 'Thinking', message_id: 'm0', text: '', at: at(0) },
            { kind: 'Text', message_id: 'm1', text: 'Done.', at: at(1) },
            { kind: 'TurnEnded' },
          ],
          false,
        )}
        {...handlers()}
      />,
    );
    expect(screen.queryByTestId('turn-chain')).toBeNull();
    expect(document.querySelector('[data-slot="reasoning"]')).toBeNull();
  });

  it('says how long reasoning took only when both its times were recorded', () => {
    const message: ChatMessage = {
      id: 'timed',
      role: 'assistant',
      text: '',
      tools: [],
      parts: [
        { kind: 'reasoning', id: 'reasoning-1', text: 'Untimed.' },
        { kind: 'reasoning', id: 'reasoning-2', text: 'Timed.', durationMs: 2400 },
      ],
    };
    render(<Message message={message} latest {...handlers()} />);
    const lines = [
      ...document.querySelectorAll('[data-slot="reasoning"] [data-slot="trace-title"]'),
    ];
    expect(lines.map((line) => line.textContent)).toEqual(['Thought', 'Thought for 2.4s']);
  });
});

describe('how long a turn worked (M92.2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A turn at work with a call on screen, `over` as useAgentChat stamps it. */
  const working = (over: Partial<ChatMessage> = {}): ChatMessage => ({
    ...live([
      {
        kind: 'ToolStart',
        tool_name: 'mcp__cerebro__search_notes',
        tool_id: 't1',
        input: '{"query":"risk"}',
        at: at(0),
      },
    ]),
    ...over,
  });
  const line = () => screen.getByTestId('turn-working');
  const tick = (ms: number) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  const chainHeader = () =>
    within(screen.getByTestId('turn-chain')).getAllByRole('button')[0].textContent ?? '';
  /** The seconds a line's "for 1m 5s" says. */
  const seconds = (text: string): number => {
    const figure = /for (?:(\d+)m )?(\d+(?:\.\d+)?)s/.exec(text);
    return figure === null ? Number.NaN : Number(figure[1] ?? 0) * 60 + Number(figure[2]);
  };

  it('ticks from the run’s Init by whole seconds, hidden from assistive tech', () => {
    vi.useFakeTimers();
    const on = handlers();
    const { rerender } = render(<Message message={working()} {...on} />);
    // Sent, and its run not begun: no figure.
    expect(line().textContent).toBe('Working…');
    // Its Init reached the reply: a run's first event, so the cursor is 1.
    rerender(<Message message={working({ seq: 1 })} {...on} />);
    expect(line().textContent).toBe('Working…');
    tick(1_000);
    expect(line().textContent).toBe('Working for 1s');
    tick(64_400);
    expect(line().textContent).toBe('Working for 1m 5s');
    // Later events move the cursor on, never the clock.
    rerender(<Message message={working({ seq: 7 })} {...on} />);
    expect(line().textContent).toBe('Working for 1m 5s');
    // Decoration: hidden, in no live region of its own, so the reply says
    // to a screen reader just what it said before.
    expect(line().getAttribute('aria-hidden')).toBe('true');
    expect(line().matches('[role="status"], [aria-live]')).toBe(false);
    expect(line().querySelector('[role="status"], [aria-live]')).toBeNull();
    expect(line().querySelector('.cb-chat-dots')).not.toBeNull();
    expect(spoken(screen.getByTestId('chat-message'))).not.toMatch(/Working/);
  });

  it('with no start, a re-attach’s or a reload’s, reads Working… and never 0s', () => {
    vi.useFakeTimers();
    const on = handlers();
    // Restored mid-turn: its cursor already past the run's Init.
    const { rerender } = render(<Message message={working({ seq: 15 })} {...on} />);
    expect(line().textContent).toBe('Working…');
    tick(30_000);
    rerender(<Message message={working({ seq: 16 })} {...on} />);
    tick(5_000);
    expect(line().textContent).toBe('Working…');
    expect(line().textContent).not.toMatch(/\d/);
  });

  it('while a card waits reads its words with no figure, and the clock counts on under it', () => {
    vi.useFakeTimers();
    const on = handlers();
    const { rerender } = render(<Message message={working()} {...on} />);
    rerender(<Message message={working({ seq: 1 })} {...on} />);
    tick(4_000);
    expect(line().textContent).toBe('Working for 4s');
    // A live ask: the run waits on the person, and Claude Code's own count
    // takes the wait in (P14).
    rerender(<Message message={working({ seq: 2 })} waitingToolId="t1" {...on} />);
    expect(line().textContent).toBe(STEP_STATUS_WORDS.waiting);
    expect(line().querySelector('.cb-chat-dots')).toBeNull();
    tick(8_000);
    expect(line().textContent).toBe(STEP_STATUS_WORDS.waiting);
    rerender(<Message message={working({ seq: 3 })} waitingToolId={null} {...on} />);
    expect(line().textContent).toBe('Working for 12s');
  });

  it('stops for a held call, and the run an answer resumes counts from its own Init', () => {
    vi.useFakeTimers();
    const on = handlers();
    let message = working({ seq: 1 });
    const { rerender } = render(<Message message={working()} {...on} />);
    rerender(<Message message={message} {...on} />);
    tick(3_000);
    expect(line().textContent).toBe('Working for 3s');
    // The gate held the call: its card waits, and the run's Done stops the
    // reply, whose line still says what it waits on.
    message = endLiveTurn(
      applyEvent(
        message,
        {
          kind: 'ToolDeferred',
          tool_id: 't1',
          tool_name: 'mcp__cerebro__search_notes',
          duration_ms: 3_000,
        },
        'live',
      ),
    );
    rerender(<Message message={{ ...message, seq: 4 }} waitingToolId="t1" {...on} />);
    expect(line().textContent).toBe(STEP_STATUS_WORDS.waiting);
    // The person takes a minute, which no run counts.
    tick(60_000);
    // The answer resumes it: streaming again with a fresh cursor, then the
    // new run's Init and the held call's result its stream opens with.
    const { seq: _cursor, ...answered } = message;
    rerender(<Message message={{ ...answered, streaming: true }} {...on} />);
    expect(line().textContent).toBe('Working…');
    rerender(<Message message={{ ...answered, streaming: true, seq: 1 }} {...on} />);
    const ran = applyEvent(answered, { kind: 'ToolDone', tool_id: 't1', output: 'Two.' }, 'live');
    rerender(<Message message={{ ...ran, streaming: true, seq: 2 }} {...on} />);
    tick(2_000);
    expect(line().textContent).toBe('Working for 2s');
  });

  it('says how long it worked once the turn settles, and only when every run counted', () => {
    const turn: AgentStreamEvent[] = [
      { kind: 'Thinking', message_id: 'm0', text: 'Look first.', at: at(0) },
      ...call('r1', 'mcp__cerebro__get_note', { path: 'notes/plan.md' }, '# Plan', 1),
      { kind: 'Text', message_id: 'm1', text: 'Done.', at: at(3) },
    ];
    const ended: AgentStreamEvent[] = [
      { kind: 'Result', text: 'Done.', duration_ms: 252_000 },
      { kind: 'TurnEnded' },
    ];
    const show = (message: ChatMessage, waitingToolId: string | null = null) => {
      cleanup();
      render(
        <Message message={message} latest={false} waitingToolId={waitingToolId} {...handlers()} />,
      );
      return chainHeader();
    };
    const steps = show(live([...turn, { kind: 'TurnEnded' }], false));
    expect(steps).toMatch(/^\d+ steps?$/);
    // Counted: the time first, by the one formatter, then the counts.
    const settled = live([...turn, ...ended], false);
    expect(settled.workedMs).toBe(252_000);
    expect(show(settled)).toBe(`Worked for ${formatDuration(252_000)} · ${steps}`);
    expect(show(settled)).toBe(`Worked for 4m 12s · ${steps}`);
    expect(screen.queryByTestId('turn-working')).toBeNull();
    // Not while it streams, nor while a card waits on it.
    expect(show(live([...turn, ...ended]))).toBe(steps);
    expect(show(settled, 'r1')).toBe(steps);
    // Nobody counted, or one run did not: today's line.
    expect(show({ ...settled, workedMs: undefined })).toBe(steps);
    expect(show({ ...settled, workedMs: null })).toBe(steps);
    // Read back from the session file, which counts nothing.
    const { messages } = replayTranscript(
      [{ kind: 'UserPrompt', text: 'Look' }, ...turn, { kind: 'TurnEnded' }],
      SESSION,
    );
    expect(show(messages[1])).toBe(steps);
  });

  it('settles never below the last figure the line showed, both counted from Init', () => {
    vi.useFakeTimers();
    const on = handlers();
    const sent = live([
      { kind: 'Thinking', message_id: 'm0', text: 'Look first.', at: at(0) },
      ...call('r1', 'mcp__cerebro__get_note', { path: 'notes/plan.md' }, '# Plan', 1),
    ]);
    let message: ChatMessage = { ...sent, seq: 1 };
    const { rerender } = render(<Message message={sent} latest {...on} />);
    rerender(<Message message={message} latest {...on} />);
    tick(12_600);
    const last = line().textContent ?? '';
    expect(last).toBe('Working for 12s');
    // Claude Code counts from its own start, which came before the Init
    // this clock started at, and the turn ends.
    for (const event of [
      { kind: 'Text', message_id: 'm1', text: 'Done.', at: at(12) },
      { kind: 'Result', text: 'Done.', duration_ms: 12_600 },
      { kind: 'TurnEnded' },
    ] as AgentStreamEvent[]) {
      message = applyEvent(message, event, 'live', SESSION);
    }
    rerender(<Message message={{ ...message, seq: 6 }} latest {...on} />);
    // The run commits before its Done, and the clock has stopped.
    tick(3_000);
    expect(line().textContent).toBe(last);
    message = endLiveTurn(
      applyEvent(
        message,
        {
          kind: 'Changeset',
          changeset: { state: 'nothing', run_id: 'r', shell_unrecorded: false },
        },
        'live',
      ),
    );
    rerender(<Message message={message} latest {...on} />);
    expect(screen.queryByTestId('turn-working')).toBeNull();
    const settled = chainHeader();
    expect(settled).toMatch(/^Worked for 13s · /);
    expect(seconds(settled)).toBeGreaterThanOrEqual(seconds(last));
  });
});

describe('a subagent', () => {
  const agentInput = {
    description: 'Read the open risks',
    subagent_type: 'cerebro-researcher',
    prompt: 'Read the open risks and say which matters most.',
  };
  const start: AgentStreamEvent[] = [
    {
      kind: 'ToolStart',
      tool_name: 'Agent',
      tool_id: 'agent-1',
      input: JSON.stringify(agentInput),
      at: at(0),
    },
  ];
  const inner: AgentStreamEvent[] = [
    { kind: 'Thinking', message_id: 's0', text: 'Find them first.', parent: 'agent-1', at: at(1) },
    {
      kind: 'ToolStart',
      tool_name: 'mcp__cerebro__search_notes',
      tool_id: 'sub-1',
      input: '{"query":"risk"}',
      parent: 'agent-1',
      at: at(2),
    },
  ];
  const finish: AgentStreamEvent[] = [
    { kind: 'ToolDone', tool_id: 'sub-1', output: 'Five risks.', parent: 'agent-1', at: at(3) },
    {
      kind: 'Text',
      message_id: 's1',
      text: 'Scanner delivery matters most.',
      parent: 'agent-1',
      at: at(4),
    },
    { kind: 'ToolDone', tool_id: 'agent-1', output: 'Scanner delivery matters most.', at: at(5) },
    {
      kind: 'ToolResult',
      tool_id: 'agent-1',
      data: {
        type: 'agent',
        agent_id: 'a0000000000000001',
        agent_type: 'cerebro-researcher',
        status: 'completed',
        tool_uses: 1,
        duration_ms: 5000,
        summary: 'Scanner delivery matters most.',
      },
    },
    { kind: 'Text', message_id: 'm1', text: 'Scanner delivery is the one.', at: at(6) },
    { kind: 'TurnEnded', last_uuid: '4f0b3f0e-3d55-4d7e-9a3c-2d1f1b8c2b10' },
  ];

  it('runs open, its own steps drawn inside it as they come', () => {
    render(
      <Message
        message={live([
          ...start,
          {
            kind: 'SubagentStarted',
            tool_id: 'agent-1',
            agent_id: 'a0000000000000001',
            subagent_type: 'cerebro-researcher',
            description: 'Read the open risks',
            background: false,
            depth: 1,
          },
          {
            kind: 'SubagentProgress',
            tool_id: 'agent-1',
            description: 'Searching for open risks',
            last_tool: 'mcp__cerebro__search_notes',
            tool_uses: 1,
          },
          ...inner,
        ])}
        {...handlers()}
      />,
    );
    const row = document.querySelector('[data-slot="subagent"]') as HTMLElement;
    expect(row.dataset.testid).toBe('action-card');
    expect(row.dataset.renderer).toBe('subagent');
    const trigger = within(row).getAllByRole('button')[0];
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(spoken(trigger)).toBe(
      'Running: Read the open risks by the cerebro-researcher 1 tool use Searching for open risks',
    );
    const steps = row.querySelector('[data-slot="subagent-steps"]') as HTMLElement;
    expect(hidden(steps)).toBe(false);
    // Its reasoning came whole, timed from its call's start (M91.4).
    expect(steps.querySelector('[data-slot="reasoning"]')?.textContent).toBe('Thought for 1s');
    const search = within(steps).getByTestId('action-card');
    expect(search.dataset.status).toBe('running');
    expect(spoken(search)).toMatch(/^Running: search notes/);
  });

  it('read back from the session file, keeps its steps and its report, never its tokens', () => {
    const { messages } = replayTranscript(
      [{ kind: 'UserPrompt', text: 'Research it' }, ...start, ...inner, ...finish],
      SESSION,
    );
    render(<Message message={messages[1]} latest={false} {...handlers()} />);
    const row = document.querySelector('[data-slot="subagent"]') as HTMLElement;
    const trigger = within(row).getAllByRole('button')[0];
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(spoken(trigger)).toBe(
      'Done: Read the open risks by the cerebro-researcher 1 tool use · 5s',
    );
    // Folded, its steps stay in the document; its report is said once.
    expect(within(row).getAllByTestId('action-card')).toHaveLength(1);
    fireEvent.click(trigger);
    expect(row.querySelector('[data-slot="subagent-result"]')?.textContent).toBe(
      'Scanner delivery matters most.',
    );
    expect(row.querySelector('[data-slot="step-text"]')).toBeNull();
    expect(row.querySelector('[data-slot="subagent-no-steps"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/token/i);
  });

  it('says its steps were not recorded when the file kept none', () => {
    const { messages } = replayTranscript(
      [{ kind: 'UserPrompt', text: 'Research it' }, ...start, ...finish.slice(2)],
      SESSION,
    );
    render(<Message message={messages[1]} latest={false} {...handlers()} />);
    const row = document.querySelector('[data-slot="subagent"]') as HTMLElement;
    fireEvent.click(within(row).getAllByRole('button')[0]);
    expect(row.querySelector('[data-slot="subagent-no-steps"]')?.textContent).toBe(
      'Steps not recorded',
    );
  });

  it('a call Claude Code refused says Denied, never Failed, and why; a nameless kind is no badge', () => {
    const message = live(
      [
        {
          kind: 'ToolStart',
          tool_name: 'Agent',
          tool_id: 'agent-1',
          input: JSON.stringify({ description: 'Read the open risks', prompt: 'x' }),
          at: at(0),
        },
        {
          kind: 'ToolDenied',
          tool_id: 'agent-1',
          tool_name: 'Agent',
          message: "Permission to use Agent has been denied by permission rule 'Agent'.",
        },
        { kind: 'ToolDone', tool_id: 'agent-1', output: 'denied', is_error: true, at: at(1) },
        { kind: 'TurnEnded' },
      ],
      false,
    );
    expect(message.tools[0].subagent?.status).toBe('failed');
    render(<Message message={message} {...handlers()} />);
    const row = document.querySelector('[data-slot="subagent"]') as HTMLElement;
    const trigger = within(row).getAllByRole('button')[0];
    expect(spoken(trigger)).toBe('Denied: Read the open risks');
    expect(spoken(row)).not.toMatch(/Failed/);
    expect(row.querySelector('[data-slot="subagent-type"]')).toBeNull();
    expect(row.querySelector('[data-slot="subagent-error"]')?.textContent).toContain(
      'has been denied',
    );
  });

  it('shows the words its own failure ended on', () => {
    const message = live(
      [
        ...start,
        {
          kind: 'Error',
          message: 'API Error: 529 overloaded',
          parent: 'agent-1',
        },
        { kind: 'ToolDone', tool_id: 'agent-1', output: 'failed', is_error: true, at: at(1) },
        { kind: 'TurnEnded' },
      ],
      false,
    );
    render(<Message message={message} {...handlers()} />);
    const row = document.querySelector('[data-slot="subagent"]') as HTMLElement;
    expect(spoken(within(row).getAllByRole('button')[0])).toMatch(/^Failed: Read the open risks/);
    expect(row.querySelector('[data-slot="subagent-error"]')?.textContent).toBe(
      'API Error: 529 overloaded',
    );
    // The turn's own bubble never says a subagent's failure.
    expect(screen.queryByTestId('turn-error')).toBeNull();
  });
});

describe('what a step says', () => {
  const tool = (id: string, over: Partial<ToolCall> = {}): ToolCall => ({
    id,
    name: 'mcp__cerebro__append_to_note',
    input: JSON.stringify({ path: `notes/${id}.md` }),
    output: 'Appended.',
    done: true,
    failed: false,
    ...over,
  });

  it('says every status in words, in what a screen reader hears', () => {
    const working: ChatMessage = {
      id: 'working',
      role: 'assistant',
      text: '',
      streaming: true,
      tools: [
        tool('running', { done: false, output: null }),
        tool('done'),
        tool('failed', { failed: true, output: 'No such note.' }),
        tool('waiting', { done: false, output: null, deferred: true }),
        tool('denied', { failed: true, output: 'x', denied: 'Denied by a rule.' }),
        {
          id: 'search',
          name: 'mcp__cerebro__search_notes',
          input: '{"query":"risk"}',
          output: null,
          done: false,
          failed: false,
        },
      ],
    };
    const stopped: ChatMessage = {
      id: 'stopped',
      role: 'assistant',
      text: '',
      tools: [
        tool('interrupted', { done: false, output: null }),
        tool('cancelled', { done: false, output: null, deferred: true, cancelled: true }),
        tool('not_run', { done: false, output: null, deferred: true }),
        tool('paused', { done: false, output: null, deferred: true, paused: true }),
      ],
    };
    render(
      <>
        <Message message={working} waitingToolId="waiting" {...handlers()} />
        <Message message={stopped} {...handlers()} />
      </>,
    );
    const card = (path: string) =>
      [...document.querySelectorAll('[data-testid="action-card"]')].find((c) =>
        c.textContent?.includes(`notes/${path}.md`),
      ) as HTMLElement;
    const words = (path: string) => spoken(card(path).querySelector('[data-slot="trace-line"]')!);
    expect(words('running')).toBe('Appending to a note notes/running.md');
    expect(words('done')).toBe('Appended to a note notes/done.md');
    expect(words('failed')).toBe('Failed to append to a note notes/failed.md');
    expect(words('denied')).toBe('Denied: append to note notes/denied.md');
    expect(words('waiting')).toBe(`${STEP_STATUS_WORDS.waiting}: append to note notes/waiting.md`);
    for (const state of ['interrupted', 'cancelled', 'not_run', 'paused'] as const) {
      expect(words(state)).toBe(`${STEP_STATUS_WORDS[state]}: append to note notes/${state}.md`);
    }
    // A row with no phrases of its own says its state before its name.
    expect(spoken(document.querySelector('[data-tool="mcp__cerebro__search_notes"]')!)).toMatch(
      /^Running: search notes/,
    );
    // Every line with a status says it in words.
    for (const line of document.querySelectorAll('[data-slot="trace-line"][data-status]')) {
      const text = spoken(line);
      const status = line.getAttribute('data-status');
      if (status === 'running') expect(text).toMatch(/^(Running: |[A-Z][a-z]+ing )/);
      if (status === 'error') expect(text).toMatch(/^(Failed|Denied)/);
      if (status === 'pending') {
        expect(
          ['waiting', 'cancelled', 'not_run', 'paused'].some((s) =>
            text.startsWith(STEP_STATUS_WORDS[s as 'waiting'] as string),
          ),
        ).toBe(true);
      }
    }
  });

  it('draws a command’s output, its test run as a report, and a failed one’s stack', () => {
    const shell = (stdout: string, stderr = '') => ({
      type: 'shell' as const,
      stdout,
      stderr,
      interrupted: false,
      truncated: false,
    });
    const message: ChatMessage = {
      id: 'shell',
      role: 'assistant',
      text: '',
      tools: [
        {
          id: 'ls',
          name: 'Bash',
          input: JSON.stringify({ command: 'ls notes' }),
          output: 'plan.md',
          done: true,
          failed: false,
          result: shell('plan.md'),
          startedAt: at(0),
          endedAt: at(2),
        },
        {
          id: 'tests',
          name: 'Bash',
          input: JSON.stringify({ command: 'pnpm vitest run' }),
          output: 'x',
          done: true,
          failed: true,
          result: shell(
            [
              ' ✓ src/a.test.ts (3 tests) 4ms',
              ' ❯ src/b.test.ts (2 tests | 1 failed) 5ms',
              '',
              ' Test Files  1 failed | 1 passed (2)',
              '      Tests  1 failed | 4 passed (5)',
              '   Duration  1.20s',
            ].join('\n'),
          ),
        },
        {
          id: 'render',
          name: 'Bash',
          input: JSON.stringify({ command: 'node render.mjs' }),
          output: 'x',
          done: true,
          failed: true,
          result: shell(
            '',
            [
              'TypeError: owner is not defined',
              '    at render (notes/plan.md:6:9)',
              '    at main (file:///vault/render.mjs:34:3)',
            ].join('\n'),
          ),
        },
      ],
    };
    const on = handlers();
    render(<Message message={message} {...on} />);
    const ls = document.querySelector('[data-slot="terminal"]') as HTMLElement;
    expect(ls.dataset.testid).toBe('action-card');
    expect(spoken(within(ls).getAllByRole('button')[0])).toBe('Ran a command ls notes 2s');
    const report = document.querySelector('[data-slot="test-results"]') as HTMLElement;
    expect(report.dataset.testid).toBe('action-card');
    expect(report.textContent).toContain('Ran 5 tests, 1 failed');
    const trace = document.querySelector('[data-slot="stack-trace"]') as HTMLElement;
    expect(hidden(trace)).toBe(false);
    expect(trace.textContent).toContain('Stack trace');
    // A frame in this vault is a button that opens its page; the URL one is text.
    fireEvent.click(within(trace).getAllByRole('button')[0]);
    fireEvent.click(within(trace).getByRole('button', { name: /notes\/plan\.md:6/ }));
    expect(on.onOpenPath).toHaveBeenCalledWith('notes/plan.md');
    expect(within(trace).queryByRole('button', { name: /render\.mjs/ })).toBeNull();
  });

  it('draws the plan a todo list call left, and a hand-off with the run it started', () => {
    const navigate = vi.fn();
    useNavStore.setState({ navigate } as never);
    const message: ChatMessage = {
      id: 'plan',
      role: 'assistant',
      text: '',
      tools: [
        {
          id: 'todo',
          name: 'TodoWrite',
          input: JSON.stringify({
            todos: [
              { content: 'Find the risks', status: 'completed', activeForm: 'Finding the risks' },
              { content: 'Weigh them', status: 'in_progress', activeForm: 'Weighing them' },
            ],
          }),
          output: 'ok',
          done: true,
          failed: false,
        },
        {
          id: 'hand',
          name: 'mcp__cerebro__hand_to',
          input: JSON.stringify({ agent: 'release-scout', message: 'Go.' }),
          output:
            'Started Release scout (run 7e1c2a90e3b14c1c9d2f6a1b5e4d3c21) with what you handed it.',
          done: true,
          failed: false,
        },
      ],
    };
    render(<Message message={message} {...handlers()} />);
    const plan = document.querySelector('[data-slot="plan"]') as HTMLElement;
    expect(plan.dataset.testid).toBe('action-card');
    expect(plan.dataset.renderer).toBe('todo');
    expect(plan.textContent).toContain('1 of 2 done');
    const handoff = document.querySelector('[data-slot="subagent-handoff"]') as HTMLElement;
    expect(handoff.dataset.testid).toBe('action-card');
    fireEvent.click(within(handoff).getByRole('button', { name: /Handed to release-scout/ }));
    expect(navigate).toHaveBeenCalledWith({
      kind: 'knowledge',
      nav: { tab: 'runs', run: '7e1c2a90e3b14c1c9d2f6a1b5e4d3c21' },
    });
  });

  it('keeps a suggested view clickable as a line of its own', () => {
    const message: ChatMessage = {
      id: 'view',
      role: 'assistant',
      text: 'I suggested a view.',
      tools: [
        {
          id: 'suggest-1',
          name: 'mcp__cerebro__suggest_view',
          input: '{}',
          output: answerText(suggestion),
          done: true,
          failed: false,
        },
      ],
    };
    render(<Message message={message} latest={false} {...handlers()} />);
    const card = screen.getByTestId('view-suggestion-card');
    expect(hidden(card)).toBe(false);
    expect(screen.queryByTestId('turn-chain')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Add as a tab' }));
    expect(accept).toHaveBeenCalledOnce();
  });
});

describe('what a reply drew on', () => {
  it('lists its sources under the answer once done, and links only http(s) (CV-16)', () => {
    const results = [
      { title: 'Scanner lead times', url: 'https://example.com/lead-times' },
      { title: 'Cutover guide', url: 'https://example.org/cutover' },
    ];
    const message: ChatMessage = {
      id: 'sources',
      role: 'assistant',
      text: 'Scanners ship in 10 weeks ([source](https://example.com/lead-times)); mail [ops](mailto:ops@example.com). See [[plan]].',
      tools: [
        {
          id: 'web',
          name: 'WebSearch',
          input: JSON.stringify({ query: 'scanner lead times' }),
          output: 'results',
          done: true,
          failed: false,
          result: { type: 'web_search', query: 'scanner lead times', results },
        },
        {
          id: 'read',
          name: 'mcp__cerebro__get_note',
          input: JSON.stringify({ path: 'notes/plan.md' }),
          output: '# Plan',
          done: true,
          failed: false,
        },
      ],
    };
    const on = handlers();
    render(<Message message={message} {...on} />);
    const sources = screen.getByTestId('turn-sources');
    expect(sources.textContent).toContain('Used 3 sources');
    fireEvent.click(within(sources).getAllByRole('button')[0]);
    const listed = [...sources.querySelectorAll('[data-slot="source"]')];
    expect(listed.map((s) => s.textContent?.replace(/ \(opens in a new tab\)/, ''))).toEqual([
      'Scanner lead timesexample.com',
      'Cutover guideexample.org',
      'Open Plan',
    ]);
    fireEvent.click(within(sources).getByRole('button', { name: 'Open Plan' }));
    expect(on.onOpenPath).toHaveBeenCalledWith('notes/plan.md');
    for (const anchor of document.querySelectorAll('a[href]')) {
      expect(anchor.getAttribute('href')).toMatch(/^https?:\/\//);
    }
  });

  it('lists none while the turn streams', () => {
    render(
      <Message
        message={{
          id: 'streaming',
          role: 'assistant',
          text: 'See [a](https://example.com/a)',
          tools: [],
          streaming: true,
        }}
        {...handlers()}
      />,
    );
    expect(screen.queryByTestId('turn-sources')).toBeNull();
  });
});

describe('keys and failures', () => {
  it('adds no window or document keydown listener (CV-47)', () => {
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const documentAdd = vi.spyOn(document, 'addEventListener');
    const message = live(
      [
        { kind: 'Thinking', message_id: 'm0', text: 'Look.', at: at(0) },
        ...call('r1', 'mcp__cerebro__get_note', { path: 'notes/plan.md' }, '# Plan', 1),
        ...call('r2', 'mcp__cerebro__get_note', { path: 'notes/risks.md' }, '# Risks', 3),
        { kind: 'Text', message_id: 'm1', text: '```ts\nconst a = 1;\n```', at: at(5) },
        { kind: 'TurnEnded' },
      ],
      false,
    );
    render(<Message message={message} latest {...handlers()} />);
    // Opening Save uses the shared Dialog's separately allowlisted modal
    // Escape/Tab owner. Transcript controls themselves install no listener.
    for (const button of screen.getAllByRole('button')) {
      if (button.getAttribute('aria-label') !== 'Save answer') act(() => button.click());
    }
    const keydowns = [...windowAdd.mock.calls, ...documentAdd.mock.calls].filter(
      ([type]) => type === 'keydown',
    );
    expect(keydowns).toEqual([]);
    windowAdd.mockRestore();
    documentAdd.mockRestore();
  });

  it('keeps a failure’s words, and shows the stack a failure printed', () => {
    const message: ChatMessage = {
      id: 'failed',
      role: 'assistant',
      text: '',
      tools: [],
      error: [
        'TypeError: Cannot read properties of undefined',
        '    at load (notes/plan.md:3:1)',
        '    at node:internal/main:1:1',
      ].join('\n'),
    };
    render(<Message message={message} {...handlers()} />);
    const box = screen.getByTestId('turn-error');
    expect(screen.getByTestId('turn-error-summary').textContent).toContain(
      'TypeError: Cannot read properties of undefined',
    );
    expect(box.querySelector('[data-slot="stack-trace"]')).not.toBeNull();
  });
});

describe('M95 existing generation observation', () => {
  const receipt = {
    generationId: '11111111111111111111111111111111',
    firstRunId: '22222222222222222222222222222222',
    currentRunId: '33333333333333333333333333333333',
    state: 'running',
  };

  it('explains a detached running observation without presenting an error, completion or retry', () => {
    const message = {
      id: 'observed-reply',
      role: 'assistant',
      text: '',
      tools: [],
      streaming: false,
      generationObservation: receipt,
    } as ChatMessage;
    render(<Message message={message} {...handlers()} />);
    const status = screen.getByRole('status', { name: 'Response status' });
    expect(status.textContent).toMatch(/response.*already|already.*response/i);
    expect(status.textContent).toMatch(/running/i);
    expect(status.textContent).toMatch(/not connected|unavailable/i);
    expect(screen.queryByTestId('turn-error')).toBeNull();
    expect(screen.queryByText('Thinking…')).toBeNull();
    expect(screen.queryByRole('button', { name: /retry|ask again|continue/i })).toBeNull();
    expect(screen.queryByTestId('turn-cancelled')).toBeNull();
    expect(screen.queryByTestId('turn-stopped')).toBeNull();
  });

  it('keeps the genuine live reply visible when observation metadata arrives beside it', () => {
    const message = {
      ...live([{ kind: 'TextDelta', text: 'The original stream continues.' }]),
      generationObservation: receipt,
    } as ChatMessage;
    render(<Message message={message} {...handlers()} />);
    expect(screen.getByText('The original stream continues.')).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Response status' }).textContent).toMatch(/running/i);
    expect(screen.getByRole('status', { name: 'Response status' }).textContent).not.toMatch(
      /not connected|unavailable/i,
    );
    expect(screen.queryByTestId('turn-error')).toBeNull();
  });
});

it('does not render a malformed cached generation object as a current status or action', () => {
  const message = {
    id: 'malformed-observation',
    role: 'assistant',
    text: 'Retain the original answer.',
    tools: [],
    generationObservation: { currentRunId: 99, state: { kind: 'success' } },
  } as unknown as ChatMessage;
  render(<Message message={message} {...handlers()} />);
  expect(screen.getByText('Retain the original answer.')).toBeTruthy();
  expect(screen.queryByRole('status', { name: 'Response status' })).toBeNull();
  expect(screen.queryByRole('button', { name: /retry|ask again|continue/i })).toBeNull();
});
