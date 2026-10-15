import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Spy mode: every call still reaches the mock backend; a test overrides one.
vi.mock('@/lib/ipc', { spy: true });

import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { TrashSettings } from './TrashSettings';

const VAULT = '/demo-vault';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const toasts = () => useUiStore.getState().toasts.map((t) => t.message);

function trashed(stamp: string, path: string, title: string) {
  fs().set(`.trash/${stamp}/${path}`, `# ${title}\n`);
  fs().set(
    `.trash/${stamp}/.trashed.json`,
    `${JSON.stringify(
      { format: 1, path, kind: 'file', title, deleted_at: '2026-10-12T08:00:00Z' },
      null,
      2,
    )}\n`,
  );
}

beforeEach(async () => {
  resetMockFs();
  vi.clearAllMocks();
  useUiStore.setState({ toasts: [] });
  await useVaultStore.getState().openVault(VAULT);
});
afterEach(cleanup);

describe('TrashSettings (M60.8)', () => {
  it('lists items newest first', async () => {
    trashed('20261012T080000Z-0001', 'notes/older.md', 'Older');
    trashed('20261013T080000Z-0002', 'notes/newer.md', 'Newer');
    render(<TrashSettings />);
    await waitFor(() => expect(screen.getAllByTestId('trash-item')).toHaveLength(2));
    const rows = screen.getAllByTestId('trash-item');
    expect(rows.map((r) => r.getAttribute('data-stamp'))).toEqual([
      '20261013T080000Z-0002',
      '20261012T080000Z-0001',
    ]);
    expect(rows[0].textContent).toContain('Newer');
    expect(rows[0].textContent).toContain('notes/newer.md');
  });

  it('says the Trash is empty when it is', async () => {
    render(<TrashSettings />);
    expect((await screen.findByTestId('trash-empty')).textContent).toBe('Nothing in the Trash.');
  });

  it('a failed read is unavailable with its reason, never empty', async () => {
    vi.mocked(ipc.listTrash).mockRejectedValue(new Error('permission denied'));
    render(<TrashSettings />);
    expect((await screen.findByTestId('section-unavailable')).textContent).toBe(
      "Couldn't read the Trash: permission denied",
    );
    expect(screen.queryByTestId('trash-empty')).toBeNull();
    vi.mocked(ipc.listTrash).mockReset();
  });

  it('Restore brings the page back and the row goes', async () => {
    trashed('20261012T080000Z-0001', 'notes/older.md', 'Older');
    const user = userEvent.setup();
    render(<TrashSettings />);
    await user.click(await screen.findByTestId('trash-restore'));
    await waitFor(() => expect(screen.queryByTestId('trash-item')).toBeNull());
    expect(fs().get('notes/older.md')).toBe('# Older\n');
    expect(toasts()).toEqual(['Restored “Older”']);
    expect(await screen.findByTestId('trash-empty')).toBeTruthy();
  });

  it('a refused restore toasts its words and keeps the row', async () => {
    trashed('20261012T080000Z-0001', 'notes/older.md', 'Older');
    fs().set('notes/older.md', '# Someone else\n');
    const user = userEvent.setup();
    render(<TrashSettings />);
    await user.click(await screen.findByTestId('trash-restore'));
    await waitFor(() =>
      expect(toasts()).toEqual([
        'notes/older.md already exists, so nothing was restored. Move or rename that page first.',
      ]),
    );
    expect(screen.getAllByTestId('trash-item')).toHaveLength(1);
    expect(fs().get('notes/older.md')).toBe('# Someone else\n');
  });

  it('an unreadable row lists with no Restore', async () => {
    fs().set('.trash/20261013T000000Z-beef/stray.md', '# Stray\n');
    render(<TrashSettings />);
    const row = await screen.findByTestId('trash-item');
    expect(row.textContent).toContain("Can't be read");
    expect(within(row).queryByTestId('trash-restore')).toBeNull();
  });
});
