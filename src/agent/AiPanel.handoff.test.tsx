// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Conversation } from './types';

// Every run the panel starts gets its own attach key, so a turn left running
// in one thread stays attached to its own run.
const wire = vi.hoisted(() => ({
  runs: 0,
  delivers: [] as ((event: AgentEvent) => void)[],
}));

vi.mock('./agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentIpc')>();
  return {
    ...actual,
    runAgent: vi.fn(async () => {
      wire.runs += 1;
      return { run: wire.runs, durableId: `handoff-${wire.runs}`, attach: `handoff-${wire.runs}` };
    }),
    attachRun: vi.fn(async (_handle, _after, deliver: (event: AgentEvent) => void) => {
      wire.delivers.push(deliver);
      return { state: 'held', done: false, detach: vi.fn() };
    }),
    stopAgent: vi.fn(async () => true),
    cancelInteraction: vi.fn(async () => true),
    listInteractions: vi.fn(async () => []),
    readCliTranscript: vi.fn(async () => ({
      state: 'unavailable',
      reason: 'not_recorded',
      retention_days: 30,
    })),
  };
});

import { AiPanel } from './AiPanel';
import * as agentIpc from './agentIpc';
import { forgetDraftsInMemory } from './drafts';
import { useUiStore } from '@/stores/uiStore';
import { useUpNextStore } from '@/stores/upNextStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { fixtureVault } from '@/test/factories';

const ANA = 'people/ana-rios.md';
const FLD = 'projects/onboarding/items/fld-1.md';

const ask = (text: string, subject: string | null, label: string | null) =>
  act(() => useUiStore.getState().askAgent(text, subject, label));

const stored = (): Conversation[] =>
  JSON.parse(localStorage.getItem('cerebro.conversations') ?? '[]') as Conversation[];
const activeId = () => localStorage.getItem('cerebro.activeConversation');
const thread = (id: string | null) => stored().find((c) => c.id === id);
const bubbles = () =>
  screen
    .queryAllByTestId('chat-message')
    .filter((m) => m.dataset.role === 'user')
    .map((m) => m.textContent);
const chips = () => screen.queryAllByTestId('context-chip').map((c) => c.textContent);
const sent = () => vi.mocked(agentIpc.runAgent).mock.calls.map(([, options]) => options);

/** A thread as the conversation list keeps it, with one exchange in it. */
function kept(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: 'Kept thread',
    usesDefaultTitle: false,
    sessionId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    createdAt: '2026-10-14T12:00:00Z',
    vault: '/demo-vault',
    archived: false,
    place: null,
    messages: [
      { id: `${id}-asked`, role: 'user', text: 'What did we decide?', tools: [] },
      { id: `${id}-said`, role: 'assistant', text: 'We kept the plan.', tools: [] },
    ],
    ...over,
  };
}

function keep(...threads: Conversation[]) {
  localStorage.setItem('cerebro.conversations', JSON.stringify(threads));
  localStorage.setItem('cerebro.activeConversation', threads[0].id);
}

