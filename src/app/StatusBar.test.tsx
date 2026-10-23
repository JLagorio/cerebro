import { navSeed } from '@/test/navSeed';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    gitPull: vi.fn(),
    gitPush: vi.fn(),
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
import { APP_VERSION } from '@/lib/appVersion';
import * as gitIpc from '@/lib/gitIpc';
import { resetGitState } from '@/git/useGit';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import type { RemoteResult } from '@/engine/git';

const result = (status: RemoteResult['status'], message: string): RemoteResult => ({
  status,
  message,
  updatedFiles: [],
  conflictFiles: [],
});

afterEach(cleanup);

describe('StatusBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(gitIpc.isGitRepo).mockResolvedValue(true);
    vi.mocked(gitIpc.getModifiedFiles).mockResolvedValue([
      { path: 'docs/plan.md', status: 'modified', staged: false },
    ]);
    vi.mocked(gitIpc.getConflictFiles).mockResolvedValue([]);
    vi.mocked(gitIpc.gitRemoteStatus).mockResolvedValue({
      hasRemote: true,
      hasUpstream: true,
      upstream: 'origin/main',
      branch: 'main',
      ahead: 0,
      behind: 0,
    });
    vi.mocked(gitIpc.gitPull).mockResolvedValue(result('up_to_date', 'Already up to date.'));
    vi.mocked(gitIpc.gitPush).mockResolvedValue(result('ok', 'Pushed.'));
    resetGitState();
    useUiStore.setState({ toast: vi.fn() });
    useVaultStore.setState({ vaultPath: '/demo-vault', entries: [] });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [navSeed({ kind: 'home' })],
      historyIndex: 0,
    });
  });

  // M15: `useGit` was a plain hook whose six call sites each held an
  // independent, never-refreshed copy. The strip read "No changes" while the
  // Changes page listed five.
  it('reads the shared git state rather than a snapshot from vault-open', async () => {
    render(<StatusBar />);
    expect(await screen.findByText('1 change')).toBeTruthy();
    expect(vi.mocked(gitIpc.getModifiedFiles)).toHaveBeenCalledWith('/demo-vault');
  });

  // M15: the segment labelled "Commit" ran no git command — it navigated to
  // Changes, which the segment beside it already does.
  it('offers no button labelled Commit that does not commit', async () => {
    render(<StatusBar />);
    await screen.findByText('1 change');
    expect(screen.queryByTestId('status-commit')).toBeNull();
  });

  // M15: the nav already owns both destinations; two chromes offering the
  // same door under different labels means neither reads as authoritative.
  it('drops the History and Settings segments the nav already owns', async () => {
    render(<StatusBar />);
    await screen.findByText('1 change');
    expect(screen.queryByTestId('status-history')).toBeNull();
    expect(screen.queryByTestId('status-settings')).toBeNull();
  });

  // M15: an effect stamped `lastSync` the moment a repo was detected, so the
  // strip claimed "Synced" on every launch before anything had synced.
  it('says Sync until a sync has actually happened', async () => {
    render(<StatusBar />);
    await screen.findByText('1 change');
    expect(screen.getByTestId('status-sync').textContent).toBe('Sync');
  });

  // M59.1: the strip said 2026.7.29 while Settings said 0.1.0.
  it("shows the app's one version", async () => {
    render(<StatusBar />);
    await screen.findByText('1 change');
    expect(screen.queryByTitle('Cerebro version')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Workspace status: demo-vault' }));
    expect(screen.getByTitle('Cerebro version').textContent).toBe(APP_VERSION);
    expect(screen.getByTestId('status-branch').textContent).toBe('main');
  });
  it('keeps a clean local vault quiet and preserves Settings and Changes in its disclosure', async () => {
    vi.mocked(gitIpc.getModifiedFiles).mockResolvedValue([]);
    vi.mocked(gitIpc.gitRemoteStatus).mockResolvedValue({
      hasRemote: false,
      hasUpstream: false,
      upstream: null,
      branch: 'main',
      ahead: 0,
      behind: 0,
    });
    render(<StatusBar />);
    const opener = await screen.findByRole('button', { name: 'Workspace status: demo-vault' });
    const footer = screen.getByTestId('status-bar');
    expect(within(footer).queryByText('No remote')).toBeNull();
    expect(within(footer).queryByText('No changes')).toBeNull();
    expect(within(footer).queryByTestId('status-sync')).toBeNull();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Workspace status' })).toBeTruthy();
    expect(screen.getByTestId('status-remote').textContent).toBe('No remote');
    expect(screen.getByTestId('status-branch').textContent).toBe('Not recorded');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'View changes' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'changes' });
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace settings' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'settings' });
    expect(gitIpc.gitPull).not.toHaveBeenCalled();
    expect(gitIpc.gitPush).not.toHaveBeenCalled();
  });

  it('keeps the history setup action for an untracked vault in workspace details', async () => {
    vi.mocked(gitIpc.isGitRepo).mockResolvedValue(false);
    render(<StatusBar />);
    fireEvent.click(await screen.findByRole('button', { name: 'Workspace status: demo-vault' }));
    expect(screen.getByText('Not tracked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start tracking history' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'changes' });
  });

  it('keeps conflicts visible outside the disclosure with their review action', async () => {
    vi.mocked(gitIpc.getConflictFiles).mockResolvedValue(['docs/plan.md']);
    render(<StatusBar />);
    const conflict = await screen.findByRole('button', { name: '1 conflicted' });
    expect(conflict.getAttribute('data-tone')).toBe('danger');
    fireEvent.click(conflict);
    expect(useNavStore.getState().selection).toEqual({ kind: 'changes' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not claim Synced when push fails, and exposes the actual failure', async () => {
    vi.mocked(gitIpc.gitPush).mockResolvedValue(result('auth_error', 'Credentials were rejected.'));
    render(<StatusBar />);
    fireEvent.click(await screen.findByTestId('status-sync'));
    expect(await screen.findByRole('button', { name: 'Sync failed' })).toBeTruthy();
    expect(screen.queryByText('Synced')).toBeNull();
    expect(gitIpc.gitPull).toHaveBeenCalledOnce();
    expect(gitIpc.gitPush).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId('status-vault'));
    expect(screen.getByRole('alert').textContent).toBe('Credentials were rejected.');
    expect(useUiStore.getState().toast).toHaveBeenCalledWith('Credentials were rejected.');
  });

  it.each(['conflict', 'no_remote', 'network_error'] as const)(
    'does not push after a %s pull',
    async (status) => {
      vi.mocked(gitIpc.gitPull).mockResolvedValue(result(status, 'Pull cannot continue.'));
      render(<StatusBar />);
      fireEvent.click(await screen.findByTestId('status-sync'));
      await screen.findByRole('button', { name: 'Sync failed' });
      expect(gitIpc.gitPush).not.toHaveBeenCalled();
    },
  );

  it('guards repeated sync and says Synced only after the push succeeds', async () => {
    let complete!: (value: RemoteResult) => void;
    vi.mocked(gitIpc.gitPull).mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    render(<StatusBar />);
    const sync = await screen.findByTestId('status-sync');
    fireEvent.click(sync);
    fireEvent.click(sync);
    expect(gitIpc.gitPull).toHaveBeenCalledOnce();
    expect((sync as HTMLButtonElement).disabled).toBe(true);
    expect(sync.textContent).toBe('Syncing…');
    expect(gitIpc.gitPush).not.toHaveBeenCalled();
    await act(async () => complete(result('up_to_date', 'Ready.')));
    await screen.findByRole('button', { name: 'Synced' });
    expect(gitIpc.gitPush).toHaveBeenCalledOnce();
  });

  it('catches an unexpected remote rejection without losing the retry control', async () => {
    vi.mocked(gitIpc.gitPull).mockRejectedValue(new Error('The connection closed.'));
    render(<StatusBar />);
    fireEvent.click(await screen.findByTestId('status-sync'));
    expect(await screen.findByRole('button', { name: 'Sync failed' })).toBeTruthy();
    expect(useUiStore.getState().toast).toHaveBeenCalledWith('The connection closed.');
  });
});
