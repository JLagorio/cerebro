import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockRoots, seedFile, seedRoot } from '@/lib/mockRoots';
import { initialRootsState, selectActiveTab, useRootsStore } from '@/stores/rootsStore';
import { EditorGroups } from './EditorGroups';
import { beginTabDrag, endTabDrag } from './tabDrag';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState(initialRootsState());
  endTabDrag();
});

/** Mount one root with these files and open them all in the first pane. */
function seed(...paths: string[]): string {
  const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
  for (const path of paths) seedFile('/repos/alpha', path, `# ${path}`);
  useRootsStore.setState({ roots: [root] });
  for (const path of paths) useRootsStore.getState().openFile(root.id, path);
  return root.id;
}

describe('EditorGroups', () => {
  it('shows one pane until something is split', async () => {
    seed('a.md');
    render(<EditorGroups />);
    // Awaited so the viewer's async read settles inside the test rather than
    // after it, which React reports as an unwrapped update.
    await screen.findByTestId('doc-viewer');
    expect(screen.getAllByTestId('editor-pane')).toHaveLength(1);
    expect(screen.queryByTestId('pane-splitter')).toBeNull();
  });

  it('renders two panes side by side after a split, with a divider between', async () => {
    seed('a.md', 'b.md');
    render(<EditorGroups />);

    fireEvent.click(screen.getAllByTestId('split-editor')[0] as HTMLElement);

    await waitFor(() => expect(screen.getAllByTestId('editor-pane')).toHaveLength(2));
    expect(screen.getAllByTestId('pane-splitter')).toHaveLength(1);
  });

  it('marks exactly one pane as focused', async () => {
    seed('a.md');
    render(<EditorGroups />);
    fireEvent.click(screen.getByTestId('split-editor'));

    await waitFor(() => {
      const focused = screen
        .getAllByTestId('editor-pane')
        .filter((p) => p.getAttribute('data-focused') === 'true');
      expect(focused).toHaveLength(1);
    });
  });

  it('clicking inside an unfocused pane focuses it', async () => {
    seed('a.md');
    render(<EditorGroups />);
    fireEvent.click(screen.getByTestId('split-editor'));
    await waitFor(() => expect(screen.getAllByTestId('editor-pane')).toHaveLength(2));

    const first = screen.getAllByTestId('editor-pane')[0] as HTMLElement;
    fireEvent.pointerDown(first);

    await waitFor(() => expect(first.getAttribute('data-focused')).toBe('true'));
  });

  it('dropping a tab on a pane body moves it there', async () => {
    const rootId = seed('a.md', 'b.md');
    render(<EditorGroups />);
    fireEvent.click(screen.getAllByTestId('split-editor')[0] as HTMLElement);
    await waitFor(() => expect(screen.getAllByTestId('editor-pane')).toHaveLength(2));

    const [left, right] = screen.getAllByTestId('editor-pane') as HTMLElement[];
    const leftId = left?.getAttribute('data-group') ?? '';
    beginTabDrag({ tab: { rootId, path: 'a.md' }, fromGroupId: leftId });
    fireEvent.drop(right as HTMLElement);

    await waitFor(() => {
      const { layout } = useRootsStore.getState();
      expect(layout.groups[1]?.tabs.map((t) => t.path).sort()).toEqual(['a.md', 'b.md']);
    });
  });

  it('the pane splitter is a keyboard-operable separator', async () => {
    seed('a.md');
    render(<EditorGroups />);
    fireEvent.click(screen.getByTestId('split-editor'));
    await waitFor(() => expect(screen.getByTestId('pane-splitter')).toBeTruthy());

    const splitter = screen.getByTestId('pane-splitter');
    expect(splitter.getAttribute('role')).toBe('separator');
    expect(splitter.getAttribute('tabindex')).toBe('0');
    // Arrow keys move it; the assertion is that they are handled at all.
    fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
    expect(screen.getAllByTestId('editor-pane')).toHaveLength(2);
  });

  it('shows the breadcrumb for the open file', async () => {
    seed('docs/guide/setup.md');
    render(<EditorGroups />);
    const crumb = await screen.findByTestId('breadcrumb');
    expect(crumb.getAttribute('data-path')).toBe('docs/guide/setup.md');
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('guide')).toBeTruthy();
  });

  it('a breadcrumb directory reveals itself in the explorer', async () => {
    const rootId = seed('docs/guide/setup.md');
    render(<EditorGroups />);
    await screen.findByTestId('breadcrumb');

    fireEvent.click(screen.getByText('docs'));

    await waitFor(() => {
      expect(useRootsStore.getState().expanded[`${rootId} docs`]).toBe(true);
      expect(useRootsStore.getState().revealSeq).toBeGreaterThan(0);
    });
  });

  /**
   * With a mouse this works by accident — a pane focuses itself on
   * pointer-down, before the click — so the assertion drives the click ALONE,
   * the way a keyboard would, where the accident does not save it.
   */
  it('a link opens in the pane it was clicked in, not the focused one', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha\n\nSee [the design](./docs/design.md).');
    seedFile('/repos/alpha', 'docs/design.md', '# Design');
    useRootsStore.setState({ roots: [root] });
    useRootsStore.getState().openFile(root.id, 'README.md');

    render(<EditorGroups />);
    fireEvent.click(await screen.findByTestId('split-editor'));
    await waitFor(() => expect(screen.getAllByTestId('editor-pane')).toHaveLength(2));

    // The RIGHT pane holds focus after a split; the link is in the left one.
    const [left, right] = screen.getAllByTestId('editor-pane') as HTMLElement[];
    expect(right?.getAttribute('data-focused')).toBe('true');

    const link = await waitFor(() => {
      const found = left?.querySelector('[data-testid="doc-internal-link"]');
      if (!found) throw new Error('no link yet');
      return found;
    });
    fireEvent.click(link);

    await waitFor(() => {
      const { layout } = useRootsStore.getState();
      expect(layout.groups[0]?.active?.path).toBe('docs/design.md');
      expect(layout.groups[1]?.active?.path).toBe('README.md');
    });
  });

  it('an empty pane says how to fill it', () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    render(<EditorGroups />);
    expect(screen.getByText('Nothing open')).toBeTruthy();
    expect(selectActiveTab(useRootsStore.getState())).toBeNull();
  });
});