function type(text: string) {
  const input = screen.getByLabelText('Message the assistant');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

// A page's ask (Knowledge, Inbox, a concept's review bar, Quick Open) is its
// own conversation: it joins the active one only while nothing has happened
// in it, and never stops the turn it leaves (M57.6).
describe('a handoff opens its own conversation', () => {
  beforeEach(() => {
    localStorage.clear();
    forgetDraftsInMemory();
    vi.clearAllMocks();
    wire.runs = 0;
    wire.delivers = [];
    Element.prototype.scrollTo ??= () => {};
    useUpNextStore.setState({ queues: {} });
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
    });
  });

  afterEach(cleanup);

  it('is sent in the active conversation while nothing has happened in it', async () => {
    render(<AiPanel presentation="panel" />);
    await waitFor(() => expect(activeId()).not.toBeNull());
    const first = activeId();

    ask('Revise the record at people/ana-rios.md.', ANA, 'Ask to revise · Ana Rios');
    await waitFor(() => expect(agentIpc.runAgent).toHaveBeenCalledOnce());
    expect(sent()[0].message).toBe('Revise the record at people/ana-rios.md.');
    expect(activeId()).toBe(first);
    expect(stored()).toHaveLength(1);
    expect(bubbles()).toEqual(['Ask to revise · Ana Rios']);
    expect(chips()).toContain('Ana Rios');
    await waitFor(() => expect(thread(first)?.title).toBe('Ask to revise · Ana Rios'));
  });

  it('opens a new conversation beside a running turn, which goes on', async () => {
    render(<AiPanel presentation="panel" />);
    type('What is slipping?');
    await waitFor(() => expect(wire.delivers).toHaveLength(1));
    const first = activeId();

    ask('Revise the record at people/ana-rios.md.', ANA, 'Ask to revise · Ana Rios');
    await waitFor(() => expect(agentIpc.runAgent).toHaveBeenCalledTimes(2));
    expect(sent()[1].message).toBe('Revise the record at people/ana-rios.md.');
    expect(activeId()).not.toBe(first);
    // Nothing waits in the thread it left, and its turn was never stopped.
    expect(useUpNextStore.getState().queues[first!]?.entries ?? []).toEqual([]);
    expect(agentIpc.stopAgent).not.toHaveBeenCalled();
    expect(bubbles()).toEqual(['Ask to revise · Ana Rios']);
    expect(chips()).toContain('Ana Rios');
    // The thread left keeps its question and the turn it has running.
    expect(thread(first)?.messages[0].text).toBe('What is slipping?');
    expect(thread(first)?.live).toMatchObject({ run: 1, attach: 'handoff-1' });
    await waitFor(() => expect(thread(activeId())?.title).toBe('Ask to revise · Ana Rios'));
  });

  it('gives two asks in quick succession a conversation each, with its own subject', async () => {
    render(<AiPanel presentation="panel" />);
    await waitFor(() => expect(activeId()).not.toBeNull());
    act(() => {
      useUiStore.getState().askAgent('Read Ana.', ANA, 'Ask · Ana Rios');
      useUiStore.getState().askAgent('Read the flow.', FLD, 'Ask · Design first-run flow');
    });
    await waitFor(() => expect(agentIpc.runAgent).toHaveBeenCalledTimes(2));
    expect(sent().map((o) => o.message)).toEqual(['Read Ana.', 'Read the flow.']);
    // Each turn was asked with its own subject in context, not the other's.
    expect(sent()[0].systemPrompt).toContain(ANA);
    expect(sent()[0].systemPrompt).not.toContain(FLD);
    expect(sent()[1].systemPrompt).toContain(FLD);
    expect(sent()[1].systemPrompt).not.toContain(ANA);
    expect(agentIpc.stopAgent).not.toHaveBeenCalled();
    expect(useUiStore.getState().handoffs).toEqual([]);
    await waitFor(() =>
      expect(stored().map((c) => c.title)).toEqual(
        expect.arrayContaining(['Ask · Ana Rios', 'Ask · Design first-run flow']),
      ),
    );
    expect(stored()).toHaveLength(2);
    expect(bubbles()).toEqual(['Ask · Design first-run flow']);
    expect(chips()).toContain('Design first-run flow');
    expect(chips()).not.toContain('Ana Rios');
  });

  it('leaves a thread restored as the panel opens whole', async () => {
    keep(kept('kept'));
    // Asked before the panel is drawn, as a closed panel is asked.
    ask('Revise the record at people/ana-rios.md.', ANA, 'Ask to revise · Ana Rios');
    render(<AiPanel presentation="panel" />);
    await waitFor(() => expect(agentIpc.runAgent).toHaveBeenCalledOnce());
    expect(activeId()).not.toBe('kept');
    expect(bubbles()).toEqual(['Ask to revise · Ana Rios']);
    const left = thread('kept');
    expect(left?.messages.map((m) => m.text)).toEqual(['What did we decide?', 'We kept the plan.']);
    expect(left?.sessionId).toBe('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    // The new thread starts its own session, never the kept one's.
    expect(sent()[0].sessionId).toBeNull();
  });

  it('opens a new conversation for a thread that cannot continue (M56.3)', async () => {
    keep(kept('elsewhere', { vault: '/another-vault', sessionId: null }));
    render(<AiPanel presentation="panel" />);
    await screen.findByTestId('thread-blocked');

    ask('What is slipping?', null, null);
    await waitFor(() => expect(agentIpc.runAgent).toHaveBeenCalledOnce());
    expect(activeId()).not.toBe('elsewhere');
    expect(screen.queryByTestId('thread-blocked')).toBeNull();
    expect(bubbles()).toEqual(['What is slipping?']);
    expect(thread('elsewhere')?.messages).toHaveLength(2);
  });
});
