// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentStreamEvent, ChatMessage, Conversation } from './types';
import type { ConversationRailProps } from './rail/ConversationRail';

const wire = vi.hoisted(() => ({ deliver: null as ((event: AgentEvent) => void) | null }));

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
  };
});

import App from '@/App';
import { AiPanel } from './AiPanel';
import { forgetDraftsInMemory } from './drafts';
import { openOutside } from './rail/ConversationRail';
import { useAppCommands } from '@/app/useAppCommands';
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
 * the panel's word on it is.
 */

const RAIL_KEY = 'cerebro.chatRailOpen';
/** A path fixtureVault holds, so the record peek and the page have one. */
const ITEM = 'projects/onboarding/items/fld-1.md';

const asked = (id: string, text: string): ChatMessage => ({ id, role: 'user', text, tools: [] });
const replied = (id: string, text: string): ChatMessage => ({
  id,
  role: 'assistant',
  text,
  tools: [],
});

/** A kept thread with a turn in it, so the conversation is not welcoming. */
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
    messages: [asked('u-1', 'What is at risk?'), replied('a-1', 'The rollout moves a week.')],
  };
  localStorage.setItem('cerebro.activeConversation', thread.id);
  localStorage.setItem('cerebro.conversations', JSON.stringify([thread]));
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
    // No card draws a body in a conversation that holds nothing yet.
    expect(rail.querySelectorAll('[data-slot="rail-section"]')).toHaveLength(0);
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
