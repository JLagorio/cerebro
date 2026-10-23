// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentStreamEvent, Conversation } from './types';

const wire = vi.hoisted(() => ({
  deliver: null as ((event: AgentEvent) => void) | null,
}));

/** The paths the panel asked the app to open. */
const opened = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('./agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentIpc')>();
  return {
    ...actual,
    runAgent: vi.fn(async () => ({ run: 8, durableId: 'sources-8', attach: 'sources-8' })),
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

vi.mock('@/app/useOpenPath', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/useOpenPath')>();
  return {
    ...actual,
    useOpenPath: () => (path: string) => {
      opened.paths.push(path);
      return { kind: 'unchanged', pane: 'main' };
    },
  };
});

import { AiPanel } from './AiPanel';
import * as agentIpc from './agentIpc';
import { forgetDraftsInMemory } from './drafts';
import { SOURCES_WORDS } from '@/components/ai/Sources';
import { fixtureVault, makeEntry } from '@/test/factories';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The panel's own sources (M91.14): the pull requests a session opened, under
 * its thread, and the Knowledge the next turn carries, under its context,
 * each the Sources element's line opening onto its rows — keeping the ids the
 * specs press (`thread-pr-links`, `context-knowledge`, its list), and the
 * link rule: only an http(s) address is ever an href, which says it opens a
 * new tab; a vault page opens in the app (CV-16).
 */

const SESSION = '00000000-0000-4000-8000-0000000000bb';

/** A kept thread, as the conversation list stores it, opened in the panel. */
function keep(over: Partial<Conversation> = {}) {
  const thread: Conversation = {
    id: 'kept',
    title: 'Release',
    usesDefaultTitle: false,
    sessionId: null,
    createdAt: '2026-10-14T12:00:00Z',
    vault: '/demo-vault',
    archived: false,
    place: null,
    messages: [],
    ...over,
  };
  localStorage.setItem('cerebro.activeConversation', thread.id);
  localStorage.setItem('cerebro.conversations', JSON.stringify([thread]));
}

const input = () => screen.getByLabelText('Message the assistant') as HTMLTextAreaElement;

let seq = 0;
function stream(event: AgentStreamEvent) {
  seq += 1;
  act(() => wire.deliver?.({ ...event, run: 8, seq }));
}

