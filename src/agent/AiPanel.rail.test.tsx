// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentStreamEvent, ChatMessage, Conversation, RunReach } from './types';
import type { ConversationRailProps } from './rail/ConversationRail';

const wire = vi.hoisted(() => ({ deliver: null as ((event: AgentEvent) => void) | null }));

/** The run the worked turn handed off, as runtime.db reads it back. */
const handOff = vi.hoisted(() => ({
  run: '0000000000000000000000000092150b',
  detail: {
    run: {
      run_id: '0000000000000000000000000092150b',
      actor: 'process:release-scout',
      outcome: 'succeeded',
      started_at: '2026-10-14T11:20:00.000Z',
      ended_at: '2026-10-14T11:24:00.000Z',
    },
    cost_components: null,
    assembly: null,
    model_id: null,
    refusals: [],
    refusals_total: 0,
    wrote: { state: 'not_recorded' },
  },
}));

/** The aside's width as its observer reports it (useMeasuredWidth); jsdom
 *  lays nothing out, so the canvas is as wide as a test says. */
const measurement = vi.hoisted(() => ({
  width: 1200 as number | null,
  measure: () => undefined,
}));

/** What the panel last handed its rail, and how often the rail was drawn. */
const handed = vi.hoisted(() => ({ props: null as ConversationRailProps | null, draws: 0 }));

vi.mock('./agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentIpc')>();
  return {
    ...actual,
    runAgent: vi.fn(async () => ({ run: 8, durableId: 'rail-8', attach: 'rail-8' })),
    attachRun: vi.fn(async (_handle, _after, deliver: (event: AgentEvent) => void) => {
      wire.deliver = deliver;
      return { state: 'held', done: false, detach: vi.fn() };
    }),
    stopAgent: vi.fn(async () => true),
    listInteractions: vi.fn(async () => []),
    readCliTranscript: vi.fn(async () => ({
      state: 'unavailable',
      reason: 'not_recorded',
      retention_days: 30,
    })),
    agentContextUsage: vi.fn(async () => ({ state: 'not_recorded' })),
  };
});

vi.mock('@/hooks/useMeasuredWidth', () => ({
  useMeasuredWidth: () => [measurement.measure, measurement.width],
}));

vi.mock('./rail/ConversationRail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rail/ConversationRail')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    ConversationRail: (props: ConversationRailProps) => {
      handed.props = props;
      return createElement(actual.ConversationRail, props);
    },
  };
});

vi.mock('@/components/ai/Rail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ai/Rail')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Rail: (props: Parameters<typeof actual.Rail>[0]) => {
      handed.draws += 1;
      return createElement(actual.Rail, props);
    },
  };
});

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    getLastVault: vi.fn(async () => '/demo-vault'),
    pickVault: vi.fn(async () => null),
    scanVault: vi.fn(async () => []),
    listViews: vi.fn(async () => []),
    startWatcher: vi.fn(async () => {}),
    fleetRunDetail: vi.fn(async () => handOff.detail),
    readConnectors: vi.fn(async () => ''),
    connectorStatus: vi.fn(async () => []),
  };
});

// What Cerebro's records read back of the session's runs (M92.12).
vi.mock('@/lib/gitIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitIpc')>();
  return {
    ...actual,
    conversationChanges: vi.fn(async () => ({ changesets: [], truncated: false })),
  };
});

import App from '@/App';
import { AiPanel } from './AiPanel';
import { agentContextUsage, listInteractions } from './agentIpc';
import { forgetDraftsInMemory } from './drafts';
import { openOutside } from './rail/ConversationRail';
import { RAIL_CHANGES_WORDS } from './elements/conversationChanges';
import { useAppCommands } from '@/app/useAppCommands';
import type { RunChangeset } from '@/engine/changeset';
import * as gitIpc from '@/lib/gitIpc';
import * as ipc from '@/lib/ipc';
import { navSeed } from '@/test/navSeed';
import { fixtureVault } from '@/test/factories';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The conversation rail's frame (M92.1): in the canvas alone, a third grid
 * area of the panel's own aside, so the header, the transcript and the
 * composer keep their parents through every toggle and presentation. It
 * docks where the canvas has room, by the `cerebro.chatRailOpen`
 * preference; where it has not, it folds away, still mounted and inert, and
 * a person opens it as a drawer for the session, which writes nothing.
 * Which one CSS draws is the browser's to prove (e2e/m92-rail.spec.ts); here
 * the panel's word on it is. Its cards are the thread's, in §0 Q5's order:
 * a row's first action stays in the canvas, its open floats first, and a
 * docked rail's Plan card stands in for the dock's. The setup cards read
 * what the panel already holds: Context the composer's own pull, Connectors
 * and Environment what the thread's runs last said they reach.
 */

const RAIL_KEY = 'cerebro.chatRailOpen';
/** A path fixtureVault holds, so the record peek and the page have one. */
const ITEM = 'projects/onboarding/items/fld-1.md';
/** The Claude Code session a turn's run opens. */
const SESSION = '00000000-0000-4000-8000-000000092151';

const asked = (id: string, text: string): ChatMessage => ({ id, role: 'user', text, tools: [] });
const replied = (id: string, text: string): ChatMessage => ({
  id,
  role: 'assistant',
  text,
  tools: [],
});

/** What a thread's last run said it reaches, as the thread saved it. */
const SAVED_REACH: RunReach = {
  connectors: [],
  missing: [],
  missing_more: 0,
  inherits: false,
  permission_mode: 'default',
  cerebro: true,
  families: { confirmable: ['allow'], shell: ['deny'], web: ['deny'], delegate: ['allow'] },
};

