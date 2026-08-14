// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/gitIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitIpc')>();
  return {
    ...actual,
    isGitRepo: vi.fn(async () => true),
    getModifiedFiles: vi.fn(async () => [] as ModifiedFile[]),
    getConflictFiles: vi.fn(async () => [] as string[]),
    getConflictMode: vi.fn(async () => 'none' as const),
    gitRemoteStatus: vi.fn(async () => ({ hasRemote: false })),
    gitCommit: vi.fn(async () => null as string | null),
  };
});

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return { ...actual, ledgerHead: vi.fn(async () => null) };
});

import {
  checkpointMessage,
  resetGitState,
  useBatchCheckpoint,
  useGit,
  withLedgerTrailer,
} from '@/git/useGit';
import { ledgerHead } from '@/lib/ipc';
import * as gitIpc from '@/lib/gitIpc';
import { useVaultStore } from '@/stores/vaultStore';
import type { ModifiedFile } from '@/engine/git';

const file = (path: string): ModifiedFile => ({ path, status: 'modified', staged: false });

// M21.7: the trailer is periodic anchoring — appended when a ledger head
// exists, and NOTHING about a checkpoint changes when one does not.
describe('withLedgerTrailer', () => {
  it('appends the chain head as a trailer when the vault has a ledger', async () => {
    vi.mocked(ledgerHead).mockResolvedValueOnce({ seq: 7, hash: 'abc123' });
    expect(await withLedgerTrailer('/v', 'Update note')).toBe(
      'Update note\n\nCerebro-Ledger-Head: abc123',
    );
  });

  it('leaves the message untouched when there is no ledger', async () => {
    vi.mocked(ledgerHead).mockResolvedValueOnce(null);
    expect(await withLedgerTrailer('/v', 'Update note')).toBe('Update note');
  });

  it('leaves the message untouched when the head read fails', async () => {
    vi.mocked(ledgerHead).mockRejectedValueOnce(new Error('no backend'));
    expect(await withLedgerTrailer('/v', 'Update note')).toBe('Update note');
  });
});

// M25.8: one commit per applied logical batch. The unit of review is the
// batch, not the file and not the turn — an M22 batch is atomic in the
// ledger, and a checkpoint that split it would offer a revert that leaves
// the working tree describing half an event.
describe('useBatchCheckpoint', () => {
  it('makes ONE commit carrying the batch id and the chain head', async () => {
    vi.mocked(ledgerHead).mockResolvedValueOnce({ seq: 7, hash: 'abc123' });
    vi.mocked(gitIpc.gitCommit).mockResolvedValueOnce('deadbee');
    useVaultStore.setState({ vaultPath: '/v' });
    const refresh = vi.fn();
    const { result } = renderHook(() => useBatchCheckpoint(refresh));
    act(() => {
      result.current('b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1', 'promoted 2 beliefs');
    });
    await waitFor(() => expect(gitIpc.gitCommit).toHaveBeenCalledTimes(1));
    expect(vi.mocked(gitIpc.gitCommit).mock.calls[0][1]).toBe(
      'applied: promoted 2 beliefs\n\nCerebro-Ledger-Head: abc123\nCerebro-Batch: b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1',
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('never fails the application it describes', async () => {
    // The ledger already holds the batch; git is the cross-attest, not the
    // record. A failed commit is a toast, not a rollback.
    vi.mocked(ledgerHead).mockResolvedValueOnce(null);
    vi.mocked(gitIpc.gitCommit).mockRejectedValueOnce(new Error('detached HEAD'));
    useVaultStore.setState({ vaultPath: '/v' });
    const refresh = vi.fn();
    const { result } = renderHook(() => useBatchCheckpoint(refresh));
    act(() => {
      result.current('b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1', 'promoted 2 beliefs');
    });
    await waitFor(() => expect(gitIpc.gitCommit).toHaveBeenCalled());
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('checkpointMessage', () => {
  it('names the note when there is only one', () => {
    expect(checkpointMessage([file('projects/atlas/items/fld-1.md')])).toBe('Update fld-1');
  });

  it('names the folder when the changes share one', () => {
    expect(checkpointMessage([file('knowledge/a.md'), file('knowledge/b.md')])).toBe(
      'Update 2 notes in knowledge',
    );
  });

  it('falls back to a count across folders', () => {
    expect(checkpointMessage([file('knowledge/a.md'), file('projects/b.md')])).toBe(
      'Update 2 notes',
    );
  });
});

// M15: `useGit` used to be a plain hook with its own useState, fetched once in
// an effect keyed on vaultPath. Six call sites therefore held six independent,
// never-refreshed copies — the status bar read "No changes" while the Changes
// page listed five, and the count the Commit affordance was gated on never
// moved for the rest of the session.
describe('useGit shares one state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGitState();
    useVaultStore.setState({ vaultPath: '/demo-vault', entries: [] });
  });
  afterEach(cleanup);

  it('probes once for two consumers, and they agree', async () => {
    const a = renderHook(() => useGit());
    const b = renderHook(() => useGit());
    await waitFor(() => expect(a.result.current.ready).toBe(true));
    expect(vi.mocked(gitIpc.isGitRepo)).toHaveBeenCalledTimes(1);
    expect(b.result.current.isRepo).toBe(true);
    expect(b.result.current.modified).toBe(a.result.current.modified);
  });

  it('re-reads when the vault entries change, so a save is not invisible', async () => {
    const { result } = renderHook(() => useGit());
    await waitFor(() => expect(result.current.ready).toBe(true));
    vi.mocked(gitIpc.getModifiedFiles).mockResolvedValueOnce([
      { path: 'docs/plan.md', status: 'modified', staged: false },
    ]);
    act(() => useVaultStore.setState({ entries: [] }));
    await waitFor(() => expect(result.current.modified).toHaveLength(1), { timeout: 4000 });
  });

  it('resets and re-probes when the vault itself changes', async () => {
    const { result } = renderHook(() => useGit());
    await waitFor(() => expect(result.current.ready).toBe(true));
    vi.mocked(gitIpc.isGitRepo).mockResolvedValueOnce(false);
    act(() => useVaultStore.setState({ vaultPath: '/other-vault' }));
    await waitFor(() => expect(result.current.isRepo).toBe(false));
    expect(vi.mocked(gitIpc.isGitRepo)).toHaveBeenLastCalledWith('/other-vault');
  });
});
