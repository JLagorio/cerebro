import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockRoots, seedFile, seedKnowledgeDir, seedRoot } from '@/lib/mockRoots';
import { useRootsStore } from './rootsStore';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState({ roots: [], expanded: {}, children: {}, open: null, docs: [] });
});

describe('loadRoots', () => {
  it('populates from the backend', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    await useRootsStore.getState().loadRoots();
    expect(useRootsStore.getState().roots).toHaveLength(1);
  });
});

describe('mount', () => {
  it('adds a root and returns null on success', async () => {
    const refusal = await useRootsStore.getState().mount('/repos/alpha');
    expect(refusal).toBeNull();
    expect(useRootsStore.getState().roots).toHaveLength(1);
  });

  it('returns the refusal instead of throwing, and mounts nothing', async () => {
    seedRoot({ path: '/vault', label: 'vault', knowledge: true });
    seedKnowledgeDir('/repos/brain');
    await useRootsStore.getState().loadRoots();

    const refusal = await useRootsStore.getState().mount('/repos/brain');

    expect(refusal?.code).toBe('knowledge_root_exists');
    expect(useRootsStore.getState().roots).toHaveLength(1);
  });
});

describe('toggle', () => {
  it('loads children on first expand and caches them', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    await useRootsStore.getState().loadRoots();

    await useRootsStore.getState().toggle(root.id, '');

    const key = `${root.id} `;
    expect(useRootsStore.getState().expanded[key]).toBe(true);
    expect(useRootsStore.getState().children[key]).toHaveLength(1);
  });

  it('collapses without discarding cached children', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    await useRootsStore.getState().loadRoots();

    await useRootsStore.getState().toggle(root.id, '');
    await useRootsStore.getState().toggle(root.id, '');

    const key = `${root.id} `;
    expect(useRootsStore.getState().expanded[key]).toBe(false);
    expect(useRootsStore.getState().children[key]).toHaveLength(1);
  });

  it('expands a nested directory under its own key', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedFile('/repos/alpha', 'docs/guide.md', '# Guide');
    await useRootsStore.getState().loadRoots();

    await useRootsStore.getState().toggle(root.id, '');
    await useRootsStore.getState().toggle(root.id, 'docs');

    expect(useRootsStore.getState().children[`${root.id} docs`]).toHaveLength(1);
  });
});

describe('unmount', () => {
  it('clears the open file when its root goes away', async () => {
    const root = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    await useRootsStore.getState().loadRoots();
    useRootsStore.getState().openFile(root.id, 'README.md');

    await useRootsStore.getState().unmount(root.id);

    expect(useRootsStore.getState().open).toBeNull();
    expect(useRootsStore.getState().roots).toHaveLength(0);
  });

  it('leaves an open file belonging to another root alone', async () => {
    const alpha = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    const beta = seedRoot({ path: '/repos/beta', label: 'beta' });
    await useRootsStore.getState().loadRoots();
    useRootsStore.getState().openFile(alpha.id, 'README.md');

    await useRootsStore.getState().unmount(beta.id);

    expect(useRootsStore.getState().open).toEqual({ rootId: alpha.id, path: 'README.md' });
  });
});

describe('loadDocs', () => {
  it('collects the index across every mounted root', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    seedRoot({ path: '/repos/beta', label: 'beta' });
    seedFile('/repos/alpha', 'README.md', '# Alpha');
    seedFile('/repos/beta', 'README.md', '# Beta');
    await useRootsStore.getState().loadRoots();

    await useRootsStore.getState().loadDocs();

    expect(useRootsStore.getState().docs).toHaveLength(2);
  });
});