/** The vault's connector list: one, Gmail. */
const GMAIL = JSON.stringify({
  servers: { gmail: { transport: 'http', url: 'https://gmail.example.test/mcp', enabled: true } },
});

/** A kept thread with a turn in it, so the conversation is not welcoming. */
function keep(
  messages: ChatMessage[] = [
    asked('u-1', 'What is at risk?'),
    replied('a-1', 'The rollout moves a week.'),
  ],
  saved: Partial<Conversation> = {},
) {
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
    ...saved,
  };
  localStorage.setItem('cerebro.activeConversation', thread.id);
  localStorage.setItem('cerebro.conversations', JSON.stringify([thread]));
}

/** A page the vault does not list: opening it is a plain page open, which
 *  floats nothing by itself. */
const PAGE = 'notes/release-plan.md';
const COMMIT = 'c0ffee'.padEnd(40, '0');

/** A turn that worked through a plan, started a subagent, read a record,
 *  handed work off and changed a page: something for every card the rail
 *  holds. */
function worked(): ChatMessage {
  return {
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
      {
        id: 'hand-1',
        name: 'mcp__cerebro__hand_to',
        input: JSON.stringify({ agent: 'release-scout', message: 'Bring the brief up to date.' }),
        output: `Started Release scout (run ${handOff.run}) with what you handed it.`,
        done: true,
        failed: false,
      },
    ],
    changesets: [
      {
        state: 'committed',
        run_id: 'run-1',
        commit: COMMIT,
        files: [
          {
            path: PAGE,
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
}

/** The panel as the shell draws it: one presentation from the store, the
 *  app's commands bound. */
function Assistant() {
  useAppCommands();
  const presentation = useUiStore((s) => s.aiPanelPresentation);
  return (
    <AiPanel
      presentation={presentation}
      onTogglePresentation={() =>
        useUiStore
          .getState()
          .setAiPanelPresentation(presentation === 'canvas' ? 'floating' : 'canvas')
      }
    />
  );
}

const input = () => screen.getByLabelText('Message the assistant') as HTMLTextAreaElement;
/** The rail, mounted: docked, folded away, or a drawer. */
const mounted = () => screen.queryByRole('region', { name: 'Conversation details' });
/** The rail a reader can reach: mounted, and not folded away. CSS hides a
 *  folded one, which jsdom does not load; the panel makes it inert. */
const details = () => {
  const rail = mounted();
  return rail?.hasAttribute('inert') === true ? null : rail;
};
const heading = () => screen.getByRole('heading', { level: 2, name: 'Conversation details' });
const toggle = () => screen.getByRole('button', { name: 'Conversation details' });
const scrim = () => screen.queryByTestId('conversation-rail-scrim');
const presentation = () => useUiStore.getState().aiPanelPresentation;

/** Open a kept conversation in the canvas, `width` px wide, its turn drawn. */
async function openKept(width: number) {
  measurement.width = width;
  keep();
  const view = render(<Assistant />);
  await screen.findByText('The rollout moves a week.');
  return view;
}

let seq = 0;
function stream(event: AgentStreamEvent) {
  seq += 1;
  act(() => wire.deliver?.({ ...event, run: 8, seq }));
}

beforeEach(() => {
  localStorage.clear();
  forgetDraftsInMemory();
  vi.clearAllMocks();
  wire.deliver = null;
  measurement.width = 1200;
  handed.props = null;
  handed.draws = 0;
  seq = 0;
  Element.prototype.scrollTo ??= () => {};
  vi.mocked(listInteractions).mockImplementation(async () => []);
  vi.mocked(agentContextUsage).mockImplementation(async () => ({ state: 'not_recorded' }));
  vi.mocked(ipc.readConnectors).mockImplementation(async () => '');
  vi.mocked(gitIpc.conversationChanges).mockImplementation(async () => ({
    changesets: [],
    truncated: false,
  }));
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
    agentConnectors: false,
    stdioApprovals: {},
    handoffs: [],
    runs: [],
    detailPath: null,
    diffView: null,
    toasts: [],
  });
});

afterEach(cleanup);

describe('the rail in the canvas', () => {
  it('is the aside’s last child, beside a header and a transcript that keep their parents', async () => {
    await openKept(1200);
    const panel = screen.getByTestId('ai-panel');
    const rail = details()!;
    expect(panel.lastElementChild).toBe(rail);
    expect(rail.dataset.drawer).toBeUndefined();
    expect(panel.querySelector('.cb-chat-header')?.parentElement).toBe(panel);
    const body = panel.querySelector('.cb-chat-body');
    expect(body?.parentElement).toBe(panel);
    expect(input().closest('.cb-chat-body')).toBe(body);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(toggle().getAttribute('aria-controls')).toBe(rail.id);
  });

  it('lives in the canvas alone: floating and the docked panel draw neither it nor its toggle', async () => {
    await openKept(1200);
    for (const other of ['floating', 'panel'] as const) {
      act(() => useUiStore.getState().setAiPanelPresentation(other));
      expect(mounted()).toBeNull();
      expect(screen.queryByRole('button', { name: 'Conversation details' })).toBeNull();
    }
    act(() => useUiStore.getState().setAiPanelPresentation('canvas'));
    expect(details()).not.toBeNull();
  });

  it('keeps one composer, one transcript and the draft through toggles and presentations', async () => {
    await openKept(1200);
    const composer = input();
    const transcript = screen.getByTestId('chat-scroll');
    const message = screen.getByText('The rollout moves a week.');
    fireEvent.change(composer, { target: { value: 'Keep this draft' } });
    fireEvent.click(toggle());
    expect(mounted()).toBeNull();
    fireEvent.click(toggle());
    expect(details()).not.toBeNull();
    for (const next of ['floating', 'panel', 'canvas', 'floating', 'canvas'] as const) {
      act(() => useUiStore.getState().setAiPanelPresentation(next));
      expect(input()).toBe(composer);
      expect(screen.getByTestId('chat-scroll')).toBe(transcript);
      expect(screen.getByText('The rollout moves a week.')).toBe(message);
      expect(composer.value).toBe('Keep this draft');
    }
    expect(details()).not.toBeNull();
  });

  it('stays away while a fresh conversation welcomes, until the person opens it', async () => {
    render(<Assistant />);
    await act(async () => {});
    expect(screen.getByTestId('chat-welcome')).toBeTruthy();
    // The preference is on, and still nothing speaks first (Q7).
    expect(useUiStore.getState().chatRailOpen).toBe(true);
    expect(mounted()).toBeNull();
    // Not even for the moment before the thread is known to hold nothing.
    expect(handed.props).toBeNull();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle());
    const rail = details()!;
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    // No card of what the conversation did draws a body in one that holds
    // nothing yet: each is its heading line, saying None, and nothing waits.
    for (const id of [
      'rail-plan',
      'rail-subagents',
      'rail-changes',
      'rail-handoffs',
      'rail-context',
      'rail-sources',
    ]) {
      const card = within(rail).getByTestId(id);
      expect(card.dataset.state).toBe('empty');
      expect(card.querySelector('.cb-ai-rail-section-body')).toBeNull();
    }
    expect(within(rail).getByTestId('rail-context').textContent).toContain('No turns yet');
    expect(screen.queryByTestId('rail-waiting')).toBeNull();
    // The setup is the vault's, there before a turn: Connectors switched off
    // in Settings is one quiet line, and Environment names the vault, what
    // a run reaches not recorded until a turn says (§2).
    const connectors = within(rail).getByTestId('rail-connectors');
    expect(connectors.dataset.state).toBe('empty');
    expect(connectors.textContent).toContain('Off in Settings');
    const environment = await within(rail).findByTestId('rail-environment');
    expect(environment.dataset.state).toBe('not-recorded');
    expect(within(environment).getByTestId('rail-environment-vault').textContent).toContain(
      'demo-vault',
    );
    expect(within(environment).getByTestId('rail-environment-reach-not-recorded')).toBeTruthy();
    expect(localStorage.getItem(RAIL_KEY)).toBeNull();
    expect(screen.getByTestId('chat-welcome')).toBeTruthy();
  });

  it('names its toggle the same, open or shut, and says what it shows', async () => {
    await openKept(1200);
    const button = toggle();
    expect(button.tabIndex).toBe(0);
    expect(button.hasAttribute('aria-pressed')).toBe(false);
    fireEvent.click(button);
    expect(toggle()).toBe(button);
    expect(button.getAttribute('aria-label')).toBe('Conversation details');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(details()!.id);
  });

  it('a docked toggle writes the preference, and turned off the rail is unmounted', async () => {
    await openKept(1200);
    fireEvent.click(toggle());
    expect(mounted()).toBeNull();
    expect(useUiStore.getState().chatRailOpen).toBe(false);
    expect(localStorage.getItem(RAIL_KEY)).toBe('false');
    fireEvent.click(toggle());
    expect(details()).not.toBeNull();
    expect(useUiStore.getState().chatRailOpen).toBe(true);
    expect(localStorage.getItem(RAIL_KEY)).toBe('true');
  });

  it('where it does not fit, folds away and opens as a drawer that writes nothing', async () => {
    await openKept(959);
    // On by the preference, and folded: mounted, out of reach, and the
    // toggle says it is not on screen.
    expect(useUiStore.getState().chatRailOpen).toBe(true);
    const rail = mounted()!;
    expect(rail.hasAttribute('inert')).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle());
    expect(mounted()).toBe(rail);
    expect(rail.hasAttribute('inert')).toBe(false);
    expect(rail.dataset.drawer).toBe('true');
    expect(rail.dataset.overlay).toBe('true');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(scrim()).not.toBeNull();
    fireEvent.click(toggle());
    expect(mounted()).toBe(rail);
    expect(rail.dataset.drawer).toBeUndefined();
    expect(rail.hasAttribute('inert')).toBe(true);
    expect(scrim()).toBeNull();
    expect(localStorage.getItem(RAIL_KEY)).toBeNull();
    expect(useUiStore.getState().chatRailOpen).toBe(true);
  });

  it('opens as a drawer over nothing when the preference keeps it off, and leaves with it', async () => {
    useUiStore.setState({ chatRailOpen: false });
    await openKept(800);
    expect(mounted()).toBeNull();
    fireEvent.click(toggle());
    expect(details()!.dataset.drawer).toBe('true');
    fireEvent.click(toggle());
    expect(mounted()).toBeNull();
    expect(localStorage.getItem(RAIL_KEY)).toBeNull();
  });

  it('a drawer takes focus to its heading and gives it back on Escape, never on a scrim press', async () => {
    await openKept(800);
    act(() => toggle().focus());
    fireEvent.click(toggle());
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    fireEvent.keyDown(heading(), { key: 'Escape' });
    expect(details()).toBeNull();
    expect(document.activeElement).toBe(toggle());
    expect(presentation()).toBe('canvas');

    fireEvent.click(toggle());
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    fireEvent.click(scrim()!);
    expect(details()).toBeNull();
    expect(document.activeElement).not.toBe(toggle());
    expect(mounted()?.contains(document.activeElement)).toBe(false);
    expect(localStorage.getItem(RAIL_KEY)).toBeNull();
  });

  it('Escape leaves a docked rail, and the canvas, where they are', async () => {
    await openKept(1200);
    act(() => heading().focus());
    fireEvent.keyDown(heading(), { key: 'Escape' });
    expect(details()).not.toBeNull();
    expect(document.activeElement).toBe(heading());
    expect(scrim()).toBeNull();
    expect(presentation()).toBe('canvas');
    expect(localStorage.getItem(RAIL_KEY)).toBeNull();
  });

  it('crosses the dock width without remounting, and lets a drawer go once the rail fits', async () => {
    const view = await openKept(800);
    const rail = mounted()!;
    fireEvent.click(toggle());
    expect(rail.dataset.drawer).toBe('true');
    measurement.width = 1200;
    view.rerender(<Assistant />);
    expect(mounted()).toBe(rail);
    expect(rail.dataset.drawer).toBeUndefined();
    expect(rail.hasAttribute('inert')).toBe(false);
    expect(scrim()).toBeNull();
    // Narrow again: the same rail folds, and the next fold starts closed.
    measurement.width = 800;
    view.rerender(<Assistant />);
    expect(mounted()).toBe(rail);
    expect(rail.hasAttribute('inert')).toBe(true);
    expect(rail.dataset.drawer).toBeUndefined();
    expect(localStorage.getItem(RAIL_KEY)).toBeNull();
  });

  it('reads nothing on the canvas’s first frame, before its width says the rail docks', async () => {
    // The observer still holds the floating card's width as the canvas is
    // drawn, and reports the canvas's own a frame later: folded, then wide.
    useUiStore.setState({ aiPanelPresentation: 'floating' });
    const view = await openWorked(400, { sessionId: SESSION });
    const before = vi.mocked(ipc.fleetRunDetail).mock.calls.length;
    act(() => useUiStore.getState().setAiPanelPresentation('canvas'));
    await act(async () => {});
    expect(mounted()).not.toBeNull();
    expect(gitIpc.conversationChanges).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.fleetRunDetail).mock.calls.length).toBe(before);
    measurement.width = 800;
    view.rerender(<Assistant />);
    await act(async () => {});
    expect(mounted()!.hasAttribute('inert')).toBe(true);
    expect(gitIpc.conversationChanges).not.toHaveBeenCalled();
    expect(vi.mocked(ipc.fleetRunDetail).mock.calls.length).toBe(before);
    measurement.width = 1200;
    view.rerender(<Assistant />);
    await waitFor(() =>
      expect(gitIpc.conversationChanges).toHaveBeenCalledWith('/demo-vault', SESSION),
    );
    await waitFor(() =>
      expect(vi.mocked(ipc.fleetRunDetail).mock.calls.length).toBeGreaterThan(before),
    );
  });
});

