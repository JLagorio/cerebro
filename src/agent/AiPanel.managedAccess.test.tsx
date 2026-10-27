// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, PendingInteraction } from './types';
import type { RunActionAccessView, SetRunActionAccessResult } from '@/lib/generated/actions';
const wire = vi.hoisted(() => ({
  deliver: null as ((event: AgentEvent) => void) | null,
  run: 700,
  listeners: new Set<(event: AgentEvent) => void>(),
}));
vi.mock('./agentIpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agentIpc')>()),
  runAgent: vi.fn(async () => ({
    run: wire.run,
    durableId: `access-${wire.run}`,
    attach: `access-${wire.run}`,
  })),
  attachRun: vi.fn(async (_handle, _after, deliver: (event: AgentEvent) => void) => {
    wire.deliver = deliver;
    return { state: 'held', done: false, detach: vi.fn() };
  }),
  answerInteraction: vi.fn(),
  stopAgent: vi.fn(async () => true),
  cancelInteraction: vi.fn(),
  listInteractions: vi.fn(async () => []),
  readCliTranscript: vi.fn(async () => ({
    state: 'unavailable',
    reason: 'not_recorded',
    retention_days: 30,
  })),
  readManagedActionAccess: vi.fn(),
  setManagedActionAccess: vi.fn(),
  onAgentEvent: vi.fn((listener: (event: AgentEvent) => void) => {
    wire.listeners.add(listener);
    return () => wire.listeners.delete(listener);
  }),
}));
import { AiPanel } from './AiPanel';
import * as ipc from './agentIpc';
import { forgetDraftsInMemory } from './drafts';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { fixtureVault } from '@/test/factories';
const view = (): RunActionAccessView => ({
  runId: `access-${wire.run}`,
  accessRevision: 'revision',
  accessRequestId: `request-${wire.run}`,
  accounts: [],
  definitions: [],
  grants: [],
});
const emit = (event: AgentEvent) => {
  wire.deliver?.(event);
  for (const listener of wire.listeners) listener(event);
};
const card = (): PendingInteraction => ({
  kind: 'managed_access',
  id: `request-${wire.run}`,
  run: wire.run,
  tool_name: 'list_actions',
  tool_id: null,
  session_id: 'access-session',
  input: '{}',
  summary: 'Choose run access',
  asked_at: '2026-10-26T12:00:00Z',
});
async function start() {
  const mounted = render(<AiPanel presentation="floating" />);
  const composer = screen.getByRole('textbox', { name: 'Message the assistant' });
  fireEvent.change(composer, { target: { value: 'Use the selected account' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await waitFor(() => expect(wire.deliver).not.toBeNull());
  return mounted;
}
beforeEach(() => {
  localStorage.clear();
  forgetDraftsInMemory();
  vi.clearAllMocks();
  wire.deliver = null;
  wire.run += 1;
  Element.prototype.scrollTo ??= () => {};
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
  vi.mocked(ipc.readManagedActionAccess).mockImplementation(async () => view());
  vi.mocked(ipc.setManagedActionAccess).mockImplementation(async () => ({
    state: 'changed',
    view: { ...view(), accessRequestId: null },
    sourceCurrent: true,
    requestClosed: true,
  }));
});
afterEach(() => {
  cleanup();
  for (const listener of wire.listeners) listener({ kind: 'Done', run: wire.run, seq: 99 });
});
describe('chat managed access sheet', () => {
  it('opens the real sheet for the original held card without sending a generic permission answer', async () => {
    await start();
    act(() => emit({ kind: 'Interaction', run: wire.run, seq: 1, interaction: card() }));
    fireEvent.click(screen.getByRole('button', { name: 'Choose access' }));
    const dialog = await screen.findByRole('dialog', { name: 'Access for this run' });
    await waitFor(() =>
      expect(ipc.readManagedActionAccess).toHaveBeenCalledExactlyOnceWith(wire.run),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(ipc.setManagedActionAccess).toHaveBeenCalledExactlyOnceWith(wire.run, {
        expectedAccessRevision: 'revision',
        completeRequestId: `request-${wire.run}`,
        selections: [],
      }),
    );
    expect(ipc.answerInteraction).not.toHaveBeenCalled();
    expect(ipc.cancelInteraction).not.toHaveBeenCalled();
  });
  it('offers live run access without a waiting card and never completes an unrelated request', async () => {
    await start();
    fireEvent.click(screen.getByRole('button', { name: 'Access for this run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Access for this run' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(ipc.setManagedActionAccess).toHaveBeenCalledWith(wire.run, {
        expectedAccessRevision: 'revision',
        completeRequestId: null,
        selections: [],
      }),
    );
  });
  it('closing and reopening during a save keeps one pending request and shows its eventual acknowledgement', async () => {
    await start();
    act(() => emit({ kind: 'Interaction', run: wire.run, seq: 1, interaction: card() }));
    let finish!: (result: SetRunActionAccessResult) => void;
    vi.mocked(ipc.setManagedActionAccess).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose access' }));
    let dialog = await screen.findByRole('dialog', { name: 'Access for this run' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Choose access' }));
    dialog = await screen.findByRole('dialog', { name: 'Access for this run' });
    expect(within(dialog).getByRole('button', { name: 'Saving…' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(ipc.setManagedActionAccess).toHaveBeenCalledTimes(1);
    expect(ipc.readManagedActionAccess).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({
        state: 'changed',
        view: { ...view(), accessRequestId: null },
        sourceCurrent: false,
        requestClosed: false,
      });
    });
    expect(within(dialog).getByRole('status').textContent).toMatch(/saved|changed/i);
    expect(ipc.setManagedActionAccess).toHaveBeenCalledTimes(1);
  });
});
