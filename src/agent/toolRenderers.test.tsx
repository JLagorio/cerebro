// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { latestTodo, turnItems } from '@/agent/elements/turn';
import { revealStep, useStepRevealStore } from '@/agent/stepReveal';
import { RENDERERS, StepItem, type RowContext } from '@/agent/toolRenderers';
import { applyEvent } from '@/agent/transcript';
import type { AgentStreamEvent, ChatMessage, ToolCall } from '@/agent/types';
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ai/MessageScroller';
import { TOOLS } from '@/lib/policy/tools';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';

/**
 * Rows drawn by the manifest's renderer (M56.8). The renderer vocabulary is
 * the manifest's, so this holds RENDERERS to it, and every single row to the
 * action card's test ids. Rows are drawn as a turn draws them (ChatTurn,
 * RunTranscript): a reply's items, each through StepItem.
 */

afterEach(cleanup);

let next = 0;
function call(name: string, over: Partial<ToolCall> = {}): ToolCall {
  next += 1;
  return {
    id: `t-${next}`,
    name: name.startsWith('mcp__') || /^[A-Z]/.test(name) ? name : `mcp__cerebro__${name}`,
    input: '{}',
    output: 'ok',
    done: true,
    failed: false,
    ...over,
  };
}

/** A reply's calls, each item through StepItem with the turn's context. */
function Rows({
  tools,
  streaming,
  waitingToolId = null,
  ...context
}: Omit<RowContext, 'streaming' | 'waitingToolId' | 'latestTodoId'> & {
  tools: ToolCall[];
  streaming: boolean;
  waitingToolId?: string | null;
}) {
  const reply: ChatMessage = { id: 'reply', role: 'assistant', text: '', tools };
  return turnItems(reply, { streaming, waitingToolId }).map((item) => (
    <StepItem
      key={item.key}
      item={item}
      {...context}
      streaming={streaming}
      waitingToolId={waitingToolId}
      latestTodoId={latestTodo(tools)}
    />
  ));
}

function rows(tools: ToolCall[], streaming = false, onOpenPath = vi.fn()) {
  render(<Rows tools={tools} streaming={streaming} onOpenPath={onOpenPath} />);
  return onOpenPath;
}

describe('RENDERERS', () => {
  it('draws every renderer the manifest uses, and no other', () => {
    const used = new Set<string>([
      ...TOOLS.tools.map((row) => row.renderer),
      ...TOOLS.cli_tools.map((row) => row.renderer),
      TOOLS.generated.renderer,
    ]);
    for (const renderer of used) expect(RENDERERS, renderer).toHaveProperty(renderer);
    expect(Object.keys(RENDERERS).sort()).toEqual(
      ['change', 'commit', 'concept', 'handoff', 'step', 'view', 'subagent', 'todo'].sort(),
    );
  });
});

