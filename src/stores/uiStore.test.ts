import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asThemeMode, useUiStore } from './uiStore';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from './vaultStore';

function reset() {
  useUiStore.setState({
    detailPath: null,
    aiPanelOpen: false,
    aiPanelPresentation: 'panel',
    quickOpenVisible: false,
    toasts: [],
  });
}

describe('uiStore', () => {
  beforeEach(reset);

  it('openDetail and closeDetail set detailPath', () => {
    useUiStore.getState().openDetail('items/fld-7.md');
    expect(useUiStore.getState().detailPath).toBe('items/fld-7.md');
    useUiStore.getState().closeDetail();
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  it('expands and docks the same assistant without losing the page or conversation request', () => {
    const ui = useUiStore.getState();
    ui.openDetail('notes/context.md');
    ui.showConversation('existing-thread');
    ui.openAssistantCanvas();
    expect(useUiStore.getState()).toMatchObject({
      aiPanelOpen: true,
      aiPanelPresentation: 'canvas',
      detailPath: 'notes/context.md',
      panelConversation: 'existing-thread',
    });
    ui.setAiPanelPresentation('panel');
    expect(useUiStore.getState()).toMatchObject({
      aiPanelOpen: true,
      aiPanelPresentation: 'panel',
      panelConversation: 'existing-thread',
    });
    ui.openAssistantCanvas();
    ui.openDetail('notes/referenced.md');
    expect(useUiStore.getState()).toMatchObject({
      aiPanelOpen: true,
      aiPanelPresentation: 'panel',
      detailPath: 'notes/referenced.md',
    });
    ui.openAssistantCanvas();
    ui.setAiPanelOpen(false);
    ui.setAiPanelOpen(true);
    expect(useUiStore.getState().aiPanelPresentation).toBe('panel');
  });

  // M15: one right-hand slot. As independent flags they stacked, and two
  // panels beside the sidebar left a ~20px canvas on a 1280px window.
  // M17.2 reverses M15's rule. These three used to assert that each occupant
  // evicted the other; the eviction is what let `open_note` kill the agent's
  // own answer, because a closed panel is an unmounted panel and an unmounted
  // panel kills its run. Which of them is DRAWN is now a layout question
  // (App.test.tsx); the store just holds two independent facts.
  describe('the record panel and the assistant are independent (M17.2)', () => {
    const BET = 'records/bets/office-hours.md';

    it('opening a record leaves the assistant open', () => {
      useUiStore.getState().setAiPanelOpen(true);
      useUiStore.getState().openDetail(BET);
      expect(useUiStore.getState().aiPanelOpen).toBe(true);
      expect(useUiStore.getState().detailPath).toBe(BET);
    });

    it('opening the assistant keeps the record it is being asked about', () => {
      // Every "Ask the agent about this" button opens the panel, and the
      // context snapshot derives activeNote from detailPath — so nulling it
      // here threw away the very record the question was about.
      useUiStore.getState().openDetail(BET);
      useUiStore.getState().setAiPanelOpen(true);
      expect(useUiStore.getState().detailPath).toBe(BET);
      expect(useUiStore.getState().aiPanelOpen).toBe(true);
    });

    it('closing one leaves the other alone', () => {
      useUiStore.getState().openDetail(BET);
      useUiStore.getState().setAiPanelOpen(true);
      useUiStore.getState().setAiPanelOpen(false);
      expect(useUiStore.getState().detailPath).toBe(BET);
      expect(useUiStore.getState().aiPanelOpen).toBe(false);

      useUiStore.getState().setAiPanelOpen(true);
      useUiStore.getState().closeDetail();
      expect(useUiStore.getState().detailPath).toBeNull();
      expect(useUiStore.getState().aiPanelOpen).toBe(true);
    });
  });

  // M52.3 — a surface's ask carries the words its bubble shows. The prompt
  // is pages long; the label is what the person pressed.
  it('askAgent opens the panel with the prompt, its subject and its label', () => {
    useUiStore.setState({ aiPanelOpen: false, handoffs: [] });
    useUiStore
      .getState()
      .askAgent('Revise the knowledge concept at …', 'knowledge/a.md', 'Ask to revise · A');
    expect(useUiStore.getState().aiPanelOpen).toBe(true);
    expect(useUiStore.getState().handoffs.at(-1)).toMatchObject({
      text: 'Revise the knowledge concept at …',
      subject: 'knowledge/a.md',
      label: 'Ask to revise · A',
    });
    // Typed words are their own label.
    useUiStore.getState().askAgent('why is onboarding stalling');
    expect(useUiStore.getState().handoffs.at(-1)).toMatchObject({
      text: 'why is onboarding stalling',
      subject: null,
      label: null,
    });
  });

  // M57.5 — a list, so a second ask never overwrites the first.
  it('askAgent appends handoffs in order, and two asks keep both', () => {
    useUiStore.setState({ aiPanelOpen: false, handoffs: [] });
    useUiStore.getState().askAgent('first', 'a.md', 'First · A');
    useUiStore.getState().askAgent('second', 'b.md', null);
    const { handoffs, aiPanelOpen } = useUiStore.getState();
    expect(aiPanelOpen).toBe(true);
    expect(handoffs.map((h) => h.text)).toEqual(['first', 'second']);
    expect(new Set(handoffs.map((h) => h.id)).size).toBe(2);
  });

  it('markHandoffAttached clears the subject; takeHandoff removes the handoff', () => {
    useUiStore.setState({ handoffs: [] });
    useUiStore.getState().askAgent('first', 'a.md', 'First · A');
    useUiStore.getState().askAgent('second', 'b.md', null);
    const [head, next] = useUiStore.getState().handoffs;
    useUiStore.getState().markHandoffAttached(head.id);
    expect(useUiStore.getState().handoffs[0]).toEqual({ ...head, subject: null });
    expect(useUiStore.getState().handoffs[1]).toEqual(next);
    useUiStore.getState().takeHandoff(head.id);
    expect(useUiStore.getState().handoffs).toEqual([next]);
  });

  // M56.4: a failure card's Open Settings names the row to bring into view.
  it('settingsFocus sets and clears, and is not persisted', () => {
    const before = { ...window.localStorage };
    useUiStore.getState().setSettingsFocus('claude-code');
    expect(useUiStore.getState().settingsFocus).toBe('claude-code');
    useUiStore.getState().setSettingsFocus(null);
    expect(useUiStore.getState().settingsFocus).toBeNull();
    expect({ ...window.localStorage }).toEqual(before);
  });

  it('setQuickOpen toggles quickOpenVisible', () => {
    useUiStore.getState().setQuickOpen(true);
    expect(useUiStore.getState().quickOpenVisible).toBe(true);
    useUiStore.getState().setQuickOpen(false);
    expect(useUiStore.getState().quickOpenVisible).toBe(false);
  });

  it('toast assigns unique increasing ids automatically', () => {
    const { toast } = useUiStore.getState();
    toast('Saved');
    toast('Vault refreshed');
    const toasts = useUiStore.getState().toasts;
    expect(toasts.map((t) => t.message)).toEqual(['Saved', 'Vault refreshed']);
    expect(toasts[1].id).toBeGreaterThan(toasts[0].id);
    expect(new Set(toasts.map((t) => t.id)).size).toBe(2);
  });

  it('a toast carries its action, and a plain one carries none (M60.7)', () => {
    const run = vi.fn();
    useUiStore.getState().toast('Renamed “A” to “B” on 2 pages', {
      action: { label: 'Undo', run },
    });
    useUiStore.getState().toast('Saved');
    const [withAction, plain] = useUiStore.getState().toasts;
    expect(withAction.action?.label).toBe('Undo');
    withAction.action?.run();
    expect(run).toHaveBeenCalledOnce();
    expect(plain).not.toHaveProperty('action');
  });

  /**
   * M16.21: this was the one member of the store's collapse family that never
   * wrote itself back — `expandedFolders`, `docPagesOpen`, `typesOpen` and the
   * sidebar all persist. So a list's bands sprang open on every reload and a
   * three-level nesting had to be re-collapsed once a session.
   */
  describe('collapsed bands persist', () => {
    beforeEach(() => {
      window.localStorage.removeItem('cerebro.collapsed');
      useUiStore.setState({ collapsed: {} });
    });

    it('writes a collapsed band to localStorage under its scope', () => {
      useUiStore.getState().toggleCollapsed('list:delivery', 'doing');
      expect(useUiStore.getState().isCollapsed('list:delivery', 'doing')).toBe(true);
      expect(JSON.parse(window.localStorage.getItem('cerebro.collapsed') ?? '{}')).toEqual({
        'list:delivery': { doing: true },
      });
    });

    // A `false` per band anyone ever touched would grow the stored map without
    // adding information: absent already means expanded to every reader.
    it('deletes the key on the way back open rather than storing false', () => {
      useUiStore.getState().toggleCollapsed('list:delivery', 'doing');
      useUiStore.getState().toggleCollapsed('list:delivery', 'doing');
      expect(useUiStore.getState().isCollapsed('list:delivery', 'doing')).toBe(false);
      expect(JSON.parse(window.localStorage.getItem('cerebro.collapsed') ?? '{}')).toEqual({
        'list:delivery': {},
      });
    });

    it('keeps scopes apart, so the same band key in two views is two states', () => {
      useUiStore.getState().toggleCollapsed('list:delivery', 'doing');
      expect(useUiStore.getState().isCollapsed('type:Work item', 'doing')).toBe(false);
    });

    // The whole point: the state survives the next launch. A fresh module
    // registry is what "next launch" means for a store built at import time.
    it('reads collapsed bands back on the next launch, ignoring a malformed scope', async () => {
      window.localStorage.setItem(
        'cerebro.collapsed',
        JSON.stringify({ 'list:delivery': { doing: true, todo: false }, junk: 'nope' }),
      );
      vi.resetModules();
      const fresh = (await import('./uiStore')).useUiStore;
      expect(fresh.getState().isCollapsed('list:delivery', 'doing')).toBe(true);
      expect(fresh.getState().isCollapsed('list:delivery', 'todo')).toBe(false);
      expect(fresh.getState().collapsed.junk).toBeUndefined();
    });
  });

  /**
   * M57.2. Shell access is a ceiling of three, off, ask or on, stored under
   * `cerebro.agentShell`. The boolean M8.1 stored migrates once ('true' is
   * on), and setting the ceiling drops it, so an older build reads off.
   */
  describe('shell ceiling', () => {
    const fresh = async () => {
      vi.resetModules();
      return (await import('./uiStore')).useUiStore.getState();
    };

    beforeEach(() => {
      window.localStorage.removeItem('cerebro.agentShell');
      window.localStorage.removeItem('cerebro.agentShellAccess');
    });

    it('defaults to off', async () => {
      expect((await fresh()).agentShell).toBe('off');
    });

    it("migrates the old boolean: 'true' is on, 'false' off", async () => {
      window.localStorage.setItem('cerebro.agentShellAccess', 'true');
      expect((await fresh()).agentShell).toBe('on');
      window.localStorage.setItem('cerebro.agentShellAccess', 'false');
      expect((await fresh()).agentShell).toBe('off');
    });

    it('keeps ask, and reads anything unknown as off', async () => {
      window.localStorage.setItem('cerebro.agentShell', 'ask');
      expect((await fresh()).agentShell).toBe('ask');
      for (const garbage of ['ASK', 'true', '{"on":1}', '']) {
        window.localStorage.setItem('cerebro.agentShell', garbage);
        expect((await fresh()).agentShell, garbage).toBe('off');
      }
      // A stored ceiling wins over the old boolean.
      window.localStorage.setItem('cerebro.agentShell', 'off');
      window.localStorage.setItem('cerebro.agentShellAccess', 'true');
      expect((await fresh()).agentShell).toBe('off');
    });

    it('writes the new key and drops the old one', async () => {
      window.localStorage.setItem('cerebro.agentShellAccess', 'true');
      const state = await fresh();
      state.setAgentShell('ask');
      expect(window.localStorage.getItem('cerebro.agentShell')).toBe('ask');
      expect(window.localStorage.getItem('cerebro.agentShellAccess')).toBeNull();
    });
  });

  /**
   * M57.7. Web access is a second ceiling, two states, stored under
   * `cerebro.agentWebAccess`: only 'true' reads on.
   */
  describe('web ceiling', () => {
    const fresh = async () => {
      vi.resetModules();
      return (await import('./uiStore')).useUiStore.getState();
    };

    beforeEach(() => {
      window.localStorage.removeItem('cerebro.agentWebAccess');
    });

    it('defaults to off, and reads anything but true as off', async () => {
      expect((await fresh()).agentWebAccess).toBe(false);
      for (const garbage of ['TRUE', 'on', '1', '']) {
        window.localStorage.setItem('cerebro.agentWebAccess', garbage);
        expect((await fresh()).agentWebAccess, garbage).toBe(false);
      }
    });

    it('persists across a reload', async () => {
      (await fresh()).setAgentWebAccess(true);
      expect(window.localStorage.getItem('cerebro.agentWebAccess')).toBe('true');
      expect((await fresh()).agentWebAccess).toBe(true);
      (await fresh()).setAgentWebAccess(false);
      expect((await fresh()).agentWebAccess).toBe(false);
    });
  });

  /**
   * M16.36. The store holds the CHOICE — light/dark/system — and never the
   * resolved theme: persisting "dark" because the OS was dark the day the
   * choice was made would freeze it there forever. Resolution lives in
   * useTheme; what is guarded here is that the choice survives a launch and
   * that nothing on disk can stop the app booting.
   */
  describe('theme mode', () => {
    beforeEach(() => {
      window.localStorage.removeItem('cerebro.themeMode');
      useUiStore.setState({ themeMode: 'system' });
    });

    it('defaults to system', () => {
      expect(useUiStore.getState().themeMode).toBe('system');
    });

    it('setThemeMode writes the bare word under cerebro.themeMode', () => {
      useUiStore.getState().setThemeMode('dark');
      expect(useUiStore.getState().themeMode).toBe('dark');
      // Bare, not JSON-quoted: index.html's pre-paint script reads this with a
      // plain getItem before any module has loaded.
      expect(window.localStorage.getItem('cerebro.themeMode')).toBe('dark');
    });

    it('reads the choice back on the next launch', async () => {
      window.localStorage.setItem('cerebro.themeMode', 'dark');
      vi.resetModules();
      const fresh = (await import('./uiStore')).useUiStore;
      expect(fresh.getState().themeMode).toBe('dark');
    });

    it('falls back to system on a corrupt persisted value rather than throwing', async () => {
      window.localStorage.setItem('cerebro.themeMode', '{"mode":"dark"}');
      vi.resetModules();
      const fresh = (await import('./uiStore')).useUiStore;
      expect(fresh.getState().themeMode).toBe('system');
    });

    // Private mode: getItem itself throws. A theme preference must never be
    // able to take the app down with it.
    it('falls back to system when localStorage is unreadable', async () => {
      // On the instance, not Storage.prototype: under Node 22 the test setup
      // installs a plain-object localStorage (the experimental global shadows
      // jsdom's), which is not a Storage at all.
      const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });
      try {
        vi.resetModules();
        const fresh = (await import('./uiStore')).useUiStore;
        expect(fresh.getState().themeMode).toBe('system');
      } finally {
        getItem.mockRestore();
      }
    });

    it('asThemeMode narrows anything unrecognised to system', () => {
      expect(asThemeMode('light')).toBe('light');
      expect(asThemeMode('dark')).toBe('dark');
      expect(asThemeMode('system')).toBe('system');
      expect(asThemeMode('midnight')).toBe('system');
      expect(asThemeMode(null)).toBe('system');
      expect(asThemeMode(undefined)).toBe('system');
      expect(asThemeMode({ mode: 'dark' })).toBe('system');
    });
  });

  // M70.2b — Comments is a panel tab like the rest: chosen, stored as the
  // bare word, and back on the next launch. A word no build knows reads as
  // Outline.
  describe('the side panel tab', () => {
    beforeEach(() => window.localStorage.removeItem('cerebro.docPanelTab'));

    it('stores comments and restores it on the next launch', async () => {
      useUiStore.getState().setDocPanelTab('comments');
      expect(window.localStorage.getItem('cerebro.docPanelTab')).toBe('comments');
      vi.resetModules();
      const fresh = (await import('./uiStore')).useUiStore;
      expect(fresh.getState().docPanelTab).toBe('comments');
    });

    it('reads an unknown value as outline', async () => {
      window.localStorage.setItem('cerebro.docPanelTab', 'threads');
      vi.resetModules();
      const fresh = (await import('./uiStore')).useUiStore;
      expect(fresh.getState().docPanelTab).toBe('outline');
    });

    it("a concept's panel takes comments too", () => {
      useUiStore.getState().setConceptPanelTab('comments');
      expect(useUiStore.getState().conceptPanelTab).toBe('comments');
      useUiStore.getState().setConceptPanelTab('details');
    });

    // M58.4 (D18): History is a side panel tab on every page.
    it('stores history and restores it on the next launch', async () => {
      useUiStore.getState().setDocPanelTab('history');
      expect(window.localStorage.getItem('cerebro.docPanelTab')).toBe('history');
      vi.resetModules();
      const fresh = (await import('./uiStore')).useUiStore;
      expect(fresh.getState().docPanelTab).toBe('history');
      window.localStorage.setItem('cerebro.docPanelTab', 'versions');
      vi.resetModules();
      expect((await import('./uiStore')).useUiStore.getState().docPanelTab).toBe('outline');
    });

    it("a concept's panel shows its history too", () => {
      useUiStore.getState().setConceptPanelTab('history');
      expect(useUiStore.getState().conceptPanelTab).toBe('history');
      useUiStore.getState().setConceptPanelTab('details');
    });
  });

  it('dismissToast removes only the matching toast', () => {
    const { toast } = useUiStore.getState();
    toast('First');
    toast('Second');
    const first = useUiStore.getState().toasts[0];
    useUiStore.getState().dismissToast(first.id);
    const remaining = useUiStore.getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].message).toBe('Second');
  });
});

