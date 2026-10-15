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
    getFileHistory: vi.fn(async () => [] as FileCommit[]),
    getCommitDiff: vi.fn(async () => ''),
    getFilePatch: vi.fn(async () => ({ text: '', truncated: false, binary: false })),
    getFileAtCommit: vi.fn(async (): Promise<FileAt> => ({ kind: 'text', text: '' })),
    commitRuns: vi.fn(async () => [] as CommitRun[]),
    restoreNoteVersion: vi.fn(async (): Promise<RestoreResult> => ({
      unchanged: false,
      before: null,
      restored: 'r'.repeat(40),
      commitError: null,
    })),
  };
});

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return { ...actual, ledgerHead: vi.fn(async () => null) };
});

import {
  checkpointMessage,
  resetGitState,
  restoreVersion,
  useAutoCheckpoint,
  useBatchCheckpoint,
  useCommitDiff,
  useCommitRuns,
  useFileHistory,
  useFilePatch,
  useFileVersions,
  useGit,
  useVaultPulse,
  withLedgerTrailer,
} from '@/git/useGit';
import { ledgerHead } from '@/lib/ipc';
import * as gitIpc from '@/lib/gitIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type {
  CommitQuery,
  CommitRun,
  FileAt,
  FileCommit,
  ModifiedFile,
  RestoreResult,
  VaultPulse,
} from '@/engine/git';

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

// M58.3: a checkpoint never takes a path a live run owns. Rust's commit_all
// leaves those for the run's own commit, so the message names only the
// person's files, and a tick with only a run's files changed commits nothing.
describe('useAutoCheckpoint leaves a live run’s files to the run', () => {
  const owned = (path: string): ModifiedFile => ({
    ...file(path),
    owner: { runId: 'run-1', actor: 'claude-code' },
  });
  /** Long enough past the inactive threshold for a tick to commit. */
  const idle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(46_000);
    });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    useVaultStore.setState({ vaultPath: '/v' });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('names only the files no run owns', async () => {
    vi.mocked(gitIpc.getModifiedFiles).mockResolvedValue([
      owned('notes/a.md'),
      owned('notes/b.md'),
      file('notes/mine.md'),
    ]);
    vi.mocked(gitIpc.gitCommit).mockResolvedValue('abc1234');
    const committed = vi.fn();
    renderHook(() => useAutoCheckpoint(true, committed));
    await idle();
    expect(gitIpc.gitCommit).toHaveBeenCalled();
    expect(vi.mocked(gitIpc.gitCommit).mock.calls[0][1]).toBe('Update mine');
    expect(committed).toHaveBeenCalled();
  });

  it('commits nothing when only a run’s files changed', async () => {
    vi.mocked(gitIpc.getModifiedFiles).mockResolvedValue([owned('notes/a.md')]);
    renderHook(() => useAutoCheckpoint(true, vi.fn()));
    await idle();
    expect(gitIpc.getModifiedFiles).toHaveBeenCalled();
    expect(gitIpc.gitCommit).not.toHaveBeenCalled();
  });
});