describe("a reply's rows", () => {
  it('folds five reads into a group that expands to their cards', () => {
    const tools = Array.from({ length: 5 }, (_, i) =>
      call('get_note', { input: JSON.stringify({ path: `notes/n-${i}.md` }) }),
    );
    rows(tools);
    const group = screen.getByTestId('action-group');
    expect(group.getAttribute('data-count')).toBe('5');
    expect(within(group).getByTestId('action-group-toggle').textContent).toContain('Read 5 notes');
    const cards = within(group).getAllByTestId('action-card');
    expect(cards).toHaveLength(5);
    // Folded: mounted, but out of sight.
    expect(cards[0].closest('[hidden]')).not.toBeNull();
    fireEvent.click(within(group).getByTestId('action-group-toggle'));
    expect(cards[0].closest('[hidden]')).toBeNull();
    expect(cards.every((card) => card.getAttribute('data-tool') === 'mcp__cerebro__get_note')).toBe(
      true,
    );
  });

  it('spins a group while a member runs, open and in its running words', () => {
    rows([call('get_note'), call('get_note', { done: false, output: null })], true);
    const group = screen.getByTestId('action-group');
    expect(group.getAttribute('data-status')).toBe('running');
    expect(group.querySelector('.animate-spin')).not.toBeNull();
    const toggle = within(group).getByTestId('action-group-toggle');
    expect(toggle.textContent).toBe('Reading 2 notes');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps a command with no shell result the card, a refusal its error', () => {
    rows([
      call('Bash', {
        input: JSON.stringify({ command: 'rm -rf build' }),
        failed: true,
        output: 'The person denied this.',
      }),
    ]);
    const card = screen.getByTestId('action-card');
    expect(card.getAttribute('data-status')).toBe('failed');
    expect(card.getAttribute('data-slot')).toBe('trace-collapsible');
    const toggle = within(card).getAllByRole('button')[0];
    expect(toggle.textContent).toContain('Failed to run a command');
    expect(toggle.textContent).toContain('rm -rf build');
    fireEvent.click(toggle);
    expect(screen.getByTestId('action-output').textContent).toBe('The person denied this.');
  });

  it('draws a command its shell answered as a Terminal, its output inside', () => {
    rows([
      call('Bash', {
        input: JSON.stringify({ command: 'git status' }),
        output: 'clean',
        result: {
          type: 'shell',
          stdout: 'clean',
          stderr: '',
          interrupted: false,
          truncated: false,
        },
      }),
    ]);
    const card = screen.getByTestId('action-card');
    expect(card.getAttribute('data-slot')).toBe('terminal');
    fireEvent.click(within(card).getAllByRole('button')[0]);
    expect(card.querySelector('[data-slot="terminal-command"]')?.textContent).toBe('$ git status');
    expect(card.querySelector('[data-slot="terminal-stdout"]')?.textContent).toBe('clean');
  });

  it('names the agent a handoff went to, and says when it could not go', () => {
    rows([
      call('hand_to', { input: JSON.stringify({ agent: 'release-scout', message: 'Go.' }) }),
      call('hand_to', {
        input: JSON.stringify({ agent: 'night-owl', message: 'Go.' }),
        failed: true,
        output: 'night-owl is paused, so it cannot be called.',
      }),
    ]);
    const [sent, refused] = screen.getAllByTestId('action-card');
    expect(sent.getAttribute('data-renderer')).toBe('handoff');
    expect(sent.textContent).toContain('Handed to release-scout');
    expect(refused.textContent).toContain("Couldn't hand to night-owl");
    expect(within(refused).getByTestId('action-handoff-refusal').textContent).toBe(
      'night-owl is paused, so it cannot be called.',
    );
  });

  it('says why Claude Code refused a handoff, never a bare Denied line', () => {
    rows([
      call('hand_to', {
        input: JSON.stringify({ agent: 'night-owl', message: 'Go.' }),
        failed: true,
        output: 'denied',
        denied: "Permission to use hand_to has been denied by permission rule 'hand_to'.",
      }),
    ]);
    const card = screen.getByTestId('action-card');
    expect(card.textContent).toContain('Denied the hand-off to night-owl');
    expect(card.textContent).not.toContain('Handed to');
    expect(within(card).getByTestId('action-handoff-refusal').textContent).toBe(
      "Permission to use hand_to has been denied by permission rule 'hand_to'.",
    );
  });

  it("clamps a handoff's refusal to its first lines, without its tool-error tags", () => {
    rows([
      call('hand_to', {
        input: JSON.stringify({ agent: 'night-owl', message: 'Go.' }),
        failed: true,
        output: '<tool_use_error>night-owl is paused, so it cannot be called.</tool_use_error>',
      }),
    ]);
    const refusal = screen.getByTestId('action-handoff-refusal');
    expect(refusal.textContent).toBe('night-owl is paused, so it cannot be called.');
    // The clamp is the inner line's, so the row's padding never shows a
    // sliver of the fourth line.
    expect(refusal.className).not.toContain('line-clamp-3');
    expect(refusal.querySelector('span')?.className).toContain('line-clamp-3');
  });

  describe('a handoff’s line, which opens the run it started', () => {
    const RUN = '0000000000000000000000000092150d';
    const handed = () =>
      call('hand_to', {
        input: JSON.stringify({ agent: 'release-scout', message: 'Go.' }),
        output: `Started Release scout (run ${RUN}) with what you handed it.`,
      });
    const realNavigate = useNavStore.getState().navigate;
    /** Where the conversation stood as the run's page opened. */
    let during: string | null = null;
    const navigate = vi.fn(() => {
      during = useUiStore.getState().aiPanelPresentation;
    });

    beforeEach(() => {
      during = null;
      navigate.mockClear();
      useNavStore.setState({ navigate } as never);
    });
    afterEach(() => {
      // Unmounted first: the line reads its navigate from the store.
      cleanup();
      useNavStore.setState({ navigate: realNavigate } as never);
    });

    it('floats the canvas first, which would hide the run’s page (M92.1)', () => {
      useUiStore.setState({ aiPanelPresentation: 'canvas', aiPanelMinimized: false });
      rows([handed()]);
      fireEvent.click(screen.getByRole('button', { name: /Handed to release-scout/ }));
      expect(navigate).toHaveBeenCalledWith({ kind: 'knowledge', nav: { tab: 'runs', run: RUN } });
      expect(during).toBe('floating');
    });

    it('opens the run beside a floating or docked conversation, which stays as it is', () => {
      for (const presentation of ['floating', 'panel'] as const) {
        useUiStore.setState({ aiPanelPresentation: presentation, aiPanelMinimized: false });
        rows([handed()]);
        fireEvent.click(screen.getByRole('button', { name: /Handed to release-scout/ }));
        expect(navigate).toHaveBeenLastCalledWith({
          kind: 'knowledge',
          nav: { tab: 'runs', run: RUN },
        });
        expect(during).toBe(presentation);
        expect(useUiStore.getState().aiPanelPresentation).toBe(presentation);
        cleanup();
      }
    });
  });

  it('counts what a commit decided, and shows a refusal’s code', () => {
    rows([
      call('commit_proposals', {
        output: JSON.stringify({
          commit_set_id: 'cs-1',
          transition: 'initial_queue',
          results: [{ id: 'p-1' }, { id: 'p-2' }, { id: 'p-3' }],
          batch_id: 'b-1',
          replayed: false,
          kept_files: ['knowledge/metrics/churn.md'],
        }),
      }),
      call('commit_proposals', {
        output: JSON.stringify({ outcome: 'refused', code: 'stale_target_version', detail: 'x' }),
      }),
      call('commit_proposals', { output: 'not the answer' }),
    ]);
    const [committed, refused, raw] = screen.getAllByTestId('action-card');
    expect(committed.getAttribute('data-renderer')).toBe('commit');
    expect(committed.textContent).toContain('Committed 3 proposals');
    expect(within(committed).getByTestId('action-commit-detail').textContent).toBe(
      'initial queue · knowledge/metrics/churn.md',
    );
    expect(refused.textContent).toContain('Commit refused: stale_target_version');
    // Neither shape: the card as it was, its output a click away.
    expect(raw.textContent).toContain('commit proposals');
  });

  it('reads a commit’s whole payload before its preview', () => {
    const answer = JSON.stringify({
      transition: 'apply',
      results: [{ id: 'p-1' }],
      kept_files: [],
    });
    rows([
      call('commit_proposals', {
        output: `${answer.slice(0, 10)}…`,
        payload: { output: answer, outputBytes: answer.length, outputTruncated: false },
      }),
    ]);
    expect(screen.getByTestId('action-card').textContent).toContain('Committed 1 proposal');
  });

  it('offers a written concept to review', () => {
    const onOpenPath = rows([
      call('write_concept', { input: JSON.stringify({ path: 'knowledge/metrics/churn.md' }) }),
    ]);
    const card = screen.getByTestId('action-card');
    expect(card.getAttribute('data-renderer')).toBe('concept');
    expect(card.getAttribute('data-write')).toBe('true');
    fireEvent.click(within(card).getByRole('button', { name: 'Open to review' }));
    expect(onOpenPath).toHaveBeenCalledWith('knowledge/metrics/churn.md');
  });

  it('offers no review for a concept write that failed', () => {
    rows([
      call('write_concept', {
        input: JSON.stringify({ path: 'knowledge/metrics/churn.md' }),
        failed: true,
      }),
    ]);
    expect(screen.queryByTestId('action-open-review')).toBeNull();
  });

  it('draws an unknown tool generic, by its raw name', () => {
    rows([call('SomethingNew'), call('mcp__gmail__search_threads')]);
    const [unknown, connector] = screen.getAllByTestId('action-card');
    expect(unknown.getAttribute('data-renderer')).toBe('step');
    expect(unknown.textContent).toContain('SomethingNew');
    expect(connector.textContent).toContain('search threads');
    expect(within(connector).getByTestId('action-server').textContent).toBe('gmail');
  });

  it('keeps action-card, data-tool and data-write on every single row', () => {
    rows([
      call('get_note'),
      call('edit_note'),
      call('hand_to'),
      call('commit_proposals'),
      call('write_concept'),
      call('get_note', { failed: true }),
      call('get_note', { done: false, output: null }),
    ]);
    const cards = screen.getAllByTestId('action-card');
    expect(cards).toHaveLength(7);
    for (const card of cards) {
      expect(card.getAttribute('data-tool')).not.toBeNull();
      expect(['true', 'false']).toContain(card.getAttribute('data-write'));
      expect(card.getAttribute('data-renderer')).not.toBeNull();
      expect(card.getAttribute('data-status')).not.toBeNull();
    }
    expect(cards.map((card) => card.getAttribute('data-status'))).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
      'failed',
      'interrupted',
    ]);
  });

  it('names every row’s call by its id, which a rail row jumps to (M92.4)', () => {
    const tools = [
      call('edit_note'),
      call('hand_to', { input: JSON.stringify({ agent: 'scout' }) }),
      call('Agent', { input: JSON.stringify({ description: 'Read the risks' }) }),
      call('TodoWrite', {
        input: JSON.stringify({ todos: [{ content: 'Read', status: 'pending' }] }),
      }),
      call('Bash', { input: JSON.stringify({ command: 'ls' }), done: false, output: null }),
    ];
    rows(tools, true);
    expect(screen.getAllByTestId('action-card').map((card) => card.dataset.toolId)).toEqual(
      tools.map((tool) => tool.id),
    );
  });

  it('says whether a card with detail is open, turning its one chevron', () => {
    rows([call('edit_note', { input: JSON.stringify({ path: 'notes/a.md' }) })]);
    const toggle = within(screen.getByTestId('action-card')).getAllByRole('button')[0];
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.querySelectorAll('.cb-ai-trace-chevron')).toHaveLength(1);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.querySelectorAll('.cb-ai-trace-chevron')).toHaveLength(1);
  });
});

