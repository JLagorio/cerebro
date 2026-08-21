// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/gitIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitIpc')>();
  return {
    ...actual,
    isGitRepo: vi.fn(async () => true),
    getModifiedFiles: vi.fn(async () => [
      { path: 'docs/plan.md', status: 'modified' as const, staged: false },
    ]),
    getConflictFiles: vi.fn(async () => []),
    getConflictMode: vi.fn(async () => 'none' as const),
    gitRemoteStatus: vi.fn(async () => ({
      hasRemote: true,
      upstream: 'origin/main',
      branch: 'main',
      ahead: 0,
      behind: 0,
    })),
  };
});

import { StatusBar } from '@/app/StatusBar';
import * as gitIpc from '@/lib/gitIpc';
import { resetGitState } from '@/git/useGit';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

describe('StatusBar', () => {
  beforeEach(() => {
    resetGitState();
    useVaultStore.setState({ vaultPath: '/demo-vault', entries: [] });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
  });

  // M15: `useGit` was a plain hook whose six call sites each held an
  // independent, never-refreshed copy. The strip read "No changes" while the
  // Changes page listed five.
  it('reads the shared git state rather than a snapshot from vault-open', async () => {
    render(<StatusBar />);
    expect(await screen.findByText('1 Changes')).toBeTruthy();
    expect(vi.mocked(gitIpc.getModifiedFiles)).toHaveBeenCalledWith('/demo-vault');
  });

  // M15: the segment labelled "Commit" ran no git command — it navigated to
  // Changes, which the segment beside it already does.
  it('offers no button labelled Commit that does not commit', async () => {
    render(<StatusBar />);
    await screen.findByText('1 Changes');
    expect(screen.queryByTestId('status-commit')).toBeNull();
  });

  // M15: the nav already owns both destinations; two chromes offering the
  // same door under different labels means neither reads as authoritative.
  it('drops the History and Settings segments the nav already owns', async () => {
    render(<StatusBar />);
    await screen.findByText('1 Changes');
    expect(screen.queryByTestId('status-history')).toBeNull();
    expect(screen.queryByTestId('status-settings')).toBeNull();
  });

  // M15: an effect stamped `lastSync` the moment a repo was detected, so the
  // strip claimed "Synced" on every launch before anything had synced.
  it('says Sync until a sync has actually happened', async () => {
    render(<StatusBar />);
    await screen.findByText('1 Changes');
    expect(screen.getByTestId('status-sync').textContent).toBe('Sync');
  });
});