// M43 — the pin. Ordered pointers, workspace state (the navClosed rule).
/**
 * The assistant's width moved here from the panel's own state (M52): the shell
 * needs it to lay the record out beside it. Same key, so a width chosen before
 * the move survives it.
 */
describe('assistant width', () => {
  beforeEach(() => window.localStorage.removeItem('cerebro.aiPanelWidth'));

  it('persists under the key the panel used, clamped to its range', () => {
    useUiStore.getState().setAiPanelWidth(1200);
    expect(useUiStore.getState().aiPanelWidth).toBe(720);
    expect(window.localStorage.getItem('cerebro.aiPanelWidth')).toBe('720');
    useUiStore.getState().setAiPanelWidth(100);
    expect(useUiStore.getState().aiPanelWidth).toBe(320);
  });

  it('reads a width stored before the move back on launch', async () => {
    window.localStorage.setItem('cerebro.aiPanelWidth', '512');
    vi.resetModules();
    const fresh = (await import('./uiStore')).useUiStore;
    expect(fresh.getState().aiPanelWidth).toBe(512);
  });
});

describe('favorites', () => {
  const VAULT = '/vaults/one';
  const OTHER = '/vaults/two';
  beforeEach(() => {
    window.localStorage.removeItem('cerebro.favorites');
    useUiStore.setState({ favorites: {} });
  });

  it('toggles a path in and out, preserving pin order', () => {
    useUiStore.getState().toggleFavorite(VAULT, 'a.md');
    useUiStore.getState().toggleFavorite(VAULT, 'b.md');
    expect(useUiStore.getState().favorites[VAULT]).toEqual(['a.md', 'b.md']);
    useUiStore.getState().toggleFavorite(VAULT, 'a.md');
    expect(useUiStore.getState().favorites[VAULT]).toEqual(['b.md']);
  });

  it('prunes favorites that no longer resolve', () => {
    useUiStore.getState().toggleFavorite(VAULT, 'gone.md');
    useUiStore.getState().toggleFavorite(VAULT, 'here.md');
    useUiStore.getState().pruneFavorites(VAULT, new Set(['here.md']));
    expect(useUiStore.getState().favorites[VAULT]).toEqual(['here.md']);
  });

  // PR #17 review: the pin is per-vault, and a prune run against the vault
  // you just opened must not delete the pins of the one you just left —
  // especially since the same relative path exists in both.
  it("keeps each vault's pins, and prunes only the vault it was asked about", () => {
    useUiStore.getState().toggleFavorite(VAULT, 'notes/plan.md');
    useUiStore.getState().toggleFavorite(OTHER, 'notes/other.md');
    useUiStore.getState().pruneFavorites(OTHER, new Set(['notes/other.md']));
    expect(useUiStore.getState().favorites).toEqual({
      [VAULT]: ['notes/plan.md'],
      [OTHER]: ['notes/other.md'],
    });
    // And a pin that exists in both vaults is two pins, not one.
    useUiStore.getState().toggleFavorite(OTHER, 'notes/plan.md');
    useUiStore.getState().toggleFavorite(VAULT, 'notes/plan.md');
    expect(useUiStore.getState().favorites[VAULT]).toEqual([]);
    expect(useUiStore.getState().favorites[OTHER]).toEqual(['notes/other.md', 'notes/plan.md']);
  });

  it('persists under cerebro.favorites, keyed by vault', () => {
    useUiStore.getState().toggleFavorite(VAULT, 'a.md');
    expect(JSON.parse(window.localStorage.getItem('cerebro.favorites') ?? '{}')).toEqual({
      [VAULT]: ['a.md'],
    });
  });

  // M55.13 — growing a page renames it; its pin follows, in place, and so do
  // pins on pages under a folder that moved. Other vaults are left alone.
  it('follows a page that moved, keeping its place in the order', () => {
    useUiStore.getState().toggleFavorite(VAULT, 'first.md');
    useUiStore.getState().toggleFavorite(VAULT, 'notes/plan.md');
    useUiStore.getState().toggleFavorite(VAULT, 'notes/doc/child.md');
    useUiStore.getState().toggleFavorite(OTHER, 'notes/plan.md');
    useUiStore.getState().remapFavorites(VAULT, 'notes/plan.md', 'notes/plan/plan.md');
    useUiStore.getState().remapFavorites(VAULT, 'notes/doc', 'notes/plan/doc');
    expect(useUiStore.getState().favorites[VAULT]).toEqual([
      'first.md',
      'notes/plan/plan.md',
      'notes/plan/doc/child.md',
    ]);
    expect(useUiStore.getState().favorites[OTHER]).toEqual(['notes/plan.md']);
    expect(window.localStorage.getItem('cerebro.favorites')).toContain('notes/plan/plan.md');
  });
});

