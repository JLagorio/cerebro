import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { DIVERGED_MESSAGE } from '@/engine/roots';
import {
  resetMockRoots,
  seedFile,
  seedRoot,
  seedRootGit,
  seedRootGitRemoteFailure,
} from '@/lib/mockRoots';
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
    // Both roots are git-capable, so the tree reads their status and then
    // their dirty count (M32.9). Let both land inside act, not after the test.
    await waitFor(() => expect(Object.keys(useRootsStore.getState().gitDirty)).toHaveLength(2));
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

  // One caret per directory, turned by the state the row announces rather
  // than traded for another glyph; with icons off the directory keeps a
  // folder glyph beside it, where a caret glyph used to make two carets.
  it.each([true, false])('turns one caret per directory (file icons %s)', async (icons) => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'docs/guide.md', '# Guide');
    await useRootsStore.getState().loadRoots();
    useUiStore.setState({ workspaceFileIcons: icons });

    render(<RootTree />);
    const root = screen.getByRole('treeitem', { name: /alpha/ });
    expect(root.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelectorAll('[data-icon^="chevron"]')).toHaveLength(1);
    expect(root.querySelector('.cb-chevron--open')).toBeNull();
    fireEvent.click(root);
    await waitFor(() => expect(root.getAttribute('aria-expanded')).toBe('true'));
    expect(root.querySelectorAll('[data-icon^="chevron"]')).toHaveLength(1);
    expect(root.querySelector('[data-icon="chevron-right"].cb-chevron--open')).not.toBeNull();
    const docs = await screen.findByRole('treeitem', { name: /docs/ });
    expect(docs.querySelectorAll('[data-icon^="chevron"]')).toHaveLength(1);
    await waitFor(() => expect(Object.keys(useRootsStore.getState().gitDirty)).toHaveLength(1));
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

describe('RootTree sync control', () => {
  /** Render, then let the mount-time status and dirty reads land. */
  async function renderSettled(rootId: string): Promise<HTMLElement> {
    render(<RootTree />);
    await waitFor(() => expect(useRootsStore.getState().gitDirty[rootId]).toBe(0));
    return screen.getByTestId('root-git-sync');
  }

  it('names a failed sync on the row, with the credential hint, and toasts nothing', async () => {
    const root = seedRoot({ path: '/repos/locked', label: 'locked', git: true });
    seedRootGit('/repos/locked', { branch: 'main', behind: 1 });
    seedRootGitRemoteFailure('/repos/locked', 'auth_error');
    await useRootsStore.getState().loadRoots();
    useUiStore.setState({ toasts: [] });

    const control = await renderSettled(root.id);
    expect(control.textContent).toBe('\u21bb');
    fireEvent.click(control);

    await waitFor(() => {
      expect(screen.getByTestId('root-git-sync').textContent).toBe('auth failed');
    });
    const failed = screen.getByTestId('root-git-sync');
    expect(failed.getAttribute('title')).toContain('Check your credential helper or SSH key');
    expect(failed.getAttribute('aria-label')).toBe('Sync locked: auth failed');
    expect(useUiStore.getState().toasts).toEqual([]);
    // The control sits inside the row's button; syncing must not also open it.
    expect(useRootsStore.getState().expanded[`${root.id} `]).toBeUndefined();
  });

  it('says a diverged root diverged, in the words a fast-forward refusal uses', async () => {
    const root = seedRoot({ path: '/repos/div', label: 'div', git: true });
    seedRootGit('/repos/div', { branch: 'main', ahead: 1, behind: 1 });
    await useRootsStore.getState().loadRoots();

    fireEvent.click(await renderSettled(root.id));

    await waitFor(() => {
      expect(screen.getByTestId('root-git-sync').textContent).toBe('diverged');
    });
    expect(screen.getByTestId('root-git-sync').getAttribute('title')).toBe(DIVERGED_MESSAGE);
  });

  it('goes quiet again once a sync lands', async () => {
    const root = seedRoot({ path: '/repos/behind', label: 'behind', git: true });
    seedRootGit('/repos/behind', { branch: 'main', behind: 1 });
    await useRootsStore.getState().loadRoots();
    useRootsStore.setState({
      gitSync: {
        [root.id]: { status: 'network_error', message: 'x', updatedFiles: [], conflictFiles: [] },
      },
    });

    const control = await renderSettled(root.id);
    expect(control.textContent).toBe('offline');
    fireEvent.click(control);

    await waitFor(() => {
      expect(screen.getByTestId('root-git-sync').textContent).toBe('\u21bb');
    });
    expect(screen.getByTestId('root-git-sync').getAttribute('aria-label')).toBe('Sync behind');
  });
});
