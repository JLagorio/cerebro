// Reviewer reproducer: public save + scan completion while History stays mounted.
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { resetMockFs, createNote } from '@/lib/mockIpc';
import { mockRecovery } from '@/lib/mockRecovery';
import { useVaultStore } from '@/stores/vaultStore';
import { RecoveryVersions } from '@/history/RecoveryVersions';

beforeEach(async () => {
  vi.restoreAllMocks();
  resetMockFs();
  useVaultStore.setState({ vaultPath: 'v' });
  await createNote('v', '', 'recovery', {}, 'outside bytes');
  mockRecovery.setEnabled('v', true);
  useVaultStore.setState({ entries: await ipc.scanVault('v') });
});

it('shows the newly retained preimage after an ordinary body save while History remains open', async () => {
  render(<RecoveryVersions path="recovery.md" />);
  await screen.findByText('No retained recovery copies for this page.');
  await act(async () => {
    await ipc.saveNoteBody({ vault: 'v', path: 'recovery.md', body: 'new human bytes' });
    useVaultStore.setState({ entries: await ipc.scanVault('v') });
  });
  expect(mockRecovery.list('v', 'recovery.md')).toHaveLength(1);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeNull(), {
    timeout: 250,
  });
});