describe('⌥⌘R and "Expand with conversation details"', () => {
  /** ⌥⌘R in the composer, as a Mac sends it: ⌥ composes the letter. */
  const pressRail = () =>
    fireEvent.keyDown(input(), { key: '®', code: 'KeyR', altKey: true, metaKey: true });

  it('floating’s options expand into the canvas with the rail shown and focused', async () => {
    useUiStore.setState({ aiPanelPresentation: 'floating' });
    await openKept(1200);
    fireEvent.click(screen.getByRole('button', { name: 'Conversation options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Expand with conversation details' }));
    expect(presentation()).toBe('canvas');
    expect(details()).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    expect(useUiStore.getState().chatRailRequest).toBeNull();
  });

  it('turns a rail the preference keeps off back on as it opens the canvas', async () => {
    useUiStore.setState({ aiPanelPresentation: 'panel', chatRailOpen: false });
    await openKept(1200);
    act(() => input().focus());
    pressRail();
    expect(presentation()).toBe('canvas');
    expect(details()).not.toBeNull();
    expect(localStorage.getItem(RAIL_KEY)).toBe('true');
  });

  it('in the canvas, hides and shows a docked rail from the composer', async () => {
    await openKept(1200);
    act(() => input().focus());
    pressRail();
    expect(mounted()).toBeNull();
    expect(localStorage.getItem(RAIL_KEY)).toBe('false');
    pressRail();
    expect(details()).not.toBeNull();
    expect(localStorage.getItem(RAIL_KEY)).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(heading()));
  });

  it('opens and shuts the drawer where the rail does not fit, writing nothing', async () => {
    await openKept(800);
    act(() => input().focus());
    pressRail();
    expect(details()!.dataset.drawer).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    fireEvent.keyDown(heading(), { key: 'r', code: 'KeyR', altKey: true, metaKey: true });
    expect(details()).toBeNull();
    // Focus in the rail goes back to its toggle, never to <body>.
    expect(document.activeElement).toBe(toggle());
    expect(localStorage.getItem(RAIL_KEY)).toBeNull();
  });
});

