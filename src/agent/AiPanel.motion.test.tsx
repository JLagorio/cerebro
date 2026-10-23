// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentStreamEvent } from './types';

const wire = vi.hoisted(() => ({
  deliver: null as ((event: AgentEvent) => void) | null,
}));

vi.mock('./agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentIpc')>();
  return {
    ...actual,
    runAgent: vi.fn(async () => ({ run: 8, durableId: 'motion-8', attach: 'motion-8' })),
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
  };
});

import { AiPanel } from './AiPanel';
import { forgetDraftsInMemory } from './drafts';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { fixtureVault } from '@/test/factories';

/** A kept thread, as the conversation list stores it. */
function thread(id: string, title: string, said: string) {
  return {
    id,
    title,
    usesDefaultTitle: false,
    sessionId: null,
    createdAt: '2026-10-14T12:00:00Z',
    vault: '/demo-vault',
    archived: false,
    place: null,
    messages: [
      { id: `${id}-asked`, role: 'user', text: `Asked in ${title}`, tools: [] },
      { id: `${id}-said`, role: 'assistant', text: said, tools: [] },
    ],
  };
}

const messages = () => screen.getAllByTestId('chat-message');
const arriving = (el: Element) => el.hasAttribute('data-arrive');

function send(text: string) {
  const input = screen.getByLabelText('Message the assistant');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

/** Opens a kept thread from the header's switcher, by its row. */
function open(title: string) {
  fireEvent.click(screen.getByTestId('conversation-switcher'));
  const row = screen.getAllByTestId('conversation-row').find((r) => r.textContent?.includes(title));
  if (row === undefined) throw new Error(`no row for ${title}`);
  fireEvent.click(within(row).getAllByRole('button')[0]);
}

/** The stream of the turn just sent, as its run's events. */
let seq = 0;
function stream(event: AgentStreamEvent) {
  seq += 1;
  act(() => wire.deliver?.({ ...event, run: 8, seq }));
}

// Arrivals (owner, 2026-10-19): what a send appends comes in, and what a
// thread opens with is simply there. jsdom plays no animation, so each mark
// stays until a test ends its entrance by hand.
describe('what arrives in the conversation', () => {
  beforeEach(() => {
    localStorage.clear();
    forgetDraftsInMemory();
    vi.clearAllMocks();
    wire.deliver = null;
    seq = 0;
    Element.prototype.scrollTo ??= () => {};
    localStorage.setItem('cerebro.activeConversation', 'first');
    localStorage.setItem(
      'cerebro.conversations',
      JSON.stringify([
        thread('first', 'First thread', 'An answer from before.'),
        thread('second', 'Second thread', 'Another answer from before.'),
      ]),
    );
    useVaultStore.setState({ vaultPath: '/demo-vault', entries: fixtureVault(), views: [] });
    useNavStore.setState({ selection: { kind: 'home' } });
    useUiStore.setState({
      aiPanelOpen: true,
      aiPanelPresentation: 'floating',
      aiPanelMinimized: false,
      panelConversation: null,
      panelAgents: { '/demo-vault': null },
      handoffs: [],
      runs: [],
      detailPath: null,
    });
  });

  afterEach(cleanup);

  it('brings in what a send appends, never the history the thread opened with', async () => {
    render(<AiPanel presentation="floating" />);
    await screen.findByText('An answer from before.');
    expect(messages().filter(arriving)).toEqual([]);
    send('What is new?');
    await waitFor(() => expect(messages()).toHaveLength(4));
    const [asked, said, question, reply] = messages();
    expect([asked, said].some(arriving)).toBe(false);
    expect(question.dataset.role).toBe('user');
    expect(arriving(question)).toBe(true);
    expect(reply.dataset.role).toBe('assistant');
    expect(arriving(reply)).toBe(true);
    // Each mark comes off when its own entrance ends, so unfolding the
    // conversation again plays nothing twice; a part's ending is not its.
    fireEvent.animationEnd(question);
    expect(arriving(question)).toBe(false);
    fireEvent.animationEnd(within(reply).getByText('Thinking…'));
    expect(arriving(reply)).toBe(true);
    fireEvent.animationEnd(reply);
    expect(arriving(reply)).toBe(false);
  });

  it('brings in a reply’s first words with their box, and each later block on its own', async () => {
    render(<AiPanel presentation="floating" />);
    await screen.findByText('An answer from before.');
    send('Write two paragraphs');
    await waitFor(() => expect(wire.deliver).not.toBeNull());
    stream({ kind: 'TextDelta', text: 'The first paragraph.' });
    const reply = messages()[3];
    const answer = reply.querySelector('.cb-chat-answer')!;
    expect(arriving(answer)).toBe(true);
    stream({ kind: 'TextDelta', text: '\n\nThe second paragraph.' });
    const blocks = [...reply.querySelectorAll('.cb-message-markdown > *')];
    expect(blocks.map((b) => b.textContent)).toEqual([
      'The first paragraph.',
      'The second paragraph.',
    ]);
    expect(blocks.map(arriving)).toEqual([false, true]);
    // Working, the reply says so under its words, in dots and its working
    // line (M92.2), both hidden from assistive tech.
    expect(reply.querySelector('.cb-chat-dots')?.getAttribute('aria-hidden')).toBe('true');
    expect(reply.querySelector('[data-testid="turn-working"]')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  it('pops Stop in as a turn starts and Send back as it ends, and neither at mount', async () => {
    render(<AiPanel presentation="floating" />);
    await screen.findByText('An answer from before.');
    const sendSlot = () => screen.getByRole('button', { name: 'Send' }).parentElement!;
    expect(arriving(sendSlot())).toBe(false);
    send('Go on');
    const stop = await screen.findByRole('button', { name: 'Stop' });
    expect(arriving(stop)).toBe(true);
    stream({ kind: 'Text', message_id: 'm-1', text: 'Done.' });
    stream({ kind: 'TurnEnded' });
    stream({ kind: 'Done' });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull());
    expect(arriving(sendSlot())).toBe(true);
  });

  it('replays nothing in a thread opened again', async () => {
    render(<AiPanel presentation="floating" />);
    await screen.findByText('An answer from before.');
    send('Something new');
    await waitFor(() => expect(messages()).toHaveLength(4));
    expect(messages().filter(arriving)).toHaveLength(2);
    open('Second thread');
    await screen.findByText('Another answer from before.');
    expect(messages().filter(arriving)).toEqual([]);
    open('First thread');
    await screen.findByText('Something new');
    expect(messages()).toHaveLength(4);
    expect(messages().filter(arriving)).toEqual([]);
  });
});
