import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMockRoots, seedRoot } from '@/lib/mockRoots';
import { initialRootsState, selectActiveTab, useRootsStore } from '@/stores/rootsStore';
import { useWorkspaceKeys } from './useWorkspaceKeys';

function Host({ enabled = true }: { enabled?: boolean }) {
  useWorkspaceKeys(enabled);
  return <input data-testid="field" />;
}

const TAURI = '__TAURI_INTERNALS__';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState(initialRootsState());
  const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
  useRootsStore.setState({ roots: [root] });
  useRootsStore.getState().openFile(root.id, 'a.md');
  useRootsStore.getState().openFile(root.id, 'b.md');
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[TAURI];
});

const press = (key: string, init: KeyboardEventInit = {}): void => {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, ...init }),
  );
};

describe('useWorkspaceKeys', () => {
  it('Cmd+\\ splits the focused pane', () => {
    render(<Host />);
    press('\\');
    expect(useRootsStore.getState().layout.groups).toHaveLength(2);
  });

  it('Cmd+Shift+] and Cmd+Shift+[ step through the strip', () => {
    render(<Host />);
    press(']', { shiftKey: true });
    expect(selectActiveTab(useRootsStore.getState())?.path).toBe('a.md');
    press('[', { shiftKey: true });
    expect(selectActiveTab(useRootsStore.getState())?.path).toBe('b.md');
  });

  it('does nothing at all while the surface is off screen', () => {
    render(<Host enabled={false} />);
    press('\\');
    expect(useRootsStore.getState().layout.groups).toHaveLength(1);
  });

  it('leaves a chord alone when it is typed into a field', () => {
    const { getByTestId } = render(<Host />);
    const field = getByTestId('field');
    field.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', metaKey: true, bubbles: true }));
    expect(useRootsStore.getState().layout.groups).toHaveLength(1);
  });

  it('ignores a bare key with no modifier', () => {
    render(<Host />);
    press('\\', { metaKey: false });
    expect(useRootsStore.getState().layout.groups).toHaveLength(1);
  });

  /**
   * Cmd+W and Cmd+1..9 are BROWSER accelerators — Chrome acts on them before a
   * listener runs and `preventDefault` does not reach them. They are bound
   * only inside the Tauri shell, where the app owns its own keys.
   */
  it('does not claim Cmd+W outside Tauri, where the browser owns it', () => {
    render(<Host />);
    press('w');
    expect(useRootsStore.getState().layout.groups[0]?.tabs).toHaveLength(2);
  });

  it('Cmd+W closes the focused tab inside Tauri', () => {
    (window as unknown as Record<string, unknown>)[TAURI] = {};
    render(<Host />);
    press('w');
    expect(useRootsStore.getState().layout.groups[0]?.tabs.map((t) => t.path)).toEqual(['a.md']);
  });

  it('Cmd+2 focuses the second pane inside Tauri', () => {
    (window as unknown as Record<string, unknown>)[TAURI] = {};
    render(<Host />);
    press('\\');
    const second = useRootsStore.getState().layout.groups[1]?.id;
    press('1');
    expect(useRootsStore.getState().layout.activeGroupId).toBe('g1');
    press('2');
    expect(useRootsStore.getState().layout.activeGroupId).toBe(second);
  });
});
