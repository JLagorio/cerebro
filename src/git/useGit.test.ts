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
  };
});

import { checkpointMessage, resetGitState, useGit } from '@/git/useGit';
import * as gitIpc from '@/lib/gitIpc';
import { useVaultStore } from '@/stores/vaultStore';
import type { ModifiedFile } from '@/engine/git';

const file = (path: string): ModifiedFile => ({ path, status: 'modified', staged: false });

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
