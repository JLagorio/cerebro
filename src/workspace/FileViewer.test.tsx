import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_BYTES, resetMockRoots, seedFile, seedRoot } from '@/lib/mockRoots';
import { useRootsStore } from '@/stores/rootsStore';
import { FileViewer } from './FileViewer';

/** A NUL written as an escape — never a raw byte in a source file. */
const NUL = '\u0000';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState({ roots: [], expanded: {}, children: {}, open: null, docs: [] });
});

describe('FileViewer', () => {
  it('renders markdown in the doc viewer', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha\n\nHello.');
    render(<FileViewer rootId={root.id} path="README.md" />);
    expect(await screen.findByTestId('doc-viewer')).toBeTruthy();
  });

  it('renders code in the code viewer', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'src/main.rs', 'fn main() {}');
    render(<FileViewer rootId={root.id} path="src/main.rs" />);
    const viewer = await screen.findByTestId('code-viewer');
    expect(viewer.getAttribute('data-lang')).toBe('rust');
  });

  it('renders an unknown extension as plain text rather than refusing', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'Dockerfile.dev', 'FROM scratch');
    render(<FileViewer rootId={root.id} path="Dockerfile.dev" />);
    const viewer = await screen.findByTestId('code-viewer');
    expect(viewer.getAttribute('data-lang')).toBe('plain');
  });

  it('renders a distinct placeholder for a binary file', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'image.png', `PNG${NUL}data`);
    render(<FileViewer rootId={root.id} path="image.png" />);
    expect(await screen.findByTestId('viewer-binary')).toBeTruthy();
  });

  it('renders a distinct placeholder for an oversized file', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'big.txt', 'x'.repeat(MAX_BYTES + 1));
    render(<FileViewer rootId={root.id} path="big.txt" />);
    expect(await screen.findByTestId('viewer-too-large')).toBeTruthy();
  });

  it('renders a distinct placeholder for a missing file', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    render(<FileViewer rootId={root.id} path="missing.md" />);
    expect(await screen.findByTestId('viewer-not-found')).toBeTruthy();
  });
});