// M45.2 — one mount, one signal: three menus open the layout editor by
// setting this, and the single App-level dialog is the only reader. Nothing
// threads callbacks through PropertyRow.
describe('layout editor signal', () => {
  beforeEach(() => {
    useUiStore.setState({ layoutEditor: null });
  });

  it('openLayoutEditor carries the type, and closeLayoutEditor nulls it', () => {
    useUiStore.getState().openLayoutEditor('Work item');
    expect(useUiStore.getState().layoutEditor).toEqual({ type: 'Work item' });
    useUiStore.getState().closeLayoutEditor();
    expect(useUiStore.getState().layoutEditor).toBeNull();
  });

  it('a second open replaces the first — one editor, latest door wins', () => {
    useUiStore.getState().openLayoutEditor('Work item');
    useUiStore.getState().openLayoutEditor('Meeting');
    expect(useUiStore.getState().layoutEditor).toEqual({ type: 'Meeting' });
  });
});

describe('wakes revision (M63.1b)', () => {
  it('noteWakesChanged bumps the revision the wake list reads again on', () => {
    useUiStore.setState({ wakesRevision: 0 });
    useUiStore.getState().noteWakesChanged();
    expect(useUiStore.getState().wakesRevision).toBe(1);
    useUiStore.getState().noteWakesChanged();
    expect(useUiStore.getState().wakesRevision).toBe(2);
  });
});

