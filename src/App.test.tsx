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

import App, { SHELL_TWO_PANEL_MIN } from '@/App';
import * as ipc from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';

const BET = 'records/bets/office-hours.md';
/** A path fixtureVault actually holds, so DetailPanel has something to draw. */
const ITEM = 'projects/onboarding/items/fld-1.md';

/**
 * Report the shell as at least `px` wide (M17.2).
 *
 * setup.ts stubs matchMedia to answer false to everything, which reads as the
 * NARROW shell — fine as a default, useless for the case this milestone is
 * about. Only `min-width` queries are answered here; `max-width` ones keep
 * saying false, so widening the window does not also turn the narrow-shell
 * behaviour on. useMediaQuery caches the MediaQueryList in a ref on first
 * render, so this must be called BEFORE render().
 */
function widthAtLeast(px: number): void {
  const min = /\(min-width:\s*(\d+)px\)/;
  vi.stubGlobal('matchMedia', (query: string) => {
    const match = min.exec(query);
    return {
      matches: match !== null && px >= Number(match[1]),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
  });
}

describe('App boot flow', () => {
  beforeEach(() => {
    // jsdom implements no scrolling at all; the assistant's transcript pins
    // itself to the bottom on mount. Not a stub for app behaviour — a stub for
    // a DOM method the environment simply does not have.
    Element.prototype.scrollTo ??= () => {};
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
    useUiStore.setState({
      quickOpenVisible: false,
      toasts: [],
      detailPath: null,
      aiPanelOpen: false,
      inboxSelectedPath: null,
    });
  });

  afterEach(() => {
    cleanup();
    // widthAtLeast stubs matchMedia globally; leaving it stubbed would make
    // every later test in this file think the window is wide.
    vi.unstubAllGlobals();
  });

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

  // M15 — the layout contract every surface is built on.
  describe('shell layout', () => {
    it('gives the canvas a <main> landmark, a skip link, and a real floor', async () => {
      render(<App />);
      await screen.findByRole('navigation', { name: 'Sidebar' });
      const main = screen.getByRole('main');
      expect(main.id).toBe('main');
      // The canvas never shrinks below its floor, whatever else is open.
      expect(main.style.minWidth).toBe('400px');
      expect(screen.getByRole('button', { name: 'Skip to content' })).toBeTruthy();
      // The row nothing may paint outside of, and the container pages size to.
      const row = main.parentElement;
      expect(row?.className).toContain('overflow-hidden');
      expect(row?.className).toContain('@container/canvas');
    });

    it('holds the right-hand panels beside the canvas, capped against its row', async () => {
      render(<App />);
      const main = await screen.findByRole('main');
      expect(screen.queryByTestId('right-panel-slot')).toBeNull();

      act(() => useUiStore.getState().openDetail(BET));
      const slot = await screen.findByTestId('right-panel-slot');
      // Beside the canvas — NOT beside the whole main column, which is what
      // let the assistant steal width from the StatusBar as well.
      expect(slot.parentElement).toBe(main.parentElement);
      // Capped against the canvas ROW, so the cap actually engages — `50vw`
      // resolved against the viewport, a box the panel does not live in.
      expect(slot.style.maxWidth).toBe('calc(100% - 400px)');

      act(() => useUiStore.getState().closeDetail());
      expect(screen.queryByTestId('right-panel-slot')).toBeNull();
    });

    it('draws the record and the assistant together when there is room (M17.2)', async () => {
      widthAtLeast(SHELL_TWO_PANEL_MIN);
      // A real entry, because DetailPanel renders null for a path the vault
      // does not hold — which would make this pass for the wrong reason.
      vi.mocked(ipc.scanVault).mockResolvedValueOnce(fixtureVault());
      render(<App />);
      await screen.findByRole('navigation', { name: 'Sidebar' });
      act(() => useUiStore.getState().setAiPanelOpen(true));
      await screen.findByTestId('ai-panel');

      act(() => useUiStore.getState().openDetail(ITEM));
      // Both drawn, neither parked — and the record the assistant is being
      // asked about is still there to be asked about.
      expect(await screen.findByTestId('detail-panel')).toBeTruthy();
      expect(screen.getByTestId('ai-panel')).toBeTruthy();
      expect(screen.queryByTestId('ai-panel-parked')).toBeNull();
      expect(useUiStore.getState().detailPath).toBe(ITEM);
    });

    it('parks the assistant rather than unmounting it when one panel fits (M17.2)', async () => {
      // The default stub reports every query false, i.e. the narrow shell.
      render(<App />);
      act(() => useUiStore.getState().setAiPanelOpen(true));
      await screen.findByTestId('ai-panel');

      act(() => useUiStore.getState().openDetail(BET));
      // The record takes the visible slot, because something just asked for it
      // to be seen. The assistant is STILL MOUNTED inside the parking box —
      // unmounting it is what killed the run mid-answer, and a narrow window
      // must not be a way back into that bug.
      const parked = await screen.findByTestId('ai-panel-parked');
      expect(parked.querySelector('[data-testid="ai-panel"]')).not.toBeNull();
      expect(useUiStore.getState().aiPanelOpen).toBe(true);
    });

    it('drops the record panel when the surface changes', async () => {
      render(<App />);
      await screen.findByRole('navigation', { name: 'Sidebar' });
      act(() => useUiStore.getState().openDetail('records/bets/office-hours.md'));
      act(() => useNavStore.getState().navigate({ kind: 'pulse' }));
      expect(useUiStore.getState().detailPath).toBeNull();
      expect(screen.queryByTestId('right-panel-slot')).toBeNull();
    });
  });

  // M15: the handler threw away the path it had just created, so you landed on
  // whichever capture `inboxSelectedPath` still pointed at and typed into it.
  it('quick capture selects the note it just created', async () => {
    const createItem = vi.fn().mockResolvedValue('inbox/2026-08-02-1200.md');
    useVaultStore.setState({ createItem });
    useUiStore.setState({ inboxSelectedPath: 'inbox/capture-b.md' });
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    await act(async () => {
      fireEvent.keyDown(window, { key: 'n', metaKey: true, shiftKey: true });
      await Promise.resolve();
    });
    expect(useUiStore.getState().inboxSelectedPath).toBe('inbox/2026-08-02-1200.md');
    expect(useNavStore.getState().selection).toEqual({ kind: 'inbox' });
  });

  // M15: `back()`/`forward()` existed in the store with no way to reach them.
  it('walks nav history with cmd+[ and cmd+]', async () => {
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    act(() => useNavStore.getState().navigate({ kind: 'pulse' }));
    fireEvent.keyDown(window, { key: '[', metaKey: true });
    expect(useNavStore.getState().selection).toEqual({ kind: 'home' });
    fireEvent.keyDown(window, { key: ']', metaKey: true });
    expect(useNavStore.getState().selection).toEqual({ kind: 'pulse' });
  });

  it('leaves cmd+[ to the editor while text is being edited', async () => {
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    act(() => useNavStore.getState().navigate({ kind: 'pulse' }));
    const field = document.createElement('input');
    document.body.appendChild(field);
    field.focus();
    fireEvent.keyDown(field, { key: '[', metaKey: true, bubbles: true });
    expect(useNavStore.getState().selection).toEqual({ kind: 'pulse' });
    field.remove();
  });

  // M16.39: the theme was reachable only by walking to Settings.
  it('flips the theme on cmd+shift+l', async () => {
    act(() => useUiStore.getState().setThemeMode('light'));
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    fireEvent.keyDown(window, { key: 'l', metaKey: true, shiftKey: true });
    expect(useUiStore.getState().themeMode).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.keyDown(window, { key: 'l', metaKey: true, shiftKey: true });
    expect(useUiStore.getState().themeMode).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  // The whole point of resolving before toggling. On 'system' with a dark OS
  // the screen is dark, so the shortcut must go to LIGHT — a naive
  // `mode === 'dark' ? 'light' : 'dark'` reads 'system', is not 'dark', and
  // sends the user to the dark they are already looking at.
  it('toggles against the resolved theme, not the stored mode', async () => {
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query === '(prefers-color-scheme: dark)',
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          onchange: null,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
    act(() => useUiStore.getState().setThemeMode('system'));
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    fireEvent.keyDown(window, { key: 'l', metaKey: true, shiftKey: true });
    expect(useUiStore.getState().themeMode).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('routes the settings selection to the settings page', async () => {
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    act(() => useNavStore.getState().navigate({ kind: 'settings' }));
    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeTruthy();
  });

  // M3.5: "New project" is gone — the sidebar's + builds a saved view, and a
  // project is one of those (Work items scoped to a folder).
  // M10: the sidebar + names a Collection — the container — rather than
  // opening the query builder, because a Collection has no query.
  it('the sidebar + creates a collection and opens its page', async () => {
    const user = userEvent.setup();
    vi.mocked(ipc.scanVault).mockResolvedValueOnce(fixtureVault());
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    await user.click(screen.getByRole('button', { name: 'New collection' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Collection name' }), 'Product');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    const page = await screen.findByTestId('collection-page');
    expect(within(page).getByText('Product')).toBeTruthy();
    // A container opens empty and says so, rather than showing a record canvas.
    expect(within(page).getByText(/Nothing in here yet/)).toBeTruthy();
  });
});
