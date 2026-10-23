// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './types';

const wire = vi.hoisted(() => ({
  deliver: null as ((event: AgentEvent) => void) | null,
  detach: vi.fn(),
}));

vi.mock('./agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentIpc')>();
  return {
    ...actual,
    runAgent: vi.fn(async () => ({ run: 8, durableId: 'floating-8', attach: 'floating-8' })),
    attachRun: vi.fn(async (_handle, _after, deliver: (event: AgentEvent) => void) => {
      wire.deliver = deliver;
      return { state: 'held', done: false, detach: wire.detach };
    }),
    answerInteraction: vi.fn(async () => ({
      resumed: { run: 9, durableId: 'floating-9', sessionId: 'session-1', attach: 'floating-9' },
    })),
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
import { useAppCommands } from '@/app/useAppCommands';
import { runCommand } from '@/lib/keys/registry';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { fixtureVault } from '@/test/factories';

function FloatingAssistant() {
  const presentation = useUiStore((state) => state.aiPanelPresentation);
  return <AiPanel presentation={presentation} />;
}

/** The composer by its label, so a hidden (minimized) one is found too: the
 * same node must survive every fold. */
const input = () => screen.getByLabelText('Message the assistant') as HTMLTextAreaElement;
/** The one round button a minimized conversation rests as. */
const fab = () => screen.getByRole('button', { name: 'Open conversation' });

describe('one floating conversation', () => {
  beforeEach(() => {
    localStorage.clear();
    forgetDraftsInMemory();
    vi.clearAllMocks();
    wire.deliver = null;
    Element.prototype.scrollTo ??= () => {};
    useVaultStore.setState({ vaultPath: '/demo-vault', entries: fixtureVault(), views: [] });
    useNavStore.setState({ selection: { kind: 'home' } });
    useUiStore.setState({
      aiPanelOpen: true,
      aiPanelPresentation: 'floating',
      aiPanelMinimized: true,
      panelConversation: null,
      panelAgents: { '/demo-vault': null },
      handoffs: [],
      runs: [],
      detailPath: null,
    });
  });

  afterEach(cleanup);

  it.each(['expired', 'elsewhere'] as const)(
    'keeps a folded %s thread reviewable without starting a new conversation automatically',
    async (reason) => {
      localStorage.setItem('cerebro.activeConversation', 'blocked-thread');
      localStorage.setItem(
        'cerebro.conversations',
        JSON.stringify([
          {
            id: 'blocked-thread',
            title: 'Retained thread',
            usesDefaultTitle: false,
            sessionId: reason === 'expired' ? 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' : null,
            createdAt: '2026-10-14T12:00:00Z',
            vault: reason === 'elsewhere' ? '/another-vault' : '/demo-vault',
            archived: false,
            place: null,
            messages: [
              {
                id: 'retained-message',
                role: 'assistant',
                text: 'Keep this conversation history.',
                tools: [],
              },
            ],
          },
        ]),
      );
      if (reason === 'expired') {
        vi.mocked(agentIpc.readCliTranscript).mockResolvedValueOnce({
          state: 'unavailable',
          reason: 'expired',
          retention_days: 30,
        });
      }
      render(<FloatingAssistant />);
      // The round button names the thread it opens as unavailable.
      const opener = await screen.findByRole('button', { name: 'Open unavailable conversation' });
      expect(opener).toBe(screen.getByTestId('ai-panel-fab'));
      expect(screen.getByTestId('ai-panel').dataset.minimized).toBe('true');
      const message = screen.getByText('Keep this conversation history.');
      expect(message.closest('[hidden]')).not.toBeNull();
      expect(screen.getByTestId('thread-blocked').closest('[hidden]')).not.toBeNull();
      expect(localStorage.getItem('cerebro.activeConversation')).toBe('blocked-thread');
      fireEvent.click(opener);
      expect(screen.getByTestId('ai-panel').dataset.minimized).toBeUndefined();
      expect(screen.queryByTestId('ai-panel-fab')).toBeNull();
      expect(screen.getByText('Keep this conversation history.')).toBe(message);
      expect(message.closest('[hidden]')).toBeNull();
      expect(screen.getByTestId('thread-blocked').closest('[hidden]')).toBeNull();
      expect(document.activeElement).toBe(screen.getByTestId('thread-blocked'));
      fireEvent.keyDown(screen.getByTestId('thread-blocked'), { key: 'Escape' });
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Open unavailable conversation' }),
        ),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Open unavailable conversation' }));
      expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Start a new conversation' }));
      expect(screen.getByRole('textbox', { name: 'Message the assistant' })).toBe(input());
      expect(localStorage.getItem('cerebro.activeConversation')).not.toBe('blocked-thread');
      expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    },
  );

  it('starts as one round button without taking focus, and keeps the same input, draft and caret through folding and presentation changes', async () => {
    render(<FloatingAssistant />);
    const panel = screen.getByTestId('ai-panel');
    const composer = input();
    expect(panel.dataset.minimized).toBe('true');
    // Nothing else is reachable: the header and the body are hidden, never
    // unmounted, and the button is the panel's one control.
    expect(within(panel).getAllByRole('button')).toEqual([fab()]);
    expect(screen.queryByRole('textbox', { name: 'Message the assistant' })).toBeNull();
    expect(composer.closest('[hidden]')).not.toBeNull();
    expect(fab().getAttribute('aria-expanded')).toBe('false');
    expect(fab().dataset.state).toBeUndefined();
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(fab());
    expect(panel.dataset.minimized).toBeUndefined();
    expect(screen.queryByTestId('ai-panel-fab')).toBeNull();
    expect(input()).toBe(composer);
    await waitFor(() => expect(document.activeElement).toBe(composer));
    fireEvent.change(composer, { target: { value: 'A draft that stays with this thread' } });
    composer.setSelectionRange(7, 12);
    const thread = localStorage.getItem('cerebro.activeConversation');
    fireEvent.click(screen.getByRole('button', { name: 'Minimize conversation' }));
    expect(panel.dataset.minimized).toBe('true');
    expect(input()).toBe(composer);
    // Minimize hands focus to the button that brings the conversation back.
    expect(document.activeElement).toBe(fab());
    fireEvent.click(fab());
    expect(input()).toBe(composer);
    await waitFor(() => expect(document.activeElement).toBe(composer));
    expect(composer.selectionStart).toBe(7);
    expect(composer.selectionEnd).toBe(12);
    act(() => useUiStore.getState().openAssistantCanvas());
    expect(screen.getByTestId('ai-panel')).toBe(panel);
    expect(input()).toBe(composer);
    act(() => useUiStore.getState().openAssistantFloating());
    expect(input()).toBe(composer);
    expect(composer.value).toBe('A draft that stays with this thread');
    expect(localStorage.getItem('cerebro.activeConversation')).toBe(thread);
    act(() => useUiStore.getState().setAiPanelMinimized(true));
    expect(screen.queryByRole('button', { name: 'Add context' })).toBeNull();
    fireEvent.click(fab());
    fireEvent.click(screen.getByRole('button', { name: 'Add context' }));
    expect(useUiStore.getState().aiPanelMinimized).toBe(false);
    expect(input()).toBe(composer);
    expect(composer.value).toBe('A draft that stays with this thread @');
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled());
  });

  // The button is a tab stop (WebKit skips a native button without one), and
  // focus a fold hands it is not a person arriving: no tooltip comes up to
  // take the next Escape. Leaving and coming back is an arrival, and names it.
  it('rests as a tab stop, and a fold that hands it focus brings up no tooltip', async () => {
    render(<FloatingAssistant />);
    expect(fab().tabIndex).toBe(0);
    fireEvent.click(fab());
    await waitFor(() => expect(document.activeElement).toBe(input()));
    fireEvent.click(screen.getByRole('button', { name: 'Minimize conversation' }));
    expect(document.activeElement).toBe(fab());
    await act(() => new Promise((resolve) => setTimeout(resolve, 600)));
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focusOut(fab());
    fireEvent.focusIn(fab());
    expect(await screen.findByRole('tooltip')).toBeTruthy();
  });

  it('discloses conversation controls without replacing the draft or thread', async () => {
    render(<FloatingAssistant />);
    await act(async () => {});
    fireEvent.click(fab());
    const composer = input();
    fireEvent.change(composer, { target: { value: 'Keep this draft while docking' } });
    const thread = localStorage.getItem('cerebro.activeConversation');
    expect(screen.queryByRole('button', { name: 'Dock conversation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close AI panel' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Conversation options' }));
    expect(screen.getByRole('menuitem', { name: 'New conversation' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Close AI panel' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: 'Dock conversation' })).toBeNull();
    expect(useUiStore.getState().aiPanelMinimized).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Conversation options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Dock conversation' }));
    expect(useUiStore.getState().aiPanelPresentation).toBe('panel');
    expect(input()).toBe(composer);
    expect(composer.value).toBe('Keep this draft while docking');
    expect(localStorage.getItem('cerebro.activeConversation')).toBe(thread);
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
  });

  it('shows the included context in a disclosure and removes it without remounting the input', async () => {
    render(<FloatingAssistant />);
    fireEvent.click(fab());
    const composer = input();
    fireEvent.change(composer, { target: { value: 'A question with intentional context' } });
    const context = screen.getByRole('button', { name: 'Context: Home' });
    expect(screen.queryByTestId('context-chips')).toBeNull();
    expect(screen.queryByTestId('chat-welcome')).toBeNull();
    fireEvent.click(context);
    expect(screen.getByRole('button', { name: 'Remove Home from context' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('context-chips')).toBeNull();
    expect(useUiStore.getState().aiPanelMinimized).toBe(false);
    fireEvent.click(context);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Home from context' }));
    expect(screen.queryByRole('button', { name: 'Context: Home' })).toBeNull();
    expect(screen.queryByTestId('context-chips')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(composer));
    expect(input()).toBe(composer);
    expect(composer.value).toBe('A question with intentional context');
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
  });

  it('gives completion its own Escape before folding onto the button, and leaves the page Escape alone', async () => {
    render(
      <>
        <button type="button">Page action</button>
        <FloatingAssistant />
      </>,
    );
    await act(async () => {});
    fireEvent.click(fab());
    fireEvent.change(input(), { target: { value: 'See [[Design' } });
    expect(screen.getByTestId('wikilink-menu')).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByTestId('wikilink-menu')).toBeNull();
    expect(useUiStore.getState().aiPanelMinimized).toBe(false);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(useUiStore.getState().aiPanelMinimized).toBe(true);
    expect(document.activeElement).toBe(fab());
    expect(input().value).toBe('See [[Design');
    act(() => useUiStore.getState().openAssistantFloating());
    const page = screen.getByRole('button', { name: 'Page action' });
    act(() => page.focus());
    fireEvent.keyDown(page, { key: 'Escape' });
    expect(useUiStore.getState().aiPanelMinimized).toBe(false);
  });

  it('⌘J folds the composer onto the button, and never takes focus from the page', async () => {
    function Shell() {
      useAppCommands();
      return (
        <>
          <button type="button">Page action</button>
          <FloatingAssistant />
        </>
      );
    }
    const toggle = () => act(() => void runCommand('assistant.toggle', ['app']));
    render(<Shell />);
    await act(async () => {});
    expect(document.activeElement).toBe(document.body);
    toggle();
    expect(useUiStore.getState().aiPanelMinimized).toBe(false);
    await waitFor(() => expect(document.activeElement).toBe(input()));
    toggle();
    expect(useUiStore.getState().aiPanelMinimized).toBe(true);
    expect(document.activeElement).toBe(fab());
    // From the page, the same key opens and folds the conversation, and
    // focus that was never the panel's is left where the person put it.
    const page = screen.getByRole('button', { name: 'Page action' });
    toggle();
    act(() => page.focus());
    toggle();
    expect(useUiStore.getState().aiPanelMinimized).toBe(true);
    expect(document.activeElement).toBe(page);
  });

  it('keeps a live turn and pending approval intact while minimized, and says so on the button', async () => {
    render(<FloatingAssistant />);
    fireEvent.click(fab());
    const composer = input();
    fireEvent.change(composer, { target: { value: 'Append it' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(wire.deliver).not.toBeNull());
    expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce();
    const attached = wire.detach.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Minimize conversation' }));
    // Working: a ring turns on the button, and a screen reader hears it.
    expect(fab().dataset.state).toBe('working');
    expect(fab().querySelector('.cb-chat-fab-ring')).not.toBeNull();
    expect(fab().querySelector('.cb-chat-fab-dot')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Working…');
    expect(document.activeElement).toBe(fab());
    expect(wire.detach).toHaveBeenCalledTimes(attached);
    const card = {
      id: 'c'.repeat(32),
      kind: 'permission',
      tool_name: 'mcp__cerebro__append_to_note',
      tool_id: 't-1',
      session_id: 'session-1',
      summary: 'Append to a note · notes/inbox.md',
      input: '{}',
      asked_at: '2026-10-17T12:00:00.000Z',
    };
    act(() => {
      wire.deliver?.({ run: 8, seq: 1, kind: 'Interaction', interaction: card });
    });
    // Waiting on the person: the ring gives way to a dot.
    expect(fab().dataset.state).toBe('waiting');
    expect(fab().querySelector('.cb-chat-fab-dot')).not.toBeNull();
    expect(fab().querySelector('.cb-chat-fab-ring')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Waiting for your answer');
    const approval = screen.getByTestId('interaction-card');
    expect(approval.closest('[hidden]')).not.toBeNull();
    fireEvent.click(fab());
    expect(screen.getByTestId('interaction-card')).toBe(approval);
    fireEvent.change(screen.getByTestId('interaction-deny-message'), {
      target: { value: 'Keep my unsent decision note' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Minimize conversation' }));
    fireEvent.click(fab());
    expect(screen.getByTestId('interaction-card')).toBe(approval);
    expect((screen.getByTestId('interaction-deny-message') as HTMLInputElement).value).toBe(
      'Keep my unsent decision note',
    );
    expect(vi.mocked(agentIpc.answerInteraction)).not.toHaveBeenCalled();
    expect(vi.mocked(agentIpc.cancelInteraction)).not.toHaveBeenCalled();
    expect(vi.mocked(agentIpc.stopAgent)).not.toHaveBeenCalled();
    expect(wire.detach).toHaveBeenCalledTimes(attached);
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(vi.mocked(agentIpc.answerInteraction)).toHaveBeenCalledOnce());
  });

  it('hands focus to the composer when an answered card leaves, never to <body>', async () => {
    render(<FloatingAssistant />);
    fireEvent.click(fab());
    const composer = input();
    fireEvent.change(composer, { target: { value: 'Append it' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(wire.deliver).not.toBeNull());
    act(() => {
      wire.deliver?.({
        run: 8,
        seq: 1,
        kind: 'Interaction',
        interaction: {
          id: 'd'.repeat(32),
          kind: 'permission',
          tool_name: 'mcp__cerebro__append_to_note',
          tool_id: 't-1',
          session_id: 'session-1',
          summary: 'Append to a note · notes/inbox.md',
          input: '{}',
          asked_at: '2026-10-17T12:00:00.000Z',
        },
      });
    });
    const allow = screen.getByTestId('interaction-allow');
    allow.focus();
    fireEvent.click(allow);
    await waitFor(() => expect(screen.queryByTestId('interaction-card')).toBeNull());
    expect(document.activeElement).toBe(composer);
  });
});
