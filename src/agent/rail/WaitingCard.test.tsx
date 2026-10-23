// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef, useCallback, useState, type RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { list } = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/agent/agentIpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/agent/agentIpc')>()),
  listInteractions: list,
}));

import { waitingRowId, type RailWaiting } from '@/agent/elements/railWaiting';
import { InteractionCard } from '@/agent/InteractionCard';
import {
  WAITING_WORDS,
  WaitingCard,
  askerWords,
  firstAnswer,
  waitingState,
} from '@/agent/rail/WaitingCard';
import type { PendingInteraction } from '@/agent/types';
import type { WaitingCard as Waiting } from '@/agent/useAgentChat';
import { Chat } from '@/components/ai/Chat';
import { MessageScrollerItem, type MessageScrollerCommands } from '@/components/ai/MessageScroller';
import { DrawerScrim } from '@/components/ui/DrawerScrim';

/**
 * The rail's Waiting card (M92.4): the call the turn waits on, which subagent
 * asked when one did, and a press that lands on the card in the transcript
 * and its first answer. With none waiting it checks the book, never while
 * folded: nothing waiting draws nothing, and a check that failed says so,
 * never hidden (CV-05).
 */

const ID = '0123456789abcdef0123456789abcdef';
const VAULT = '/demo-vault';

function card(over: Partial<PendingInteraction> = {}): PendingInteraction {
  return {
    id: ID,
    kind: 'permission',
    tool_name: 'mcp__cerebro__append_to_note',
    tool_id: 'ask-1',
    session_id: '0f8fad5b-d9cb-469f-a165-70867728950e',
    summary: 'append to note · notes/inbox.md',
    input: '{"path":"notes/inbox.md"}',
    asked_at: '2026-07-28T12:00:00Z',
    ...over,
  };
}

function waiting(over: Partial<RailWaiting> = {}): RailWaiting {
  return {
    id: ID,
    toolName: 'mcp__cerebro__append_to_note',
    summary: 'append to note · notes/inbox.md',
    asker: { type: 'cerebro-researcher', description: 'Read the open risks' },
    answering: false,
    stale: null,
    ...over,
  };
}

const noScroller = createRef<MessageScrollerCommands>();
const rail = () => screen.queryByTestId('rail-waiting');
const line = () => screen.getByTestId('rail-waiting-card');