/**
 * M53.27: a run the budget gate deferred gives back the record its claim
 * made, in memory and in the localStorage mirror the next launch starts from.
 */
describe('forgetJobRecord', () => {
  const stored = (key: string): unknown =>
    JSON.parse(window.localStorage.getItem(key) ?? 'null') as unknown;

  beforeEach(() => {
    window.localStorage.removeItem('cerebro.learnAttempts');
    window.localStorage.removeItem('cerebro.skillRuns');
    useUiStore.setState({ learnAttempts: {}, skillRuns: {} });
  });

  it('forgets an attempt that still holds the run key, and its mirror', () => {
    const ui = useUiStore.getState();
    ui.recordLearnAttempt('knowledge/a.md', 'stale:2026-07-01');
    ui.recordLearnAttempt('knowledge/b.md', 'stale:2026-07-02');
    ui.forgetJobRecord('/vault', 'attempts', 'knowledge/a.md', 'stale:2026-07-01');
    const left = { 'knowledge/b.md': 'stale:2026-07-02' };
    expect(useUiStore.getState().learnAttempts).toEqual(left);
    expect(stored('cerebro.learnAttempts')).toEqual(left);
  });

  it('forgets a fire in the vault it names, and its mirror, never the same fire elsewhere', () => {
    const ui = useUiStore.getState();
    ui.recordSkillRun('/vault', 'records/skills/digest.md', '2026-07-31 09:00');
    ui.recordSkillRun('/other', 'records/skills/digest.md', '2026-07-31 09:00');
    ui.forgetJobRecord('/vault', 'skillRuns', 'records/skills/digest.md', '2026-07-31 09:00');
    const left = { '/vault': {}, '/other': { 'records/skills/digest.md': '2026-07-31 09:00' } };
    expect(useUiStore.getState().skillRuns).toEqual(left);
    expect(stored('cerebro.skillRuns')).toEqual(left);
  });

  it('keeps a record that holds a different run key', () => {
    // Re-recorded since the deferred claim, so no longer that run's to give
    // back.
    const ui = useUiStore.getState();
    ui.recordLearnAttempt('knowledge/a.md', 'stale:2026-08-01');
    ui.recordSkillRun('/vault', 'records/skills/digest.md', '2026-08-01 09:00');
    const before = useUiStore.getState();
    ui.forgetJobRecord('/vault', 'attempts', 'knowledge/a.md', 'stale:2026-07-01');
    ui.forgetJobRecord('/vault', 'skillRuns', 'records/skills/digest.md', '2026-07-31 09:00');
    // Nor a slot in a vault that never recorded it.
    ui.forgetJobRecord('/other', 'skillRuns', 'records/skills/digest.md', '2026-08-01 09:00');
    // The same objects: no new state, so nothing re-renders.
    expect(useUiStore.getState().learnAttempts).toBe(before.learnAttempts);
    expect(useUiStore.getState().skillRuns).toBe(before.skillRuns);
    expect(stored('cerebro.learnAttempts')).toEqual({ 'knowledge/a.md': 'stale:2026-08-01' });
    expect(stored('cerebro.skillRuns')).toEqual({
      '/vault': { 'records/skills/digest.md': '2026-08-01 09:00' },
    });
  });
});

