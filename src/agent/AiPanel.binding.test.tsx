// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The binding read is held open by each test, so the handoff demonstrably
// waits for it rather than winning a race by luck.
let answerBinding: (handle: string | null) => void = () => {};
let refuseBinding: (err: Error) => void = () => {};

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    getLastVault: vi.fn(async () => '/demo-vault'),
    getPanelAgent: vi.fn(
      () =>
        new Promise<string | null>((resolve, reject) => {
          answerBinding = resolve;
          refuseBinding = reject;
        }),
    ),
  };
});

vi.mock('@/agent/agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/agentIpc')>();
  return { ...actual, runAgent: vi.fn(async () => ({ run: 8, durableId: 'durable-chat-8' })) };
});

import App from '@/App';
import * as agentIpc from '@/agent/agentIpc';
import { useUiStore } from '@/stores/uiStore';

const lastOptions = () => {
  const calls = vi.mocked(agentIpc.runAgent).mock.calls;
  return calls[calls.length - 1][1];
};

// M56.6 — a handoff (QuickOpen, Ask to revise, the Knowledge asks) opens the
// panel and sends in the same mount. The binding lives in the app's config
// only, so the store starts empty, as it does at app start.
describe('a handoff into a bound panel (M56.6)', () => {
  beforeEach(() => {
    vi.mocked(agentIpc.runAgent).mockClear();
    useUiStore.setState({
      panelAgents: {},
      panelAgentsUnreadable: {},
      handoffs: [],
      aiPanelOpen: false,
      toasts: [],
    });
  });

  afterEach(() => cleanup());

  it('waits for the binding read, then runs as the bound agent', async () => {
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });

    act(() => useUiStore.getState().askAgent('What is slipping?'));
    await screen.findByTestId('ai-panel');
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();

    await act(async () => answerBinding('release-scout'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    expect(lastOptions().actor).toBe('process:release-scout');
  });

  it('waits the same way when the handoff carries a subject', async () => {
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });

    act(() => useUiStore.getState().askAgent('Revise it.', 'records/agents/release-scout.md'));
    await screen.findByTestId('ai-panel');
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();

    await act(async () => answerBinding('release-scout'));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    expect(lastOptions().actor).toBe('process:release-scout');
  });

  it('goes ahead as the plain assistant once the read has failed and said so', async () => {
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });

    act(() => useUiStore.getState().askAgent('What is slipping?'));
    await screen.findByTestId('ai-panel');
    expect(vi.mocked(agentIpc.runAgent)).not.toHaveBeenCalled();

    await act(async () => refuseBinding(new Error('config.json is unreadable')));
    await vi.waitFor(() => expect(vi.mocked(agentIpc.runAgent)).toHaveBeenCalledOnce());
    expect(lastOptions().actor).toBeNull();
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
      "Couldn't read who answers in the assistant panel: config.json is unreadable",
    );
  });
});