/** Send `text` from the composer, and wait for its run to attach. */
async function send(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(input(), { key: 'Enter' });
  });
  await waitFor(() => expect(wire.deliver).not.toBeNull());
}

/** Open a kept conversation whose turn did something for every card. */
async function openWorked(width: number, saved: Partial<Conversation> = {}) {
  measurement.width = width;
  keep([asked('u-1', 'What is at risk?'), worked()], saved);
  const view = render(<Assistant />);
  await screen.findByText('Scanner delivery is the risk to escalate.');
  return view;
}

/** The transcript, where a rail row's jump lands. */
const transcript = () => screen.getByTestId('chat-scroll');

describe('the cards', () => {
  /** The rail's cards, in the order it draws them. */
  const cardIds = () =>
    [...details()!.querySelectorAll<HTMLElement>('[data-slot="rail-cards"] > [data-testid]')].map(
      (card) => card.dataset.testid,
    );

  it('holds Q5’s cards in order, each drawn from the thread', async () => {
    // Nothing waits and the book cannot be read: Waiting on you says so,
    // first, rather than leaving the rail quiet (CV-05).
    vi.mocked(listInteractions).mockImplementation(async () => {
      throw new Error('the book is unreadable');
    });
    vi.mocked(ipc.readConnectors).mockImplementation(async () => GMAIL);
    useUiStore.setState({ agentConnectors: true });
    await openWorked(1200, { reach: SAVED_REACH });
    // Each card that reads makes no claim until its read lands.
    await waitFor(() =>
      expect(cardIds()).toEqual([
        'rail-waiting',
        'rail-plan',
        'rail-subagents',
        'rail-changes',
        'rail-handoffs',
        'rail-context',
        'rail-sources',
        'rail-connectors',
        'rail-environment',
      ]),
    );
    const state = (id: string) => screen.getByTestId(id).dataset.state;
    expect(state('rail-waiting')).toBe('unavailable');
    for (const id of [
      'rail-plan',
      'rail-subagents',
      'rail-changes',
      'rail-handoffs',
      'rail-sources',
      'rail-connectors',
      'rail-environment',
    ]) {
      expect(state(id)).toBe('ready');
    }
    // A thread with no session has had no turn Claude Code could measure.
    expect(state('rail-context')).toBe('empty');
    const rail = within(details()!);
    expect(rail.getByTestId('rail-subagent').dataset.toolId).toBe('agent-1');
    expect(rail.getByTestId('rail-change').dataset.path).toBe(PAGE);
    expect(rail.getByTestId('rail-handoff').dataset.runId).toBe(handOff.run);
    expect(rail.getByTestId('rail-source').dataset.turn).toBe('a-1');
    expect(rail.getByTestId('rail-connector').dataset.name).toBe('gmail');
    expect(rail.getByTestId('rail-environment-shell').dataset.state).toBe('off');
  });

  it('shows the plan once beside a docked rail, and the dock’s wherever the rail is not', async () => {
    const view = await openKept(1200);
    await send('Make a plan');
    stream({
      kind: 'ToolStart',
      tool_name: 'TodoWrite',
      tool_id: 'todo-live',
      input: JSON.stringify({
        todos: [{ content: 'Read the risks', status: 'in_progress', activeForm: 'Reading' }],
      }),
    });
    const panel = screen.getByTestId('ai-panel');
    const dock = screen.getByTestId('live-plan');
    // The rail's card holds the list, and the aside says so; where the rail
    // docks, chat.css hides the dock's in the layout pass that docks it, and
    // React never hides it a frame late (jsdom loads no CSS: the e2e spec
    // measures it).
    expect(screen.getByTestId('rail-plan').dataset.state).toBe('ready');
    expect(panel.dataset.railPlan).toBe('true');
    expect(dock.hidden).toBe(false);
    // Turned off, the rail takes its card with it, and nothing hides the
    // dock's.
    fireEvent.click(toggle());
    expect(mounted()).toBeNull();
    expect(panel.dataset.railPlan).toBeUndefined();
    fireEvent.click(toggle());
    expect(panel.dataset.railPlan).toBe('true');
    // Folded away where it does not fit, and opened there as a drawer: still
    // the rail open on a plan, which the dock's container query reads as
    // docked only at its width.
    measurement.width = 800;
    view.rerender(<Assistant />);
    expect(mounted()?.hasAttribute('inert')).toBe(true);
    expect(panel.dataset.railPlan).toBe('true');
    fireEvent.click(toggle());
    expect(details()!.dataset.drawer).toBe('true');
    expect(screen.getByTestId('live-plan')).toBe(dock);
    expect(dock.hidden).toBe(false);
  });

  it('hides the dock’s plan only where the rail docks: one rule, under the dock’s query', () => {
    const css = readFileSync(resolve(__dirname, 'chat.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const query = '@container chat-canvas (min-width: 960px) {';
    const start = css.indexOf(query);
    expect(start).toBeGreaterThan(-1);
    // The query's block, to its closing brace.
    let depth = 0;
    let end = start + query.length - 1;
    for (; end < css.length; end += 1) {
      if (css[end] === '{') depth += 1;
      else if (css[end] === '}' && --depth === 0) break;
    }
    const docked = css.slice(start, end + 1);
    const rule =
      /\.cb-chat\[data-presentation='canvas'\]\[data-rail-plan\] \.cb-chat-plan \{\s*display: none;\s*\}/;
    expect(docked).toMatch(rule);
    // Nowhere else: folded away or a drawer, the dock's plan shows.
    expect(css.slice(0, start) + css.slice(end + 1)).not.toContain('data-rail-plan');
  });

  it('a Handed off row shows its hand-off in the canvas, and its open floats first', async () => {
    await openWorked(1200);
    const row = await within(details()!).findByTestId('rail-handoff');
    await waitFor(() => expect(row.dataset.state).toBe('done'));
    expect(row.dataset.runId).toBe(handOff.run);
    // Its first action: the hand-off's own line in the transcript, on the
    // button that opens its run there.
    fireEvent.click(within(row).getByTestId('rail-handoff-show'));
    const line = transcript().querySelector<HTMLElement>(
      '[data-testid="action-card"][data-tool-id="hand-1"]',
    )!;
    expect(document.activeElement).toBe(line.querySelector('[data-slot="subagent-handoff-run"]'));
    expect(presentation()).toBe('canvas');
    // Its second: the run, on Agents, which the canvas would hide.
    fireEvent.click(within(row).getByTestId('rail-handoff-open'));
    expect(presentation()).toBe('floating');
    expect(useNavStore.getState().selection).toEqual({
      kind: 'knowledge',
      nav: { tab: 'runs', run: handOff.run },
    });
  });

  it('Context reads the composer’s own pull: one figure, the turn it is from, no read of its own', async () => {
    await openKept(1200);
    // The session's first reading came with no breakdown, as a run that
    // took its message in argv files (an answer's resume, or any run but a
    // seated one, M92.13).
    vi.mocked(agentContextUsage).mockImplementation(async () => ({
      state: 'recorded',
      used: 30_000,
      window: 200_000,
      model: 'claude-sonnet-5',
      at: '2026-10-14T12:00:00.000Z',
    }));
    await send('Say it again');
    stream({ kind: 'Init', session_id: SESSION });
    const card = await within(details()!).findByTestId('rail-context');
    await waitFor(() => expect(card.dataset.state).toBe('partial'));
    expect(vi.mocked(agentContextUsage)).toHaveBeenCalledTimes(1);
    expect(card.textContent).toContain('Breakdown not recorded for this turn');
    // The ring's figure, word for word: one reading, one figure (O3).
    const ring = screen.getByTestId('context-use').textContent ?? '';
    expect(ring).not.toBe('');
    expect(card.textContent).toContain(`${ring} used`);
    expect(screen.getByTestId('rail-context-freshness').textContent).toMatch(
      /^From the previous turn/,
    );

    // The turn ends: the pull reads again, once, and this time Claude Code's
    // own account came with it.
    vi.mocked(agentContextUsage).mockImplementation(async () => ({
      state: 'recorded',
      used: 31_000,
      window: 200_000,
      model: 'claude-sonnet-5',
      at: '2026-10-14T12:05:00.000Z',
      breakdown: {
        categories: [
          { name: 'System prompt', tokens: 6_000, kind: 'used' },
          { name: 'MCP tools (deferred)', tokens: 450, kind: 'deferred' },
          { name: 'Messages', tokens: 24_550, kind: 'used' },
          { name: 'Free space', tokens: 169_000, kind: 'free' },
        ],
        total: 31_000,
        max: 200_000,
        model: 'claude-sonnet-5',
        mcpServers: [{ name: 'cerebro', tools: 31, loaded: 0, tokens: 0 }],
      },
    }));
    stream({ kind: 'TurnEnded', stop_reason: 'end_turn' });
    stream({ kind: 'Done' });
    await waitFor(() => expect(card.dataset.state).toBe('ready'));
    expect(vi.mocked(agentContextUsage)).toHaveBeenCalledTimes(2);
    expect(within(card).getByTestId('rail-context-categories')).toBeTruthy();
    expect(card.textContent).toContain('not loaded');
    expect(card.textContent).toContain(`${screen.getByTestId('context-use').textContent} used`);
    expect(screen.getByTestId('rail-context-freshness').textContent).toMatch(
      /^Read when the last turn ended/,
    );
  });

  it('Connectors and Environment read what the thread’s runs reach: the saved fact, then the turn’s own', async () => {
    vi.mocked(ipc.readConnectors).mockImplementation(async () => GMAIL);
    useUiStore.setState({ agentConnectors: true });
    await openWorked(1200, { reach: SAVED_REACH });
    const rail = within(details()!);
    // Before a turn: what the thread's last run said, as the thread saved it.
    const gmail = await rail.findByTestId('rail-connector');
    expect(gmail.dataset.run).toBe('not-loaded');
    await waitFor(() => expect(rail.getByTestId('rail-environment').dataset.state).toBe('ready'));
    expect(rail.getByTestId('rail-environment-shell').dataset.state).toBe('off');
    const reads = vi.mocked(ipc.readConnectors).mock.calls.length;

    // The turn's own run says what it reaches as it starts, and the rail
    // reads it from the reply.
    await send('Say it again');
    stream({ kind: 'Init', session_id: SESSION });
    stream({
      kind: 'Reach',
      reach: {
        ...SAVED_REACH,
        connectors: [{ name: 'gmail', status: 'connected' }],
        families: { ...SAVED_REACH.families, shell: ['allow'] },
      },
    });
    expect(rail.getByTestId('rail-connector').dataset.run).toBe('loaded');
    expect(rail.getByTestId('rail-connectors-mail')).toBeTruthy();
    expect(rail.getByTestId('rail-environment-shell').dataset.state).toBe('on');
    // Its words are no news to either; its end reads the list again.
    for (let word = 0; word < 5; word += 1) stream({ kind: 'TextDelta', text: `word${word} ` });
    expect(vi.mocked(ipc.readConnectors).mock.calls.length).toBe(reads);
    stream({ kind: 'TurnEnded', stop_reason: 'end_turn' });
    stream({ kind: 'Done' });
    await waitFor(() =>
      expect(vi.mocked(ipc.readConnectors).mock.calls.length).toBeGreaterThan(reads),
    );
  });

  it('a subagent row opens its line in the transcript, and the canvas stays', async () => {
    await openWorked(1200);
    const line = transcript().querySelector<HTMLElement>('[data-tool-id="agent-1"]')!;
    const fold = line.querySelector<HTMLElement>('[data-slot="trace-collapsible-trigger"]')!;
    expect(fold.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(within(details()!).getByTestId('rail-subagent'));
    expect(fold.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(fold);
    expect(presentation()).toBe('canvas');
  });

  it('a subagent row in the drawer closes it and lands on the line', async () => {
    await openWorked(800);
    fireEvent.click(toggle());
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    fireEvent.click(within(details()!).getByTestId('rail-subagent'));
    expect(details()).toBeNull();
    expect(scrim()).toBeNull();
    const line = transcript().querySelector<HTMLElement>('[data-tool-id="agent-1"]')!;
    expect(document.activeElement).toBe(
      line.querySelector('[data-slot="trace-collapsible-trigger"]'),
    );
    expect(presentation()).toBe('canvas');
  });

  it('Waiting on you jumps to the card in the transcript and lands on its first answer', async () => {
    await openKept(1200);
    await send('Escalate it');
    stream({
      kind: 'ToolStart',
      tool_name: 'mcp__cerebro__append_to_note',
      tool_id: 'ask-1',
      input: JSON.stringify({ path: PAGE, text: 'Escalate the scanner risk.' }),
    });
    stream({
      kind: 'Interaction',
      interaction: {
        id: 'card-1',
        kind: 'permission',
        tool_name: 'mcp__cerebro__append_to_note',
        tool_id: 'ask-1',
        session_id: 'session-1',
        summary: 'Append to release-plan.md',
        input: '{}',
        asked_at: '2026-10-14T12:00:00Z',
      },
    });
    const row = transcript().querySelector<HTMLElement>('[data-message-id="waiting:card-1"]');
    expect(row?.contains(screen.getByTestId('interaction-card'))).toBe(true);
    fireEvent.click(await screen.findByTestId('rail-waiting-card'));
    expect(document.activeElement).toBe(screen.getByTestId('interaction-allow'));
    expect(presentation()).toBe('canvas');
  });

  it('a Changes row shows its change in the canvas, and its open floats first', async () => {
    await openWorked(1200);
    const change = within(details()!).getByTestId('rail-change');
    // Its first action: the file's row in the turn's changeset.
    fireEvent.click(within(change).getByRole('button', { name: /^Jump to where/ }));
    const file = transcript().querySelector<HTMLElement>(
      `[data-slot="file-tree-file"][data-path="${PAGE}"]`,
    )!;
    expect(file.contains(document.activeElement)).toBe(true);
    expect(presentation()).toBe('canvas');
    // Its second: the page, which the canvas would hide.
    fireEvent.click(within(change).getByTestId('rail-change-open'));
    expect(presentation()).toBe('floating');
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: PAGE });
  });

  it('a Sources row jumps to the reply that used it, and its open floats first', async () => {
    await openWorked(1200);
    const source = within(details()!).getByTestId('rail-source');
    fireEvent.click(within(source).getByTestId('rail-source-jump'));
    const line = transcript().querySelector<HTMLElement>('[data-testid="turn-sources"]')!;
    expect(line.contains(document.activeElement)).toBe(true);
    expect(presentation()).toBe('canvas');
    fireEvent.click(within(source).getByTestId('rail-source-open'));
    expect(presentation()).toBe('floating');
    expect(useUiStore.getState().detailPath).toBe(ITEM);
  });

  it('opens a turn’s diff with the run the conversation’s fold names', async () => {
    await openWorked(1200);
    fireEvent.click(await screen.findByTestId('turn-changeset-view-diff'));
    expect(useUiStore.getState().diffView).toEqual({
      path: PAGE,
      commit: COMMIT,
      review: { conversationId: 'kept', runId: 'run-1' },
    });
  });

  it('Changes reads back the runs no reply holds while the rail shows, never one a reply holds', async () => {
    // A run of the session no reply holds: Cerebro's records read it back,
    // with what only its run's reader knew not recorded.
    const older: RunChangeset = {
      state: 'committed',
      run_id: 'run-0',
      commit: 'f00d'.padEnd(40, '0'),
      files: [
        {
          path: 'notes/older.md',
          previous_path: null,
          kind: 'added',
          additions: 4,
          deletions: 0,
          also_by: null,
        },
      ],
      additions: 4,
      deletions: 0,
      binary: 0,
      shell_unrecorded: null,
      kept_out_of_git: null,
    };
    // The reply's own run, read back with other counts: the reply's copy wins.
    const held: RunChangeset = {
      ...older,
      run_id: 'run-1',
      commit: COMMIT,
      files: [{ ...older.files[0], path: PAGE, kind: 'modified', additions: 9, deletions: 9 }],
    };
    vi.mocked(gitIpc.conversationChanges).mockImplementation(async () => ({
      changesets: [older, held],
      truncated: false,
    }));
    await openWorked(1200);
    // No session yet: nothing of it to read back.
    expect(gitIpc.conversationChanges).not.toHaveBeenCalled();
    await send('Say it again');
    stream({ kind: 'Init', session_id: SESSION });
    await waitFor(() =>
      expect(gitIpc.conversationChanges).toHaveBeenCalledWith('/demo-vault', SESSION),
    );
    const changes = within(details()!).getByTestId('rail-changes');
    const row = (path: string) =>
      changes.querySelector<HTMLElement>(`[data-testid="rail-change"][data-path="${path}"]`);
    await waitFor(() => expect(row('notes/older.md')).not.toBeNull());
    expect(row('notes/older.md')!.dataset.kind).toBe('added');
    expect(row('notes/older.md')!.textContent).toContain(RAIL_CHANGES_WORDS.alsoByNotRecorded);
    // No reply holds it, so there is nowhere in the transcript to jump to.
    expect(within(row('notes/older.md')!).queryByRole('button', { name: /^Jump to/ })).toBeNull();
    expect(row(PAGE)!.textContent).toContain('+2 −1');
    expect(row(PAGE)!.textContent).not.toContain('+9');

    // Turned off, the rail reads nothing, and a turn that ends meanwhile is
    // read back as it shows again.
    fireEvent.click(toggle());
    const asked = vi.mocked(gitIpc.conversationChanges).mock.calls.length;
    stream({ kind: 'TurnEnded', stop_reason: 'end_turn' });
    stream({ kind: 'Done' });
    await act(async () => {});
    expect(vi.mocked(gitIpc.conversationChanges).mock.calls.length).toBe(asked);
    fireEvent.click(toggle());
    await waitFor(() =>
      expect(vi.mocked(gitIpc.conversationChanges).mock.calls.length).toBe(asked + 1),
    );
  });
});

describe('the conversation list', () => {
  it('marks the open thread from its own turn', async () => {
    await openKept(1200);
    await send('Say it again');
    fireEvent.click(screen.getByTestId('conversation-switcher'));
    const row = await screen.findByTestId('conversation-row');
    expect(row.dataset.threadStatus).toBe('working');
    expect(within(row).getByTestId('thread-status').dataset.status).toBe('working');
  });
});

describe('what a rail row does', () => {
  it('its primary action stays in the canvas', async () => {
    await openKept(1200);
    const target = input();
    act(() => handed.props!.jump(() => target.focus()));
    expect(presentation()).toBe('canvas');
    expect(document.activeElement).toBe(target);
    expect(details()).not.toBeNull();
  });

  it('from the drawer, closes it without handing focus back to its opener', async () => {
    await openKept(800);
    act(() => toggle().focus());
    fireEvent.click(toggle());
    await waitFor(() => expect(document.activeElement).toBe(heading()));
    act(() => handed.props!.jump(() => input().focus()));
    expect(details()).toBeNull();
    expect(scrim()).toBeNull();
    expect(document.activeElement).toBe(input());
    expect(presentation()).toBe('canvas');
    expect(localStorage.getItem(RAIL_KEY)).toBeNull();
  });

  it('a turn’s stream never draws the rail again', async () => {
    await openKept(1200);
    fireEvent.change(input(), { target: { value: 'Say it again' } });
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' });
    });
    await waitFor(() => expect(wire.deliver).not.toBeNull());
    const drawn = handed.draws;
    const before = handed.props;
    expect(drawn).toBeGreaterThan(0);
    for (let word = 0; word < 50; word += 1) stream({ kind: 'TextDelta', text: `word${word} ` });
    expect(screen.getByText(/word49/)).toBeTruthy();
    expect(details()).not.toBeNull();
    expect(handed.draws).toBe(drawn);
    // What the panel hands it holds still too, so a card added later is not
    // drawn again by a word either.
    expect(handed.props).toEqual(before);
    expect(handed.props!.jump).toBe(before!.jump);
  });
});

/**
 * A secondary action opens a page or the record peek, which the canvas
 * hides (`display: none` under the shell's `data-chat-canvas`, and inert):
 * the conversation floats first. A diff on the page already open changes no
 * selection, so nothing else would float it.
 */
describe('a secondary open, in the shell', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: null,
      entries: [],
      views: [],
      status: 'idle',
      error: null,
    });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [navSeed({ kind: 'home' })],
      historyIndex: 0,
    });
    useUiStore.setState({ aiPanelOpen: false, aiPanelPresentation: 'floating', diffView: null });
  });

  async function canvasShell() {
    vi.mocked(ipc.scanVault).mockResolvedValueOnce(fixtureVault());
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    await waitFor(() => expect(useVaultStore.getState().status).toBe('ready'));
    const shell = screen.getByTestId('main-column').parentElement!;
    const page = document.getElementById('main')!;
    return { shell, page };
  }

  it('floats before it opens the record peek, so the peek is drawn and the page live', async () => {
    const { shell, page } = await canvasShell();
    act(() => useUiStore.getState().openAssistantCanvas());
    expect(shell.hasAttribute('data-chat-canvas')).toBe(true);
    expect(page.hasAttribute('inert')).toBe(true);
    let during: string | null = null;
    act(() =>
      openOutside(() => {
        during = presentation();
        useUiStore.getState().openDetail(ITEM);
      }),
    );
    expect(during).toBe('floating');
    const peek = (await screen.findByTestId('detail-panel')).closest('.m71-detail-frame')!;
    expect(shell.hasAttribute('data-chat-canvas')).toBe(false);
    expect(peek.hasAttribute('inert')).toBe(false);
    expect(page.hasAttribute('inert')).toBe(false);
  });

  it('floats before a diff of the page already open, which no navigation would float', async () => {
    const { shell, page } = await canvasShell();
    act(() => useNavStore.getState().navigate({ kind: 'doc', path: ITEM }));
    await screen.findByTestId('doc-page');
    await act(async () => {});
    act(() => useUiStore.getState().openAssistantCanvas());
    expect(page.hasAttribute('inert')).toBe(true);
    // Opened plainly, the diff waits behind the canvas.
    act(() => useUiStore.getState().openDiff(ITEM, null));
    expect(presentation()).toBe('canvas');
    act(() => useUiStore.getState().closeDiff());
    act(() => openOutside(() => useUiStore.getState().openDiff(ITEM, null)));
    expect(presentation()).toBe('floating');
    expect(useUiStore.getState().diffView).toEqual({ path: ITEM, commit: null });
    expect(shell.hasAttribute('data-chat-canvas')).toBe(false);
    expect(page.hasAttribute('inert')).toBe(false);
    await act(async () => {});
  });
});
