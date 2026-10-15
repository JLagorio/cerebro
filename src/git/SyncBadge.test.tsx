// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitState } from '@/git/useGit';

vi.mock('@/git/useGit', () => ({
  useGit: (): GitState => ({
    ready: true,
    isRepo: true,
    modified: [],
    conflicts: [],
    conflictMode: 'none',
    remote: {
      hasRemote: true,
      hasUpstream: true,
      upstream: 'origin/main',
      branch: 'main',
      ahead: 2,
      behind: 0,
    },
    sync: 'ahead',
    refresh: async () => {},
  }),
}));

import { destination } from '@/engine/destinations';
import { SyncBadge } from '@/git/SyncBadge';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

describe('SyncBadge (M59.1)', () => {
  beforeEach(() => {
    useVaultStore.setState({ vaultPath: '/demo-vault' });
    useNavStore.setState({ selection: { kind: 'home' } });
  });

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
