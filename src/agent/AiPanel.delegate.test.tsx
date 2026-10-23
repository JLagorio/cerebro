// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    getLastVault: vi.fn(async () => '/demo-vault'),
    getPanelAgent: vi.fn(async () => null),
  };
});

vi.mock('@/agent/agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/agentIpc')>();
  return { ...actual, runAgent: vi.fn(async () => ({ run: 8, durableId: 'durable-chat-8' })) };
});

import App from '@/App';
import * as agentIpc from '@/agent/agentIpc';
import { useUiStore } from '@/stores/uiStore';

// M91.2d: the panel sends the Subagents switch from Settings, not another
// ceiling's, as it stands when the turn starts.
describe('the panel sends the Subagents switch (M91.2d)', () => {
  beforeEach(() => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useUiStore.setState({
      panelAgents: {},
      panelAgentsUnreadable: {},
      handoffs: [],
      aiPanelOpen: false,
      toasts: [],
      agentShell: 'off',
      agentWebAccess: true,
      agentConnectors: true,
    });
  });

  afterEach(() => cleanup());

  for (const [on, sent] of [
    [false, 'off'],
    [true, 'on'],
  ] as const) {
    it(`sends ${sent} while Settings says ${sent}`, async () => {
      useUiStore.setState({ agentDelegate: on });
      render(<App />);
      await screen.findByRole('navigation', { name: 'Sidebar' });
      act(() => useUiStore.getState().askAgent('What is slipping?'));
      await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
      expect(vi.mocked(agentIpc.runAgent).mock.calls[0][1].delegate).toBe(sent);
    });
  }
});
