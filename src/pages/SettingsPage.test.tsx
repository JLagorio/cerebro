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
    claudeUserSettings: vi.fn(async () => ({ state: 'browser' })),
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

  // M59.3 — the open log is a Settings section, after Workflow.
  it('renders Recently opened after Workflow', () => {
    render(<SettingsPage />);
    const section = screen.getByTestId('settings-recently-opened');
    expect(section.querySelector('h2')?.textContent).toBe('Recently opened');
    const headings = [...document.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings.indexOf('Recently opened')).toBe(headings.indexOf('Workflow') + 1);
  });

  // M60.8 — the vault's Trash is a Settings section, right after Vault.
  it('renders Recently deleted after Vault', async () => {
    resetMockFs();
    render(<SettingsPage />);
    const section = screen.getByTestId('settings-trash');
    expect(section.querySelector('h2')?.textContent).toBe('Recently deleted');
    const headings = [...document.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings.indexOf('Recently deleted')).toBe(headings.indexOf('Vault') + 1);
    expect(await screen.findByTestId('trash-empty')).toBeTruthy();
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

  // M57.2: Shell access is a ceiling of three, with the person's own Claude
  // Code rules counted beside it.
  describe('shell access', () => {
    beforeEach(() => {
      useUiStore.setState({ agentShell: 'off' });
      window.localStorage.removeItem('cerebro.agentShell');
    });

    it('offers Off, Ask and On, with one hint per value, and keeps Ask', async () => {
      const user = userEvent.setup();
      render(<SettingsPage />);
      const hint = () => screen.getByTestId('shell-hint').textContent;
      expect(hint()).toBe(
        "Cerebro's tools only. The assistant can't run commands or edit files directly.",
      );
      await user.click(screen.getByTestId('shell-ask'));
      expect(useUiStore.getState().agentShell).toBe('ask');
      expect(window.localStorage.getItem('cerebro.agentShell')).toBe('ask');
      expect(hint()).toContain('A card in the conversation names each command or file change');
      expect(hint()).toContain("Scheduled agents can't ask");
      await user.click(screen.getByTestId('shell-on'));
      expect(hint()).toContain('without asking');
      expect(useUiStore.getState().agentShell).toBe('on');
    });

    const disclosure = async (settings: unknown) => {
      vi.mocked(agentIpc.claudeUserSettings).mockResolvedValue(settings as never);
      render(<SettingsPage />);
      await vi.waitFor(() => expect(screen.getByTestId('shell-user-rules')).toBeTruthy());
      return screen.getByTestId('shell-user-rules').textContent ?? '';
    };
    const managed = "Settings your organization manages can act too, and Cerebro can't see them.";

    it('counts the rules and hook events it read, and never promises every command asks', async () => {
      const text = await disclosure({
        state: 'read',
        path: '/h/.claude/settings.json',
        allow: 201,
        ask: 2,
        deny: 3,
        hook_events: ['PreToolUse', 'Stop'],
      });
      expect(text).toBe(
        `Your own Claude Code settings act before Cerebro asks: 201 allow rules, and hooks on 2 events (PreToolUse, Stop). A command they allow runs without a card. ${managed}`,
      );
    });

    it('says a read file holds none', async () => {
      const text = await disclosure({
        state: 'read',
        path: '/h/.claude/settings.json',
        allow: 0,
        ask: 0,
        deny: 4,
        hook_events: [],
      });
      expect(text).toBe(`Your Claude Code settings hold no allow rules or hooks. ${managed}`);
    });

    it('says where it looked when there is no file', async () => {
      const text = await disclosure({ state: 'absent', path: '/h/.claude/settings.json' });
      expect(text).toBe(`No Claude Code settings file at /h/.claude/settings.json. ${managed}`);
    });

    it('says it could not read them, never that there are none', async () => {
      const text = await disclosure({
        state: 'unreadable',
        path: '/h/.claude/settings.json',
        detail: 'Permission denied',
      });
      expect(text).toBe(
        "Couldn't read /h/.claude/settings.json, so Cerebro can't tell which commands your own rules allow without a card.",
      );
      expect(screen.getByTestId('shell-user-rules').getAttribute('data-state')).toBe('unreadable');
    });

    it('says the browser has none to read', async () => {
      expect(await disclosure({ state: 'browser' })).toBe('Desktop app only.');
    });

    it('reads them again when the window comes back', async () => {
      vi.mocked(agentIpc.claudeUserSettings).mockClear();
      vi.mocked(agentIpc.claudeUserSettings).mockResolvedValue({ state: 'browser' });
      render(<SettingsPage />);
      await vi.waitFor(() => expect(agentIpc.claudeUserSettings).toHaveBeenCalledTimes(1));
      window.dispatchEvent(new Event('focus'));
      await vi.waitFor(() => expect(agentIpc.claudeUserSettings).toHaveBeenCalledTimes(2));
    });
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
        row.compareDocumentPosition(screen.getByTestId('shell-off')) &
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
