// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    getLastVault: vi.fn(async () => '/demo-vault'),
    pickVault: vi.fn(async () => null),
    scanVault: vi.fn(async () => []),
    listViews: vi.fn(async () => []),
    startWatcher: vi.fn(async () => {}),
  };
});

import App from '@/App';
import * as ipc from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault, makeEntry } from '@/test/factories';

describe('App boot flow', () => {
  beforeEach(() => {
    useVaultStore.setState({
      vaultPath: null,
      entries: [],
      views: [],
      status: 'idle',
      error: null,
    });
    useNavStore.setState({
      selection: { kind: 'home' },
      history: [{ kind: 'home' }],
      historyIndex: 0,
    });
    useUiStore.setState({ quickOpenVisible: false, toasts: [], detailPath: null });
  });

  afterEach(cleanup);

  it('opens the last vault on boot and shows the sidebar', async () => {
    render(<App />);
    expect(await screen.findByRole('navigation', { name: 'Sidebar' })).toBeTruthy();
    expect(vi.mocked(ipc.getLastVault)).toHaveBeenCalled();
    expect(screen.queryByText('Open demo vault')).toBeNull();
  });

  it('shows the vault chooser when no vault is configured', async () => {
    vi.mocked(ipc.getLastVault).mockResolvedValueOnce(null);
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Open demo vault' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();
  });

  // Deviation test (Task 23, execution-log note 15b, reported): a
  // getLastVault rejection left `booted` false forever — a permanently blank
  // screen instead of the vault chooser.
  it('still shows the vault chooser when reading the last vault fails', async () => {
    vi.mocked(ipc.getLastVault).mockRejectedValueOnce(new Error('config unreadable'));
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Open demo vault' })).toBeTruthy();
  });

  // Deviation test (Task 23, execution-log note 15c, reported): the chooser's
  // async click handlers were unguarded — a picker rejection was a silent
  // unhandled rejection with no feedback.
  it('shows the picker error in the chooser when choosing a folder fails', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.getLastVault).mockResolvedValueOnce(null);
    vi.mocked(ipc.pickVault).mockRejectedValueOnce(new Error('dialog crashed'));
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Choose folder…' }));
    expect(await screen.findByText('dialog crashed')).toBeTruthy();
  });

  it('opens the quick-open palette on cmd+k', async () => {
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(useUiStore.getState().quickOpenVisible).toBe(true);
  });

  it('routes the settings selection to the settings page', async () => {
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    act(() => useNavStore.getState().navigate({ kind: 'settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy();
  });

  // Fix test (fix round D8): plan line 7618 promises the Sidebar seam opens
  // the project dialog "prefilled with the space"; Task 23's spec never wired
  // it, leaving dead chrome (note-14 violation).
  it('sidebar new-project row opens the dialog preselected with the clicked space', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.scanVault).mockResolvedValueOnce([
      // A space that sorts first in the sidebar AND lists first in the
      // dialog's default, so preselection is distinguishable from both.
      makeEntry({ path: 'spaces/aaa-ops.md', title: 'AAA ops', type: 'Space' }),
      ...fixtureVault(),
    ]);
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    const rows = screen.getAllByRole('button', { name: 'New project' });
    await user.click(rows[1]); // Field platform's row (sidebar sorts spaces by title)
    const dialog = await screen.findByRole('dialog');
    expect((within(dialog).getByLabelText('Space') as HTMLSelectElement).value).toBe(
      'spaces/field-platform.md',
    );
  });
});
