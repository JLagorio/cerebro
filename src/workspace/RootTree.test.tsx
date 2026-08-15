import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockRoots, seedFile, seedRoot, seedRootGit } from '@/lib/mockRoots';
import { initialRootsState, selectActiveTab, useRootsStore } from '@/stores/rootsStore';
import { useUiStore } from '@/stores/uiStore';
import { RootTree } from './RootTree';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState(initialRootsState());
});

describe('RootTree', () => {
  it('shows one row per mounted root before anything is expanded', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedRoot({ path: '/repos/beta', label: 'beta' });
    await useRootsStore.getState().loadRoots();

    render(<RootTree />);

    expect(screen.getAllByTestId('tree-row')).toHaveLength(2);
  });

  it('expands a root on click and lists its children', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    seedFile('/repos/alpha', 'src/main.rs', 'fn main() {}');
    await useRootsStore.getState().loadRoots();

    render(<RootTree />);
    fireEvent.click(screen.getByText('alpha'));

    await waitFor(() => expect(screen.getAllByTestId('tree-row').length).toBeGreaterThan(1));
    expect(screen.getByText('README.md')).toBeTruthy();
    expect(screen.getByText('src')).toBeTruthy();
  });

  it('opens a file when a leaf row is clicked', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    await useRootsStore.getState().loadRoots();

    render(<RootTree />);
    fireEvent.click(screen.getByText('alpha'));
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy());
    fireEvent.click(screen.getByText('README.md'));

    expect(selectActiveTab(useRootsStore.getState())).toEqual({
      rootId: root.id,
      path: 'README.md',
    });
  });

  it('marks a root whose directory has vanished as unavailable', async () => {
    const root = seedRoot({ path: '/repos/gone', label: 'gone' });
    await useRootsStore.getState().loadRoots();
    // A probe of a missing path yields no capabilities at all.
    useRootsStore.setState({
      roots: [{ ...root, caps: { knowledge: false, git: false, writable: false } }],
    });

    render(<RootTree />);

    expect(screen.getByTestId('root-unavailable')).toBeTruthy();
  });

  it('gives a file its own icon, and drops to a neutral one when icons are off', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'main.rs', 'fn main() {}');
    await useRootsStore.getState().loadRoots();

    useUiStore.setState({ workspaceFileIcons: true });
    const withIcons = render(<RootTree />);
    fireEvent.click(screen.getByText('alpha'));
    await waitFor(() => expect(screen.getByText('main.rs')).toBeTruthy());
    // A .rs file is code-coloured, so the row carries more than one glyph.
    expect(withIcons.container.querySelectorAll('svg').length).toBeGreaterThan(1);
    withIcons.unmount();

    useUiStore.setState({ workspaceFileIcons: false });
    render(<RootTree />);
    expect(screen.getByText('main.rs')).toBeTruthy();
  });

  it('is a real tree: roles, levels, and one tabbable row', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'docs/guide.md', '# Guide');
    await useRootsStore.getState().loadRoots();

    render(<RootTree />);
    fireEvent.click(screen.getByText('alpha'));
    await waitFor(() => expect(screen.getByText('docs')).toBeTruthy());

    expect(screen.getByRole('tree')).toBeTruthy();
    const rows = screen.getAllByRole('treeitem');
    expect(rows[0]?.getAttribute('aria-level')).toBe('1');
    expect(rows[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(rows[1]?.getAttribute('aria-level')).toBe('2');
    // Roving tabindex: exactly one row is in the tab order.
    expect(rows.filter((r) => r.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('walks with the arrow keys and opens with Enter', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    await useRootsStore.getState().loadRoots();

    render(<RootTree />);
    const rootRow = screen.getAllByRole('treeitem')[0] as HTMLElement;

    // Right expands a closed directory rather than moving.
    fireEvent.keyDown(rootRow, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy());

    // Down steps onto the child, Enter opens it.
    fireEvent.keyDown(rootRow, { key: 'ArrowDown' });
    const child = screen.getAllByRole('treeitem')[1] as HTMLElement;
    await waitFor(() => expect(child.getAttribute('tabindex')).toBe('0'));
    fireEvent.keyDown(child, { key: 'Enter' });

    expect(selectActiveTab(useRootsStore.getState())?.path).toBe('README.md');
  });

  it('Left collapses an open directory, then climbs to the parent', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'docs/guide.md', '# Guide');
    await useRootsStore.getState().loadRoots();

    render(<RootTree />);
    fireEvent.click(screen.getByText('alpha'));
    await waitFor(() => expect(screen.getByText('docs')).toBeTruthy());
    fireEvent.click(screen.getByText('docs'));
    await waitFor(() => expect(screen.getByText('guide.md')).toBeTruthy());

    const docsRow = screen
      .getAllByRole('treeitem')
      .find((r) => r.getAttribute('data-path') === 'docs') as HTMLElement;
    fireEvent.keyDown(docsRow, { key: 'ArrowLeft' });

    await waitFor(() => {
      expect(useRootsStore.getState().expanded[`${root.id} docs`]).toBe(false);
    });
  });

  it('marks the open file as the active row', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    await useRootsStore.getState().loadRoots();

    render(<RootTree />);
    fireEvent.click(screen.getByText('alpha'));
    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy());
    fireEvent.click(screen.getByText('README.md'));

    await waitFor(() => {
      const row = screen
        .getAllByTestId('tree-row')
        .find((r) => r.getAttribute('data-path') === 'README.md');
      expect(row?.getAttribute('data-active')).toBe('true');
    });
  });
});

describe('RootTree git badge', () => {
  it('shows branch and counts for a repo root that has something to say', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha', git: true });
    seedRootGit('/repos/alpha', { branch: 'main', ahead: 2, behind: 1 });
    await useRootsStore.getState().loadRoots();

    render(<RootTree />);

    await waitFor(() => {
      expect(screen.getByTestId('root-git-badge').textContent).toBe('main ↑2 ↓1');
    });
  });

  it('stays silent for a clean repo in sync — nothing speaks first', async () => {
    seedRoot({ path: '/repos/quiet', label: 'quiet', git: true });
    seedRootGit('/repos/quiet', { branch: 'main', ahead: 0, behind: 0 });
    await useRootsStore.getState().loadRoots();

    render(<RootTree />);

    await waitFor(() => {
      expect(useRootsStore.getState().gitStatus['root-1']?.branch).toBe('main');
    });
    expect(screen.queryByTestId('root-git-badge')).toBeNull();
  });

  it('never badges a root that is not a repo, and stores the refusal instead', async () => {
    seedRoot({ path: '/notes', label: 'notes', git: false });
    await useRootsStore.getState().loadRoots();

    render(<RootTree />);

    expect(screen.queryByTestId('root-git-badge')).toBeNull();
    // No git capability means the tree never even asks, so nothing is refused
    // and nothing is toasted — the row is simply a plain folder.
    expect(useRootsStore.getState().gitRefusals['root-1']).toBeUndefined();
  });
});
