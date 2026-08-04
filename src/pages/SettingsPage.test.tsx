import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return { ...actual, pickVault: vi.fn(async () => null) };
});

import { SettingsPage } from '@/pages/SettingsPage';
import * as ipc from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

describe('SettingsPage', () => {
  beforeEach(() => {
    useVaultStore.setState({ vaultPath: '/demo-vault', status: 'ready', error: null });
    useUiStore.setState({ toasts: [] });
  });

  it('shows the current vault path and app version', () => {
    render(<SettingsPage />);
    expect(screen.getByText('/demo-vault')).toBeTruthy();
    expect(screen.getByText('0.1.0')).toBeTruthy();
  });

  it('re-picks and opens a new vault from the change vault button', async () => {
    const user = userEvent.setup();
    const openVault = vi.fn().mockResolvedValue(undefined);
    useVaultStore.setState({ openVault });
    vi.mocked(ipc.pickVault).mockResolvedValueOnce('/new-vault');
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: 'Change vault…' }));
    await vi.waitFor(() => expect(openVault).toHaveBeenCalledWith('/new-vault'));
  });

  // Deviation test (execution-log note 15a, reported): vaultStore.status ===
  // 'error' was displayed nowhere — the vault section surfaces it so a failed
  // boot is recoverable right where "Change vault…" lives.
  it('shows the vault error when the last open failed', () => {
    useVaultStore.setState({ status: 'error', error: 'Not a vault: /gone' });
    render(<SettingsPage />);
    expect(screen.getByText('Not a vault: /gone')).toBeTruthy();
  });

  // Deviation test (execution-log note 17b guard discipline, reported): the
  // folder picker itself can reject — no fire-and-forget writes in Settings.
  it('surfaces a picker failure via toast', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.pickVault).mockRejectedValueOnce(new Error('dialog crashed'));
    render(<SettingsPage />);
    await user.click(screen.getByRole('button', { name: 'Change vault…' }));
    await vi.waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        "Couldn't open the folder picker",
      );
    });
  });

  // M16.36: the only place the theme can be chosen. The control writes the
  // CHOICE — resolving 'system' to a concrete palette is useTheme's job, and
  // is covered there.
  it('picks a theme, and the choice reaches the store', async () => {
    const user = userEvent.setup();
    useUiStore.setState({ themeMode: 'system' });
    render(<SettingsPage />);
    await user.click(screen.getByTestId('theme-dark'));
    expect(useUiStore.getState().themeMode).toBe('dark');
    await user.click(screen.getByTestId('theme-system'));
    expect(useUiStore.getState().themeMode).toBe('system');
  });

  it('marks the stored mode as the selected segment', () => {
    useUiStore.setState({ themeMode: 'light' });
    render(<SettingsPage />);
    expect(screen.getByTestId('theme-light').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('theme-dark').getAttribute('aria-selected')).toBe('false');
  });

  // M15 [CRITICAL]: Settings had no scroll container at all — its root was a
  // plain `mx-auto max-w-[640px]` div inside a flex row that neither scrolls
  // nor clips. Everything below the fold was unreachable, and the overflow
  // painted on top of the status bar and swallowed its clicks.
  it('is its own scroll host so nothing below the fold is unreachable', () => {
    render(<SettingsPage />);
    const page = screen.getByTestId('settings-page');
    expect(page.className).toContain('overflow-y-auto');
    // `flex-1` without `min-h-0` still overflows a flex parent.
    expect(page.className).toContain('min-h-0');
    expect(page.className).toContain('flex-1');
  });
});
