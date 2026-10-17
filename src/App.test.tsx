import { navSeed } from '@/test/navSeed';
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

import RETIRED from '../shared/prompt/retired-terms.json';
import App, { SHELL_TWO_PANEL_MIN } from '@/App';
import { SHELL_BARE_TWO_PANEL_MIN, SHELL_RAIL_TWO_PANEL_MIN } from '@/app/shellLayout';
import { __resetQuit, beginLeaving } from '@/app/quit';
import * as ipc from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useUndoStore, type UndoEntry } from '@/stores/undoStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';

/** One undo entry, for the undo keys to find (M60.7). */
const UNDO_ENTRY: UndoEntry = {
  id: 1,
  label: 'Renamed',
  vault: '/demo-vault',
  at: 0,
  kind: 'batch',
  files: [],
};

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

/**
 * `widthAtLeast`, with a window that can be resized afterwards: the
 * `min-width` queries App asks report a change as the width crosses them, the
 * way a browser's do. Call before render().
 */
function resizableWindow(initial: number): (width: number) => void {
  const min = /\(min-width:\s*(\d+)px\)/;
  let width = initial;
  const lists: { query: string; last: boolean; listeners: Set<() => void> }[] = [];
  vi.stubGlobal('matchMedia', (query: string) => {
    const match = min.exec(query);
    const matches = () => match !== null && width >= Number(match[1]);
    const list = { query, last: matches(), listeners: new Set<() => void>() };
    lists.push(list);
    return {
      get matches() {
        return matches();
      },
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: (_: string, fn: () => void) => list.listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => list.listeners.delete(fn),
      dispatchEvent: vi.fn(),
    };
  });
  return (next: number) => {
    act(() => {
      width = next;
      for (const list of lists) {
        const now = (() => {
          const match = min.exec(list.query);
          return match !== null && width >= Number(match[1]);
        })();
        if (now === list.last) continue;
        list.last = now;
        for (const fn of list.listeners) fn();
      }
    });
  };
}

/**
 * jsdom lays nothing out, so every observed box reports `width` — the canvas
 * row and the shell alike. Enough for the arithmetic the shell says out loud
 * (the drag handles' ranges); CSS draws the widths themselves.
 */
