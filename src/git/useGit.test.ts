// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

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
    getVaultPulse: vi.fn(async (): Promise<VaultPulse> => ({ tracked: true, commits: [] })),
    getFileHistory: vi.fn(async () => [] as GitCommit[]),
    getCommitDiff: vi.fn(async () => ''),
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
  useCommitDiff,
  useFileHistory,
  useGit,
  useVaultPulse,
  withLedgerTrailer,
} from '@/git/useGit';
import { ledgerHead } from '@/lib/ipc';
import * as gitIpc from '@/lib/gitIpc';
import { useVaultStore } from '@/stores/vaultStore';
import type { GitCommit, ModifiedFile, VaultPulse } from '@/engine/git';

const file = (path: string): ModifiedFile => ({ path, status: 'modified', staged: false });

// M21.7: the trailer is a join key between a commit and the ledger head —
// nothing reads it back (M49.10) — appended when a ledger head exists, and
// NOTHING about a checkpoint changes when one does not.
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

// M53.13: the shell stopped letting WebKit throttle a hidden window, so an
// awake 20 s poll would keep spawning git for as long as the app sat hidden,
// for a state nothing hidden shows. It sleeps instead, and coming back reads.
describe('the git poll sleeps while the window is hidden', () => {
  /** useGit's POLL_MS. */
  const POLL = 20_000;
  let visibility: MockInstance<() => DocumentVisibilityState> | null = null;

  /** Let fake time pass, and every probe it started land. */
  const pass = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetGitState();
    useVaultStore.setState({ vaultPath: '/demo-vault', entries: [] });
  });
  afterEach(() => {
    cleanup();
    visibility?.mockRestore();
    visibility = null;
    vi.useRealTimers();
  });

  it('probes nothing while hidden, reads once on coming back, then polls again', async () => {
    visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    renderHook(() => useGit());
    await pass(0);
    // Opening the vault reads it, whatever the window is doing.
    expect(gitIpc.isGitRepo).toHaveBeenCalledTimes(1);

    await pass(POLL);
    expect(gitIpc.isGitRepo).toHaveBeenCalledTimes(1);

    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await pass(0);
    expect(gitIpc.isGitRepo).toHaveBeenCalledTimes(2);

    // Asleep, not gone: the next tick in view probes again.
    await pass(POLL);
    expect(gitIpc.isGitRepo).toHaveBeenCalledTimes(3);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const commit = (hash: string): GitCommit => ({
  hash,
  shortHash: hash.slice(0, 7),
  message: `commit ${hash}`,
  author: 'Ana Rios',
  date: 1_753_700_000,
});

// M53.15: these hooks caught a failed read and handed back [] — so the History
// page said "No history yet" and a note's History block vanished when git
// could not be read at all. A failed read is its own answer now.
describe('history reads tell a failed read from an empty one', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVaultStore.setState({ vaultPath: '/demo-vault', entries: [] });
  });
  afterEach(cleanup);

  it('starts loading, and a rejected read is unavailable rather than empty', async () => {
    vi.mocked(gitIpc.getFileHistory).mockRejectedValueOnce(new Error('git log exited 128'));
    const { result } = renderHook(() => useFileHistory('notes/plan.md'));
    expect(result.current.kind).toBe('loading');
    await waitFor(() => expect(result.current.kind).toBe('unavailable'));
  });

  it('hands back what a resolved read returned', async () => {
    vi.mocked(gitIpc.getFileHistory).mockResolvedValueOnce([commit('aaaaaaaa')]);
    const { result } = renderHook(() => useFileHistory('notes/plan.md'));
    await waitFor(() =>
      expect(result.current).toEqual({ kind: 'ready', data: [commit('aaaaaaaa')] }),
    );
    expect(gitIpc.getFileHistory).toHaveBeenCalledWith('/demo-vault', 'notes/plan.md');
  });

  it('reads the pulse again on reload', async () => {
    vi.mocked(gitIpc.getVaultPulse).mockRejectedValueOnce(new Error('git log exited 128'));
    const { result } = renderHook(() => useVaultPulse());
    await waitFor(() => expect(result.current.pulse.kind).toBe('unavailable'));
    act(() => result.current.reload());
    await waitFor(() =>
      expect(result.current.pulse).toEqual({ kind: 'ready', data: { tracked: true, commits: [] } }),
    );
    expect(gitIpc.getVaultPulse).toHaveBeenCalledTimes(2);
  });

  it("goes back to loading on a new path and ignores the old path's late answer", async () => {
    const forA = deferred<GitCommit[]>();
    const forB = deferred<GitCommit[]>();
    vi.mocked(gitIpc.getFileHistory)
      .mockReturnValueOnce(forA.promise)
      .mockReturnValueOnce(forB.promise);
    const { result, rerender } = renderHook(({ path }) => useFileHistory(path), {
      initialProps: { path: 'notes/a.md' },
    });
    rerender({ path: 'notes/b.md' });
    expect(result.current.kind).toBe('loading');

    await act(async () => forA.resolve([commit('aaaaaaaa')]));
    expect(result.current.kind).toBe('loading');

    await act(async () => forB.resolve([commit('bbbbbbbb')]));
    expect(result.current).toEqual({ kind: 'ready', data: [commit('bbbbbbbb')] });
  });

  it('reads no diff until a commit is asked for', async () => {
    vi.mocked(gitIpc.getCommitDiff).mockResolvedValueOnce('diff --git a/x b/x');
    const { result, rerender } = renderHook(({ hash }) => useCommitDiff(hash), {
      initialProps: { hash: null as string | null },
    });
    expect(result.current.kind).toBe('loading');
    expect(gitIpc.getCommitDiff).not.toHaveBeenCalled();

    rerender({ hash: 'c2c2c2c2' });
    await waitFor(() =>
      expect(result.current).toEqual({ kind: 'ready', data: 'diff --git a/x b/x' }),
    );
    expect(gitIpc.getCommitDiff).toHaveBeenCalledWith('/demo-vault', 'c2c2c2c2');
  });

  it('is unavailable, not empty, with no vault to read', () => {
    useVaultStore.setState({ vaultPath: null });
    const { result } = renderHook(() => useVaultPulse());
    expect(result.current.pulse.kind).toBe('unavailable');
    expect(gitIpc.getVaultPulse).not.toHaveBeenCalled();
  });
});
