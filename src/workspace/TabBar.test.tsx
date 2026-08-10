import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockRoots, seedRoot } from '@/lib/mockRoots';
import { useRootsStore } from '@/stores/rootsStore';
import { TabBar } from './TabBar';

function reset(): void {
  resetMockRoots();
  useRootsStore.setState({
    roots: [],
    expanded: {},
    children: {},
    open: null,
    tabs: [],
    docs: [],
  });
}

beforeEach(reset);

describe('TabBar', () => {
  it('renders nothing when no file is open', () => {
    render(<TabBar />);
    expect(screen.queryByTestId('tab-bar')).toBeNull();
  });

  it('opens one tab per distinct file', () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    useRootsStore.setState({ roots: [root] });
    useRootsStore.getState().openFile(root.id, 'README.md');
    useRootsStore.getState().openFile(root.id, 'src/main.rs');

    render(<TabBar />);

    expect(screen.getAllByTestId('tab')).toHaveLength(2);
  });

  it('re-opening a file focuses its tab instead of duplicating it', () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    useRootsStore.setState({ roots: [root] });
    useRootsStore.getState().openFile(root.id, 'README.md');
    useRootsStore.getState().openFile(root.id, 'src/main.rs');
    useRootsStore.getState().openFile(root.id, 'README.md');

    render(<TabBar />);

    expect(screen.getAllByTestId('tab')).toHaveLength(2);
    expect(useRootsStore.getState().open?.path).toBe('README.md');
  });

  it('keeps same-named files from different roots apart', () => {
    const alpha = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    const beta = seedRoot({ path: '/repos/beta', label: 'beta' });
    useRootsStore.setState({ roots: [alpha, beta] });
    useRootsStore.getState().openFile(alpha.id, 'README.md');
    useRootsStore.getState().openFile(beta.id, 'README.md');

    render(<TabBar />);

    expect(screen.getAllByTestId('tab')).toHaveLength(2);
  });

  it('shows the basename, not the whole path', () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    useRootsStore.setState({ roots: [root] });
    useRootsStore.getState().openFile(root.id, 'docs/guide/setup.md');

    render(<TabBar />);

    expect(screen.getByText('setup.md')).toBeTruthy();
  });

  it('focuses a tab when it is clicked', () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    useRootsStore.setState({ roots: [root] });
    useRootsStore.getState().openFile(root.id, 'README.md');
    useRootsStore.getState().openFile(root.id, 'src/main.rs');

    render(<TabBar />);
    fireEvent.click(screen.getByText('README.md'));

    expect(useRootsStore.getState().open?.path).toBe('README.md');
  });

  it('closing the focused tab falls back to its left neighbour', () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    useRootsStore.setState({ roots: [root] });
    useRootsStore.getState().openFile(root.id, 'a.md');
    useRootsStore.getState().openFile(root.id, 'b.md');

    render(<TabBar />);
    fireEvent.click(screen.getByLabelText('Close b.md'));

    expect(useRootsStore.getState().open?.path).toBe('a.md');
    expect(useRootsStore.getState().tabs).toHaveLength(1);
  });

  it('closing the last tab leaves nothing open', () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    useRootsStore.setState({ roots: [root] });
    useRootsStore.getState().openFile(root.id, 'only.md');

    render(<TabBar />);
    fireEvent.click(screen.getByLabelText('Close only.md'));

    expect(useRootsStore.getState().open).toBeNull();
    expect(useRootsStore.getState().tabs).toHaveLength(0);
  });

  it('closing an unfocused tab does not move focus', () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    useRootsStore.setState({ roots: [root] });
    useRootsStore.getState().openFile(root.id, 'a.md');
    useRootsStore.getState().openFile(root.id, 'b.md');

    render(<TabBar />);
    fireEvent.click(screen.getByLabelText('Close a.md'));

    expect(useRootsStore.getState().open?.path).toBe('b.md');
  });
});
