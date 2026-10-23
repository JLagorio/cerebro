import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real browser adapter, watched: the mock's journal and book answer.
vi.mock('./agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentIpc')>();
  return {
    ...actual,
    listInteractions: vi.fn(actual.listInteractions),
    runState: vi.fn(actual.runState),
  };
});

import * as agentIpc from './agentIpc';
import { mockJournal, onAgentEvent, runAgent, type RunHandle } from './agentIpc';
import {
  ConversationNavigation,
  ConversationSwitcher,
  THREAD_STATUS_WORDS,
} from './ConversationSwitcher';
import { releaseHeldMockRuns } from './mockAgent';
import { resetMockInteractions } from './mockInteractions';
import { resetThreadStatus, type TurnFlags } from './threadStatusStore';
import type { Conversation, LiveTurn } from './types';
import type { ConversationState } from './useConversations';
import { failNext, resetFaults } from '@/lib/mockFaults';
import * as mock from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The conversation list's chips (M92.7): Working on a thread whose run goes
 * on while nobody watches it, Needs you on one a card waits for, inside the
 * row's button; nothing for a status nobody can tell, and one line under the
 * heading for a status that could not be read. Over the browser mock, whose
 * journal and book stand in for Rust's.
 */

const VAULT = '/demo-vault';
const listInteractions = vi.mocked(agentIpc.listInteractions);
const runState = vi.mocked(agentIpc.runState);
const asks = globalThis as { __cerebroMockAsk?: unknown };

beforeEach(() => {
  mock.resetMockFs();
  resetMockInteractions();
  resetThreadStatus();
  useVaultStore.setState({ vaultPath: VAULT });
  listInteractions.mockClear();
  runState.mockClear();
});

afterEach(() => {
  cleanup();
  releaseHeldMockRuns();
  resetFaults();
  resetThreadStatus();
  delete asks.__cerebroMockAsk;
});

function thread(id: string, title: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title,
    usesDefaultTitle: false,
    sessionId: null,
    messages: [],
    createdAt: '2026-10-23T09:00:00Z',
    archived: false,
    place: null,
    placeLabel: 'Home',
    ...over,
  };
}

/** The list's state: `conversations`, `activeId` open. */
function stateOf(conversations: Conversation[], activeId: string): ConversationState {
  return {
    conversations,
    activeId,
    active: conversations.find((c) => c.id === activeId) ?? null,
    here: { kind: 'home' },
    hereLabel: 'Home',
    startedElsewhere: null,
    anchorNow: vi.fn(),
    start: vi.fn(),
    select: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    setRunOptions: vi.fn(),
    branchFrom: vi.fn(() => null),
    transcript: { state: 'idle' },
    blocked: null,
    ready: true,
  };
}

const OPEN = thread('open', 'Open thread', { sessionId: '00000000-0000-4000-8000-000000092700' });

function liveOf(handle: RunHandle): LiveTurn {
  if (handle.attach === undefined) throw new Error('a mock run has an attach key');
  return { run: handle.run, attach: handle.attach, assistantId: 'reply-1' };
}

/** Start an attended mock run in the vault, as a send does. */
async function start(message: string): Promise<RunHandle> {
  const started = await act(() =>
    runAgent(VAULT, { message, shell: 'off', connectors: false, attended: true }),
  );
  if ('deferred' in started || 'settled' in started) throw new Error('an attended run starts');
  return started;
}

/** Resolve once `run` says an event of `kind`. */
function first(run: number, kind: string): Promise<void> {
  return new Promise((resolve) => {
    const off = onAgentEvent((event) => {
      if (event.kind !== kind) return;
      off();
      resolve();
    }, run);
  });
}

function rowOf(title: string): HTMLElement {
  const row = screen.getAllByTestId('conversation-row').find((r) => r.textContent?.includes(title));
  if (row === undefined) throw new Error(`no row for ${title}`);
  return row;
}

const statusOf = (title: string) => rowOf(title).getAttribute('data-thread-status');
const chipOf = (title: string) => within(rowOf(title)).queryByTestId('thread-status');

function navigation(conversations: Conversation[], activeId = 'open', turn?: TurnFlags) {
  return <ConversationNavigation state={stateOf(conversations, activeId)} turn={turn} />;
}

