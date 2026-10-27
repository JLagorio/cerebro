import { describe, expect, it, vi } from 'vitest';
import { createBackupWorkflow, type BackupWorkflowDeps } from './backupWorkflow';
import type { WorkspaceBackupOperation, WorkspaceBackupReview } from '@/lib/generated/workspace';
import type { FlushReport } from '@/editor/documentOwner';
import type { OpenPageSnapshot } from '@/editor/saveParticipants';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const clean = (): FlushReport => ({ outcomes: [], unresolvedOwnerIds: [] });
const review = (mode: WorkspaceBackupReview['mode'] = 'create'): WorkspaceBackupReview => ({
  operationId: 'op1',
  token: `token-${mode}`,
  mode,
  expiresAt: '1793030460000',
  labels: {
    source: '/original',
    input: mode === 'create' ? null : '/bundle',
    output: mode === 'check' ? null : '/copy',
  },
  summary: null,
});
function fixture() {
  let presentation = { vaultPath: '/original' as string | null, opening: 1 };
  let unresolved: OpenPageSnapshot[] = [];
  const api = {
    availability: vi
      .fn<BackupWorkflowDeps['api']['availability']>()
      .mockResolvedValue({ kind: 'available', sourceLabel: '/original', checkRestore: true }),
    choose: vi
      .fn<BackupWorkflowDeps['api']['choose']>()
      .mockResolvedValue({ kind: 'review', review: review() }),
    check: vi
      .fn<BackupWorkflowDeps['api']['check']>()
      .mockResolvedValue({ kind: 'review', review: review('check') }),
    restore: vi
      .fn<BackupWorkflowDeps['api']['restore']>()
      .mockResolvedValue({ kind: 'review', review: review('restore') }),
    commit: vi
      .fn<BackupWorkflowDeps['api']['commit']>()
      .mockResolvedValue({
        kind: 'started',
        operationId: 'op1',
        mode: 'create',
        labels: review().labels,
      }),
    commitRestore: vi
      .fn<BackupWorkflowDeps['api']['commitRestore']>()
      .mockResolvedValue({
        kind: 'started',
        operationId: 'op1',
        mode: 'restore',
        labels: review('restore').labels,
      }),
    cancel: vi.fn<BackupWorkflowDeps['api']['cancel']>().mockResolvedValue({ kind: 'cancelled' }),
    operation: vi.fn<BackupWorkflowDeps['api']['operation']>().mockResolvedValue({ kind: 'none' }),
  };
  const flush = vi.fn<BackupWorkflowDeps['flush']>().mockResolvedValue(clean());
  const toast = vi.fn();
  const workflow = createBackupWorkflow({
    api,
    flush,
    toast,
    presentation: () => presentation,
    unresolved: () => unresolved,
  });
  return {
    workflow,
    api,
    flush,
    toast,
    switchTo(path: string | null) {
      presentation = { vaultPath: path, opening: presentation.opening + 1 };
    },
    dirty(rows: OpenPageSnapshot[]) {
      unresolved = rows;
    },
  };
}
const dirty = (): OpenPageSnapshot => ({
  key: { vaultId: '/original', path: 'page.md', ownerId: 'body' },
  participantId: 'original-page-body',
  latestDraft: 'retained draft',
  generation: 2,
  acknowledgedGeneration: 1,
  inFlightGeneration: null,
  failure: null,
  blocked: 'choice',
});
describe('app-owned backup save barrier', () => {
  it('waits for actual save acknowledgement before invoking the one native commit', async () => {
    const f = fixture();
    const save = deferred<FlushReport>();
    f.flush.mockReturnValue(save.promise);
    await f.workflow.chooseCreate();
    const pending = f.workflow.commit();
    expect(f.flush).toHaveBeenCalledOnce();
    expect(f.api.commit).not.toHaveBeenCalled();
    save.resolve(clean());
    expect(await pending).toBe(true);
    expect(f.api.commit).toHaveBeenCalledExactlyOnceWith('token-create');
    expect(f.workflow.getSnapshot().operation?.kind).toBe('running');
  });
  it.each(['failed', 'blocked', 'pending'] as const)(
    'keeps a %s save visible and never commits',
    async (kind) => {
      const f = fixture();
      f.dirty([dirty()]);
      const outcome =
        kind === 'blocked'
          ? { kind, ownerId: 'body', generation: 2, reason: 'choice' as const }
          : kind === 'pending'
            ? { kind, ownerId: 'body', generation: 2, status: 'unknown' as const, code: 'pending' }
            : { kind, ownerId: 'body', generation: 2, code: 'save-failed' };
      f.flush.mockResolvedValue({
        outcomes: [outcome],
        unresolvedOwnerIds: ['original-page-body'],
      });
      await f.workflow.chooseCreate();
      expect(await f.workflow.commit()).toBe(false);
      expect(f.api.commit).not.toHaveBeenCalled();
      expect(f.workflow.getSnapshot().blocked[0]?.key.path).toBe('page.md');
      expect(f.workflow.getSnapshot().message).toMatch(/save|draft/i);
    },
  );
  it('checks a fresh unresolved generation after the flush report', async () => {
    const f = fixture();
    f.flush.mockImplementation(async () => {
      f.dirty([dirty()]);
      return clean();
    });
    await f.workflow.chooseCreate();
    expect(await f.workflow.commit()).toBe(false);
    expect(f.api.commit).not.toHaveBeenCalled();
    expect(f.workflow.getSnapshot().blocked).toHaveLength(1);
  });
  it('invalidates a same-path reopen during saving and cancels only the pending choice', async () => {
    const f = fixture();
    const save = deferred<FlushReport>();
    f.flush.mockReturnValue(save.promise);
    await f.workflow.chooseCreate();
    const pending = f.workflow.commit();
    f.switchTo('/original');
    save.resolve(clean());
    expect(await pending).toBe(false);
    expect(f.api.commit).not.toHaveBeenCalled();
    expect(f.api.cancel).toHaveBeenCalledExactlyOnceWith('token-create');
  });
  it('discards a chooser response for a superseded opening', async () => {
    const f = fixture();
    const choice = deferred<Awaited<ReturnType<BackupWorkflowDeps['api']['choose']>>>();
    f.api.choose.mockReturnValue(choice.promise);
    const pending = f.workflow.chooseCreate();
    f.switchTo('/other');
    choice.resolve({ kind: 'review', review: review() });
    expect(await pending).toBe(false);
    expect(f.api.cancel).toHaveBeenCalledExactlyOnceWith('token-create');
    expect(f.workflow.getSnapshot().operation?.kind).not.toBe('pending');
  });
  it('restores the checked separate input without saving or relabeling the current vault', async () => {
    const f = fixture();
    f.dirty([dirty()]);
    await f.workflow.check();
    await f.workflow.chooseRestore();
    f.switchTo('/other');
    expect(await f.workflow.commit()).toBe(true);
    expect(f.flush).not.toHaveBeenCalled();
    expect(f.api.commitRestore).toHaveBeenCalledExactlyOnceWith('token-restore');
    expect(f.workflow.getSnapshot().operation).toMatchObject({
      kind: 'running',
      mode: 'restore',
      labels: { input: '/bundle', output: '/copy' },
    });
  });
  it('never retries an uncertain native commit automatically or on a duplicate click', async () => {
    const f = fixture();
    f.api.commit.mockRejectedValue(new Error('lost acknowledgement'));
    await f.workflow.chooseCreate();
    expect(await f.workflow.commit()).toBe(false);
    expect(await f.workflow.commit()).toBe(false);
    expect(f.api.commit).toHaveBeenCalledOnce();
    expect(f.workflow.getSnapshot().uncertain).toBe(true);
    expect(f.toast).toHaveBeenCalled();
  });
  it('does not let a stale status read replace an acknowledged running operation', async () => {
    const f = fixture();
    await f.workflow.chooseCreate();
    const read = deferred<WorkspaceBackupOperation>();
    f.api.operation.mockReturnValue(read.promise);
    const pendingRead = f.workflow.refresh();
    await f.workflow.commit();
    read.resolve({ kind: 'pending', review: review() });
    await pendingRead;
    expect(f.workflow.getSnapshot().operation?.kind).toBe('running');
  });
  it('retains completed original-source status when the current vault changes', async () => {
    const f = fixture();
    const terminal: WorkspaceBackupOperation = {
      kind: 'terminal',
      operationId: 'op1',
      mode: 'create',
      labels: review().labels,
      result: {
        kind: 'completed',
        workspaceId: 'workspace',
        summary: null,
        output: {
          kind: 'completed',
          location: { displayLocation: '/copy', verification: 'verified' },
        },
      },
    };
    f.api.operation.mockResolvedValue(terminal);
    await f.workflow.refresh();
    f.switchTo('/other');
    await f.workflow.presentationChanged();
    expect(f.workflow.getSnapshot().operation).toEqual(terminal);
  });
  it('a failed status read stays unavailable instead of becoming an empty workflow', async () => {
    const f = fixture();
    await f.workflow.chooseCreate();
    f.api.operation.mockRejectedValue(new Error('unavailable'));
    expect(await f.workflow.refresh()).toBe(false);
    expect(f.workflow.getSnapshot().message).toMatch(/unavailable|status/i);
    expect(f.workflow.getSnapshot().operation?.kind).toBe('pending');
  });
});

it('a thrown page flush keeps drafts pending and does not claim an unknown native copy', async () => {
  const f = fixture();
  f.flush.mockRejectedValue(new Error('save unavailable'));
  await f.workflow.chooseCreate();
  expect(await f.workflow.commit()).toBe(false);
  expect(f.api.commit).not.toHaveBeenCalled();
  expect(f.workflow.getSnapshot().operation?.kind).toBe('pending');
  expect(f.workflow.getSnapshot().uncertain).toBe(false);
  expect(f.workflow.getSnapshot().message).toMatch(/saving|draft/i);
});
it('missing native history after a lost commit acknowledgement is described as unknown', async () => {
  const f = fixture();
  f.api.commit.mockRejectedValue(new Error('lost acknowledgement'));
  await f.workflow.chooseCreate();
  await f.workflow.commit();
  await f.workflow.refresh();
  expect(f.workflow.getSnapshot().operation?.kind).toBe('none');
  expect(f.workflow.getSnapshot().message).toMatch(/previous backup outcome is unavailable/i);
  expect(f.api.commit).toHaveBeenCalledOnce();
});