/** Every link the panel draws goes to the web, never to a vault path. */
function onlyWebLinks() {
  for (const link of screen.getByTestId('ai-panel').querySelectorAll('a')) {
    expect(link.getAttribute('href') ?? '', link.outerHTML).toMatch(/^https?:\/\//);
  }
}

beforeEach(() => {
  localStorage.clear();
  forgetDraftsInMemory();
  vi.clearAllMocks();
  wire.deliver = null;
  opened.paths = [];
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

describe('the pull requests a session opened', () => {
  const PULL = 'https://github.com/acme/app/pull/42';

  it('lists them under the thread read back, open, each a link that says it opens a new tab', async () => {
    keep({ sessionId: SESSION });
    vi.mocked(agentIpc.readCliTranscript).mockResolvedValueOnce({
      state: 'read',
      lines: 4,
      unclassified: [],
      events: [
        { kind: 'UserPrompt', text: 'Open a pull request for the fix' },
        { kind: 'Text', message_id: 'm-1', text: 'Opened acme/app#42.' },
        { kind: 'TurnEnded' },
        { kind: 'PrLink', number: 42, url: PULL, repository: 'acme/app' },
        // Rust passes only https; a record that slipped past it is words.
        { kind: 'PrLink', number: 7, url: 'javascript:alert(1)', repository: 'acme/site' },
      ],
    });
    render(<AiPanel presentation="panel" />);
    const links = await screen.findByTestId('thread-pr-links');
    expect(links.dataset.slot).toBe('sources');
    // A row of the transcript, after its messages.
    const rows = [...screen.getByRole('log').children].filter(
      (el) => el instanceof HTMLElement && el.dataset.slot === 'message-scroller-item',
    );
    expect(rows.at(-1)?.contains(links)).toBe(true);
    // Open from the start: they are what the session made.
    const line = within(links).getByRole('button', { name: 'Opened 2 pull requests' });
    expect(line.getAttribute('aria-expanded')).toBe('true');
    const link = within(links).getByRole('link', {
      name: `acme/app#42 github.com${SOURCES_WORDS.newTab}`,
    });
    expect(link.getAttribute('href')).toBe(PULL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noreferrer noopener');
    expect(within(links).getAllByRole('link')).toHaveLength(1);
    const words = within(links).getByText('acme/site#7');
    expect(words.closest('a')).toBeNull();
    onlyWebLinks();
  });

  it('comes in under the turn that opened one, once', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    fireEvent.change(input(), { target: { value: 'Open a pull request' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(wire.deliver).not.toBeNull());
    expect(screen.queryByTestId('thread-pr-links')).toBeNull();
    stream({ kind: 'PrLink', number: 42, url: PULL, repository: 'acme/app' });
    stream({ kind: 'PrLink', number: 42, url: PULL, repository: 'acme/app' });
    const links = screen.getByTestId('thread-pr-links');
    expect(links.hasAttribute('data-arrive')).toBe(true);
    expect(within(links).getByRole('button', { name: 'Opened 1 pull request' })).toBeTruthy();
    expect(within(links).getAllByRole('link')).toHaveLength(1);
    onlyWebLinks();
  });
});

describe('the Knowledge the next turn carries', () => {
  const PAGE = makeEntry({ path: 'notes/atlas.md', title: 'Atlas' });
  const concept = (
    path: string,
    title: string,
    links: Record<string, string[]> = {},
    props: Record<string, unknown> = {},
  ) =>
    makeEntry({
      path: `knowledge/concepts/${path}`,
      title,
      properties: {
        type: 'concept',
        description: `${title} claim.`,
        ...props,
      } as unknown as Record<string, never>,
      relationships: { about: ['Atlas'], ...links },
    });
  const KNOWLEDGE = [
    concept(
      'cutover.md',
      'Warehouse cutover',
      {},
      {
        verified: [{ by: 'human:me', at: '2026-07-01' }],
      },
    ),
    concept('old.md', 'The offline window'),
    concept('new.md', 'Offline sync window', { supersedes: ['The offline window'] }),
  ];

  beforeEach(() => {
    useVaultStore.setState({ entries: [...fixtureVault(), PAGE, ...KNOWLEDGE] });
    useNavStore.setState({ selection: { kind: 'doc', path: PAGE.path } });
  });

  const line = () => screen.getByTestId('context-knowledge');
  const list = () => screen.getByTestId('context-knowledge-list');

  it('is a line under the context that counts what stands, opening onto every concept', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    expect(line()).toBe(screen.getByRole('button', { name: 'Knowledge · 2' }));
    expect(line().textContent).toContain('Knowledge · 2');
    const context = screen.getByTestId('chat-context');
    expect(context.contains(line())).toBe(true);
    expect(screen.getByTestId('context-chips').contains(line())).toBe(false);
    // Closed until asked, its concepts kept in the document.
    expect(line().getAttribute('aria-expanded')).toBe('false');
    expect(list().closest('[hidden]')).not.toBeNull();
    fireEvent.click(line());
    expect(line().getAttribute('aria-expanded')).toBe('true');
    expect(list().closest('[hidden]')).toBeNull();
    // What stands first, then the replaced one, last, saying so.
    const row = (name: string) => within(list()).getByRole('button', { name });
    expect(within(list()).getAllByRole('button')).toEqual([
      row('Open Offline sync window · unreviewed'),
      row('Open Warehouse cutover'),
      row('Open The offline window · replaced'),
    ]);
    const replaced = row('Open The offline window · replaced');
    expect(replaced.textContent).toContain('The offline window');
    expect(replaced.textContent).toContain('· replaced');
    expect(replaced.textContent).not.toContain('unreviewed');
  });

  it('opens a concept in the app, never through an href', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    fireEvent.click(line());
    const cutover = within(list()).getByRole('button', { name: 'Open Warehouse cutover' });
    expect(cutover.closest('a')).toBeNull();
    fireEvent.click(within(list()).getByText('Warehouse cutover'));
    expect(opened.paths).toEqual(['knowledge/concepts/cutover.md']);
    expect(list().querySelector('a')).toBeNull();
    onlyWebLinks();
  });

  it('follows the chips: taking the page out takes its knowledge with it', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    expect(line()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Atlas from context' }));
    expect(screen.queryByTestId('context-knowledge')).toBeNull();
    expect(screen.queryByTestId('context-knowledge-list')).toBeNull();
  });
});

describe('the transcript’s way back to the latest', () => {
  it('keeps the jump-to-latest id the specs press', async () => {
    keep({
      messages: [
        { id: 'u-1', role: 'user', text: 'Asked before', tools: [] },
        { id: 'a-1', role: 'assistant', text: 'Answered before.', tools: [] },
      ],
    });
    render(<AiPanel presentation="panel" />);
    await screen.findByText('Answered before.');
    expect(screen.getByTestId('jump-to-latest')).toBe(
      screen.getByRole('button', { name: 'Jump to latest' }),
    );
  });
});