beforeEach(() => {
  list.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

describe('WaitingCard', () => {
  it('says what the call asks, and which subagent asked', () => {
    render(
      <WaitingCard
        waiting={waiting()}
        vault={VAULT}
        thread="t-1"
        folded={false}
        jump={vi.fn()}
        scroller={noScroller}
      />,
    );
    expect(rail()?.dataset.state).toBe('ready');
    expect(screen.getByRole('group', { name: 'Waiting on you' })).toBe(rail());
    expect(line().textContent).toContain('append to note · notes/inbox.md');
    expect(line().textContent).toContain(
      'Asked by the cerebro-researcher subagent: Read the open risks',
    );
    expect(line().dataset.cardId).toBe(ID);
    // A tab stop of its own (WebKit), and it answers nothing itself (Q6).
    expect(line().tabIndex).toBe(0);
    expect(within(rail() as HTMLElement).getAllByRole('button')).toHaveLength(2);
    expect(document.querySelectorAll('[data-unknown-icon]')).toHaveLength(0);
    // A card waits: the book is not read.
    expect(list).not.toHaveBeenCalled();
  });

  it('names no one when the turn’s own call asks', () => {
    render(
      <WaitingCard
        waiting={waiting({ asker: null })}
        vault={VAULT}
        thread="t-1"
        folded={false}
        jump={vi.fn()}
        scroller={noScroller}
      />,
    );
    expect(line().textContent).not.toContain('Asked by');
  });

  it('says a card answered too late no longer waits', () => {
    render(
      <WaitingCard
        waiting={waiting({ stale: 'No longer waiting: this request was already answered.' })}
        vault={VAULT}
        thread="t-1"
        folded={false}
        jump={vi.fn()}
        scroller={noScroller}
      />,
    );
    expect(rail()?.dataset.state).toBe('partial');
    expect(line().textContent).toContain(WAITING_WORDS.stale);
  });

  it('draws nothing while nothing waits and the book says so', async () => {
    const { container } = render(
      <WaitingCard
        waiting={null}
        vault={VAULT}
        thread="t-1"
        folded={false}
        jump={vi.fn()}
        scroller={noScroller}
      />,
    );
    await waitFor(() => expect(list).toHaveBeenCalledWith(VAULT));
    await act(async () => undefined);
    expect(container.firstChild).toBeNull();
  });

  it('says it could not check what is waiting when the book cannot be read, never hidden', async () => {
    list.mockRejectedValue(new Error('the book is locked'));
    render(
      <WaitingCard
        waiting={null}
        vault={VAULT}
        thread="t-1"
        folded={false}
        jump={vi.fn()}
        scroller={noScroller}
      />,
    );
    const unavailable = await screen.findByTestId('section-unavailable');
    expect(unavailable.textContent).toContain(WAITING_WORDS.unavailable);
    expect(rail()?.dataset.state).toBe('unavailable');
    expect(screen.queryByTestId('rail-waiting-card')).toBeNull();
  });

  it('never reads while folded, and checks again each time it is shown', async () => {
    const props = {
      waiting: null,
      vault: VAULT,
      jump: vi.fn(),
      scroller: noScroller,
    };
    const { rerender } = render(<WaitingCard {...props} thread="t-1" folded />);
    await act(async () => undefined);
    expect(list).not.toHaveBeenCalled();
    rerender(<WaitingCard {...props} thread="t-1" folded={false} />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    // Another conversation is checked for itself.
    rerender(<WaitingCard {...props} thread="t-2" folded={false} />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    // A card comes, and goes: the book is read again once it has.
    rerender(<WaitingCard {...props} waiting={waiting()} thread="t-2" folded={false} />);
    await act(async () => undefined);
    expect(list).toHaveBeenCalledTimes(2);
    rerender(<WaitingCard {...props} thread="t-2" folded={false} />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
  });

  it('never lets one conversation’s failed check speak for another', async () => {
    list.mockRejectedValueOnce(new Error('locked')).mockReturnValue(new Promise(() => undefined));
    const props = { waiting: null, vault: VAULT, jump: vi.fn(), scroller: noScroller };
    const { rerender } = render(<WaitingCard {...props} thread="t-1" folded={false} />);
    await screen.findByTestId('section-unavailable');
    rerender(<WaitingCard {...props} thread="t-2" folded={false} />);
    expect(rail()).toBeNull();
  });
});

describe('the words', () => {
  it('names the subagent as far as it was recorded', () => {
    expect(askerWords(null)).toBeNull();
    expect(askerWords({ type: 'Explore', description: 'Map it' })).toBe(
      'Asked by the Explore subagent: Map it',
    );
    expect(askerWords({ type: 'Explore', description: '' })).toBe('Asked by the Explore subagent');
    expect(askerWords({ type: ' ', description: 'Map it' })).toBe('Asked by a subagent: Map it');
    expect(askerWords({ type: '', description: '' })).toBe(WAITING_WORDS.notRecorded);
  });

  it('reads not recorded for a subagent that recorded nothing of itself, and partial once stale', () => {
    expect(waitingState(waiting())).toBe('ready');
    expect(waitingState(waiting({ asker: null }))).toBe('ready');
    expect(waitingState(waiting({ answering: true }))).toBe('ready');
    expect(waitingState(waiting({ asker: { type: '', description: ' ' } }))).toBe('not-recorded');
    expect(waitingState(waiting({ stale: 'Too late.' }))).toBe('partial');
  });

  it('finds a card’s first answer it can press: a button, else a question’s first choice', () => {
    const fixture = document.createElement('div');
    fixture.innerHTML = `
      <div data-slot="confirmation-actions">
        <button disabled>Allow once</button><button>Deny</button>
      </div>`;
    expect(firstAnswer(fixture)?.textContent).toBe('Deny');
    fixture.innerHTML = `
      <fieldset data-slot="questionnaire-item"><input type="radio" value="a" /></fieldset>
      <div data-slot="questionnaire-actions"><button>Send answers</button></div>`;
    expect(firstAnswer(fixture)?.getAttribute('value')).toBe('a');
    fixture.innerHTML =
      '<div data-slot="confirmation-actions"><button disabled>Allow</button></div>';
    expect(firstAnswer(fixture)).toBeNull();
  });
});

/**
 * The jump end to end: the card drawn in the transcript under its row id,
 * the rail's card beside it, as a drawer at a narrow width. The press closes
 * the drawer without handing focus back to what opened it, and lands on the
 * card in the transcript and its first answer, in one settling jump. jsdom
 * has no layout: the card's row stands 600px down, and the viewport records
 * each scroll it is asked for.
 */
describe('a jump to the card', () => {
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
      const top = this.dataset.messageId === waitingRowId(ID) ? 600 : 0;
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

  /** The canvas: the transcript with the card that waits, and the rail. */
  function Canvas({ held, drawer: opened = false }: { held: Waiting; drawer?: boolean }) {
    const scroller = useRefOnce();
    const [drawer, setDrawer] = useState(opened);
    // AiPanel's `jumpFromRail`: the drawer closes, then the jump runs.
    const jump = useCallback((go: () => void) => {
      setDrawer(false);
      go();
    }, []);
    const rail = (
      <WaitingCard
        waiting={waiting({ answering: held.answering })}
        vault={VAULT}
        thread="t-1"
        folded={false}
        jump={jump}
        scroller={scroller}
      />
    );
    return (
      <aside>
        <button type="button" data-testid="opener" onClick={() => setDrawer(true)}>
          Conversation details
        </button>
        <Chat scrollerRef={scroller}>
          <MessageScrollerItem messageId="reply">The turn so far.</MessageScrollerItem>
          <MessageScrollerItem messageId={waitingRowId(held.card.id)}>
            <InteractionCard interaction={held} onAnswer={vi.fn()} />
          </MessageScrollerItem>
        </Chat>
        {drawer && (
          <DrawerScrim
            modal={false}
            onDismiss={() => setDrawer(false)}
            label="Close conversation details"
            className="scrim"
          />
        )}
        {drawer ? (
          <section data-overlay="" data-testid="drawer">
            {rail}
          </section>
        ) : (
          <section data-testid="docked">{rail}</section>
        )}
      </aside>
    );
  }

  /** The Chat's commands, held across renders. */
  function useRefOnce(): RefObject<MessageScrollerCommands | null> {
    const [ref] = useState(() => createRef<MessageScrollerCommands>());
    return ref;
  }

  const held = (over: Partial<Waiting> = {}): Waiting => ({
    card: card(),
    messageId: 'reply',
    answering: false,
    stale: null,
    ...over,
  });

  it('lands on the card in the transcript, in one settling jump, and focuses its first answer', () => {
    render(<Canvas held={held()} />);
    expect(scrolls).toEqual([]);
    fireEvent.click(line());
    expect(scrolls).toEqual([{ top: 600, behavior: 'auto' }]);
    expect(document.activeElement).toBe(screen.getByTestId('interaction-allow'));
  });

  it('closes the drawer without handing focus back to what opened it', () => {
    render(<Canvas held={held()} />);
    const opener = screen.getByTestId('opener');
    opener.focus();
    fireEvent.click(opener);
    const press = within(screen.getByTestId('drawer')).getByTestId('rail-waiting-card');
    press.focus();
    fireEvent.click(press);
    expect(screen.queryByTestId('drawer')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('interaction-allow'));
    act(() => undefined);
    expect(document.activeElement).not.toBe(opener);
  });

  it('focuses the card itself while its answers wait, for as long as it holds focus', () => {
    render(<Canvas held={held({ answering: true })} />);
    fireEvent.click(line());
    const asking = screen.getByTestId('interaction-card');
    expect(document.activeElement).toBe(asking);
    expect(asking.getAttribute('tabindex')).toBe('-1');
    act(() => asking.blur());
    expect(asking.hasAttribute('tabindex')).toBe(false);
  });
});
