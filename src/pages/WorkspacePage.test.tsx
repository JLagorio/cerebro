import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
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
});