describe('a held call (M57.1)', () => {
  it('says each deferred status in its own words, with its data-status', () => {
    const held = call('append_to_note', {
      input: JSON.stringify({ path: 'notes/inbox.md' }),
      output: null,
      done: false,
      deferred: true,
    });
    const cases = [
      [{}, held.id, 'waiting', 'Waiting for your answer'],
      [{ cancelled: true }, null, 'cancelled', 'Cancelled: it did not run'],
      [{}, null, 'not_run', 'Not run: it waited for an answer that never came'],
      [
        { paused: true },
        null,
        'paused',
        'Paused by a hook outside Cerebro; your next message refuses it',
      ],
    ] as const;
    for (const [over, waitingToolId, status, words] of cases) {
      render(
        <Rows
          tools={[{ ...held, ...over }]}
          streaming={false}
          onOpenPath={vi.fn()}
          waitingToolId={waitingToolId}
        />,
      );
      const card = screen.getByTestId('action-card');
      expect(card.getAttribute('data-status'), status).toBe(status);
      expect(screen.getByTestId('action-deferred').textContent).toBe(words);
      expect(screen.queryByTestId('action-interrupted')).toBeNull();
      expect(card.querySelector('.animate-spin')).toBeNull();
      cleanup();
    }
  });

  it('draws a held handoff as the plain card, never as handed', () => {
    render(
      <Rows
        tools={[
          call('hand_to', {
            input: JSON.stringify({ agent: 'scout', task: 'x' }),
            output: null,
            done: false,
            deferred: true,
          }),
        ]}
        streaming={false}
        onOpenPath={vi.fn()}
      />,
    );
    expect(screen.getByTestId('action-card').textContent).not.toContain('Handed to');
    expect(screen.getByTestId('action-deferred')).toBeTruthy();
  });
});

