import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockRoots, seedFile, seedRoot } from '@/lib/mockRoots';
import { useRootsStore } from '@/stores/rootsStore';
import { useUiStore } from '@/stores/uiStore';
import { RootTree } from './RootTree';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState({
    roots: [],
    expanded: {},
    children: {},
    open: null,
    tabs: [],
    docs: [],
  });
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

    expect(useRootsStore.getState().open).toEqual({ rootId: root.id, path: 'README.md' });
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