describe('the chips', () => {
  it('shows Working on a thread whose detached run goes on, and clears it at its Done', async () => {
    const view = render(navigation([OPEN]));
    const handle = await start('wait for me');
    view.rerender(navigation([OPEN, thread('left', 'Left running', { live: liveOf(handle) })]));
    await waitFor(() => expect(statusOf('Left running')).toBe('working'));
    expect(chipOf('Left running')?.getAttribute('data-status')).toBe('working');
    expect(chipOf('Left running')?.textContent).toBe(THREAD_STATUS_WORDS.working);
    // The run is held mid-tool; let it go on and end while nobody watches.
    await first(handle.run, 'ToolStart');
    await waitFor(() => {
      releaseHeldMockRuns();
      expect(statusOf('Left running')).toBe('idle');
    });
    expect(chipOf('Left running')).toBeNull();
  });

  it('reads the book again at an Interaction: a thread left before its session still needs you', async () => {
    asks.__cerebroMockAsk = ['append_to_note'];
    const view = render(navigation([OPEN]));
    const handle = await start('append "Escalate the scanner risk." to notes/inbox.md');
    const asked = first(handle.run, 'Interaction');
    const ended = first(handle.run, 'Done');
    // Left before Claude Code named its session: only the run that asked
    // ties the card to the thread.
    view.rerender(
      navigation([OPEN, thread('left', 'Left asking', { sessionId: null, live: liveOf(handle) })]),
    );
    await waitFor(() => expect(statusOf('Left asking')).toBe('working'));
    const before = listInteractions.mock.calls.length;
    await act(async () => {
      await asked;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(listInteractions.mock.calls.length).toBeGreaterThan(before);
    await waitFor(() => expect(statusOf('Left asking')).toBe('needs_you'));
    expect(chipOf('Left asking')?.textContent).toBe(THREAD_STATUS_WORDS.needs_you);
    // The run ended on the card, which still waits: it still needs you.
    await act(async () => {
      await ended;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(statusOf('Left asking')).toBe('needs_you');
  });

  it('puts the status in the row button’s name, ahead of the place', async () => {
    const view = render(navigation([OPEN]));
    const handle = await start('wait for me');
    view.rerender(navigation([OPEN, thread('left', 'Left running', { live: liveOf(handle) })]));
    const button = await screen.findByRole('button', { name: /Left running.*Working.*Home/ });
    const chip = within(button).getByTestId('thread-status');
    expect(chip.nextElementSibling?.textContent).toBe('Home');
  });

  it('keeps the chip in the row’s button, never under its hover actions', async () => {
    const view = render(navigation([OPEN]));
    const handle = await start('wait for me');
    view.rerender(navigation([OPEN, thread('left', 'Left running', { live: liveOf(handle) })]));
    await waitFor(() => expect(statusOf('Left running')).toBe('working'));
    const [main, ...actions] = within(rowOf('Left running')).getAllByRole('button', {
      hidden: true,
    });
    expect(within(main).getByTestId('thread-status')).toBeTruthy();
    expect(actions.map((a) => a.getAttribute('aria-label'))).toEqual([
      'Rename Left running',
      'Delete Left running',
    ]);
    for (const action of actions) expect(main.contains(action)).toBe(false);
  });

  it('turns the Working spinner, which reduced motion stills', async () => {
    const view = render(navigation([OPEN]));
    const handle = await start('wait for me');
    view.rerender(navigation([OPEN, thread('left', 'Left running', { live: liveOf(handle) })]));
    await waitFor(() => expect(statusOf('Left running')).toBe('working'));
    const spinner = chipOf('Left running')?.querySelector('.animate-spin');
    expect(spinner?.getAttribute('aria-hidden')).toBe('true');
    const css = readFileSync(join(__dirname, '../styles/index.css'), 'utf8');
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.animate-spin,[\s\S]*?\{\s*animation: none;/);
  });

  it('draws the open thread from its own flags, ahead of the book and the journal', async () => {
    const view = render(navigation([OPEN], 'open', { streaming: true, waiting: false }));
    await waitFor(() => expect(statusOf('Open thread')).toBe('working'));
    view.rerender(navigation([OPEN], 'open', { streaming: true, waiting: true }));
    await waitFor(() => expect(statusOf('Open thread')).toBe('needs_you'));
    view.rerender(navigation([OPEN], 'open', { streaming: false, waiting: false }));
    await waitFor(() => expect(statusOf('Open thread')).toBe('idle'));
    expect(chipOf('Open thread')).toBeNull();
  });
});

describe('what draws no chip', () => {
  it('draws nothing for a status nobody can tell', async () => {
    render(
      navigation([
        OPEN,
        thread('left', 'Left before', {
          live: { run: 3, attach: 'mock-earlier-3', assistantId: 'reply-1' },
        }),
      ]),
    );
    await waitFor(() => expect(runState).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(statusOf('Open thread')).toBe('idle'));
    expect(statusOf('Left before')).toBe('unknown');
    expect(screen.queryByTestId('thread-status')).toBeNull();
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });

  it('never infers Working after a restart, even while this launch’s run of that number works', async () => {
    const view = render(navigation([OPEN]));
    const handle = await start('wait for me');
    // Saved before a restart: the same run number, under the last launch's key.
    const stale = { run: handle.run, attach: `mock-earlier-${handle.run}`, assistantId: 'r' };
    view.rerender(
      navigation([
        OPEN,
        thread('now', 'Working now', { live: liveOf(handle) }),
        thread('before', 'Left before the restart', { live: stale }),
      ]),
    );
    await waitFor(() => expect(statusOf('Working now')).toBe('working'));
    await waitFor(() =>
      expect(runState).toHaveBeenCalledWith({ run: stale.run, attach: stale.attach }),
    );
    await waitFor(() => expect(statusOf('Left before the restart')).toBe('unknown'));
    expect(chipOf('Left before the restart')).toBeNull();
    await first(handle.run, 'ToolStart');
    await waitFor(() => {
      releaseHeldMockRuns();
      expect(statusOf('Working now')).toBe('idle');
    });
    expect(statusOf('Left before the restart')).toBe('unknown');
  });
});

describe('a status that could not be read', () => {
  /** A run the mock journal holds, still going. */
  function going(run: number): LiveTurn {
    return { run, attach: mockJournal.open(run), assistantId: 'reply-1' };
  }

  it('says Status unavailable under the heading when a run’s read is refused', async () => {
    failNext('agent_events_since');
    render(navigation([OPEN, thread('left', 'Left running', { live: going(927_001) })]));
    const line = await screen.findByTestId('section-unavailable');
    expect(line.textContent).toBe(THREAD_STATUS_WORDS.unavailable);
    expect(line.previousElementSibling?.textContent).toBe('Conversations');
    expect(statusOf('Left running')).toBe('unavailable');
    expect(screen.queryByTestId('thread-status')).toBeNull();
    expect(screen.getAllByTestId('section-unavailable')).toHaveLength(1);
  });

  it('says the same when the book could not be read, never a quiet list', async () => {
    failNext('list_interactions');
    render(navigation([OPEN, thread('other', 'Other thread', { sessionId: 's-other' })]));
    const line = await screen.findByTestId('section-unavailable');
    expect(line.textContent).toBe(THREAD_STATUS_WORDS.unavailable);
    expect(statusOf('Other thread')).toBe('unavailable');
  });

  it('reads a run the journal holds once the read goes through again', async () => {
    const left = thread('left', 'Left running', { live: going(927_002) });
    failNext('agent_events_since');
    const view = render(navigation([OPEN, left]));
    await screen.findByTestId('section-unavailable');
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    // A thread leaving the open slot asks again.
    view.rerender(navigation([OPEN, left], 'left'));
    view.rerender(navigation([OPEN, left], 'open'));
    await waitFor(() => expect(statusOf('Left running')).toBe('working'));
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });
});

describe('the header’s menu', () => {
  it('reads nothing until it opens, then draws the same chips', async () => {
    const left = thread('left', 'Left running', {
      live: { run: 927_003, attach: mockJournal.open(927_003), assistantId: 'reply-1' },
    });
    render(<ConversationSwitcher state={stateOf([OPEN, left], 'open')} />);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(listInteractions).not.toHaveBeenCalled();
    expect(runState).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('conversation-switcher'));
    await waitFor(() => expect(statusOf('Left running')).toBe('working'));
    expect(chipOf('Left running')?.textContent).toBe(THREAD_STATUS_WORDS.working);
  });
});
