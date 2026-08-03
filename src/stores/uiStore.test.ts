import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from './uiStore';

function reset() {
  useUiStore.setState({
    detailPath: null,
    aiPanelOpen: false,
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

  // M15: one right-hand slot. As independent flags they stacked, and two
  // panels beside the sidebar left a ~20px canvas on a 1280px window.
  describe('the right-hand slot holds one occupant', () => {
    it('opening a record closes the assistant', () => {
      useUiStore.getState().setAiPanelOpen(true);
      useUiStore.getState().openDetail('records/bets/office-hours.md');
      expect(useUiStore.getState().aiPanelOpen).toBe(false);
      expect(useUiStore.getState().detailPath).toBe('records/bets/office-hours.md');
    });

    it('opening the assistant closes the record panel', () => {
      useUiStore.getState().openDetail('records/bets/office-hours.md');
      useUiStore.getState().setAiPanelOpen(true);
      expect(useUiStore.getState().detailPath).toBeNull();
      expect(useUiStore.getState().aiPanelOpen).toBe(true);
    });

    it('closing the assistant leaves the slot empty rather than reviving a record', () => {
      useUiStore.getState().openDetail('records/bets/office-hours.md');
      useUiStore.getState().setAiPanelOpen(true);
      useUiStore.getState().setAiPanelOpen(false);
      expect(useUiStore.getState().detailPath).toBeNull();
      expect(useUiStore.getState().aiPanelOpen).toBe(false);
    });
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
