// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Profiler, memo, useCallback, useMemo, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  railSubagents,
  type RailSubagentRow,
  type RailSubagents,
} from '@/agent/elements/railSubagents';
import { turnItems } from '@/agent/elements/turn';
import {
  SUBAGENTS_WORDS,
  SubagentsCard,
  subagentsCount,
  subagentsState,
  type SubagentsCardProps,
} from '@/agent/rail/SubagentsCard';
import { useStepRevealStore } from '@/agent/stepReveal';
import { StepItem } from '@/agent/toolRenderers';
import { applyEvent } from '@/agent/transcript';
import type { AgentStreamEvent, ChatMessage } from '@/agent/types';
import {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ai/MessageScroller';
import { DrawerScrim } from '@/components/ui/DrawerScrim';

/**
 * The rail's Subagents card (M92.4): a line per subagent the conversation
 * started, as its line in the transcript says it, the heading counting them
 * by state; a press jumps to the subagent's own line in the transcript, which
 * opens, comes into view and takes focus. It reads nothing itself, and says
 * what reading the transcript back could not tell it (CV-05).
 */

afterEach(() => {
  cleanup();
  useStepRevealStore.setState({ asked: null });
});

const row = (over: Partial<RailSubagentRow> & Pick<RailSubagentRow, 'toolId'>) =>
  ({
    type: 'cerebro-researcher',
    description: 'Read the open risks',
    state: 'done',
    ...over,
  }) as RailSubagentRow;

const ROWS: RailSubagentRow[] = [
  row({ toolId: 'a-1', toolUses: 3, durationMs: 4100 }),
  row({ toolId: 'a-2', state: 'running', description: 'Check the dates', now: 'Reading notes' }),
  row({ toolId: 'a-3', type: '' }),
  row({ toolId: 'a-4', state: 'denied', description: 'Fetch the vendor page' }),
  row({ toolId: 'a-5', state: 'running', description: '' }),
  row({ toolId: 'a-6', state: 'failed' }),
  row({ toolId: 'a-7' }),
];

const held = (rows: RailSubagentRow[]): RailSubagents => ({ rows, held: true });

const card = () => screen.getByTestId('rail-subagents');
const lines = () => screen.queryAllByTestId('rail-subagent');

/** What a control says to a screen reader, roughly: its text, piece by
 *  piece, without what is hidden from assistive tech. */
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

describe('SubagentsCard', () => {
  it('draws each subagent as its line says it, counting the states it holds', () => {
    render(
      <SubagentsCard subagents={held(ROWS)} transcript="idle" folded={false} jump={vi.fn()} />,
    );
    expect(card().dataset.state).toBe('ready');
    // Zero buckets are left out.
    expect(
      within(card()).getByRole('button', {
        name: `Subagents 2 running · 3 done · 1 failed · 1 denied`,
      }),
    ).toBeTruthy();
    expect(lines().map((line) => [line.dataset.toolId, line.dataset.state])).toEqual(
      ROWS.map((r) => [r.toolId, r.state]),
    );
    const [done, running, nameless, denied, untitled] = lines();
    expect(spoken(done)).toBe(
      `Done: Read the open risks by the cerebro-researcher 3 tool uses · 4.1s${SUBAGENTS_WORDS.show}`,
    );
    expect(spoken(running)).toBe(
      `Running: Check the dates by the cerebro-researcher Reading notes${SUBAGENTS_WORDS.show}`,
    );
    // A kind nobody named is no badge; a task nobody named reads as the
    // transcript reads it; a refused call says denied, never failed.
    expect(nameless.querySelector('[data-slot="subagent-type"]')).toBeNull();
    expect(spoken(denied)).toMatch(/^Denied: Fetch the vendor page by the cerebro-researcher/);
    expect(spoken(denied)).not.toMatch(/Failed/);
    expect(spoken(untitled)).toMatch(/^Running: Subagent /);
    // Every line is a tab stop of its own (WebKit), and none counts tokens.
    for (const line of lines()) expect(line.tabIndex).toBe(0);
    expect(card().textContent).not.toMatch(/token/i);
    expect(document.querySelectorAll('[data-unknown-icon]')).toHaveLength(0);
  });

  it('jumps in the canvas: the rail’s jump, then the reveal of that subagent’s line', () => {
    const jump = vi.fn((go: () => void) => go());
    render(<SubagentsCard subagents={held(ROWS)} transcript="idle" folded={false} jump={jump} />);
    fireEvent.click(lines()[2]);
    expect(jump).toHaveBeenCalledOnce();
    expect(useStepRevealStore.getState().asked?.toolId).toBe('a-3');
  });

  it('is one quiet line when the conversation started none', () => {
    render(
      <SubagentsCard subagents={held([])} transcript="rebuilt" folded={false} jump={vi.fn()} />,
    );
    expect(card().dataset.state).toBe('empty');
    expect(card().textContent).toBe('SubagentsNone');
    expect(within(card()).queryByRole('button')).toBeNull();
  });

  it('says a line’s steps were not recorded, once the transcript has healed what it could', () => {
    const subagents = held([
      row({ toolId: 'a-1', stepsNotRecorded: true }),
      row({ toolId: 'a-2' }),
    ]);
    const { rerender } = render(
      <SubagentsCard subagents={subagents} transcript="reading" folded={false} jump={vi.fn()} />,
    );
    // While it is read back, steps may still come: nothing claimed yet.
    expect(card().dataset.state).toBe('ready');
    expect(card().textContent).not.toContain(SUBAGENTS_WORDS.notRecorded);
    rerender(
      <SubagentsCard subagents={subagents} transcript="healed" folded={false} jump={vi.fn()} />,
    );
    expect(card().dataset.state).toBe('not-recorded');
    expect(lines()[0].textContent).toContain(SUBAGENTS_WORDS.notRecorded);
    expect(lines()[1].textContent).not.toContain(SUBAGENTS_WORDS.notRecorded);
  });

  it('keeps the lines it holds when the transcript could not be read back, and says so', () => {
    render(
      <SubagentsCard
        subagents={held([row({ toolId: 'a-1' })])}
        transcript="unavailable"
        folded={false}
        jump={vi.fn()}
      />,
    );
    expect(card().dataset.state).toBe('partial');
    expect(screen.getByTestId('rail-subagents-partial').textContent).toContain(
      SUBAGENTS_WORDS.partial,
    );
    expect(lines()).toHaveLength(1);
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });

  it('says it could not read the conversation when it holds no turns, never none', () => {
    render(
      <SubagentsCard
        subagents={{ rows: [], held: false }}
        transcript="unavailable"
        folded={false}
        jump={vi.fn()}
      />,
    );
    expect(card().dataset.state).toBe('unavailable');
    expect(screen.getByTestId('section-unavailable').textContent).toContain(
      SUBAGENTS_WORDS.unavailable,
    );
    expect(card().textContent).not.toContain('None');
  });

  it('waits, drawing nothing, while a thread with nothing held is read back', () => {
    const { container } = render(
      <SubagentsCard
        subagents={{ rows: [], held: false }}
        transcript="reading"
        folded={false}
        jump={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('keeps what it drew while folded away, and draws the latest as the rail unfolds', () => {
    const jump = vi.fn();
    const { rerender } = render(
      <SubagentsCard subagents={held(ROWS)} transcript="idle" folded jump={jump} />,
    );
    rerender(<SubagentsCard subagents={held([])} transcript="idle" folded jump={jump} />);
    expect(lines()).toHaveLength(ROWS.length);
    rerender(<SubagentsCard subagents={held([])} transcript="idle" folded={false} jump={jump} />);
    expect(card().dataset.state).toBe('empty');
  });
});

describe('a turn’s stream', () => {
  it('never draws the card again: fifty words read back the same lines', () => {
    let drawn = 0;
    let stream: (text: string) => void = () => undefined;
    let reply: ChatMessage = {
      id: 'reply',
      role: 'assistant',
      text: '',
      tools: [],
      streaming: true,
    };
    for (const event of [
      {
        kind: 'ToolStart',
        tool_name: 'Agent',
        tool_id: 'a-1',
        input: JSON.stringify({ description: 'Read the open risks' }),
      },
      { kind: 'SubagentProgress', tool_id: 'a-1', description: 'Reading notes/risks.md' },
    ] as AgentStreamEvent[]) {
      reply = applyEvent(reply, event, 'live');
    }
    const jump = () => undefined;
    const count = () => {
      drawn += 1;
    };
    // The rail as the panel holds it (ConversationRail, memoized): it draws
    // only when what it is handed changes.
    const Rail = memo(function Rail(props: SubagentsCardProps) {
      return (
        <Profiler id="rail" onRender={count}>
          <SubagentsCard {...props} />
        </Profiler>
      );
    });
    // The panel: its messages, a new list with every word, and the card's
    // lines derived from them.
    function Host() {
      const [messages, setMessages] = useState<ChatMessage[]>([reply]);
      stream = (text) =>
        setMessages(([last]) => [applyEvent(last, { kind: 'TextDelta', text }, 'live')]);
      const subagents = useMemo(() => railSubagents(messages), [messages]);
      return <Rail subagents={subagents} transcript="idle" folded={false} jump={jump} />;
    }
    render(<Host />);
    const before = drawn;
    expect(before).toBeGreaterThan(0);
    for (let at = 0; at < 50; at += 1) act(() => stream(`word ${at} `));
    expect(drawn).toBe(before);
    expect(lines()[0].textContent).toContain('Reading notes/risks.md');
  });
});

describe('rail-jump.css', () => {
  const css = readFileSync(resolve(__dirname, 'rail-jump.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  it('spends motion tokens, never a duration of its own', () => {
    const timed = [...css.matchAll(/(?:transition|animation)[\w-]*:([^;]+);/g)];
    expect(timed.length).toBeGreaterThan(0);
    for (const [, value] of timed) {
      expect(value).toMatch(/var\(--(?:motion|dur)-/);
      expect(value).not.toMatch(/(?<![\w-])\d*\.?\d+m?s\b/);
    }
  });

  it('paints with DS tokens only', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
  });
});

describe('the words', () => {
  it('counts the states a line is in, in order, and none it is not', () => {
    expect(subagentsCount([])).toBeUndefined();
    expect(
      subagentsCount([
        row({ toolId: '1', state: 'interrupted' }),
        row({ toolId: '2', state: 'not_run' }),
        row({ toolId: '3', state: 'waiting' }),
        row({ toolId: '4', state: 'done' }),
      ]),
    ).toBe('1 waiting · 1 done · 1 interrupted · 1 not run');
  });

  it('reads unavailable only where no turn is held, and partial where some are', () => {
    expect(subagentsState({ rows: [], held: false }, 'unavailable')).toBe('unavailable');
    expect(subagentsState({ rows: [], held: true }, 'unavailable')).toBe('partial');
    expect(subagentsState({ rows: [], held: true }, 'reading')).toBe('empty');
    expect(subagentsState({ rows: [], held: false }, 'reading')).toBeNull();
    expect(subagentsState({ rows: [], held: false }, 'idle')).toBe('empty');
  });
});

/**
 * The jump end to end: the card in a drawer over the conversation, as the
 * canvas opens it at a narrow width. The press closes the drawer without
 * handing focus back to what opened it (DrawerScrim gives it back on Escape
 * only), and the subagent's line in the transcript opens, comes into view in
 * one settling jump, and takes focus. jsdom has no layout: the line stands
 * 600px down, and the viewport records each scroll it is asked for.
 */
describe('a jump from the drawer', () => {
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
      const top =
        this.dataset.toolId === AGENT && this.dataset.testid !== 'rail-subagent' ? 600 : 0;
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
  });

  /** A reply whose researcher reported, with a step of its own. */
  function reply(): ChatMessage {
    const events: AgentStreamEvent[] = [
      {
        kind: 'ToolStart',
        tool_name: 'Agent',
        tool_id: AGENT,
        input: JSON.stringify({
          description: 'Read the open risks',
          subagent_type: 'cerebro-researcher',
        }),
      },
      {
        kind: 'ToolStart',
        tool_name: 'mcp__cerebro__get_note',
        tool_id: 'sub-1',
        input: '{"path":"notes/risks.md"}',
        parent: AGENT,
      },
      { kind: 'ToolDone', tool_id: 'sub-1', output: 'Five risks.', parent: AGENT },
      { kind: 'ToolDone', tool_id: AGENT, output: 'Scanner delivery.' },
    ];
    let message: ChatMessage = { id: 'reply', role: 'assistant', text: '', tools: [] };
    for (const event of events) message = applyEvent(message, event, 'live');
    return message;
  }

  /** The canvas: its transcript, and its rail as a drawer the opener opens. */
  function Canvas({ message }: { message: ChatMessage }) {
    const [drawer, setDrawer] = useState(false);
    // AiPanel's `jumpFromRail`: the drawer closes, then the jump runs.
    const jump = useCallback((go: () => void) => {
      setDrawer(false);
      go();
    }, []);
    const subagents = useMemo(() => railSubagents([message]), [message]);
    return (
      <>
        <button type="button" data-testid="opener" onClick={() => setDrawer(true)}>
          Conversation details
        </button>
        <MessageScrollerProvider autoScroll>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent>
                <MessageScrollerItem messageId={message.id}>
                  {turnItems(message, { streaming: false }).map((item) => (
                    <StepItem key={item.key} item={item} onOpenPath={vi.fn()} />
                  ))}
                </MessageScrollerItem>
              </MessageScrollerContent>
            </MessageScrollerViewport>
          </MessageScroller>
        </MessageScrollerProvider>
        {drawer && (
          <DrawerScrim
            modal={false}
            onDismiss={() => setDrawer(false)}
            label="Close conversation details"
            className="scrim"
          />
        )}
        {drawer && (
          <section data-overlay="" data-testid="drawer">
            <SubagentsCard subagents={subagents} transcript="idle" folded={false} jump={jump} />
          </section>
        )}
      </>
    );
  }

  it('closes the drawer without handing focus back, and lands on the opened line', () => {
    render(<Canvas message={reply()} />);
    const opener = screen.getByTestId('opener');
    opener.focus();
    fireEvent.click(opener);
    const line = within(screen.getByTestId('drawer')).getByTestId('rail-subagent');
    line.focus();
    fireEvent.click(line);
    expect(screen.queryByTestId('drawer')).toBeNull();
    const step = document.querySelector<HTMLElement>(
      `[data-testid="action-card"][data-tool-id="${AGENT}"]`,
    ) as HTMLElement;
    const fold = within(step).getAllByRole('button')[0];
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(scrolls).toEqual([{ top: 600, behavior: 'auto' }]);
    expect(document.activeElement).toBe(fold);
    expect(document.activeElement).not.toBe(opener);
    // Nothing comes along later to hand focus back.
    act(() => undefined);
    expect(document.activeElement).toBe(fold);
  });
});
