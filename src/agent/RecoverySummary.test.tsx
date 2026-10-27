// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoverySummary } from './RecoverySummary';
import { readChatRecovery } from './agentIpc';
import { getVaultOpening, useVaultStore } from '@/stores/vaultStore';
import type { ChatRecoveryInspection } from '@/lib/generated/actions';
vi.mock('./agentIpc', async (original) => ({ ...(await original<typeof import('./agentIpc')>()), readChatRecovery: vi.fn() }));
const RUN = 'original-native-root';
const root = () => ({ runId: RUN, vaultPath: '/vault', opening: getVaultOpening() });
function observation(): ChatRecoveryInspection {
  return {
    origin: { rootAttemptId: 'a'.repeat(32), runId: RUN, vaultId: 'vault', storeId: 'store', actorId: 'human:me', cliSessionId: 'session', historicalAppSessionId: 'old-session', outcome: 'failed', startedAt: '2026-10-26T00:00:00Z', endedAt: '2026-10-26T00:01:00Z', nativeClosedAt: '2026-10-26T00:01:00Z', nativeCloseKind: 'completed', appClosePrecision: 'clean_exact' },
    effects: [], brokerInventory: { state: 'complete', inspectedRunIds: [RUN], observedCount: 0, overflow: false, reasons: [] },
    generationCoverage: { state: 'unknown', reason: 'root_only_no_generation_binding' },
    externalEffectsCoverage: { state: 'unknown', reason: 'unbrokered_execution_not_covered' }, issues: [],
  };
}
function withPreview(): ChatRecoveryInspection {
  const value = observation();
  const effect = { invocationId: 'b'.repeat(32), state: 'outcome_unknown' as const, approvalId: null, accountLabel: 'Private account', canRetry: false, canReconcile: false };
  value.brokerInventory.observedCount = 1;
  value.effects = [{ effect, detailsRead: 'available', reason: null, details: { effect, revision: 1, account: { accountId: 'account', label: 'Private account', accountRevision: 1 }, target: null, definitionDigest: 'c'.repeat(64), inputDigest: 'd'.repeat(64), preview: { summary: 'Original private issue preview', fields: [], redactedFields: [] }, approval: null, attempts: [] } }];
  return value;
}
function summary(nativeRoot: ReturnType<typeof root> | null = root()) {
  const props = { question: 'Original question', error: 'Stopped', onOpenPath: vi.fn(), onClose: vi.fn(), nativeRoot };
  return <RecoverySummary {...props} />;
}
beforeEach(() => { vi.mocked(readChatRecovery).mockReset(); useVaultStore.setState({ vaultPath: '/vault', entriesVault: '/vault', status: 'ready' }); });
afterEach(cleanup);
describe('M95 original native reply action inspection', () => {
  it('reads only the captured original root and distinguishes measured zero from unknown external coverage', async () => {
    vi.mocked(readChatRecovery).mockResolvedValue(observation()); render(summary());
    await waitFor(() => expect(readChatRecovery).toHaveBeenCalledExactlyOnceWith(RUN));
    expect(await screen.findByText('No managed actions were recorded for this run.')).toBeTruthy();
    expect(screen.getByText('Actions outside managed connectors are not covered.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /ask again|allow|retry action/i })).toBeNull();
  });
  it('does not invent an original root for a cached reply', () => {
    render(summary(null)); expect(readChatRecovery).not.toHaveBeenCalled();
    expect(screen.getByText('The original run is not available from this reply.')).toBeTruthy();
  });
  it('shows a failed native read as unavailable, never measured zero', async () => {
    vi.mocked(readChatRecovery).mockRejectedValue({ code: 'denied', message: 'Unavailable in this opening.', retryDisposition: 'never' }); render(summary());
    expect(await screen.findByText('Managed action history is unavailable.')).toBeTruthy();
    expect(screen.queryByText('No managed actions were recorded for this run.')).toBeNull();
  });
  it('drops prior account disclosure while refresh is pending and keeps denied details hidden', async () => {
    let finish!: (value: ChatRecoveryInspection) => void;
    vi.mocked(readChatRecovery).mockResolvedValueOnce(withPreview()).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })); render(summary());
    expect(await screen.findByText('Original private issue preview')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh action history' }));
    expect(screen.queryByText('Original private issue preview')).toBeNull(); expect(screen.queryByText('Private account')).toBeNull();
    const denied = withPreview(); denied.effects[0] = { effect: { ...denied.effects[0]!.effect, accountLabel: null }, detailsRead: 'denied', details: null, reason: 'account_denied' };
    await act(async () => finish(denied));
    expect(screen.getByText('Action details are no longer accessible.')).toBeTruthy(); expect(screen.queryByText('Original private issue preview')).toBeNull();
    expect(screen.getByText('Outcome unknown')).toBeTruthy();
  });
  it('cannot restore disclosure after a batched vault A to B to A departure', async () => {
    let finish!: (value: ChatRecoveryInspection) => void;
    vi.mocked(readChatRecovery).mockImplementation(() => new Promise((resolve) => { finish = resolve; })); render(summary());
    await waitFor(() => expect(readChatRecovery).toHaveBeenCalledTimes(1));
    act(() => { useVaultStore.setState({ vaultPath: '/other' }); useVaultStore.setState({ vaultPath: '/vault' }); });
    await act(async () => finish(withPreview()));
    expect(screen.queryByText('Original private issue preview')).toBeNull(); expect(readChatRecovery).toHaveBeenCalledTimes(1);
    expect(screen.getByText('The original run is not available from this reply.')).toBeTruthy();
  });
  it('refuses a response belonging to another original root', async () => {
    const other = withPreview(); other.origin.runId = 'foreign-native-root'; vi.mocked(readChatRecovery).mockResolvedValue(other); render(summary());
    expect(await screen.findByText('Managed action history is unavailable.')).toBeTruthy(); expect(screen.queryByText('Original private issue preview')).toBeNull();
  });
  it('does not read again or present a late result after unmount', async () => {
    let finish!: (value: ChatRecoveryInspection) => void;
    vi.mocked(readChatRecovery).mockImplementation(() => new Promise((resolve) => { finish = resolve; })); const view = render(summary());
    await waitFor(() => expect(readChatRecovery).toHaveBeenCalledTimes(1)); view.unmount(); await act(async () => finish(withPreview()));
    expect(screen.queryByText('Original private issue preview')).toBeNull(); expect(readChatRecovery).toHaveBeenCalledTimes(1);
  });
});


