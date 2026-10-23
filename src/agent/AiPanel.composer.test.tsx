import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentEvent } from './types';

const wire = vi.hoisted(() => ({
  deliver: null as ((event: AgentEvent) => void) | null,
}));

vi.mock('./agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agentIpc')>();
  return {
    ...actual,
    runAgent: vi.fn(async () => ({ run: 8, durableId: 'composer-8', attach: 'composer-8' })),
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

import { AiPanel } from './AiPanel';
import * as agentIpc from './agentIpc';
import { forgetDraftsInMemory } from './drafts';
import { makeEntry } from '@/engine/testHelpers';
import { ASK_BASE_LABEL, askBasePrompt, askedAbout } from '@/lib/prompts';
import { fixtureVault } from '@/test/factories';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The composer (M91.12a): the Prompt Input with its text, the Model Selector
 * and the Context reading in its tools, Send and Stop as its submit, and the
 * starters as Suggestions — keeping every name, id and key path the panel's
 * specs press.
 */

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PAGE = makeEntry({ path: 'notes/phoenix.md', title: 'Phoenix' });

/** A kept thread with a Claude Code session, as the conversation list stores it. */
function keepThread(sessionId: string | null) {
  localStorage.setItem('cerebro.activeConversation', 'kept');
  localStorage.setItem(
    'cerebro.conversations',
    JSON.stringify([
      {
        id: 'kept',
        title: 'Kept thread',
        usesDefaultTitle: false,
        sessionId,
        createdAt: '2026-10-14T12:00:00Z',
        vault: '/demo-vault',
        archived: false,
        place: null,
        messages: [
          { id: 'kept-asked', role: 'user', text: 'Asked before', tools: [] },
          { id: 'kept-said', role: 'assistant', text: 'Answered before.', tools: [] },
        ],
      },
    ]),
  );
}

const composer = () => screen.getByTestId('chat-composer');
const input = () => screen.getByLabelText('Message the assistant') as HTMLTextAreaElement;
const contextUse = () => screen.getByTestId('context-use');

beforeEach(() => {
  localStorage.clear();
  forgetDraftsInMemory();
  vi.clearAllMocks();
  // Each case says what the pull answers; none inherits another's.
  vi.mocked(agentIpc.agentContextUsage).mockImplementation(async () => ({
    state: 'not_recorded',
  }));
  wire.deliver = null;
  Element.prototype.scrollTo ??= () => {};
  useVaultStore.setState({
    vaultPath: '/demo-vault',
    entries: [...fixtureVault(), PAGE],
    views: [],
  });
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

describe('the composer is a Prompt Input', () => {
  it('keeps its names, ids and one textarea in every presentation, and holds no form', async () => {
    const { rerender } = render(<AiPanel presentation="floating" />);
    await act(async () => {});
    const field = input();
    for (const presentation of ['floating', 'panel', 'canvas'] as const) {
      rerender(<AiPanel presentation={presentation} />);
      await act(async () => {});
      expect(input()).toBe(field);
      const pill = composer();
      expect(pill.dataset.slot).toBe('prompt-input');
      expect(pill.tagName).toBe('DIV');
      expect(pill.querySelector('form')).toBeNull();
      expect(field.dataset.slot).toBe('prompt-input-textarea');
      expect(within(pill).getByRole('textbox', { name: 'Message the assistant' })).toBe(field);
      expect(within(pill).getByRole('button', { name: 'Add context' })).toBeTruthy();
      const picker = within(pill).getByTestId('run-options');
      expect(picker.getAttribute('aria-label')).toBe('Model and effort: Claude Code default');
      // The reading sits beside the picker, in the same tools.
      const tools = picker.closest('[data-slot="prompt-input-tools"]');
      expect(tools).not.toBeNull();
      expect(tools?.contains(contextUse())).toBe(true);
      const send = within(pill).getByRole('button', { name: 'Send' }) as HTMLButtonElement;
      expect(send.dataset.slot).toBe('prompt-input-submit');
      expect(send.disabled).toBe(true);
    }
  });

  it('never names the reading “Context:”, which is the chips’ disclosure', async () => {
    useUiStore.setState({ aiPanelPresentation: 'floating' });
    render(<AiPanel presentation="floating" />);
    await act(async () => {});
    const disclosure = within(composer()).getByRole('button', { name: /^Context:/ });
    expect(disclosure.getAttribute('aria-label')).toBe('Context: Home');
    expect(contextUse().getAttribute('aria-label')).not.toMatch(/^Context:/);
    expect(within(composer()).getAllByRole('button', { name: /^Context:/ })).toEqual([disclosure]);
  });

  it('says how to send in the panel’s footer, and sends what is written on Enter', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    expect(screen.getByTestId('composer-status').textContent).toBe(
      'Enter to send · [[ to reference a note',
    );
    fireEvent.change(input(), { target: { value: 'Second line coming' } });
    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true });
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    expect(input().value).toBe('');
  });

  it('sends nothing on an Enter that ends an IME composition', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    fireEvent.change(input(), { target: { value: 'にほんご' } });
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
    fireEvent.compositionStart(input());
    fireEvent.keyDown(input(), { key: 'Enter' });
    await act(async () => {});
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();
    expect(input().value).toBe('にほんご');
    fireEvent.compositionEnd(input());
    fireEvent.keyDown(input(), { key: 'Enter' });
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
  });

  it('trades Send for Stop and Add to Up next while a turn runs', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    fireEvent.change(input(), { target: { value: 'Go on' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    const stop = await screen.findByRole('button', { name: 'Stop' });
    expect(stop.dataset.slot).toBe('prompt-input-submit');
    expect(stop.dataset.status).toBe('streaming');
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(within(composer()).getByRole('button', { name: 'Add to Up next' })).toBeTruthy();
    expect(screen.getByTestId('composer-status').textContent).toBe(
      'Working… · Enter adds to Up next',
    );
    expect((screen.getByTestId('run-options') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(stop);
    await waitFor(() => expect(vi.mocked(agentIpc.stopAgent)).toHaveBeenCalled());
  });
});

describe('the Context reading', () => {
  it('reads not recorded for a conversation with no session yet, and asks nothing', async () => {
    render(<AiPanel presentation="panel" />);
    await act(async () => {});
    expect(contextUse().getAttribute('aria-label')).toBe('Context use not recorded');
    expect(contextUse().textContent).toBe('');
    expect(vi.mocked(agentIpc.agentContextUsage)).not.toHaveBeenCalled();
  });

  it('reads the session’s pulled reading, its ring decoration', async () => {
    keepThread(SESSION);
    vi.mocked(agentIpc.agentContextUsage).mockResolvedValue({
      state: 'recorded',
      used: 124_000,
      window: 200_000,
      model: 'claude-sonnet-5',
      at: '2026-10-22T12:00:08.000Z',
    });
    render(<AiPanel presentation="panel" />);
    const reading = await screen.findByRole('button', { name: '62% of context used' });
    expect(reading).toBe(contextUse());
    expect(reading.textContent).toBe('62%');
    expect(reading.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(vi.mocked(agentIpc.agentContextUsage)).toHaveBeenCalledWith(SESSION);
  });

  it('reads unavailable when the pull fails, never not recorded', async () => {
    keepThread(SESSION);
    vi.mocked(agentIpc.agentContextUsage).mockRejectedValue(new Error('the book is gone'));
    render(<AiPanel presentation="panel" />);
    const reading = await screen.findByRole('button', { name: 'Context use unavailable' });
    expect(reading).toBe(contextUse());
    expect(reading.textContent).toBe('');
  });

  it('reads not recorded for a session Claude Code has reported nothing for', async () => {
    keepThread(SESSION);
    render(<AiPanel presentation="panel" />);
    await waitFor(() =>
      expect(vi.mocked(agentIpc.agentContextUsage)).toHaveBeenCalledWith(SESSION),
    );
    expect(contextUse().getAttribute('aria-label')).toBe('Context use not recorded');
  });
});

describe('the starters are Suggestions', () => {
  it('shows each label and sends its prompt, the bubble saying the act and the page', async () => {
    useNavStore.setState({ selection: { kind: 'doc', path: PAGE.path } });
    render(<AiPanel presentation="canvas" />);
    await act(async () => {});
    const group = screen.getByRole('group', { name: 'Conversation starters' });
    const rows = within(group).getAllByTestId('ai-suggestion');
    expect(rows[0].textContent).toBe(ASK_BASE_LABEL);
    expect(rows[0].classList.contains('cb-ai-suggestion')).toBe(true);
    fireEvent.click(rows[0]);
    await waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    const sent = vi.mocked(agentIpc.runAgent).mock.calls[0][1] as { message: string };
    expect(sent.message).toBe(askBasePrompt(PAGE.path, PAGE.title));
    expect(
      screen.getAllByTestId('chat-message').find((m) => m.dataset.role === 'user')?.textContent,
    ).toBe(askedAbout(ASK_BASE_LABEL, PAGE.title));
  });

  it('stays borderless: the rows’ own rule draws no border, and the panel adds none', () => {
    const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
    const element = strip(
      readFileSync(resolve(__dirname, '../components/ai/conversation.css'), 'utf8'),
    );
    const rule = element.slice(element.indexOf('.cb-ai-suggestion {'));
    expect(rule.slice(0, rule.indexOf('}'))).toMatch(/\n\s+border: 0;/);
    const panel = strip(readFileSync(resolve(__dirname, 'chat.css'), 'utf8'));
    const starterRules = [...panel.matchAll(/([^{}]*cb-chat-suggestion[^{}]*)\{([^}]*)\}/g)];
    expect(starterRules.length).toBeGreaterThan(0);
    for (const [, , body] of starterRules) expect(body).not.toMatch(/\bborder\b/);
  });
});