// M56.6 — the panel's binding lives in config.json; the store mirrors it.
describe('panel agent binding', () => {
  beforeEach(() => {
    resetMockFs();
    useUiStore.setState({ panelAgents: {}, panelAgentsUnreadable: {}, toasts: [] });
  });

  it('loads per vault: null is unbound, a handle is bound', async () => {
    await useUiStore.getState().loadPanelAgent('/demo-vault');
    expect(useUiStore.getState().panelAgents).toEqual({ '/demo-vault': null });
    expect(await useUiStore.getState().setPanelAgent('/demo-vault', 'release-scout')).toBe(true);
    expect(useUiStore.getState().panelAgents['/demo-vault']).toBe('release-scout');
    expect(await ipc.getPanelAgent('/demo-vault')).toBe('release-scout');
    useUiStore.setState({ panelAgents: {} });
    await useUiStore.getState().loadPanelAgent('/demo-vault');
    expect(useUiStore.getState().panelAgents['/demo-vault']).toBe('release-scout');
    expect(await useUiStore.getState().setPanelAgent('/demo-vault', null)).toBe(true);
    expect(useUiStore.getState().panelAgents['/demo-vault']).toBeNull();
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('a refused set toasts once, answers false and keeps the binding', async () => {
    await useUiStore.getState().setPanelAgent('/demo-vault', 'scout');
    expect(await useUiStore.getState().setPanelAgent('/demo-vault', 'Release Scout')).toBe(false);
    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
      'Couldn\'t change who answers in the assistant panel: "Release Scout" is not an agent handle',
    ]);
    expect(useUiStore.getState().panelAgents['/demo-vault']).toBe('scout');
  });

  it('a failed read toasts, keeps the binding it had and marks the vault unreadable', async () => {
    const spy = vi.spyOn(ipc, 'getPanelAgent').mockRejectedValueOnce(new Error('disk gone'));
    useUiStore.setState({ panelAgents: { '/demo-vault': 'scout' } });
    await useUiStore.getState().loadPanelAgent('/demo-vault');
    expect(useUiStore.getState().panelAgents).toEqual({ '/demo-vault': 'scout' });
    expect(useUiStore.getState().panelAgentsUnreadable).toEqual({ '/demo-vault': true });
    expect(useUiStore.getState().toasts).toHaveLength(1);
    spy.mockRestore();
  });

  it('a good read or a set clears the unreadable mark, and only that vault’s', async () => {
    useUiStore.setState({ panelAgentsUnreadable: { '/demo-vault': true, '/other': true } });
    await useUiStore.getState().loadPanelAgent('/demo-vault');
    expect(useUiStore.getState().panelAgentsUnreadable).toEqual({ '/other': true });
    expect(await useUiStore.getState().setPanelAgent('/other', null)).toBe(true);
    expect(useUiStore.getState().panelAgentsUnreadable).toEqual({});
  });

  it('opening a vault reads its binding before any panel mounts', async () => {
    await ipc.setPanelAgent('/demo-vault', 'release-scout');
    void useVaultStore.getState().openVault('/demo-vault');
    await vi.waitFor(() =>
      expect(useUiStore.getState().panelAgents['/demo-vault']).toBe('release-scout'),
    );
  });
});

