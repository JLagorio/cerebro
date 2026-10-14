import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return { ...actual, pickVault: vi.fn(async () => null) };
});

vi.mock('@/agent/agentIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/agentIpc')>();
  return {
    ...actual,
    checkAgent: vi.fn(async () => ({
      installed: true,
      version: '2.1.250 (Claude Code)',
      path: '/opt/claude/bin/claude',
    })),
  };
});

import { SettingsPage } from '@/pages/SettingsPage';
import { makeEntry } from '@/engine/testHelpers';
import { resetMockFs } from '@/lib/mockIpc';
import * as agentIpc from '@/agent/agentIpc';
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

  // M56.4: the row a not-signed-in card's Open Settings lands on.
  describe('the Claude Code row', () => {
    const status = () => screen.getByTestId('settings-claude-code-status');

    it('leads the Assistant section with the version, path and sign-in words', async () => {
      render(<SettingsPage />);
      const row = screen.getByTestId('settings-claude-code');
      expect(row.textContent).toContain(
        "Cerebro runs your own copy and uses its sign-in; no key enters the app. If a run says Claude Code isn't signed in, open Terminal, run claude, and type /login.",
      );
      await vi.waitFor(() => expect(status().textContent).toContain('2.1.250 (Claude Code)'));
      expect(status().textContent).toContain('/opt/claude/bin/claude');
      const section = row.closest('section');
      expect(section?.querySelector('h2')?.textContent).toBe('Assistant');
      // It comes before every other row of the section.
      expect(section?.querySelector('[data-testid="settings-claude-code"]')).toBe(row);
      expect(
        row.compareDocumentPosition(screen.getByRole('switch', { name: 'Shell access' })) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('says when Claude Code is not found', async () => {
      vi.mocked(agentIpc.checkAgent).mockResolvedValueOnce({
        installed: false,
        version: null,
        path: null,
      });
      render(<SettingsPage />);
      await vi.waitFor(() =>
        expect(status().textContent).toBe(
          'Claude Code was not found on this machine. Install it, then reopen Cerebro.',
        ),
      );
    });

    it("says when it couldn't check", async () => {
      vi.mocked(agentIpc.checkAgent).mockRejectedValueOnce(new Error('ipc down'));
      render(<SettingsPage />);
      await vi.waitFor(() =>
        expect(status().textContent).toBe("Couldn't check for Claude Code on this machine."),
      );
    });

    it('scrolls into view once when a card asked for it, then clears the ask', async () => {
      const scrolled = vi.fn();
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = scrolled;
      try {
        useUiStore.setState({ settingsFocus: 'claude-code' });
        render(<SettingsPage />);
        await vi.waitFor(() => expect(useUiStore.getState().settingsFocus).toBeNull());
        expect(scrolled).toHaveBeenCalledTimes(1);
        expect(scrolled.mock.contexts[0]).toBe(screen.getByTestId('settings-claude-code'));
        cleanup();
        render(<SettingsPage />);
        expect(scrolled).toHaveBeenCalledTimes(1);
      } finally {
        Element.prototype.scrollIntoView = original;
      }
    });
  });
});

// M56.6 — Settings binds this vault's panel to an Agent record.
describe('Panel assistant', () => {
  const SCOUT = makeEntry({
    path: 'records/agents/release-scout.md',
    title: 'Release scout',
    type: 'Agent',
  });
  const DIGEST = makeEntry({
    path: 'records/agents/digest.md',
    title: 'Digest',
    type: 'Agent',
    properties: { paused: true },
  });

  beforeEach(() => {
    resetMockFs();
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      status: 'ready',
      error: null,
      entries: [SCOUT, DIGEST],
    });
    useUiStore.setState({ toasts: [], panelAgents: {} });
  });

  const select = () => screen.getByRole('combobox', { name: 'Panel assistant' });

  it('lists the plain assistant and each agent by title, paused ones marked', async () => {
    render(<SettingsPage />);
    const options = Array.from(select().querySelectorAll('option')).map((o) => [
      o.value,
      o.textContent,
    ]);
    expect(options).toEqual([
      ['', 'Claude Code (no agent)'],
      ['digest', 'Digest (paused)'],
      ['release-scout', 'Release scout'],
    ]);
    await vi.waitFor(() => expect(useUiStore.getState().panelAgents['/demo-vault']).toBeNull());
    expect((select() as HTMLSelectElement).value).toBe('');
    expect(screen.getByText(/Who answers in the assistant panel\./)).toBeTruthy();
  });

  it('choosing an agent writes the binding, and the plain assistant clears it', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    await vi.waitFor(() => expect(useUiStore.getState().panelAgents['/demo-vault']).toBeNull());
    await user.selectOptions(select(), 'release-scout');
    await vi.waitFor(async () =>
      expect(await ipc.getPanelAgent('/demo-vault')).toBe('release-scout'),
    );
    expect((select() as HTMLSelectElement).value).toBe('release-scout');
    await user.selectOptions(select(), '');
    await vi.waitFor(async () => expect(await ipc.getPanelAgent('/demo-vault')).toBeNull());
    expect(screen.queryByTestId('panel-agent-dangling')).toBeNull();
  });

  it('names a binding no record answers to, and Clear unbinds it', async () => {
    const user = userEvent.setup();
    await ipc.setPanelAgent('/demo-vault', 'old-scout');
    render(<SettingsPage />);
    const line = await screen.findByTestId('panel-agent-dangling');
    expect(line.textContent).toContain(
      '@old-scout — no agent answers to this name, so the assistant answers',
    );
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await vi.waitFor(() => expect(screen.queryByTestId('panel-agent-dangling')).toBeNull());
    expect(await ipc.getPanelAgent('/demo-vault')).toBeNull();
  });
});
