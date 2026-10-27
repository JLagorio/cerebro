// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentStreamEvent, ChatMessage, Conversation } from './types';

const wire = vi.hoisted(() => ({
  deliver: null as ((event: AgentEvent) => void) | null,
  /** Holds every run before it starts: the send stays parked. */
  park: false,
  /** Runs each turn on the mock backend, as the browser build does. */
  real: false,
}));

/** What the panel asks the conversation list to branch, and a refusal made
 * the way the list makes one: a toast, and no thread. */
const branching = vi.hoisted(() => ({ calls: [] as [string, string][], refuse: false }));

vi.mock('./agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentIpc')>();
  return {
    ...actual,
    runAgent: vi.fn(async (...args: Parameters<typeof actual.runAgent>) =>
      wire.real
        ? actual.runAgent(...args)
        : wire.park
          ? new Promise<never>(() => undefined)
          : { run: 8, durableId: 'body-8', attach: 'body-8' },
    ),
    attachRun: vi.fn(async (...args: Parameters<typeof actual.attachRun>) => {
      if (wire.real) return actual.attachRun(...args);
      wire.deliver = args[2];
      return { state: 'held', done: false, detach: vi.fn() };
    }),
    stopAgent: vi.fn(async () => true),
    listInteractions: vi.fn(async (...args: Parameters<typeof actual.listInteractions>) =>
      wire.real ? actual.listInteractions(...args) : [],
    ),
    readCliTranscript: vi.fn(async (...args: Parameters<typeof actual.readCliTranscript>) =>
      wire.real
        ? actual.readCliTranscript(...args)
        : { state: 'unavailable', reason: 'not_recorded', retention_days: 30 },
    ),
    agentContextUsage: vi.fn(async () => ({ state: 'not_recorded' })),
    readChatRecovery: vi.fn(actual.readChatRecovery),
  };
});

vi.mock('./useConversations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useConversations')>();
  const { useUiStore } = await import('@/stores/uiStore');
  return {
    ...actual,
    useConversations: (...args: Parameters<typeof actual.useConversations>) => {
      const state = actual.useConversations(...args);
      return {
        ...state,
        branchFrom: (thread: string, message: string) => {
          branching.calls.push([thread, message]);
          if (!branching.refuse) return state.branchFrom(thread, message);
          useUiStore.getState().toast(actual.NO_SUCH_REPLY);
          return null;
        },
      };
    },
  };
});

import { AiPanel } from './AiPanel';
import * as agentIpc from './agentIpc';
import { forgetDraftsInMemory } from './drafts';
import { CHECKPOINT_WORDS } from '@/components/ai/Checkpoint';
import { fixtureVault } from '@/test/factories';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { resetMockFs } from '@/lib/mockIpc';
import { mockDrop } from '@/lib/mockDropped';

/**
 * The panel's body (M91.12c): the transcript is a Chat whose Message Scroller
 * settles each question near the top and follows the reply, with the way
 * back to the latest; "Branch from here" stands between turns where the
 * thread can branch; and while a turn works through a plan, the dock shows
 * it over the composer. Every id, role and name the panel's specs press
 * stays.
 */

const SESSION = '00000000-0000-4000-8000-0000000000aa';
const line = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

const asked = (id: string, text: string): ChatMessage => ({ id, role: 'user', text, tools: [] });
const replied = (id: string, text: string, uuid: string | null = null): ChatMessage => ({
  id,
  role: 'assistant',
  text,
  tools: [],
  ...(uuid === null ? {} : { anchor: { sessionId: SESSION, uuid } }),
});

/** Two turns, both of whose replies name the line they ended on. */
const TWO_TURNS: ChatMessage[] = [
  asked('u-1', 'What is at risk?'),
  replied('a-1', 'The scanner delivery.', line(11)),
  asked('u-2', 'And if it slips?'),
  replied('a-2', 'The rollout moves a week.', line(22)),
];

/** A kept thread, as the conversation list stores it, opened in the panel. */
function keep(messages: ChatMessage[], over: Partial<Conversation> = {}) {
  const thread: Conversation = {
    id: 'kept',
    title: 'Release risks',
    usesDefaultTitle: false,
    sessionId: null,
    createdAt: '2026-10-14T12:00:00Z',
    vault: '/demo-vault',
    archived: false,
    place: null,
    messages,
    ...over,
  };
  localStorage.setItem('cerebro.activeConversation', thread.id);
  localStorage.setItem('cerebro.conversations', JSON.stringify([thread]));
}

