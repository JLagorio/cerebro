import { beforeEach, describe, expect, it } from 'vitest';
import {
  resetMockRoots,
  seedFile,
  seedKnowledgeDir,
  seedRoot,
  seedRootGit,
  seedRootNested,
} from '@/lib/mockRoots';
import { initialRootsState, selectActiveTab, useRootsStore } from './rootsStore';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState(initialRootsState());
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

    expect(selectActiveTab(useRootsStore.getState())).toBeNull();
    expect(useRootsStore.getState().roots).toHaveLength(0);
  });

  it('leaves an open file belonging to another root alone', async () => {
    const alpha = seedRoot({ path: '/repos/alpha', label: 'alpha' });
    const beta = seedRoot({ path: '/repos/beta', label: 'beta' });
    await useRootsStore.getState().loadRoots();
    useRootsStore.getState().openFile(alpha.id, 'README.md');

    await useRootsStore.getState().unmount(beta.id);

    expect(selectActiveTab(useRootsStore.getState())).toEqual({
      rootId: alpha.id,
      path: 'README.md',
    });
  });
});

describe('loadGitStatus', () => {
  it('loads git status for a repo root and keeps refusals as values', async () => {
    const repo = seedRoot({ path: '/repos/alpha', label: 'alpha', git: true });
    const plain = seedRoot({ path: '/notes', label: 'notes', git: false });
    seedRootGit('/repos/alpha', { branch: 'main', ahead: 0, behind: 2 });
    await useRootsStore.getState().loadRoots();

    await useRootsStore.getState().loadGitStatus(repo.id);
    expect(useRootsStore.getState().gitStatus[repo.id]?.branch).toBe('main');
    expect(useRootsStore.getState().gitRefusals[repo.id]).toBeUndefined();

    await useRootsStore.getState().loadGitStatus(plain.id);
    // READ, not toasted away — the typed-refusal exemption to the store rule.
    expect(useRootsStore.getState().gitRefusals[plain.id]?.code).toBe('no_git_capability');
    expect(useRootsStore.getState().gitStatus[plain.id]).toBeUndefined();
  });

  it('clears a stale refusal once the root resolves', async () => {
    const root = seedRoot({ path: '/repos/late', label: 'late', git: false });
    await useRootsStore.getState().loadRoots();
    await useRootsStore.getState().loadGitStatus(root.id);
    expect(useRootsStore.getState().gitRefusals[root.id]?.code).toBe('no_git_capability');

    // The directory became a repo; the gate re-probes and the badge must not
    // keep rendering yesterday's refusal.
    seedRootGit('/repos/late', { branch: 'trunk' });
    await useRootsStore.getState().loadRoots();
    await useRootsStore.getState().loadGitStatus(root.id);

    expect(useRootsStore.getState().gitRefusals[root.id]).toBeUndefined();
    expect(useRootsStore.getState().gitStatus[root.id]?.branch).toBe('trunk');
  });
});

describe('syncRoot', () => {
  it('fast-forwards a root that is only behind, and refreshes the badge', async () => {
    const root = seedRoot({ path: '/repos/behind', label: 'behind', git: true });
    seedRootGit('/repos/behind', { branch: 'main', ahead: 0, behind: 2 });
    await useRootsStore.getState().loadRoots();

    const result = await useRootsStore.getState().syncRoot(root.id);

    expect(result && 'status' in result && result.status).toBe('updated');
    expect(useRootsStore.getState().gitStatus[root.id]?.behind).toBe(0);
  });

  it('never attempts a pull on a diverged root', async () => {
    const root = seedRoot({ path: '/repos/div', label: 'div', git: true });
    seedRootGit('/repos/div', { branch: 'main', ahead: 1, behind: 1 });
    await useRootsStore.getState().loadRoots();

    const result = await useRootsStore.getState().syncRoot(root.id);

    // Fetch succeeded; the pull was not even asked for, so the counts stand.
    expect(result && 'status' in result && result.status).toBe('updated');
    expect(useRootsStore.getState().gitStatus[root.id]?.behind).toBe(1);
    expect(useRootsStore.getState().gitStatus[root.id]?.ahead).toBe(1);
  });

  it('returns parent_repo as a value the caller renders, and does not toast', async () => {
    const root = seedRoot({ path: '/work/mono/sub', label: 'sub', git: true });
    seedRootGit('/work/mono/sub', { branch: 'main', behind: 2 });
    seedRootNested('/work/mono/sub');
    await useRootsStore.getState().loadRoots();

    const result = await useRootsStore.getState().syncRoot(root.id);

    expect(result && 'code' in result && result.code).toBe('parent_repo');
    expect(useRootsStore.getState().gitRefusals[root.id]?.code).toBe('parent_repo');
  });
});
