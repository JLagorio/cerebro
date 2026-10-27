import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceBackupAvailability,
  WorkspaceBackupChoiceResult,
  WorkspaceBackupCommitResult,
  WorkspaceBackupCancelResult,
  WorkspaceBackupOperation,
} from '@/lib/generated/workspace';
const native = vi.hoisted(() => ({
  opening: 1,
  availability: vi.fn<(vault: string | null) => Promise<WorkspaceBackupAvailability>>(),
  choose: vi.fn<(vault: string) => Promise<WorkspaceBackupChoiceResult>>(),
  check: vi.fn<() => Promise<WorkspaceBackupChoiceResult>>(),
  restore: vi.fn<(token: string) => Promise<WorkspaceBackupChoiceResult>>(),
  commit: vi.fn<(token: string) => Promise<WorkspaceBackupCommitResult>>(),
  commitRestore: vi.fn<(token: string) => Promise<WorkspaceBackupCommitResult>>(),
  cancel: vi.fn<(token: string) => Promise<WorkspaceBackupCancelResult>>(),
  operation: vi.fn<() => Promise<WorkspaceBackupOperation>>(),
  listen: vi.fn<(handler: () => void) => Promise<() => void>>(),
  flush: vi.fn(async () => ({ outcomes: [], unresolvedOwnerIds: [] })),
  unresolved: vi.fn(() => []),
  toast: vi.fn<(message: string) => void>(),
}));
vi.mock('@/lib/ipc', () => ({
  workspaceBackupAvailability: native.availability,
  chooseWorkspaceBackup: native.choose,
  checkWorkspaceBackup: native.check,
  chooseWorkspaceRestore: native.restore,
  commitWorkspaceBackup: native.commit,
  commitWorkspaceRestore: native.commitRestore,
  cancelWorkspaceBackupChoice: native.cancel,
  workspaceBackupOperation: native.operation,
  onWorkspaceBackupChanged: native.listen,
}));
vi.mock('@/stores/vaultStore', async () => {
  const { create } = await import('zustand');
  return {
    useVaultStore: create<{ vaultPath: string | null }>(() => ({ vaultPath: '/original-vault' })),
    getVaultOpening: () => native.opening,
  };
});
vi.mock('@/stores/uiStore', () => ({ useUiStore: { getState: () => ({ toast: native.toast }) } }));
vi.mock('@/editor/openPages', () => ({
  flushOpenPages: native.flush,
  unresolvedOpenPages: native.unresolved,
}));
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => vi.fn() }));
import { useVaultStore } from '@/stores/vaultStore';
import { useWorkspaceBackupHost, workspaceBackupWorkflow } from './useWorkspaceBackup';
import { WorkspaceBackupSettings } from './WorkspaceBackupSettings';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
const labels = { source: '/original-vault', input: null, output: '/original-backup' };
const running: WorkspaceBackupOperation = {
  kind: 'running',
  operationId: 'original-operation',
  mode: 'create',
  labels,
};
const completed: WorkspaceBackupOperation = {
  kind: 'terminal',
  operationId: 'original-operation',
  mode: 'create',
  labels,
  result: {
    kind: 'completed',
    workspaceId: null,
    summary: null,
    output: {
      kind: 'completed_but_response_unavailable',
      location: { displayLocation: '/original-backup', verification: 'original_spelling_only' },
    },
  },
};
function Host({ settings = true }: { settings?: boolean }) {
  useWorkspaceBackupHost();
  return settings ? <WorkspaceBackupSettings /> : <p>Another page</p>;
}
async function mount() {
  const view = render(<Host />);
  await act(async () => {
    await Promise.resolve();
  });
  return view;
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  native.opening = 1;
  useVaultStore.setState({ vaultPath: '/original-vault' });
  native.availability.mockResolvedValue({
    kind: 'available',
    sourceLabel: '/original-vault',
    checkRestore: true,
  });
  native.choose.mockResolvedValue({
    kind: 'review',
    review: {
      operationId: 'original-operation',
      token: 'original-token',
      mode: 'create',
      labels,
      summary: null,
      expiresAt: null,
    },
  });
  native.cancel.mockResolvedValue({ kind: 'cancelled' });
  native.operation.mockResolvedValue({ kind: 'none' });
  native.listen.mockResolvedValue(vi.fn());
  native.flush.mockResolvedValue({ outcomes: [], unresolvedOwnerIds: [] });
  native.unresolved.mockReturnValue([]);
  await workspaceBackupWorkflow.refresh();
  await workspaceBackupWorkflow.refreshAvailability();
  native.operation.mockClear();
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});
describe('App-owned backup host', () => {
  it('recovers a terminal event that arrived before the original commit acknowledgement without copying again', async () => {
    const ack = deferred<WorkspaceBackupCommitResult>();
    native.commit.mockReturnValueOnce(ack.promise);
    await mount();
    await act(async () => {
      await workspaceBackupWorkflow.chooseCreate();
    });
    let committing!: Promise<boolean>;
    await act(async () => {
      committing = workspaceBackupWorkflow.commit();
      await Promise.resolve();
    });
    expect(native.commit).toHaveBeenCalledExactlyOnceWith('original-token');
    native.operation.mockResolvedValue(completed);
    const beforeEvent = native.operation.mock.calls.length;
    await act(async () => {
      native.listen.mock.calls[0][0]();
      await Promise.resolve();
    });
    expect(native.operation.mock.calls.length).toBe(beforeEvent + 1);
    expect(workspaceBackupWorkflow.getSnapshot().operation).toBeNull();
    await act(async () => {
      ack.resolve({ kind: 'started', operationId: 'original-operation', mode: 'create', labels });
      await committing;
    });
    expect(screen.getByRole('status', { name: 'Backup in progress' })).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByLabelText('Backup result').textContent).toContain('/original-backup');
    expect(screen.queryByRole('status', { name: 'Backup in progress' })).toBeNull();
    expect(native.commit).toHaveBeenCalledTimes(1);
    expect(native.choose).toHaveBeenCalledTimes(1);
  });
  it('releases a listener resolved after host unmount and ignores its late events', async () => {
    const setup = deferred<() => void>();
    const release = vi.fn();
    native.listen.mockReturnValueOnce(setup.promise);
    const view = await mount();
    const lateEvent = native.listen.mock.calls[0][0];
    view.unmount();
    native.operation.mockClear();
    await act(async () => {
      setup.resolve(release);
      await Promise.resolve();
    });
    expect(release).toHaveBeenCalledTimes(1);
    await act(async () => {
      lateEvent();
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(native.operation).not.toHaveBeenCalled();
  });
  it('keeps original running operation across Settings remount and vault switch until its actual terminal status', async () => {
    native.operation.mockResolvedValue(running);
    const view = await mount();
    expect(screen.getByRole('status', { name: 'Backup in progress' }).textContent).toContain(
      '/original-vault',
    );
    view.rerender(<Host settings={false} />);
    await act(async () => {
      native.opening += 1;
      useVaultStore.setState({ vaultPath: '/new-vault' });
      await Promise.resolve();
    });
    view.rerender(<Host />);
    expect(screen.getByRole('status', { name: 'Backup in progress' }).textContent).toContain(
      '/original-backup',
    );
    expect(
      (screen.getByRole('button', { name: 'Create backup…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(native.cancel).not.toHaveBeenCalled();
    native.operation.mockResolvedValue(completed);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByLabelText('Backup result').textContent).toContain('/original-vault');
    expect(screen.getByLabelText('Backup result').textContent).toContain('/original-backup');
    expect(native.commit).not.toHaveBeenCalled();
    expect(native.commitRestore).not.toHaveBeenCalled();
  });
});
