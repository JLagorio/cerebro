import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockRoots, seedFile, seedRoot } from '@/lib/mockRoots';
import { useRootsStore } from '@/stores/rootsStore';
import { DocsTab } from './DocsTab';

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

describe('DocsTab', () => {
  it('bubbles markdown from every mounted root, grouped by root', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedRoot({ path: '/repos/beta', label: 'beta' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    seedFile('/repos/beta', 'docs/guide.md', '# Beta guide');
    await useRootsStore.getState().loadRoots();

    render(<DocsTab />);

    expect(await screen.findByText('Alpha')).toBeTruthy();
    expect(await screen.findByText('Beta guide')).toBeTruthy();
    expect(screen.getAllByTestId('docs-group')).toHaveLength(2);
  });

  it('excludes non-markdown files', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    seedFile('/repos/alpha', 'src/main.rs', 'fn main() {}');
    await useRootsStore.getState().loadRoots();

    render(<DocsTab />);

    expect(await screen.findByTestId('doc-card')).toBeTruthy();
    expect(screen.getAllByTestId('doc-card')).toHaveLength(1);
  });

  it('opens a document when its card is clicked', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    await useRootsStore.getState().loadRoots();

    render(<DocsTab />);
    fireEvent.click(await screen.findByTestId('doc-card'));

    expect(useRootsStore.getState().open).toEqual({ rootId: root.id, path: 'README.md' });
  });

  it('says so when there is no markdown at all', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    await useRootsStore.getState().loadRoots();

    render(<DocsTab />);

    expect(await screen.findByTestId('docs-empty')).toBeTruthy();
  });
});