function measureEverythingAt(width: number): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private readonly onResize: ResizeObserverCallback) {}
      observe(target: Element) {
        const entry = { target, contentRect: { width } } as unknown as ResizeObserverEntry;
        this.onResize([entry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

describe('App boot flow', () => {
  beforeEach(() => {
    window.localStorage.removeItem('cerebro.lastPlace');
    window.localStorage.removeItem('cerebro.panes');
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
      history: [navSeed({ kind: 'home' })],
      historyIndex: 0,
    });
    useUiStore.setState({
      quickOpenVisible: false,
      toasts: [],
      detailPath: null,
      aiPanelOpen: false,
      aiPanelPresentation: 'panel',
      inboxSelectedPath: null,
      sidebarCollapsed: false,
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

  it.each([true, false])(
    'restores a last page only while it resolves: %s (M65.4)',
    async (exists) => {
      const path = 'strategy/systems-map.md';
      window.localStorage.setItem(
        'cerebro.lastPlace',
        JSON.stringify({ '/demo-vault': { kind: 'doc', path } }),
      );
      vi.mocked(ipc.scanVault).mockResolvedValueOnce(
        exists
          ? fixtureVault().map((entry) => (entry.path === ITEM ? { ...entry, path } : entry))
          : [],
      );
      render(<App />);
      await screen.findByRole('navigation', { name: 'Sidebar' });
      await waitFor(() => expect(useVaultStore.getState().status).toBe('ready'));
      expect(useNavStore.getState().selection).toEqual(
        exists ? { kind: 'doc', path } : { kind: 'home' },
      );
      expect(useNavStore.getState().history).toHaveLength(1);
      expect(useUiStore.getState().toasts).toEqual([]);
      if (!exists)
        expect(JSON.parse(window.localStorage.getItem('cerebro.lastPlace')!)).toEqual({});
    },
  );

  it('shows the vault chooser when no vault is configured', async () => {
    vi.mocked(ipc.getLastVault).mockResolvedValueOnce(null);
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Open demo vault' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();
  });

  // M54.8 — the welcome card is the first description of the app a new user
  // reads, so it speaks the model the app has today (AGENTS.md CV-20).
  it('welcomes a new user with no retired term', async () => {
    vi.mocked(ipc.getLastVault).mockResolvedValueOnce(null);
    render(<App />);
    const card = (await screen.findByRole('heading', { name: 'Open a vault' })).parentElement;
    const text = (card?.textContent ?? '').toLowerCase();
    expect(text).toContain('a vault is a folder of markdown files');
    expect(RETIRED.terms.filter((term) => text.includes(term.toLowerCase()))).toEqual([]);
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
      expect(screen.getByTestId('ai-panel-frame').dataset.parked).toBeUndefined();
      expect(useUiStore.getState().detailPath).toBe(ITEM);
    });

    it('lets the record give the assistant its room, in CSS, and says the width it comes to (M52)', async () => {
      widthAtLeast(SHELL_TWO_PANEL_MIN);
      measureEverythingAt(1176);
      vi.mocked(ipc.scanVault).mockResolvedValueOnce(fixtureVault());
      // The record widened by its « control; the assistant at its default.
      useUiStore.setState({ detailWidth: 1000, aiPanelWidth: 380 });
      render(<App />);
      await screen.findByRole('navigation', { name: 'Sidebar' });
      act(() => useUiStore.getState().setAiPanelOpen(true));
      act(() => useUiStore.getState().openDetail(ITEM));

      const record = await screen.findByTestId('detail-panel');
      const assistant = screen.getByTestId('ai-panel');
      // Drawn at the stored 1000 as `flex-none`, the pair came to 1380 in a
      // 776px slot, and the slot clipped the assistant. Sized from the row's
      // measurement instead, every width was a frame behind a window drag,
      // and for that frame the slot clipped it again. Now CSS does the give:
      // the record is the one panel that shrinks, down to its floor …
      expect(record.style.width).toBe('1000px');
      expect(record.style.minWidth).toBe('320px');
      expect(record.className).toMatch(/(^|\s)shrink(\s|$)/);
      // … and the assistant keeps its width, capped at the slot less that floor.
      expect(assistant.style.width).toBe('380px');
      expect(screen.getByTestId('ai-panel-frame').className).toContain('flex-none');
      expect(assistant.className).toContain('max-w-full');
      expect(screen.getByTestId('ai-panel-frame').style.maxWidth).toBe('calc(100% - 320px)');
      // What that comes to — 1176 − 400 canvas floor − 380 — is where a drag
      // starts and stops: the width it stores is one it drew.
      const handle = within(record).getByRole('separator', { name: 'Resize detail panel' });
      expect(handle.getAttribute('aria-valuenow')).toBe('396');
      expect(handle.getAttribute('aria-valuemax')).toBe('396');
      // The preference itself is kept, for the day the room comes back.
      expect(useUiStore.getState().detailWidth).toBe(1000);
    });

    it('caps the sidebar drag at the width it can draw beside the panels (M52)', async () => {
      widthAtLeast(1440);
      measureEverythingAt(1440);
      vi.mocked(ipc.scanVault).mockResolvedValueOnce(fixtureVault());
      useUiStore.setState({ sidebarWidth: 264, aiPanelWidth: 380 });
      render(<App />);
      await screen.findByRole('navigation', { name: 'Sidebar' });
      const handle = () => screen.getByRole('separator', { name: 'Resize sidebar' });
      expect(handle().getAttribute('aria-valuemax')).toBe('460');

      act(() => useUiStore.getState().setAiPanelOpen(true));
      act(() => useUiStore.getState().openDetail(ITEM));
      await screen.findByTestId('detail-panel');
      // 1440 − 54 rail − (400 canvas + 320 record floor + 380 assistant).
      expect(handle().getAttribute('aria-valuemax')).toBe('286');
    });

    /**
     * M52 — the rail and the park are CSS: both sides are mounted and a media
     * query shows one, in the same layout pass as the width. Decided in React
     * they landed a frame late, and that frame drew the old plan — at
     * 1300→1000, an 80px assistant with Send past the window's edge. jsdom
     * applies no stylesheet, so these read the classes CSS draws from.
     */
    const column = () => screen.getByTestId('sidebar');
    const rail = () => screen.getByTestId('app-rail');
    const frame = () => screen.getByTestId('ai-panel-frame');
    const tab = () =>
      screen.getByRole('button', { name: 'Assistant hidden — close the record to show it' });

    async function bothOpen() {
      vi.mocked(ipc.scanVault).mockResolvedValueOnce(fixtureVault());
      render(<App />);
      await screen.findByRole('navigation', { name: 'Sidebar' });
      act(() => useUiStore.getState().setAiPanelOpen(true));
      act(() => useUiStore.getState().openDetail(ITEM));
      await screen.findByTestId('detail-panel');
    }

    it('steps the sidebar down to its rail before it parks the assistant (M52)', async () => {
      widthAtLeast(SHELL_RAIL_TWO_PANEL_MIN);
      await bothOpen();

      // The rail under 1274, the column above it — latched, since the rail is
      // what keeps both panels here …
      expect(rail().className).toContain('m71-app-rail');
      expect(column().className).toMatch(/(^|\s)max-\[1274px\]:hidden(\s|$)/);
      // … and the assistant parked under 1094, behind its tab.
      expect(frame().className).toContain('max-[1094px]:w-0');
      expect(tab().className).toContain('hidden max-[1094px]:flex');
      // Here, React agrees: drawn, not inert.
      expect(frame().dataset.parked).toBeUndefined();
      expect(frame().hasAttribute('inert')).toBe(false);
      // Derived: the user's collapsed flag is not the shell's to write.
      expect(useUiStore.getState().sidebarCollapsed).toBe(false);

      // The record closes: the context column returns; the rail stays.
      act(() => useUiStore.getState().closeDetail());
      expect(rail()).toBeTruthy();
      expect(screen.queryByTestId('ai-parked-tab')).toBeNull();
      expect(column().className).not.toContain('max-[1274px]:hidden');
      expect(frame().className).not.toContain(':w-0');
    });

    it('parks the assistant behind a tab that says so, and the tab brings it back (M52)', async () => {
      widthAtLeast(SHELL_RAIL_TWO_PANEL_MIN - 1);
      await bothOpen();

      // Parked, and — a frame after CSS — inert.
      expect(frame().dataset.parked).toBe('true');
      expect(frame().hasAttribute('inert')).toBe(true);
      expect(frame().querySelector('[data-testid="ai-panel"]')).not.toBeNull();
      // The zap stayed pressed and nothing said why. The tab says why, from
      // inside the slot, so the record gives it its strip.
      expect(tab().closest('[data-testid="right-panel-slot"]')).not.toBeNull();
      // The widen control does not blame an assistant that takes no room.
      expect(screen.queryByRole('button', { name: /close the Assistant/ })).toBeNull();

      fireEvent.click(tab());
      expect(useUiStore.getState().detailPath).toBeNull();
      expect(frame().dataset.parked).toBeUndefined();
      expect(screen.queryByTestId('ai-parked-tab')).toBeNull();
    });

    // Verified at 1050: pressing the Assistant beside a record took the
    // sidebar from 264 to its rail AND parked the assistant.
    it('never takes the rail where it would not keep the assistant (M52)', async () => {
      widthAtLeast(SHELL_RAIL_TWO_PANEL_MIN - 1);
      await bothOpen();
      // The column shows from 986 to 1093; the rail only in the band, and
      // under 986, where the column would push the parked tab off the window.
      const classes = (el: HTMLElement) => el.className.split(/\s+/);
      expect(classes(column())).not.toContain('max-[1274px]:hidden');
      expect(classes(column())).toContain('min-[1094px]:max-[1274px]:hidden');
      expect(classes(column())).toContain('max-[986px]:hidden');
      expect(rail().className).toContain('m71-app-rail');
    });

    it('keeps a rail that was showing as the window shrinks past the rail (M52)', async () => {
      const resizeTo = resizableWindow(1150);
      await bothOpen();
      resizeTo(1000);
      // Latched: the rail under all of 1274, so the sidebar does not grow
      // back into a column as the window gets smaller.
      expect(rail().className).toContain('m71-app-rail');
      expect(column().className).toMatch(/(^|\s)max-\[1274px\]:hidden(\s|$)/);
      expect(frame().dataset.parked).toBe('true');

      // Room again: the latch lets go, and the next shrink starts from the column.
      resizeTo(1300);
      resizeTo(1000);
      expect(rail().className).toContain('m71-app-rail');
    });

    it('keeps one assistant mounted through every crossing (M17.2, M52)', async () => {
      const resizeTo = resizableWindow(1300);
      await bothOpen();
      const assistant = screen.getByTestId('ai-panel');
      for (const width of [1150, 1000, 1300, 1000, 1150]) {
        resizeTo(width);
        // The same node: a remount would detach it from its turn and read
        // the thread back, which a resize has no business costing (M57.6).
        expect(screen.getByTestId('ai-panel')).toBe(assistant);
      }
      expect(screen.getAllByTestId('ai-panel')).toHaveLength(1);
    });

    it('expands the same conversation, hides page commands, and docks when navigation opens a page', async () => {
      widthAtLeast(1440);
      await bothOpen();
      const assistant = screen.getByTestId('ai-panel');
      const page = document.getElementById('main')!;
      act(() => useUiStore.getState().openAssistantCanvas());
      expect(screen.getByTestId('ai-panel')).toBe(assistant);
      expect(assistant.dataset.presentation).toBe('canvas');
      expect(page.hasAttribute('inert')).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: 'Skip to content' }));
      expect(assistant.contains(document.activeElement)).toBe(true);
      act(() => useNavStore.getState().navigate({ kind: 'doc', path: ITEM }));
      expect(screen.getByTestId('ai-panel')).toBe(assistant);
      expect(assistant.dataset.presentation).toBe('panel');
      expect(page.hasAttribute('inert')).toBe(false);
    });

    it('a vault switch remounts the assistant, so no turn outlives its vault (M53.10)', async () => {
      // The one remount the frame allows, and on purpose: Rust ends the old
      // vault's runs as the new one opens, and a panel keyed by the vault
      // lets go of them, so a turn asked in one vault never answers in the
      // next.
      render(<App />);
      await screen.findByRole('navigation', { name: 'Sidebar' });
      act(() => useUiStore.getState().setAiPanelOpen(true));
      const before = await screen.findByTestId('ai-panel');

      act(() => useVaultStore.setState({ vaultPath: '/another-vault' }));
      const after = await screen.findByTestId('ai-panel');
      expect(after).not.toBe(before);
      expect(before.isConnected).toBe(false);
      expect(screen.getAllByTestId('ai-panel')).toHaveLength(1);
    });

    it('uses the room a user-collapsed sidebar gives back before parking anything (M52)', async () => {
      widthAtLeast(SHELL_BARE_TWO_PANEL_MIN);
      useUiStore.setState({ sidebarCollapsed: true });
      vi.mocked(ipc.scanVault).mockResolvedValueOnce(fixtureVault());
      render(<App />);
      await screen.findByTestId('sidebar-expand');
      act(() => useUiStore.getState().setAiPanelOpen(true));
      act(() => useUiStore.getState().openDetail(ITEM));
      await screen.findByTestId('detail-panel');
      expect(frame().dataset.parked).toBeUndefined();
      expect(rail()).toBeTruthy();
      // The persistent rail is included even with the context panel collapsed.
      expect(frame().className).toContain('max-[1094px]:w-0');
    });

    it('gives the main column both floors, and CSS picks by the width it parks at (M52)', async () => {
      widthAtLeast(SHELL_TWO_PANEL_MIN);
      useUiStore.setState({ aiPanelWidth: 380 });
      await bothOpen();
      const main = screen.getByTestId('main-column');
      expect(main.style.getPropertyValue('--shell-floor')).toBe('min(1100px, 100vw - 234px)');
      // Canvas 400 + record 320 + the tab's 32.
      expect(main.style.getPropertyValue('--shell-floor-parked')).toBe('min(752px, 100vw - 234px)');
      expect(main.className).toContain('max-[1094px]:min-w-[var(--shell-floor-parked)]');
    });

    // Verified at 1100px: a concept with its Details panel beside the
    // assistant drew its reading column at 200px (title "Syn/c/erro/r/rate")
    // while the sidebar kept all 264 — the floor never counted the page's
    // own panel, so the page gave before the sidebar did.
    it("counts a page's own side panel in the main column's floor (M52)", async () => {
      vi.mocked(ipc.scanVault).mockResolvedValueOnce(fixtureVault());
      useUiStore.setState({ docPanelOpen: true });
      render(<App />);
      const main = await screen.findByRole('main');
      const column = main.parentElement?.parentElement;
      if (!column) throw new Error('no main column');
      const floor = () => column.style.getPropertyValue('--shell-floor');
      expect(floor()).toBe('min(400px, 100vw - 234px)');

      act(() => useNavStore.getState().navigate({ kind: 'doc', path: ITEM }));
      await screen.findByTestId('doc-side-panel');
      expect(floor()).toBe('min(672px, 100vw - 234px)');

      act(() => useUiStore.getState().setDocPanelOpen(false));
      expect(floor()).toBe('min(400px, 100vw - 234px)');
    });

    it('parks the assistant rather than unmounting it when one panel fits (M17.2)', async () => {
      // The default stub reports every query false, i.e. the narrow shell.
      render(<App />);
      act(() => useUiStore.getState().setAiPanelOpen(true));
      await screen.findByTestId('ai-panel');

      act(() => useUiStore.getState().openDetail(BET));
      // The record takes the visible slot, because something just asked for it
      // to be seen. The assistant is STILL MOUNTED inside the parking box —
      // unmounting it once killed the run mid-answer (M17.2), and even now
      // that a turn outlives its panel (M57.6), a narrow window must not
      // detach a turn someone is watching.
      const parked = await screen.findByTestId('ai-panel-frame');
      expect(parked.dataset.parked).toBe('true');
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

    // M65.1: the canvas is the page key scope, the keymap's fallback.
    it('makes each pane the page key scope inside main', async () => {
      render(<App />);
      await screen.findByRole('navigation', { name: 'Sidebar' });
      const main = screen.getByRole('main');
      expect(main.hasAttribute('data-key-scope')).toBe(false);
      const pane = screen.getByTestId('pane');
      expect(main.contains(pane)).toBe(true);
      expect(pane.getAttribute('data-key-scope')).toBe('page');
      expect(pane.hasAttribute('data-key-scope-page')).toBe(true);
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

  // M60.7: the undo keys are mounted at the root, beside the other globals.
  it('mounts the undo keys: cmd+z undoes the newest change', async () => {
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    const undo = vi.fn(async () => true);
    const before = useUndoStore.getState();
    useUndoStore.setState({ undo, past: [{ ...UNDO_ENTRY }] });
    try {
      fireEvent.keyDown(window, { key: 'z', metaKey: true });
      expect(undo).toHaveBeenCalledOnce();
    } finally {
      useUndoStore.setState({ undo: before.undo, past: [] });
    }
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
    expect(await screen.findByRole('heading', { name: 'General', level: 1 })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeTruthy();
  });

  // M45.2 — one mount, one signal: the layout editor lives beside the other
  // global overlays and only the uiStore signal raises it.
  it('mounts the layout editor at the root, driven by the signal', async () => {
    vi.mocked(ipc.scanVault).mockResolvedValueOnce(fixtureVault());
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    expect(screen.queryByTestId('layout-editor')).toBeNull();
    act(() => useUiStore.getState().openLayoutEditor('Work item'));
    expect(screen.getByTestId('layout-editor')).toBeTruthy();
    act(() => useUiStore.getState().closeLayoutEditor());
    expect(screen.queryByTestId('layout-editor')).toBeNull();
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

  // M55.10: quit is a leave. NoteBodyEditor's own leave test shows a held
  // save is written on unmount; this one shows quitting unmounts the shell.
  it('leaving for a quit shows the quit screen and unmounts the shell', async () => {
    render(<App />);
    await screen.findByRole('navigation', { name: 'Sidebar' });
    let left = false;
    try {
      await act(async () => {
        await beginLeaving(60_000).then(() => (left = true));
      });
      expect(left, 'resolved by the screen mounting, long before the budget').toBe(true);
      expect(screen.getByTestId('quit-screen').textContent).toBe('Saving…');
      expect(screen.getByRole('status')).toBe(screen.getByTestId('quit-screen'));
      expect(screen.queryByRole('navigation', { name: 'Sidebar' })).toBeNull();
    } finally {
      act(() => __resetQuit());
    }
    expect(await screen.findByRole('navigation', { name: 'Sidebar' })).toBeTruthy();
  });
});