describe('the thread a detached run belongs to (M57.6)', () => {
  beforeEach(() => {
    useUiStore.setState({ aiPanelOpen: false, panelConversation: null, runs: [] });
  });

  it('showConversation opens the panel and names the thread', () => {
    useUiStore.getState().showConversation('c-1');
    expect(useUiStore.getState().aiPanelOpen).toBe(true);
    expect(useUiStore.getState().panelConversation).toBe('c-1');
  });

  it('takePanelConversation hands it over once and clears it', () => {
    useUiStore.getState().showConversation('c-1');
    expect(useUiStore.getState().takePanelConversation()).toBe('c-1');
    expect(useUiStore.getState().panelConversation).toBeNull();
    expect(useUiStore.getState().takePanelConversation()).toBeNull();
  });

  it('attachChild records the attach key with the child', () => {
    useUiStore.getState().startRun({
      id: 'r-1',
      owner: 'chat',
      label: 'question',
      place: null,
      path: null,
      conversationId: 'c-1',
      run: null,
      startedAt: 0,
    });
    useUiStore.getState().attachChild('r-1', 8, 'run-0008');
    expect(useUiStore.getState().runs[0]).toMatchObject({ run: 8, attach: 'run-0008' });
    useUiStore.getState().attachChild('r-1', 9);
    expect(useUiStore.getState().runs[0]).toMatchObject({ run: 9, attach: 'run-0008' });
  });

  it('openDiff keeps a turn diff’s review, and closeDiff clears it (M58.5)', () => {
    const review = { conversationId: 'c-1', runId: 'run-7' };
    useUiStore.getState().openDiff('notes/a.md', 'a'.repeat(40), review);
    expect(useUiStore.getState().diffView).toEqual({
      path: 'notes/a.md',
      commit: 'a'.repeat(40),
      review,
    });
    useUiStore.getState().closeDiff();
    expect(useUiStore.getState().diffView).toBeNull();
    useUiStore.getState().openDiff('notes/a.md');
    expect(useUiStore.getState().diffView).toEqual({ path: 'notes/a.md', commit: null });
  });
});