describe('useFilePatch (M58.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVaultStore.setState({ vaultPath: '/v' });
  });
  afterEach(cleanup);

  it('asks nothing until a file and a commit are named, then reads once', async () => {
    const { result, rerender } = renderHook(
      ({ path, commit }: { path: string | null; commit: string | null }) =>
        useFilePatch(path, commit),
      { initialProps: { path: null as string | null, commit: 'abc' as string | null } },
    );
    expect(result.current).toEqual({ kind: 'loading' });
    expect(gitIpc.getFilePatch).not.toHaveBeenCalled();
    rerender({ path: 'notes/a.md', commit: 'abc' });
    await waitFor(() => expect(result.current.kind).toBe('ready'));
    expect(gitIpc.getFilePatch).toHaveBeenCalledExactlyOnceWith('/v', 'notes/a.md', 'abc');
  });

  it('reads a failed load as unavailable', async () => {
    vi.mocked(gitIpc.getFilePatch).mockRejectedValueOnce(new Error('bad revision'));
    const { result } = renderHook(() => useFilePatch('notes/a.md', 'abc'));
    await waitFor(() => expect(result.current).toEqual({ kind: 'unavailable' }));
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

const commit = (hash: string, patch: Partial<FileCommit> = {}): FileCommit => ({
  hash,
  shortHash: hash.slice(0, 7),
  message: `commit ${hash}`,
  author: 'Ana Rios',
  date: 1_753_700_000,
  parent: null,
  previousAt: null,
  pathAt: 'notes/plan.md',
  previousPath: null,
  change: 'modified',
  ...patch,
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
    const forA = deferred<FileCommit[]>();
    const forB = deferred<FileCommit[]>();
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

// M58.4: the attribution read, both sides of a version, and Restore.
describe('version reads and Restore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVaultStore.setState({ vaultPath: '/demo-vault', entries: [] });
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  it('useFileHistory hands back FileCommit rows', async () => {
    const row = commit('a'.repeat(40), { parent: 'b'.repeat(40), previousPath: 'old.md' });
    vi.mocked(gitIpc.getFileHistory).mockResolvedValueOnce([row]);
    const { result } = renderHook(() => useFileHistory('notes/plan.md'));
    await waitFor(() => expect(result.current).toEqual({ kind: 'ready', data: [row] }));
  });

  it('useCommitRuns is keyed by what it asks, and goes unavailable on a reject', async () => {
    const asked: CommitQuery[] = [{ hash: 'a'.repeat(40), path: 'notes/plan.md', since: null }];
    const { result, rerender } = renderHook(({ q }) => useCommitRuns(q), {
      initialProps: { q: asked },
    });
    await waitFor(() => expect(result.current).toEqual({ kind: 'ready', data: [] }));
    // The same queries in a fresh array ask nothing again.
    rerender({ q: asked.map((x) => ({ ...x })) });
    expect(gitIpc.commitRuns).toHaveBeenCalledTimes(1);
    expect(gitIpc.commitRuns).toHaveBeenCalledWith('/demo-vault', asked);
    vi.mocked(gitIpc.commitRuns).mockRejectedValueOnce(new Error('no runtime db'));
    rerender({ q: [{ hash: 'c'.repeat(40), path: null, since: null }] });
    await waitFor(() => expect(result.current.kind).toBe('unavailable'));
    // Nothing to ask is no read, and an empty answer.
    rerender({ q: [] });
    await waitFor(() => expect(result.current).toEqual({ kind: 'ready', data: [] }));
    expect(gitIpc.commitRuns).toHaveBeenCalledTimes(2);
  });

  it('useFileVersions reads after at pathAt and before at the parent, old name and all', async () => {
    const renamed = commit('a'.repeat(40), {
      parent: 'p'.repeat(40),
      pathAt: 'b.md',
      previousPath: 'a.md',
      change: 'renamed',
    });
    const { result } = renderHook(() => useFileVersions(renamed));
    await waitFor(() => expect(result.current.kind).toBe('ready'));
    expect(gitIpc.getFileAtCommit).toHaveBeenCalledWith('/demo-vault', 'b.md', 'a'.repeat(40));
    expect(gitIpc.getFileAtCommit).toHaveBeenCalledWith('/demo-vault', 'a.md', 'p'.repeat(40));
  });

  it('useFileVersions skips the side there is nothing to read on', async () => {
    const rootCommit = commit('a'.repeat(40), { parent: null });
    const root = renderHook(() => useFileVersions(rootCommit));
    await waitFor(() => expect(root.result.current.kind).toBe('ready'));
    expect(root.result.current).toEqual({
      kind: 'ready',
      data: { before: null, after: { kind: 'text', text: '' } },
    });
    vi.mocked(gitIpc.getFileAtCommit).mockClear();
    const addedCommit = commit('b'.repeat(40), { parent: 'p'.repeat(40), change: 'added' });
    const added = renderHook(() => useFileVersions(addedCommit));
    await waitFor(() => expect(added.result.current.kind).toBe('ready'));
    expect(gitIpc.getFileAtCommit).toHaveBeenCalledTimes(1);
    vi.mocked(gitIpc.getFileAtCommit).mockClear();
    const deletedCommit = commit('c'.repeat(40), { parent: 'p'.repeat(40), change: 'deleted' });
    const deleted = renderHook(() => useFileVersions(deletedCommit));
    await waitFor(() => expect(deleted.result.current.kind).toBe('ready'));
    expect(deleted.result.current).toMatchObject({ data: { after: null } });
    expect(gitIpc.getFileAtCommit).toHaveBeenCalledTimes(1);
    expect(gitIpc.getFileAtCommit).toHaveBeenCalledWith(
      '/demo-vault',
      'notes/plan.md',
      'p'.repeat(40),
    );
  });

  it('useFileVersions is unavailable when a read rejects', async () => {
    vi.mocked(gitIpc.getFileAtCommit).mockRejectedValueOnce(new Error('kept no copy'));
    const one = commit('a'.repeat(40));
    const { result } = renderHook(() => useFileVersions(one));
    await waitFor(() => expect(result.current.kind).toBe('unavailable'));
  });

  it('restoreVersion toasts what happened, and false on a refusal', async () => {
    const toasts = () => useUiStore.getState().toasts.map((t) => t.message);
    expect(await restoreVersion('/demo-vault', 'notes/plan.md', 'a'.repeat(40), 'Plan')).toBe(true);
    expect(toasts()).toEqual(['Restored Plan. The version it replaced is in History.']);
    vi.mocked(gitIpc.restoreNoteVersion).mockResolvedValueOnce({
      unchanged: true,
      before: null,
      restored: null,
      commitError: null,
    });
    await restoreVersion('/demo-vault', 'notes/plan.md', 'a'.repeat(40), 'Plan');
    vi.mocked(gitIpc.restoreNoteVersion).mockResolvedValueOnce({
      unchanged: false,
      before: null,
      restored: null,
      commitError: 'index.lock exists',
    });
    await restoreVersion('/demo-vault', 'notes/plan.md', 'a'.repeat(40), 'Plan');
    vi.mocked(gitIpc.restoreNoteVersion).mockRejectedValueOnce(
      new Error("That version is not in this page's history."),
    );
    expect(await restoreVersion('/demo-vault', 'notes/plan.md', 'z'.repeat(40), 'Plan')).toBe(
      false,
    );
    expect(toasts().slice(1)).toEqual([
      'This page already matches that version.',
      'Restored Plan. History will record it at the next checkpoint.',
      "Couldn't restore Plan: That version is not in this page's history.",
    ]);
  });
});
