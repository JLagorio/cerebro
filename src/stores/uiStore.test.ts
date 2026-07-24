import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from './uiStore';

function reset() {
  useUiStore.setState({ detailPath: null, quickOpenVisible: false, toasts: [] });
}

describe('uiStore', () => {
  beforeEach(reset);

  it('openDetail and closeDetail set detailPath', () => {
    useUiStore.getState().openDetail('items/fld-7.md');
    expect(useUiStore.getState().detailPath).toBe('items/fld-7.md');
    useUiStore.getState().closeDetail();
    expect(useUiStore.getState().detailPath).toBeNull();
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
