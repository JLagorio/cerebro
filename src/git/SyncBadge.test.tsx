// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitRemoteStatus } from '@/engine/git';
import type { GitState } from '@/git/useGit';

const COUNTED: GitRemoteStatus = {
  hasRemote: true,
  hasUpstream: true,
  upstream: 'origin/main',
  branch: 'main',
  ahead: 2,
  behind: 0,
};

/** The remote the mocked shared state reports; its sync state is derived by
 * the real `syncState`, as `useGit` derives it. */
const git = vi.hoisted(() => ({
  remote: null as GitRemoteStatus | null,
  readError: null as string | null,
}));

vi.mock('@/git/useGit', async () => {
  const { syncState } = await import('@/engine/git');
  return {
    useGit: (): GitState => ({
      ready: true,
      isRepo: true,
      readError: git.readError,
      branch: 'main',
      modified: [],
      conflicts: [],
      conflictMode: 'none',
      remote: git.remote,
      sync: syncState(git.remote, 0, 0),
      refresh: async () => {},
    }),
  };
});

import { destination } from '@/engine/destinations';
import { UNCOUNTED_WORDS } from '@/engine/git';
import { SyncBadge } from '@/git/SyncBadge';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

beforeEach(() => {
  git.remote = COUNTED;
  git.readError = null;
  useVaultStore.setState({ vaultPath: '/demo-vault' });
  useNavStore.setState({ selection: { kind: 'home' } });
});

describe('SyncBadge (M59.1)', () => {
  it("names the history button as the nav does, with the table's icon, and opens it", () => {
    render(<SyncBadge />);
    fireEvent.click(screen.getByTestId('sync-badge'));
    const history = screen.getByRole('button', { name: 'History' });
    expect(screen.queryByRole('button', { name: 'Pulse' })).toBeNull();
    expect(history.querySelector(`[data-icon="${destination('pulse').icon}"]`)).not.toBeNull();
    fireEvent.click(history);
    expect(useNavStore.getState().selection).toEqual({ kind: 'pulse' });
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
  });
});

// M92.10: a count git did not take is unknown, never "Up to date".
describe('SyncBadge with counts git did not take (M92.10)', () => {
  it('says Up to date only for counts git took', () => {
    git.remote = { ...COUNTED, ahead: 0 };
    render(<SyncBadge />);
    expect(screen.getByTestId('sync-badge').textContent).toBe('Up to date');
    fireEvent.click(screen.getByTestId('sync-badge'));
    expect(screen.getByTestId('sync-remote-line').textContent).toBe('main · 0 ahead, 0 behind');
  });

  it('says Sync unknown when the count failed, and why, with no number', () => {
    git.remote = { ...COUNTED, ahead: null, behind: null };
    render(<SyncBadge />);
    const badge = screen.getByTestId('sync-badge');
    expect(badge.textContent).toBe('Sync unknown');
    expect(badge.querySelector('[data-icon="circle-dashed"]')).not.toBeNull();
    fireEvent.click(badge);
    const line = screen.getByTestId('sync-remote-line').textContent;
    expect(line).toBe(`main · ${UNCOUNTED_WORDS.unread}`);
    expect(line).not.toMatch(/null|\d/);
    expect(screen.queryByText('Up to date')).toBeNull();
  });

  it('says Sync unknown for a branch with no upstream, and names that', () => {
    git.remote = { ...COUNTED, ahead: null, behind: null, hasUpstream: false, upstream: null };
    render(<SyncBadge />);
    expect(screen.getByTestId('sync-badge').textContent).toBe('Sync unknown');
    fireEvent.click(screen.getByTestId('sync-badge'));
    expect(screen.getByTestId('sync-remote-line').textContent).toBe(
      `main · ${UNCOUNTED_WORDS.no_upstream}`,
    );
    // The person can still pull and push: git decides those, not the count.
    expect(screen.getByRole('button', { name: 'Pull' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Push' })).toBeTruthy();
  });
});

// M92.9: a read that failed can say none of the badge's states, and the
// status bar says it failed.
describe('SyncBadge after a git read that failed (M92.9)', () => {
  it('draws no badge, even over what an earlier read counted', () => {
    git.readError = 'git status exited 128';
    render(<SyncBadge />);
    expect(screen.queryByTestId('sync-badge')).toBeNull();
  });
});