const stored = (): Conversation[] =>
  JSON.parse(localStorage.getItem('cerebro.conversations') ?? '[]') as Conversation[];

const input = () => screen.getByLabelText('Message the assistant') as HTMLTextAreaElement;
const log = () => screen.getByRole('log');
/** The transcript's rows, as the Message Scroller holds them. */
const rows = () =>
  [...log().children].filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement && el.dataset.slot === 'message-scroller-item',
  );
/** A row by what it holds: a message by its role, or a checkpoint. */
const rowKind = (row: HTMLElement) =>
  row.querySelector('[data-testid="turn-checkpoint"]') !== null
    ? 'checkpoint'
    : (row.querySelector<HTMLElement>('[data-testid="chat-message"]')?.dataset.role ?? 'other');

function send(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.keyDown(input(), { key: 'Enter' });
}

let seq = 0;
function stream(event: AgentStreamEvent) {
  seq += 1;
  act(() => wire.deliver?.({ ...event, run: 8, seq }));
}

/** A TodoWrite call's start, with the list it writes. */
function writeTodos(id: string, statuses: string[]): AgentStreamEvent {
  const todos = [
    ['List the open risks', 'Listing the open risks'],
    ['Read the dated risks', 'Reading the dated risks'],
    ['Name the risk to escalate', 'Naming the risk to escalate'],
  ].map(([content, activeForm], at) => ({ content, status: statuses[at], activeForm }));
  return {
    kind: 'ToolStart',
    tool_name: 'TodoWrite',
    tool_id: id,
    input: JSON.stringify({ todos }),
  };
}

beforeEach(() => {
  localStorage.clear();
  forgetDraftsInMemory();
  vi.clearAllMocks();
  wire.deliver = null;
  wire.park = false;
  wire.real = false;
  branching.calls = [];
  branching.refuse = false;
  seq = 0;
  Element.prototype.scrollTo ??= () => {};
  useVaultStore.setState({ vaultPath: '/demo-vault', entries: fixtureVault(), views: [] });
  useNavStore.setState({ selection: { kind: 'home' } });
  useUiStore.setState({
    aiPanelOpen: true,
    aiPanelPresentation: 'panel',
    aiPanelMinimized: false,
    panelConversation: null,
    panelAgents: { '/demo-vault': null },
    handoffs: [],
    runs: [],
    detailPath: null,
    toasts: [],
  });
});

afterEach(cleanup);

