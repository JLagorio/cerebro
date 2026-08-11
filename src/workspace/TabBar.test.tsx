import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { activeTab, type EditorGroup } from '@/engine/editorGroups';
import { resetMockRoots, seedRoot } from '@/lib/mockRoots';
import { initialRootsState, selectActiveTab, useRootsStore } from '@/stores/rootsStore';
import { TabBar } from './TabBar';
import { beginTabDrag, endTabDrag } from './tabDrag';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState(initialRootsState());
  endTabDrag();
});

/** Mount one root and open these files into the focused group. */
function openAll(...paths: string[]): string {
  const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
  useRootsStore.setState({ roots: [root] });
  for (const path of paths) useRootsStore.getState().openFile(root.id, path);
  return root.id;
}

/** The focused group, as the page would hand it to the strip. */
const focusedGroup = (): EditorGroup => {
  const { layout } = useRootsStore.getState();
  return layout.groups.find((g) => g.id === layout.activeGroupId) as EditorGroup;
};

/** Render the focused group's strip against current store state. */
function renderStrip() {
  return render(<TabBar group={focusedGroup()} focused />);
}

describe('TabBar', () => {
  it('renders an empty strip when nothing is open', () => {
    render(<TabBar group={focusedGroup()} focused />);
    expect(screen.queryAllByTestId('tab')).toHaveLength(0);
  });

  it('opens one tab per distinct file', () => {
    openAll('README.md', 'src/main.rs');
    renderStrip();
    expect(screen.getAllByTestId('tab')).toHaveLength(2);
  });

  it('re-opening a file focuses its tab instead of duplicating it', () => {
    openAll('README.md', 'src/main.rs', 'README.md');
    renderStrip();
    expect(screen.getAllByTestId('tab')).toHaveLength(2);
    expect(selectActiveTab(useRootsStore.getState())?.path).toBe('README.md');
  });

  it('keeps same-named files from different roots apart', () => {
    const alpha = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    const beta = seedRoot({ path: '/repos/beta', label: 'beta' });
    useRootsStore.setState({ roots: [alpha, beta] });
    useRootsStore.getState().openFile(alpha.id, 'README.md');
    useRootsStore.getState().openFile(beta.id, 'README.md');

    renderStrip();

    expect(screen.getAllByTestId('tab')).toHaveLength(2);
  });

  it('shows the basename, not the whole path', () => {
    openAll('docs/guide/setup.md');
    renderStrip();
    expect(screen.getByText('setup.md')).toBeTruthy();
  });

  it('focuses a tab when it is clicked', () => {
    openAll('README.md', 'src/main.rs');
    renderStrip();
    fireEvent.click(screen.getByText('README.md'));
    expect(selectActiveTab(useRootsStore.getState())?.path).toBe('README.md');
  });

  it('closing the focused tab falls back to its left neighbour', () => {
    openAll('a.md', 'b.md');
    renderStrip();
    fireEvent.click(screen.getByLabelText('Close b.md'));

    expect(selectActiveTab(useRootsStore.getState())?.path).toBe('a.md');
    expect(focusedGroup().tabs).toHaveLength(1);
  });

  it('closing the last tab leaves nothing open', () => {
    openAll('only.md');
    renderStrip();
    fireEvent.click(screen.getByLabelText('Close only.md'));

    expect(selectActiveTab(useRootsStore.getState())).toBeNull();
    expect(focusedGroup().tabs).toHaveLength(0);
  });

  it('closing an unfocused tab does not move focus', () => {
    openAll('a.md', 'b.md');
    renderStrip();
    fireEvent.click(screen.getByLabelText('Close a.md'));
    expect(selectActiveTab(useRootsStore.getState())?.path).toBe('b.md');
  });

  // `auxclick` is not in RTL's event map, so it is constructed by hand. It
  // must bubble: React listens at the root, not on the element.
  const auxClick = (el: HTMLElement, button: number): void => {
    fireEvent(el, new MouseEvent('auxclick', { bubbles: true, button }));
  };

  it('middle-click closes a tab', () => {
    openAll('a.md', 'b.md');
    renderStrip();
    auxClick(screen.getAllByTestId('tab')[0] as HTMLElement, 1);
    expect(focusedGroup().tabs.map((t) => t.path)).toEqual(['b.md']);
  });

  it('ignores a right-button aux click, which belongs to the menu', () => {
    openAll('a.md', 'b.md');
    renderStrip();
    auxClick(screen.getAllByTestId('tab')[0] as HTMLElement, 2);
    expect(focusedGroup().tabs).toHaveLength(2);
  });

  it('splits the focused tab into a second pane', () => {
    openAll('a.md');
    renderStrip();
    fireEvent.click(screen.getByTestId('split-editor'));

    const { layout } = useRootsStore.getState();
    expect(layout.groups).toHaveLength(2);
    expect(activeTab(layout)?.path).toBe('a.md');
  });

  it('offers close, close-others and split from the right-click menu', () => {
    openAll('a.md', 'b.md');
    renderStrip();
    fireEvent.contextMenu(screen.getAllByTestId('tab')[0] as HTMLElement);

    expect(screen.getByText('Close others')).toBeTruthy();
    fireEvent.click(screen.getByText('Close others'));

    expect(focusedGroup().tabs.map((t) => t.path)).toEqual(['a.md']);
  });

  /**
   * A drop, built by hand.
   *
   * RTL routes `drop` through `DragEvent`, which jsdom does not implement, so
   * the pointer coordinate in the init is silently discarded — and the
   * coordinate is the entire question here, since it decides which side of a
   * tab the drop lands on. A `MouseEvent` carries `clientX` honestly, and
   * `dataTransfer` is attached because a browser always supplies one.
   */
  const dropAt = (el: HTMLElement, clientX: number): void => {
    const event = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX });
    Object.defineProperty(event, 'dataTransfer', {
      value: { setData: () => {}, dropEffect: '', effectAllowed: '' },
    });
    fireEvent(el, event);
  };

  it('drops a tab AFTER one whose midpoint the pointer passed', () => {
    openAll('a.md', 'b.md', 'c.md');
    renderStrip();
    const group = focusedGroup();
    const rootId = group.tabs[0]?.rootId ?? '';

    beginTabDrag({ tab: { rootId, path: 'a.md' }, fromGroupId: group.id });
    // jsdom gives every element a zero-size box at the origin, so any clientX
    // past 0 is "right of the midpoint" — the case being asserted.
    dropAt(screen.getAllByTestId('tab')[2] as HTMLElement, 10);

    expect(focusedGroup().tabs.map((t) => t.path)).toEqual(['b.md', 'c.md', 'a.md']);
  });

  it('drops a tab BEFORE one the pointer has not passed', () => {
    openAll('a.md', 'b.md', 'c.md');
    renderStrip();
    const group = focusedGroup();
    const rootId = group.tabs[0]?.rootId ?? '';

    beginTabDrag({ tab: { rootId, path: 'a.md' }, fromGroupId: group.id });
    dropAt(screen.getAllByTestId('tab')[2] as HTMLElement, 0);

    expect(focusedGroup().tabs.map((t) => t.path)).toEqual(['b.md', 'a.md', 'c.md']);
  });

  it('ignores a drop when nothing is being dragged', () => {
    openAll('a.md', 'b.md');
    renderStrip();
    dropAt(screen.getAllByTestId('tab')[0] as HTMLElement, 0);
    expect(focusedGroup().tabs.map((t) => t.path)).toEqual(['a.md', 'b.md']);
  });
});
