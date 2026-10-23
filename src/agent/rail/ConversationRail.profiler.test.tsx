// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentStreamEvent, ChatMessage, Conversation } from '@/agent/types';

const wire = vi.hoisted(() => ({ deliver: null as ((event: AgentEvent) => void) | null }));

/** Commits under the rail's Profiler and the conversation lists'. */
const commits = vi.hoisted(() => ({ rail: 0, list: 0 }));

vi.mock('@/agent/agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/agentIpc')>();
  return {
    ...actual,
    runAgent: vi.fn(async () => ({ run: 9, durableId: 'still-9', attach: 'still-9' })),
    attachRun: vi.fn(async (_handle, _after, deliver: (event: AgentEvent) => void) => {
      wire.deliver = deliver;
      return { state: 'held', done: false, detach: vi.fn() };
    }),
    stopAgent: vi.fn(async () => true),
    // A card that waits holds its turn, so nothing streams beside it: the
    // Waiting card a stream can stand beside is the one that could not
    // check the book.
    listInteractions: vi.fn(async () => {
      throw new Error('the book is unreadable');
    }),
    readCliTranscript: vi.fn(async () => ({
      state: 'unavailable',
      reason: 'not_recorded',
      retention_days: 30,
    })),
    agentContextUsage: vi.fn(async () => ({ state: 'not_recorded' })),
  };
});

vi.mock('@/hooks/useMeasuredWidth', () => ({
  useMeasuredWidth: () => [() => undefined, 1200],
}));

// The rail's Profiler sits inside its memo boundary, around every card: it
// records the rail drawn again by its host and any card drawn on its own.
vi.mock('@/components/ai/Rail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ai/Rail')>();
  const { Profiler, createElement } = await import('react');
  const counted = () => {
    commits.rail += 1;
  };
  return {
    ...actual,
    Rail: (props: Parameters<typeof actual.Rail>[0]) =>
      createElement(Profiler, { id: 'rail', onRender: counted }, createElement(actual.Rail, props)),
  };
});

// The same for both conversation lists: the canvas sidebar's and the
// header's menu.
vi.mock('@/agent/ConversationSwitcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/ConversationSwitcher')>();
  const { Profiler, createElement } = await import('react');
  const counted = () => {
    commits.list += 1;
  };
  return {
    ...actual,
    ConversationNavigation: (props: Parameters<typeof actual.ConversationNavigation>[0]) =>
      createElement(
        Profiler,
        { id: 'list', onRender: counted },
        createElement(actual.ConversationNavigation, props),
      ),
    ConversationSwitcher: (props: Parameters<typeof actual.ConversationSwitcher>[0]) =>
      createElement(
        Profiler,
        { id: 'list', onRender: counted },
        createElement(actual.ConversationSwitcher, props),
      ),
  };
});

import { AiPanel } from '@/agent/AiPanel';
import { forgetDraftsInMemory } from '@/agent/drafts';
import { fixtureVault } from '@/test/factories';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The whole rail holds still while a turn streams (M92, each wave's closing
 * step): every mounted card and a 50-word stream make no commit in the rail,
 * and none in the conversation lists. Every word makes a new message and a
 * new list of them (transcript.ts), so the rail takes its host's memoized,
 * derived props, never the messages, and the lists take a state that stays
 * the same object while what they list does.
 */

/** A record the fixture vault holds: what the turn read. */
const ITEM = 'projects/onboarding/items/fld-1.md';

/** A turn that worked through a plan, started a subagent, read a record and
 *  changed a page: something for every card the rail holds. */
const worked: ChatMessage = {
  id: 'a-1',
  role: 'assistant',
  text: 'Scanner delivery is the risk to escalate.',
  tools: [
    {
      id: 'todo-1',
      name: 'TodoWrite',
      input: JSON.stringify({
        todos: [
          { content: 'List the open risks', status: 'completed', activeForm: 'Listing' },
          { content: 'Name the risk to escalate', status: 'in_progress', activeForm: 'Naming' },
        ],
      }),
      output: 'Todos have been modified successfully.',
      done: true,
      failed: false,
    },
    {
      id: 'agent-1',
      name: 'Agent',
      input: JSON.stringify({
        description: 'Read the open risks',
        subagent_type: 'cerebro-researcher',
        prompt: 'Read the open risks.',
      }),
      output: 'Scanner delivery.',
      done: true,
      failed: false,
      subagent: {
        type: 'cerebro-researcher',
        description: 'Read the open risks',
        status: 'done',
        toolUses: 0,
        durationMs: 4100,
        parts: [],
        tools: [],
      },
    },
    {
      id: 'read-1',
      name: 'mcp__cerebro__get_note',
      input: JSON.stringify({ path: ITEM }),
      output: '# Field app',
      done: true,
      failed: false,
    },
  ],
  changesets: [
    {
      state: 'committed',
      run_id: 'run-1',
      commit: 'c0ffee'.padEnd(40, '0'),
      files: [
        {
          path: 'notes/release-plan.md',
          previous_path: null,
          kind: 'modified',
          additions: 2,
          deletions: 1,
          also_by: [],
        },
      ],
      additions: 2,
      deletions: 1,
      binary: 0,
      shell_unrecorded: false,
    },
  ],
};