it('clears an already disclosed account and preview on a batched departure', async () => {
  vi.mocked(readChatRecovery).mockResolvedValue(withPreview()); render(summary());
  expect(await screen.findByText('Original private issue preview')).toBeTruthy();
  act(() => { useVaultStore.setState({ vaultPath: '/other' }); useVaultStore.setState({ vaultPath: '/vault' }); });
  expect(screen.queryByText('Original private issue preview')).toBeNull(); expect(screen.queryByText('Private account')).toBeNull();
  expect(readChatRecovery).toHaveBeenCalledTimes(1);
});
it('clears prior disclosure immediately when the original root changes', async () => {
  vi.mocked(readChatRecovery).mockResolvedValueOnce(withPreview()).mockImplementationOnce(() => new Promise(() => undefined));
  const view = render(summary()); expect(await screen.findByText('Original private issue preview')).toBeTruthy();
  view.rerender(summary({ ...root(), runId: 'another-original-root' }));
  expect(screen.queryByText('Original private issue preview')).toBeNull(); expect(screen.queryByText('Private account')).toBeNull();
  await waitFor(() => expect(readChatRecovery).toHaveBeenLastCalledWith('another-original-root'));
});
it('never calls an incomplete zero inventory a measured absence', async () => {
  const partial = observation(); partial.brokerInventory.state = 'incomplete'; partial.brokerInventory.reasons = ['metadata_limit'];
  vi.mocked(readChatRecovery).mockResolvedValue(partial); render(summary());
  expect(await screen.findByText('Managed action history is incomplete.')).toBeTruthy();
  expect(screen.queryByText('No managed actions were recorded for this run.')).toBeNull();
});
it('reports unknown generation coverage and offers no effect action even when native flags are true', async () => {
  const value = withPreview(); value.effects[0]!.effect.canRetry = true; value.effects[0]!.effect.canReconcile = true;
  vi.mocked(readChatRecovery).mockResolvedValue(value); render(summary());
  expect(await screen.findByText('Original private issue preview')).toBeTruthy();
  expect(screen.getByText('Other attempts in this conversation are not covered.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /ask again|allow|retry|reconcile/i })).toBeNull();
});
it('ignores a pending native answer after the actual same-path open action changes the opening', async () => {
  const original = root(); let finish!: (value: ChatRecoveryInspection) => void;
  vi.mocked(readChatRecovery).mockImplementation(() => new Promise((resolve) => { finish = resolve; })); render(summary(original));
  await waitFor(() => expect(readChatRecovery).toHaveBeenCalledTimes(1));
  await act(async () => useVaultStore.getState().openVault('/vault'));
  expect(getVaultOpening()).toBeGreaterThan(original.opening);
  await act(async () => finish(withPreview()));
  expect(screen.queryByText('Original private issue preview')).toBeNull(); expect(readChatRecovery).toHaveBeenCalledTimes(1);
  expect(screen.getByText('The original run is not available from this reply.')).toBeTruthy();
});
