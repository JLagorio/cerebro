// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/gitIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitIpc')>();
  return {
    ...actual,
    isGitRepo: vi.fn(async () => true),
    getModifiedFiles: vi.fn(async () => []),
    getConflictFiles: vi.fn(async () => []),
    getConflictMode: vi.fn(async () => 'none' as const),
    gitRemoteStatus: vi.fn(async () => ({
      branch: 'main',
      ahead: null,
      behind: null,
      hasRemote: false,
      hasUpstream: false,
      upstream: null,
    })),
    gitProviderStatus: vi.fn(async () => ({ native: { available: true, message: '' } })),
    gitAuthorIdentity: vi.fn(async () => ({
      name: 'Ana Rios',
      email: 'ana@example.test',
      source: 'repository',
      warning: null,
    })),
  };
});

import { GitSettings } from '@/git/GitSettings';
import { resetGitState } from '@/git/useGit';
import * as gitIpc from '@/lib/gitIpc';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * History in Settings (M9.4), and a git read that failed (M92.9): it says the
 * read failed and reads again on request. It never offers Enable history,
 * which is for a vault a read found has none.
 */

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitIpc.isGitRepo).mockResolvedValue(true);
  resetGitState();
  useVaultStore.setState({ vaultPath: '/demo-vault', entries: [] });
});
afterEach(cleanup);

describe('GitSettings', () => {
  it('offers Enable history where a read found no repository', async () => {
    vi.mocked(gitIpc.isGitRepo).mockResolvedValue(false);
    render(<GitSettings />);
    expect(await screen.findByRole('button', { name: 'Enable history' })).toBeTruthy();
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });

  it('says a failed read failed, offers no Enable history, and reads again on Try again', async () => {
    vi.mocked(gitIpc.isGitRepo).mockRejectedValue(new Error('git is not on this PATH'));
    render(<GitSettings />);
    const unavailable = await screen.findByTestId('section-unavailable');
    expect(unavailable.textContent).toContain('Couldn’t read this vault’s history');
    expect(unavailable.textContent).toContain('git is not on this PATH');
    expect(screen.queryByRole('button', { name: 'Enable history' })).toBeNull();
    expect(gitIpc.isGitRepo).toHaveBeenCalledTimes(1);
    vi.mocked(gitIpc.isGitRepo).mockResolvedValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Automatic checkpoints')).toBeTruthy();
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
    expect(gitIpc.isGitRepo).toHaveBeenCalledTimes(2);
  });
});