function keep() {
  const thread: Conversation = {
    id: 'kept',
    title: 'Release risks',
    usesDefaultTitle: false,
    sessionId: null,
    createdAt: '2026-10-14T12:00:00Z',
    vault: '/demo-vault',
    archived: false,
    place: null,
    messages: [{ id: 'u-1', role: 'user', text: 'What is at risk?', tools: [] }, worked],
  };
  localStorage.setItem('cerebro.activeConversation', thread.id);
  localStorage.setItem('cerebro.conversations', JSON.stringify([thread]));
}

let seq = 0;
function stream(event: AgentStreamEvent) {
  seq += 1;
  act(() => wire.deliver?.({ ...event, run: 9, seq }));
}

/** Let every read a render started land: the git probe, the book, the
 *  status reads. */
async function settle() {
  for (let pass = 0; pass < 3; pass += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const CARDS = ['rail-waiting', 'rail-plan', 'rail-subagents', 'rail-changes', 'rail-sources'];

let sidebar: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  forgetDraftsInMemory();
  vi.clearAllMocks();
  wire.deliver = null;
  seq = 0;
  Element.prototype.scrollTo ??= () => {};
  sidebar = document.createElement('nav');
  document.body.append(sidebar);
  useVaultStore.setState({ vaultPath: '/demo-vault', entries: fixtureVault(), views: [] });
  useNavStore.setState({ selection: { kind: 'home' } });
  useUiStore.setState({
    aiPanelOpen: true,
    aiPanelPresentation: 'canvas',
    aiPanelMinimized: false,
    chatRailOpen: true,
    chatRailRequest: null,
    panelConversation: null,
    panelAgents: { '/demo-vault': null },
    handoffs: [],
    runs: [],
    detailPath: null,
    toasts: [],
  });
});

afterEach(() => {
  cleanup();
  sidebar.remove();
});

describe('the whole rail, while a turn streams', () => {
  it('commits nothing in the rail or the conversation lists over 50 words', async () => {
    keep();
    render(<AiPanel presentation="canvas" navigationTarget={sidebar} />);
    await screen.findByText('Scanner delivery is the risk to escalate.');
    const rail = screen.getByRole('region', { name: 'Conversation details' });
    // Docked: a folded rail's cards keep what they drew, which would hold
    // still whatever their props did.
    expect(rail.hasAttribute('inert')).toBe(false);
    // Every card is up, Waiting on you saying it could not check.
    await within(rail).findByTestId('rail-waiting');
    expect(
      [...rail.querySelectorAll<HTMLElement>('[data-slot="rail-cards"] > [data-testid]')].map(
        (card) => card.dataset.testid,
      ),
    ).toEqual(CARDS);
    expect(within(sidebar).getByRole('navigation', { name: 'Conversations' })).toBeTruthy();

    const input = screen.getByLabelText('Message the assistant');
    fireEvent.change(input, { target: { value: 'Say more' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });
    await waitFor(() => expect(wire.deliver).not.toBeNull());
    // The turn's start is news to the rail (Changes lands when it ends) and
    // to the lists (the thread works now); its words are not.
    stream({ kind: 'TextDelta', text: 'Words ' });
    await settle();
    // The Profilers count: a rail and lists that never commit prove nothing.
    expect(commits.rail).toBeGreaterThan(0);
    expect(commits.list).toBeGreaterThan(0);
    commits.rail = 0;
    commits.list = 0;
    for (let word = 0; word < 50; word += 1) stream({ kind: 'TextDelta', text: `word${word} ` });
    expect(screen.getByText(/word49/)).toBeTruthy();
    expect(commits).toEqual({ rail: 0, list: 0 });
    // Still drawn and still the rail it was.
    expect(screen.getByRole('region', { name: 'Conversation details' })).toBe(rail);
    for (const id of CARDS) expect(within(rail).getByTestId(id)).toBeTruthy();
  });
});
