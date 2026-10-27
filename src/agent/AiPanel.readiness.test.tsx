import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from './types';
import type { CliReadinessProbe } from './cliReadinessTypes';

const wire = vi.hoisted(() => ({ deliver: null as ((event: AgentEvent) => void) | null }));
vi.mock('./agentIpc', async (original) => ({
  ...(await original<typeof import('./agentIpc')>()),
  checkAgent: vi.fn(async () => {
    throw new Error('IPC unavailable');
  }),
  readCliReadiness: vi.fn(),
  runAgent: vi.fn(async () => ({ run: 9, durableId: 'readiness-9', attach: 'readiness-9' })),
  attachRun: vi.fn(async (_handle, _after, deliver: (event: AgentEvent) => void) => {
    wire.deliver = deliver;
    return { state: 'held', done: false, detach: vi.fn() };
  }),
  listInteractions: vi.fn(async () => []),
  agentContextUsage: vi.fn(async () => ({ state: 'not_recorded' })),
}));

import { AiPanel } from './AiPanel';
import { ClaudeCodeRow } from '@/pages/ClaudeCodeRow';
import { readCliReadiness } from './agentIpc';
import { __resetCliReadiness } from './useCliReadiness';
import { forgetDraftsInMemory } from './drafts';
import { fixtureVault } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { useNavStore } from '@/stores/navStore';
import { __resetOpenPages } from '@/editor/openPages';

const available: CliReadinessProbe = {
  state: 'available',
  backend: 'native',
  path: '/local/claude',
  version: '2.1',
};
beforeEach(() => {
  localStorage.clear();
  forgetDraftsInMemory();
  __resetOpenPages();
  __resetCliReadiness();
  vi.clearAllMocks();
  wire.deliver = null;
  vi.mocked(readCliReadiness).mockResolvedValue(available);
  Element.prototype.scrollTo ??= () => {};
  useVaultStore.setState({ vaultPath: '/demo-vault', entries: fixtureVault(), views: [] });
  useNavStore.setState({ selection: { kind: 'home' } });
  useUiStore.setState({
    aiPanelOpen: true,
    aiPanelMinimized: false,
    aiPanelPresentation: 'panel',
    panelConversation: null,
    panelAgents: { '/demo-vault': null },
    handoffs: [],
    runs: [],
    toasts: [],
    detailPath: null,
    settingsFocus: null,
  });
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
});

describe('shared readiness through the persistent assistant and Settings', () => {
  it.each(['floating', 'panel', 'canvas'] as const)(
    'a rejected discovery is unavailable in Settings and the %s assistant, with one check and no install assertion',
    async (presentation) => {
      vi.mocked(readCliReadiness).mockRejectedValueOnce(new Error('transport secret'));
      render(
        <>
          <AiPanel presentation={presentation} />
          <ClaudeCodeRow />
        </>,
      );
      await waitFor(() =>
        expect(screen.getByTestId('settings-claude-code-status').textContent).toBe(
          "Couldn't check for Claude Code on this machine.",
        ),
      );
      expect(
        await within(screen.getByTestId('ai-panel')).findByRole('button', {
          name: 'Retry checking Claude Code',
        }),
      ).toBeTruthy();
      expect(screen.queryByText('not installed')).toBeNull();
      expect(screen.queryByText(/Install it/)).toBeNull();
      expect(readCliReadiness).toHaveBeenCalledTimes(1);
    },
  );

  it('a Settings recheck retains the current question, approval, scroll and newer composer node', async () => {
    render(
      <>
        <AiPanel presentation="panel" />
        <ClaudeCodeRow />
      </>,
    );
    const settings = within(screen.getByTestId('settings-claude-code'));
    await settings.findByText(/2.1/);
    const composer = screen.getByLabelText('Message the assistant');
    fireEvent.change(composer, { target: { value: 'A question to keep' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(wire.deliver).not.toBeNull());
    act(() =>
      wire.deliver!({
        run: 9,
        seq: 1,
        kind: 'Interaction',
        interaction: {
          id: 'readiness-card',
          kind: 'permission',
          tool_name: 'mcp__cerebro__append_to_note',
          tool_id: 'readiness-tool',
          session_id: 'session-1',
          summary: 'Append to the selected page',
          input: '{}',
          asked_at: '2026-10-23T12:00:00Z',
        },
      }),
    );
    const approval = await screen.findByTestId('interaction-card');
    const transcript = screen.getByTestId('chat-scroll');
    transcript.scrollTop = 123;
    fireEvent.change(composer, { target: { value: 'Newer draft stays here' } });
    let resolve!: (value: CliReadinessProbe) => void;
    vi.mocked(readCliReadiness).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.click(settings.getByRole('button', { name: 'Check again' }));
    expect(screen.getByTestId('settings-claude-code-status').textContent).toContain('Checking');
    await act(async () => resolve({ ...available, version: '2.2' }));
    expect(screen.getByLabelText('Message the assistant')).toBe(composer);
    expect(composer).toHaveProperty('value', 'Newer draft stays here');
    expect(screen.getByTestId('interaction-card')).toBe(approval);
    expect(screen.getByTestId('chat-scroll')).toBe(transcript);
    expect(transcript.scrollTop).toBe(123);
    expect(within(transcript).getByText('A question to keep')).toBeTruthy();
    expect(readCliReadiness).toHaveBeenCalledTimes(2);
  });
});
