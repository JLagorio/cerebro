import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageNavigationProvider } from '@/app/PageNavigation';
import { PaneContext } from '@/stores/navStore';
import { resetMockRoots, seedFile, seedRoot } from '@/lib/mockRoots';
import { initialRootsState, useRootsStore } from '@/stores/rootsStore';
import { WorkspacePage } from './WorkspacePage';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState(initialRootsState());
});

describe('WorkspacePage', () => {
  it('prompts to mount when nothing is mounted', async () => {
    render(<WorkspacePage selection={{ kind: 'workspace' }} />);
    expect(await screen.findByTestId('workspace-empty')).toBeTruthy();
    expect(screen.getByText('Explorer', { exact: true })).toBeTruthy();
  });

  it('renders the tree once a root is mounted', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    render(<WorkspacePage selection={{ kind: 'workspace' }} />);
    expect(await screen.findByTestId('root-tree')).toBeTruthy();
    expect(await screen.findByText('alpha')).toBeTruthy();
  });

  it('opens the file named by the selection, so Back restores it', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');

    render(<WorkspacePage selection={{ kind: 'workspace', root: root.id, path: 'README.md' }} />);

    const viewer = await screen.findByTestId('doc-viewer');
    expect(viewer.getAttribute('data-path')).toBe('README.md');
  });

  it('opens the mount dialog from the sidebar', async () => {
    render(<WorkspacePage selection={{ kind: 'workspace' }} />);
    fireEvent.click(await screen.findByTestId('mount-root'));
    await waitFor(() => expect(screen.getByTestId('mount-dialog')).toBeTruthy());
  });

  it('lends one Explorer to the shell and closes its drawer only when a file opens', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    const target = document.createElement('div');
    document.body.append(target);
    const controls = { show: vi.fn(), hide: vi.fn() };
    const view = render(
      <PageNavigationProvider value={{ kind: 'workspace', paneId: 'p1', target, controls }}>
        <PaneContext.Provider value="p1">
          <WorkspacePage selection={{ kind: 'workspace' }} />
        </PaneContext.Provider>
      </PageNavigationProvider>,
    );
    try {
      const tree = await within(target).findByTestId('root-tree');
      expect(screen.getAllByTestId('root-tree')).toHaveLength(1);
      expect(within(target).queryByText('Explorer', { exact: true })).toBeNull();
      expect(within(target).getByRole('button', { name: 'Mount a folder' }).textContent).toContain(
        'Mount folder',
      );
      fireEvent.click(within(target).getByRole('button', { name: 'Explorer settings' }));
      expect(
        within(target).getByRole('menuitemcheckbox', { name: 'File type icons' }),
      ).toBeTruthy();
      fireEvent.click(within(target).getByRole('button', { name: 'Explorer settings' }));
      expect(screen.getByTestId('workspace-page').contains(tree)).toBe(false);
      fireEvent.click(within(tree).getByRole('treeitem', { name: /alpha/ }));
      expect(controls.hide).not.toHaveBeenCalled();
      fireEvent.keyDown(await within(tree).findByRole('treeitem', { name: /README.md/ }), {
        key: 'Enter',
      });
      expect(controls.hide).toHaveBeenCalledOnce();
      expect((await screen.findByTestId('doc-viewer')).getAttribute('data-path')).toBe('README.md');
      expect(useRootsStore.getState().layout.groups[0]?.tabs[0]?.rootId).toBe(root.id);
      fireEvent.click(screen.getByRole('button', { name: 'Files' }));
      expect(controls.show).toHaveBeenCalledOnce();
      fireEvent.click(screen.getByTestId('crumb-root'));
      expect(controls.show).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
      target.remove();
    }
  });
});
