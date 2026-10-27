import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceBackupSettings } from './WorkspaceBackupSettings';
import { createBackupWorkflow, type BackupWorkflowDeps } from './backupWorkflow';
import { useVaultStore } from '@/stores/vaultStore';
import type { WorkspaceBackupOperation, WorkspaceBackupReview } from '@/lib/generated/workspace';
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => vi.fn() }));
function fixture(operation: WorkspaceBackupOperation) {
  const review: WorkspaceBackupReview = {
    operationId: 'original-operation',
    mode: 'restore',
    token: 'original-token',
    labels: { source: '/old-vault', input: '/checked-backup', output: '/separate-copy' },
    summary: null,
    expiresAt: null,
  };
  const api: BackupWorkflowDeps['api'] = {
    availability: vi.fn(async () => ({
      kind: 'available' as const,
      sourceLabel: '/current-vault',
      checkRestore: true,
    })),
    choose: vi.fn(async () => ({
      kind: 'preview' as const,
      mode: 'create' as const,
      message: 'Preview only; no files were written.',
    })),
    check: vi.fn(async () => ({
      kind: 'review' as const,
      review: { ...review, mode: 'check' as const },
    })),
    restore: vi.fn(async () => ({ kind: 'review' as const, review })),
    commit: vi.fn(async () => ({
      kind: 'started' as const,
      operationId: 'original-operation',
      mode: 'create' as const,
      labels: review.labels,
    })),
    commitRestore: vi.fn(async () => ({
      kind: 'started' as const,
      operationId: 'original-operation',
      mode: 'restore' as const,
      labels: review.labels,
    })),
    cancel: vi.fn(async () => ({ kind: 'cancelled' as const })),
    operation: vi.fn(async () => operation),
  };
  const workflow = createBackupWorkflow({
    api,
    presentation: () => ({ vaultPath: '/current-vault', opening: 1 }),
    flush: async () => ({ outcomes: [], unresolvedOwnerIds: [] }),
    unresolved: () => [],
    toast: vi.fn(),
  });
  return { workflow, api };
}
beforeEach(() => {
  useVaultStore.setState({ vaultPath: '/current-vault' });
});
describe('Backups settings', () => {
  it('walks a checked bundle through review and an explicit separate restore', async () => {
    const f = fixture({ kind: 'none' });
    await f.workflow.refreshAvailability();
    await f.workflow.refresh();
    render(<WorkspaceBackupSettings workflow={f.workflow} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Restore a separate copy…' }));
    expect(await screen.findByText('Backup checked')).toBeTruthy();
    expect(f.api.commitRestore).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Choose restore destination…' }));
    expect(await screen.findByText('Review separate restore')).toBeTruthy();
    expect(screen.getByText(/separate inactive copy/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restore separate copy' }));
    expect(f.api.commitRestore).toHaveBeenCalledExactlyOnceWith('original-token');
    expect(
      (await screen.findByRole('status', { name: 'Backup in progress' })).textContent,
    ).toContain('/separate-copy');
  });
  it('retains original-source running status across Settings remount and a vault switch', async () => {
    const f = fixture({
      kind: 'running',
      operationId: 'original-operation',
      mode: 'create',
      labels: { source: '/old-vault', output: '/backup', input: null },
    });
    await f.workflow.refresh();
    await f.workflow.refreshAvailability();
    const first = render(<WorkspaceBackupSettings workflow={f.workflow} />);
    first.unmount();
    act(() => {
      useVaultStore.setState({ vaultPath: '/new-vault' });
    });
    render(<WorkspaceBackupSettings workflow={f.workflow} />);
    expect(screen.getByRole('status', { name: 'Backup in progress' }).textContent).toContain(
      '/old-vault',
    );
    expect(
      (screen.getByRole('button', { name: 'Create backup…' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(f.api.commit).not.toHaveBeenCalled();
  });
  it('shows uncertain creation and original-spelling confidence without inventing empty output', async () => {
    const f = fixture({
      kind: 'terminal',
      operationId: 'original-operation',
      mode: 'create',
      labels: { source: '/old-vault', output: '/copy', input: null },
      result: {
        kind: 'refused',
        refusal: {
          kind: 'unknown_outcome',
          message: 'The native result was unavailable.',
          authority: null,
          backup: null,
          output: {
            kind: 'creation_uncertain',
            location: { displayLocation: '/copy', verification: 'original_spelling_only' },
          },
        },
      },
    });
    await f.workflow.refresh();
    render(<WorkspaceBackupSettings workflow={f.workflow} />);
    expect(screen.getByText(/creation could not be confirmed/i)).toBeTruthy();
    expect(screen.getByText(/copy may have moved/i)).toBeTruthy();
    expect(screen.queryByText('No output was created.')).toBeNull();
    expect(f.api.commit).not.toHaveBeenCalled();
  });
  it('keeps preview truthful rather than displaying a successful filesystem operation', async () => {
    const f = fixture({ kind: 'preview', message: 'Preview only; no files were written.' });
    await f.workflow.refreshAvailability();
    await f.workflow.refresh();
    render(<WorkspaceBackupSettings workflow={f.workflow} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Create backup…' }));
    expect(screen.getByText(/preview only; no files were written/i)).toBeTruthy();
    expect(screen.queryByLabelText('Backup result')).toBeNull();
  });
});