it('mirrors and restores a dismissed insight without writing the global legacy key', () => {
  useUiStore.setState({ dismissedInsights: [] });
  const stored = localStorage.getItem('cerebro.dismissedInsights');
  useUiStore.getState().dismissInsight('knowledge/one.md');
  useUiStore.getState().dismissInsight('knowledge/one.md');
  expect(useUiStore.getState().dismissedInsights).toEqual(['knowledge/one.md']);
  useUiStore.getState().restoreInsight('knowledge/one.md');
  expect(useUiStore.getState().dismissedInsights).toEqual([]);
  expect(localStorage.getItem('cerebro.dismissedInsights')).toBe(stored);
});

it('the peek keeps its pane siblings and steps over held files (M65.8)', () => {
  const ui = useUiStore.getState();
  ui.setDetailSiblings(['a', 'held', 'b'], 'p1');
  ui.setDetailSiblings(['x', 'y'], 'p2');
  ui.openDetail('a', 'p1');
  expect(useUiStore.getState().detailSiblings).toEqual(['a', 'held', 'b']);
  ui.stepDetail(1, (path) => path === 'held');
  expect(useUiStore.getState().detailPath).toBe('b');
  expect(useUiStore.getState().detailPane).toBe('p1');
  ui.setDetailSiblings(['new'], 'p2');
  expect(useUiStore.getState().detailSiblings).toEqual(['a', 'held', 'b']);
  ui.closeDetail();
  expect(useUiStore.getState().detailPane).toBeNull();
});