describe('the transcript is a Chat', () => {
  it('draws each message in a row of a named log, the person’s turns its anchors', async () => {
    keep(TWO_TURNS.map((m) => ({ ...m, anchor: undefined })));
    render(<AiPanel presentation="panel" />);
    await screen.findByText('The rollout moves a week.');
    const region = screen.getByRole('region', { name: 'Conversation' });
    expect(screen.getByTestId('chat-scroll').contains(region)).toBe(true);
    expect(region.contains(log())).toBe(true);
    expect(rows().map(rowKind)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(rows().map((row) => row.dataset.scrollAnchor)).toEqual([
      'true',
      'false',
      'true',
      'false',
    ]);
    // Each row is its message's, by id, so a jump can find it.
    expect(rows()[1].dataset.messageId).toBe('a-1');
    expect(within(rows()[1]).getByTestId('chat-message').dataset.role).toBe('assistant');
    expect(log().hasAttribute('aria-busy')).toBe(false);
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy();
  });

  it('holds the log busy while a turn streams, and not while it waits on the person', async () => {
    keep([asked('u-1', 'Asked before'), replied('a-1', 'Answered before.')]);
    render(<AiPanel presentation="panel" />);
    await screen.findByText('Answered before.');
    send('Say it again');
    await waitFor(() => expect(wire.deliver).not.toBeNull());
    expect(log().getAttribute('aria-busy')).toBe('true');
    // The new question is a row of its own that settles near the top.
    expect(rowKind(rows()[2])).toBe('user');
    expect(rows()[2].dataset.scrollAnchor).toBe('true');
    stream({ kind: 'Text', message_id: 'm-1', text: 'Said again.' });
    stream({ kind: 'TurnEnded' });
    stream({ kind: 'Done' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    expect(log().hasAttribute('aria-busy')).toBe(false);

    wire.deliver = null;
    send('Append it');
    await waitFor(() => expect(wire.deliver).not.toBeNull());
    expect(log().getAttribute('aria-busy')).toBe('true');
    stream({
      kind: 'Interaction',
      interaction: {
        id: 'c'.repeat(32),
        kind: 'permission',
        tool_name: 'mcp__cerebro__append_to_note',
        tool_id: 't-1',
        session_id: 'session-1',
        summary: 'Append to a note · notes/inbox.md',
        input: '{}',
        asked_at: '2026-10-17T12:00:00.000Z',
      },
    });
    expect(log().hasAttribute('aria-busy')).toBe(false);
    // The card is a row of the log, after the last message, and no anchor.
    const card = screen.getByTestId('interaction-card');
    const holder = rows().find((row) => row.contains(card));
    expect(holder).toBe(rows().at(-1));
    expect(holder?.dataset.scrollAnchor).toBe('false');
  });

  it('shows the welcome in the thread’s place until there is something to scroll', async () => {
    render(<AiPanel presentation="canvas" />);
    await act(async () => {});
    const welcome = screen.getByTestId('chat-welcome');
    expect(screen.getByTestId('chat-scroll').contains(welcome)).toBe(true);
    expect(screen.queryByRole('log')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  });

  it('says it is reading a thread’s transcript in the thread’s place', async () => {
    keep([], { sessionId: SESSION });
    vi.mocked(agentIpc.readCliTranscript).mockReturnValueOnce(new Promise(() => undefined));
    render(<AiPanel presentation="panel" />);
    const reading = await screen.findByTestId('transcript-reading');
    expect(reading.textContent).toBe('Reading the transcript…');
    expect(screen.getByTestId('chat-scroll').contains(reading)).toBe(true);
  });

  it('opens the last turn’s chain of thought in a thread read back, the earlier ones folded', async () => {
    keep([], { sessionId: SESSION });
    vi.mocked(agentIpc.readCliTranscript).mockResolvedValueOnce({
      state: 'read',
      lines: 8,
      unclassified: [],
      events: [
        { kind: 'UserPrompt', text: 'What is at risk?' },
        { kind: 'Thinking', message_id: 'm-1', text: 'The dated risks first.' },
        { kind: 'Text', message_id: 'm-1', text: 'The scanner delivery.' },
        { kind: 'TurnEnded', last_uuid: line(11) },
        { kind: 'UserPrompt', text: 'And if it slips?' },
        { kind: 'Thinking', message_id: 'm-2', text: 'Weighing the dates.' },
        { kind: 'Text', message_id: 'm-2', text: 'The rollout moves a week.' },
        { kind: 'TurnEnded', last_uuid: line(22) },
      ],
    });
    render(<AiPanel presentation="panel" />);
    await screen.findByText('The rollout moves a week.');
    const chains = screen.getAllByTestId('turn-chain');
    expect(chains).toHaveLength(2);
    const opened = chains.map(
      (chain) => within(chain).getAllByRole('button')[0].getAttribute('aria-expanded') === 'true',
    );
    expect(opened).toEqual([false, true]);
    // Read back, the thread can branch after its first turn.
    expect(screen.getAllByTestId('turn-checkpoint')).toHaveLength(1);
  });
});

/**
 * jsdom lays nothing out, so these cases do, as a browser would: each row of
 * the transcript its height, one under another, in a viewport VIEW tall that
 * clamps its scroll; and they deliver its resizes when they say.
 */
describe('the transcript keeps the reader’s place', () => {
  const VIEW = 400;
  const PEEK = 64;
  let heights = new Map<string, number>();
  let scrolls: ScrollToOptions[] = [];
  let positions = new WeakMap<Element, number>();
  let observed: { callback: ResizeObserverCallback; target: Element | null }[] = [];

  const isViewport = (el: Element) =>
    el instanceof HTMLElement && el.dataset.slot === 'message-scroller-viewport';
  const isRow = (el: Element): el is HTMLElement =>
    el instanceof HTMLElement && el.dataset.slot === 'message-scroller-item';
  const rowsIn = (viewport: Element) => {
    const content = viewport.querySelector('[data-slot="message-scroller-content"]');
    return content === null ? [] : [...content.children].filter(isRow);
  };
  const heightOf = (row: HTMLElement) => heights.get(row.dataset.messageId ?? '') ?? 100;
  const spacerOf = (viewport: Element) => {
    const spacer = viewport.querySelector<HTMLElement>('[data-message-scroller-spacer]');
    return spacer === null || spacer.hidden ? 0 : Number.parseFloat(spacer.style.height || '0');
  };
  const rect = (top: number, height: number) =>
    ({
      x: 0,
      y: top,
      left: 0,
      right: 320,
      top,
      bottom: top + height,
      width: 320,
      height,
    }) as DOMRect;
  const viewport = () => document.querySelector('[data-slot="message-scroller-viewport"]')!;
  const jump = () => screen.getByRole('button', { name: 'Jump to latest' });

  beforeEach(() => {
    heights = new Map([
      ['kept-asked', 80],
      ['kept-said', 600],
    ]);
    scrolls = [];
    positions = new WeakMap();
    observed = [];
    const define = (name: string, descriptor: PropertyDescriptor) =>
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
    define('clientHeight', {
      get(this: HTMLElement) {
        return isViewport(this) ? VIEW : 0;
      },
    });
    define('scrollHeight', {
      get(this: HTMLElement) {
        if (!isViewport(this)) return 0;
        return rowsIn(this).reduce((sum, row) => sum + heightOf(row), 0) + spacerOf(this);
      },
    });
    define('scrollTop', {
      get(this: HTMLElement) {
        return positions.get(this) ?? 0;
      },
      set(this: HTMLElement, value: number) {
        const max = Math.max(0, this.scrollHeight - this.clientHeight);
        positions.set(this, Math.min(max, Math.max(0, value)));
      },
    });
    define('scrollTo', {
      writable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        if (isViewport(this)) scrolls.push(options);
        this.scrollTop = options.top ?? 0;
      },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (isViewport(this)) return rect(0, VIEW);
      const port = this.closest('[data-slot="message-scroller-viewport"]');
      if (!isRow(this) || port === null) return rect(0, 0);
      let top = 0;
      for (const row of rowsIn(port)) {
        if (row === this) break;
        top += heightOf(row);
      }
      return rect(top - port.scrollTop, heightOf(this));
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly entry: (typeof observed)[number];
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, target: null };
          observed.push(this.entry);
        }
        observe(target: Element) {
          this.entry.target = target;
        }
        unobserve() {}
        disconnect() {
          this.entry.target = null;
        }
      },
    );
    keep([asked('kept-asked', 'Asked before'), replied('kept-said', 'Answered before.')]);
  });

  afterEach(() => {
    for (const name of ['clientHeight', 'scrollHeight', 'scrollTop', 'scrollTo']) {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** The transcript was resized: the observers on its parts hear it. */
  function resized() {
    act(() => {
      for (const { callback, target } of observed) {
        if (target instanceof HTMLElement && target.dataset.slot?.startsWith('message-scroller')) {
          callback([], {} as ResizeObserver);
        }
      }
    });
  }

  it('settles a question as it is sent near the top, a peek of the turn before above it', async () => {
    render(<AiPanel presentation="panel" />);
    await screen.findByText('Answered before.');
    send('What comes next?');
    await waitFor(() => expect(rows()).toHaveLength(4));
    const question = rows()[2];
    expect(question.dataset.scrollAnchor).toBe('true');
    // Its top, less the peek: the two rows before it are 80 and 600 tall.
    await waitFor(() => expect(scrolls.at(-1)).toEqual({ top: 80 + 600 - PEEK, behavior: 'auto' }));
    expect(viewport().scrollTop).toBe(80 + 600 - PEEK);
  });

  it('offers the way back to the latest when there is more below, and follows the reply from it', async () => {
    render(<AiPanel presentation="panel" />);
    await screen.findByText('Answered before.');
    // Opened at its last question, whose long reply runs on below the view.
    await waitFor(() => expect(jump().dataset.active).toBe('true'));
    expect(jump().hasAttribute('inert')).toBe(false);
    fireEvent.click(jump());
    expect(scrolls.at(-1)).toEqual({ top: 80 + 600 - VIEW, behavior: 'auto' });
    await waitFor(() => expect(jump().dataset.active).toBe('false'));
    expect(jump().hasAttribute('inert')).toBe(true);
    // At the live edge, a reply that grows is followed.
    heights.set('kept-said', 900);
    resized();
    await waitFor(() => expect(scrolls.at(-1)).toEqual({ top: 80 + 900 - VIEW, behavior: 'auto' }));
    // A reader who scrolls up is let go, and offered the way back.
    fireEvent.wheel(viewport());
    viewport().scrollTop = 0;
    fireEvent.scroll(viewport());
    await waitFor(() => expect(jump().dataset.active).toBe('true'));
    const followed = scrolls.length;
    heights.set('kept-said', 1000);
    resized();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(scrolls).toHaveLength(followed);
    expect(viewport().scrollTop).toBe(0);
  });
});

describe('Branch from here', () => {
  const branchButtons = () => screen.queryAllByRole('button', { name: /^Branch from here/ });

  it('stands between a reply and the turn after it, named by the turn it follows', async () => {
    keep(TWO_TURNS);
    render(<AiPanel presentation="panel" />);
    await screen.findByText('The rollout moves a week.');
    expect(rows().map(rowKind)).toEqual(['user', 'assistant', 'checkpoint', 'user', 'assistant']);
    const button = screen.getByRole('button', {
      name: CHECKPOINT_WORDS.name('your message “What is at risk?”'),
      description: 'Files stay as they are',
    });
    expect(button.textContent).toBe('Branch from here');
    expect(button).toBe(screen.getByTestId('branch-from-here'));
    expect(within(log()).queryByRole('separator')).toBeNull();
    // A checkpoint is a row of its own, not a message, and no anchor.
    const row = rows()[2];
    expect(row.dataset.scrollAnchor).toBe('false');
    expect(row.querySelector('[data-testid="chat-message"]')).toBeNull();
    // After the last reply, a branch would be the thread itself.
    expect(branchButtons()).toHaveLength(1);
  });

  it('is not offered after a reply whose turn named no line', async () => {
    keep(TWO_TURNS.map((m) => (m.id === 'a-1' ? replied('a-1', m.text) : m)));
    render(<AiPanel presentation="panel" />);
    await screen.findByText('The rollout moves a week.');
    expect(branchButtons()).toHaveLength(0);
  });

  it('is not offered in a thread had in another vault', async () => {
    keep(TWO_TURNS, { vault: '/another-vault' });
    render(<AiPanel presentation="panel" />);
    await screen.findByText('The rollout moves a week.');
    expect(screen.getByTestId('thread-blocked')).toBeTruthy();
    expect(branchButtons()).toHaveLength(0);
  });

  it('is not offered while the transcript is read, nor when it could not be', async () => {
    let answer: (read: Awaited<ReturnType<typeof agentIpc.readCliTranscript>>) => void = () =>
      undefined;
    vi.mocked(agentIpc.readCliTranscript).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    keep(TWO_TURNS, { sessionId: SESSION });
    render(<AiPanel presentation="panel" />);
    await screen.findByText('The rollout moves a week.');
    expect(branchButtons()).toHaveLength(0);
    await act(async () =>
      answer({ state: 'unavailable', reason: 'unreadable', retention_days: 30 }),
    );
    expect(screen.getByTestId('transcript-unavailable').dataset.reason).toBe('unreadable');
    expect(branchButtons()).toHaveLength(0);
  });

  it('opens a new conversation holding the thread up to the reply, its composer taking focus', async () => {
    keep(TWO_TURNS);
    render(<AiPanel presentation="panel" />);
    await screen.findByText('The rollout moves a week.');
    fireEvent.click(screen.getByTestId('branch-from-here'));
    expect(branching.calls).toEqual([['kept', 'a-1']]);
    await waitFor(() => expect(screen.getAllByTestId('chat-message')).toHaveLength(2));
    const opened = localStorage.getItem('cerebro.activeConversation');
    expect(opened).not.toBe('kept');
    const branch = stored().find((c) => c.id === opened);
    expect(branch?.fork).toEqual({ from: SESSION, at: line(11) });
    expect(branch?.messages.map((m) => m.id)).toEqual(['u-1', 'a-1']);
    // The thread it left keeps every turn.
    expect(stored().find((c) => c.id === 'kept')?.messages).toHaveLength(4);
    // In the branch the reply is the last message: there is nothing to branch.
    expect(branchButtons()).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(input()));
  });

  it('stays in the thread when the branch is refused, which says why', async () => {
    branching.refuse = true;
    keep(TWO_TURNS);
    render(<AiPanel presentation="panel" />);
    await screen.findByText('The rollout moves a week.');
    fireEvent.click(screen.getByTestId('branch-from-here'));
    expect(branching.calls).toEqual([['kept', 'a-1']]);
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe(
      'That reply is no longer in the conversation, so nothing was branched.',
    );
    expect(localStorage.getItem('cerebro.activeConversation')).toBe('kept');
    expect(screen.getAllByTestId('chat-message')).toHaveLength(4);
    expect(branchButtons()).toHaveLength(1);
  });

  it('waits while a send is still starting, since leaving would cancel it', async () => {
    wire.park = true;
    keep(TWO_TURNS);
    render(<AiPanel presentation="panel" />);
    await screen.findByText('The rollout moves a week.');
    send('Who decides?');
    await waitFor(() => expect(branchButtons()).toHaveLength(2));
    for (const button of branchButtons()) expect((button as HTMLButtonElement).disabled).toBe(true);
    // Names the turn a reply answered, the newer one too.
    expect(branchButtons()[1].getAttribute('aria-label')).toBe(
      CHECKPOINT_WORDS.name('your message “And if it slips?”'),
    );
  });

  it('branches at the line a turn the mock backend ran ended on, and the branch runs on from there', async () => {
    wire.real = true;
    resetMockFs();
    const working = () => screen.queryByRole('button', { name: 'Stop' }) !== null;
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    // The M91 scripts end their turns on a line a branch can start from.
    send('Think it through: which risk goes first?');
    await screen.findByText(/Having thought it through/);
    await waitFor(() => expect(working()).toBe(false));
    expect(branchButtons()).toHaveLength(0);
    send('Thanks');
    await waitFor(() => expect(screen.getAllByTestId('chat-message')).toHaveLength(4));
    await waitFor(() => expect(working()).toBe(false));
    const source = localStorage.getItem('cerebro.activeConversation')!;
    const anchor = stored().find((c) => c.id === source)?.messages[1].anchor;
    expect(anchor).toBeDefined();
    fireEvent.click(
      screen.getByRole('button', {
        name: CHECKPOINT_WORDS.name('your message “Think it through: which risk goes first?”'),
      }),
    );
    await waitFor(() => expect(screen.getAllByTestId('chat-message')).toHaveLength(2));
    const branch = localStorage.getItem('cerebro.activeConversation')!;
    expect(branch).not.toBe(source);
    expect(stored().find((c) => c.id === branch)?.fork).toEqual({
      from: anchor?.sessionId,
      at: anchor?.uuid,
    });
    send('And after that?');
    await waitFor(() => expect(screen.getAllByTestId('chat-message')).toHaveLength(4));
    await waitFor(() => expect(working()).toBe(false));
    // Its first turn forked a session of its own.
    const ran = stored().find((c) => c.id === branch);
    expect(ran?.sessionId).not.toBeNull();
    expect(ran?.sessionId).not.toBe(anchor?.sessionId);
    expect(ran !== undefined && 'fork' in ran).toBe(false);
    expect(screen.queryByTestId('failure-notice')).toBeNull();
    expect(screen.queryByTestId('turn-error')).toBeNull();
    // Three whole mock turns: past the default budget on a loaded machine.
  }, 30_000);
});

describe('the live plan in the dock', () => {
  const plan = () => screen.queryByTestId('live-plan');

  it('shows the plan a turn works through over the composer, only while it works', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    send('Make a todo list');
    await waitFor(() => expect(wire.deliver).not.toBeNull());
    expect(plan()).toBeNull();
    stream(writeTodos('todo-1', ['in_progress', 'pending', 'pending']));
    const section = plan()!;
    expect(section.tagName).toBe('SECTION');
    expect(section.getAttribute('aria-label')).toBe('Plan');
    expect(section.closest('.cb-chat-activity')).not.toBeNull();
    expect(section.closest('[role="log"]')).toBeNull();
    const left = within(section).getByRole('button', { name: '3 to do' });
    expect(left.getAttribute('aria-expanded')).toBe('true');
    const steps = within(section).getAllByRole('listitem');
    // The step under way says so, in the agent's own words, with the light.
    expect(steps[0].textContent).toBe('In progress: Listing the open risks');
    expect(steps[0].querySelector('.cb-ai-shimmer')).not.toBeNull();
    expect(steps[1].textContent).toBe('To do: Read the dated risks');
    expect(within(section).queryByRole('button', { name: /done$/ })).toBeNull();

    stream({ kind: 'ToolDone', tool_id: 'todo-1', output: 'Todos updated.', is_error: false });
    stream(writeTodos('todo-2', ['completed', 'in_progress', 'pending']));
    expect(within(plan()!).getByRole('button', { name: '2 to do' })).toBeTruthy();
    // What is done folds under its count.
    const done = within(plan()!).getByRole('button', { name: '1 done' });
    expect(done.getAttribute('aria-expanded')).toBe('false');

    stream({ kind: 'Text', message_id: 'm-1', text: 'All three done.' });
    stream({ kind: 'TurnEnded' });
    stream({ kind: 'Done' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    expect(plan()).toBeNull();
  });

  it('draws the step under way without the light while the turn waits on the person', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    send('Make a todo list');
    await waitFor(() => expect(wire.deliver).not.toBeNull());
    stream(writeTodos('todo-1', ['in_progress', 'pending', 'pending']));
    stream({
      kind: 'Interaction',
      interaction: {
        id: 'd'.repeat(32),
        kind: 'permission',
        tool_name: 'mcp__cerebro__append_to_note',
        tool_id: 't-2',
        session_id: 'session-1',
        summary: 'Append to a note · notes/inbox.md',
        input: '{}',
        asked_at: '2026-10-17T12:00:00.000Z',
      },
    });
    const step = within(plan()!).getAllByRole('listitem')[0];
    expect(step.textContent).toBe('In progress: List the open risks');
    expect(step.querySelector('.cb-ai-shimmer')).toBeNull();
  });

  it('draws no plan for a turn that wrote none, or wrote an empty one', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    send('What is at risk?');
    await waitFor(() => expect(wire.deliver).not.toBeNull());
    stream({
      kind: 'ToolStart',
      tool_name: 'mcp__cerebro__search_notes',
      tool_id: 's-1',
      input: JSON.stringify({ query: 'risk' }),
    });
    stream({ kind: 'Text', message_id: 'm-1', text: 'Two risks are open.' });
    expect(plan()).toBeNull();
    stream({
      kind: 'ToolStart',
      tool_name: 'TodoWrite',
      tool_id: 'todo-1',
      input: JSON.stringify({ todos: [] }),
    });
    expect(plan()).toBeNull();
  });
});

describe('failed-turn inspection', () => {
  it('reviewing a failed labelled ask is observational and retains the newer composer', async () => {
    const label = 'Ask to revise · Sync error rate';
    const prompt = 'Review knowledge/metrics/sync-error-rate.md using its existing evidence.';
    const error = 'Connection closed before the reply finished.';
    keep([
      { ...asked('u-failed', label), prompt },
      { ...replied('a-failed', 'I started checking the existing evidence.'), error },
    ]);
    resetMockFs();
    const { rerender } = render(<AiPanel presentation="panel" />);
    const failed = await screen.findByTestId('turn-error');
    expect(failed.textContent).toContain(error);
    const composer = input();
    const transcript = log();
    const thread = localStorage.getItem('cerebro.activeConversation');
    fireEvent.change(composer, { target: { value: 'Keep these newer composer words' } });
    composer.setSelectionRange(5, 10);
    expect(screen.getByRole('button', { name: 'Remove Home from context' })).toBeTruthy();
    // Reuse the existing attachment fixture: an outside file is only staged
    // here. It must not be copied or sent by inspecting a failed reply.
    const elementFromPoint = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => composer,
    });
    try {
      await act(async () =>
        mockDrop({
          at: { x: 10, y: 10 },
          files: [{ path: '/outside/newer-context.pdf', base64: 'JVBERi0xLjcK' }],
        }),
      );
    } finally {
      if (elementFromPoint === undefined) Reflect.deleteProperty(document, 'elementFromPoint');
      else Object.defineProperty(document, 'elementFromPoint', elementFromPoint);
    }
    await waitFor(() => expect(screen.getAllByTestId('composer-attachment')).toHaveLength(1));
    const pending = () => screen.getByTestId('composer-attachment');
    expect(within(pending()).getByText('newer-context.pdf')).toBeTruthy();
    expect(pending().dataset.state).toBe('idle');
    expect(agentIpc.runAgent).not.toHaveBeenCalled();
    expect(within(transcript).getAllByTestId('chat-message')).toHaveLength(2);

    // The fallback deliberately reaches today's actual unsafe callback. The
    // first failure must expose replay, not merely the missing new label.
    const inspect =
      within(failed).queryByRole('button', { name: 'Review what happened' }) ??
      within(failed).getByRole('button', { name: 'Retry' });
    await act(async () => {
      fireEvent.click(inspect);
    });
    expect({
      launches: vi.mocked(agentIpc.runAgent).mock.calls.map(([, options]) => options.message),
      userTurns: within(log())
        .getAllByTestId('chat-message')
        .filter((message) => message.dataset.role === 'user').length,
    }).toEqual({ launches: [], userTurns: 1 });

    // Uncredited until the causal RED above has been observed and the
    // approved read-only inspection is implemented.
    expect(within(failed).getByRole('button', { name: 'Review what happened' })).toBe(inspect);
    const review = screen.getByRole('region', { name: 'Review what happened' });
    expect(within(review).getByText(label, { exact: true })).toBeTruthy();
    expect(review.textContent).toContain(error);
    expect(review.textContent).toContain('may be incomplete');
    expect(review.textContent).not.toContain(prompt);
    expect(agentIpc.readChatRecovery).not.toHaveBeenCalled();

    const unchangedComposer = () => {
      expect(input()).toBe(composer);
      expect(composer.value).toBe('Keep these newer composer words');
      expect(composer.selectionStart).toBe(5);
      expect(composer.selectionEnd).toBe(10);
      expect(log()).toBe(transcript);
      expect(localStorage.getItem('cerebro.activeConversation')).toBe(thread);
      expect(screen.getByRole('button', { name: 'Remove Home from context' })).toBeTruthy();
      expect(screen.getAllByTestId('composer-attachment')).toHaveLength(1);
      expect(within(pending()).getByText('newer-context.pdf')).toBeTruthy();
      expect(pending().dataset.state).toBe('idle');
      expect(agentIpc.runAgent).not.toHaveBeenCalled();
      expect(agentIpc.readChatRecovery).not.toHaveBeenCalled();
    };
    unchangedComposer();
    rerender(<AiPanel presentation="canvas" />);
    await act(async () => {});
    const canvasReview = screen.getByRole('region', { name: 'Review what happened' });
    expect(within(canvasReview).getByText(label, { exact: true })).toBeTruthy();
    unchangedComposer();
    fireEvent.click(within(canvasReview).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Review what happened' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(inspect));
    unchangedComposer();
    rerender(<AiPanel presentation="panel" />);
    await act(async () => {});
    unchangedComposer();
    expect(within(log()).getAllByTestId('chat-message')).toHaveLength(2);
    expect(screen.getByTestId('turn-error').textContent).toContain(error);
  });
});


it('M95 reviews a genuinely started failed reply through its original native root without another send', async () => {
  vi.mocked(agentIpc.readChatRecovery).mockRejectedValueOnce({ code: 'unavailable', message: 'Native history is unavailable.', retryDisposition: 'refresh' });
  render(<AiPanel presentation="panel" />); send('Inspect this original turn');
  await waitFor(() => expect(wire.deliver).not.toBeNull());
  act(() => wire.deliver?.({ kind: 'Error', run: 8, seq: 1, message: 'Original native interruption' }));
  stream({ kind: 'Done' });
  const button = await screen.findByRole('button', { name: 'Review what happened' }); fireEvent.click(button);
  await waitFor(() => expect(agentIpc.readChatRecovery).toHaveBeenCalledExactlyOnceWith('body-8'));
  expect(agentIpc.runAgent).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('region', { name: 'Review what happened' })).toBeTruthy();
});