/**
 * A rail row's jump (M92.4, stepReveal.ts): the subagent's line in the
 * conversation's transcript opens, comes into view in one settling jump and
 * takes focus; a line drawn where no transcript scrolls takes nothing.
 * jsdom has no layout, so the subagent's line stands 600px down and the
 * viewport records each scroll it is asked for.
 */
describe('a rail’s reveal (M92.4)', () => {
  const AGENT = 'agent-1';
  let scrolls: ScrollToOptions[] = [];

  beforeEach(() => {
    scrolls = [];
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      writable: true,
      value(options: ScrollToOptions) {
        scrolls.push(options);
      },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const top = this.dataset.toolId === AGENT ? 600 : 0;
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 320,
        bottom: top + 40,
        width: 320,
        height: 40,
        toJSON: () => ({}),
      } as DOMRect;
    });
  });

  afterEach(() => {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo;
    vi.restoreAllMocks();
    useStepRevealStore.setState({ asked: null });
  });

  /** A reply whose researcher reported, with its own steps, while the turn
   *  streams on. */
  function streamed(done = true): ChatMessage {
    const events: AgentStreamEvent[] = [
      {
        kind: 'ToolStart',
        tool_name: 'Agent',
        tool_id: AGENT,
        input: JSON.stringify({ description: 'Read the open risks', subagent_type: 'researcher' }),
      },
    ];
    if (done) {
      events.push(
        {
          kind: 'ToolStart',
          tool_name: 'mcp__cerebro__search_notes',
          tool_id: 'sub-1',
          input: '{"query":"risk"}',
          parent: AGENT,
        },
        { kind: 'ToolDone', tool_id: 'sub-1', output: 'Five risks.', parent: AGENT },
        { kind: 'ToolDone', tool_id: AGENT, output: 'Scanner delivery.' },
      );
    }
    let message: ChatMessage = {
      id: 'reply',
      role: 'assistant',
      text: '',
      tools: [],
      streaming: true,
    };
    for (const event of events) message = applyEvent(message, event, 'live');
    return message;
  }

  /** The reply as the conversation draws it: in its transcript's scroller. */
  function Conversation({ message }: { message: ChatMessage }) {
    return (
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent>
              <MessageScrollerItem messageId={message.id}>
                {turnItems(message, { streaming: true }).map((item) => (
                  <StepItem key={item.key} item={item} onOpenPath={vi.fn()} streaming />
                ))}
              </MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
        </MessageScroller>
      </MessageScrollerProvider>
    );
  }

  const line = () => document.querySelector<HTMLElement>(`[data-tool-id="${AGENT}"]`);
  const fold = () => within(line() as HTMLElement).getAllByRole('button')[0];

  it('opens the line, brings it into view in one settling jump, and focuses it', () => {
    let message = streamed();
    const { rerender } = render(<Conversation message={message} />);
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    expect(scrolls).toEqual([]);
    act(() => revealStep(AGENT));
    expect(fold().getAttribute('aria-expanded')).toBe('true');
    expect(scrolls).toEqual([{ top: 600, behavior: 'auto' }]);
    expect(document.activeElement).toBe(fold());
    // Spent: the line took it once.
    expect(useStepRevealStore.getState().asked).toBeNull();
    // The turn streams on under it: fifty words move nothing and close
    // nothing.
    for (let at = 0; at < 50; at += 1) {
      message = applyEvent(message, { kind: 'TextDelta', text: `word ${at} ` }, 'live');
      rerender(<Conversation message={message} />);
    }
    expect(scrolls).toHaveLength(1);
    expect(fold().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(fold());
    // The reader's own fold still closes it.
    fireEvent.click(fold());
    expect(fold().getAttribute('aria-expanded')).toBe('false');
  });

  it('shows it again when asked again', () => {
    render(<Conversation message={streamed()} />);
    act(() => revealStep(AGENT));
    fireEvent.click(fold());
    act(() => revealStep(AGENT));
    expect(fold().getAttribute('aria-expanded')).toBe('true');
    expect(scrolls).toHaveLength(2);
  });

  it('focuses a line with nothing to open for as long as it holds focus', () => {
    render(<Conversation message={streamed(false)} />);
    // Just started: no steps yet, nothing to open.
    expect(within(line() as HTMLElement).queryByRole('button')).toBeNull();
    act(() => revealStep(AGENT));
    expect(document.activeElement).toBe(line());
    expect(line()?.getAttribute('tabindex')).toBe('-1');
    act(() => line()?.blur());
    expect(line()?.hasAttribute('tabindex')).toBe(false);
  });

  it('leaves another call’s line alone', () => {
    render(<Conversation message={streamed()} />);
    act(() => revealStep('somewhere-else'));
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    expect(scrolls).toEqual([]);
    expect(document.activeElement).toBe(document.body);
  });

  it('is taken by no line drawn where no transcript scrolls, which never throws (RunTranscript)', () => {
    // A run's detail draws the same steps with no scroller around them.
    render(
      <>
        {turnItems(streamed(), { streaming: false }).map((item) => (
          <StepItem key={item.key} item={item} onOpenPath={vi.fn()} />
        ))}
      </>,
    );
    expect(() => act(() => revealStep(AGENT))).not.toThrow();
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    expect(scrolls).toEqual([]);
    expect(document.activeElement).toBe(document.body);
    expect(useStepRevealStore.getState().asked?.toolId).toBe(AGENT);
  });
});
