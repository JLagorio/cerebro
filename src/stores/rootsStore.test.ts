import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UNCOUNTED_WORDS } from '@/engine/git';
import { DIVERGED_MESSAGE, syncNotice } from '@/engine/roots';
import {
  resetMockRoots,
  seedFile,
  seedKnowledgeDir,
  seedRoot,
  seedRootGit,
  seedRootGitRemoteFailure,
  seedRootNested,
} from '@/lib/mockRoots';
import * as rootsIpc from '@/lib/rootsIpc';
import { initialRootsState, selectActiveTab, useRootsStore } from './rootsStore';
import { useUiStore } from './uiStore';

beforeEach(() => {
  resetMockRoots();
  useRootsStore.setState(initialRootsState());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadRoots', () => {
  it('populates from the backend', async () => {
    seedRoot({ path: '/repos/alpha', label: 'alpha' });
    expect(useRootsStore.getState().rootsLoaded).toBe(false);
    await useRootsStore.getState().loadRoots();
    expect(useRootsStore.getState().roots).toHaveLength(1);
    expect(useRootsStore.getState().rootsLoaded).toBe(true);
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
    expect(useRootsStore.getState().gitSync[root.id]).toEqual(result);
  });

  it('answers a diverged root with the divergence message, and leaves its counts', async () => {
    const root = seedRoot({ path: '/repos/div', label: 'div', git: true });
    seedRootGit('/repos/div', { branch: 'main', ahead: 1, behind: 1 });
    await useRootsStore.getState().loadRoots();
    useUiStore.setState({ toasts: [] });

    const result = await useRootsStore.getState().syncRoot(root.id);

    // The fetch landed and the pull was never asked for (rootsIpc.test.ts
    // proves that at the invoke seam), but the row still needs the answer
    // `--ff-only` would have given.
    expect(result && 'status' in result && result.status).toBe('rejected');
    expect(useRootsStore.getState().gitSync[root.id]).toEqual({
      status: 'rejected',
      message: DIVERGED_MESSAGE,
      updatedFiles: [],
      conflictFiles: [],
    });
    expect(useRootsStore.getState().gitStatus[root.id]?.behind).toBe(1);
    expect(useRootsStore.getState().gitStatus[root.id]?.ahead).toBe(1);
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('keeps a failed fetch as the row’s answer, with the credential hint, and toasts nothing', async () => {
    const root = seedRoot({ path: '/repos/locked', label: 'locked', git: true });
    seedRootGit('/repos/locked', { branch: 'main', behind: 2 });
    seedRootGitRemoteFailure('/repos/locked', 'auth_error');
    await useRootsStore.getState().loadRoots();
    useUiStore.setState({ toasts: [] });

    const result = await useRootsStore.getState().syncRoot(root.id);

    expect(result && 'status' in result && result.status).toBe('auth_error');
    const kept = useRootsStore.getState().gitSync[root.id];
    expect(kept && 'status' in kept && kept.status).toBe('auth_error');
    expect(kept?.message).toContain('credential helper');
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('a sync that lands replaces the last one’s answer', async () => {
    const root = seedRoot({ path: '/repos/late', label: 'late', git: true });
    seedRootGit('/repos/late', { branch: 'main', hasRemote: false });
    await useRootsStore.getState().loadRoots();

    await useRootsStore.getState().syncRoot(root.id);
    const first = useRootsStore.getState().gitSync[root.id];
    expect(first && 'status' in first && first.status).toBe('no_remote');

    // A remote is added and the root falls behind it: the next sync lands, and
    // yesterday's "no remote" must not outlive it.
    seedRootGit('/repos/late', { branch: 'main', behind: 1 });
    await useRootsStore.getState().syncRoot(root.id);

    const second = useRootsStore.getState().gitSync[root.id];
    expect(second && 'status' in second && second.status).toBe('updated');
  });

  // M92.10: a count git did not take is unknown, never the 0 that would read
  // as "nothing to pull" or the 0 that would let a diverged root pull.
  it.each([
    ['both counts unknown', { ahead: null, behind: null }],
    ['behind unknown while nothing is ahead', { ahead: 0, behind: null }],
    ['ahead unknown while behind', { ahead: null, behind: 2 }],
  ] as const)('never pulls with %s, and settles as couldn’t tell', async (_, counts) => {
    const root = seedRoot({ path: '/repos/uncounted', label: 'uncounted', git: true });
    seedRootGit('/repos/uncounted', { branch: 'main', ...counts });
    await useRootsStore.getState().loadRoots();
    useUiStore.setState({ toasts: [] });
    const pull = vi.spyOn(rootsIpc, 'rootGitPullFf');

    const result = await useRootsStore.getState().syncRoot(root.id);

    expect(pull).not.toHaveBeenCalled();
    const unread = {
      uncounted: 'unread',
      message: `${UNCOUNTED_WORDS.unread}, so nothing was pulled`,
    };
    expect(result).toEqual(unread);
    expect(useRootsStore.getState().gitSync[root.id]).toEqual(unread);
    expect(syncNotice(result ?? undefined)).toEqual({
      text: "couldn't tell",
      title: unread.message,
    });
    // The counts stay unknown: nothing turned them into zeros.
    expect(useRootsStore.getState().gitStatus[root.id]).toMatchObject(counts);
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('never pulls a branch that tracks no upstream, and says why it couldn’t tell', async () => {
    const root = seedRoot({ path: '/repos/loose', label: 'loose', git: true });
    seedRootGit('/repos/loose', { branch: 'topic', hasUpstream: false });
    await useRootsStore.getState().loadRoots();
    const pull = vi.spyOn(rootsIpc, 'rootGitPullFf');

    const result = await useRootsStore.getState().syncRoot(root.id);

    expect(pull).not.toHaveBeenCalled();
    expect(result).toEqual({
      uncounted: 'no_upstream',
      message: `${UNCOUNTED_WORDS.no_upstream}, so nothing was pulled`,
    });
    expect(useRootsStore.getState().gitStatus[root.id]).toMatchObject({
      ahead: null,
      behind: null,
    });
  });

  it('never pulls when the status read after the fetch answered nothing', async () => {
    const root = seedRoot({ path: '/repos/unread', label: 'unread', git: true });
    seedRootGit('/repos/unread', { branch: 'main', behind: 2 });
    await useRootsStore.getState().loadRoots();
    vi.spyOn(rootsIpc, 'rootGitRemoteStatus').mockResolvedValue({
      code: 'git_error',
      message: 'git exited non-zero',
    });
    const pull = vi.spyOn(rootsIpc, 'rootGitPullFf');

    const result = await useRootsStore.getState().syncRoot(root.id);

    expect(pull).not.toHaveBeenCalled();
    expect(result && 'uncounted' in result && result.uncounted).toBe('unread');
    // What the read said stays the read's answer.
    expect(useRootsStore.getState().gitRefusals[root.id]?.code).toBe('git_error');
  });

  it('still pulls a root whose counts were read and say it is only behind', async () => {
    const root = seedRoot({ path: '/repos/counted', label: 'counted', git: true });
    seedRootGit('/repos/counted', { branch: 'main', ahead: 0, behind: 1 });
    await useRootsStore.getState().loadRoots();
    const pull = vi.spyOn(rootsIpc, 'rootGitPullFf');

    await useRootsStore.getState().syncRoot(root.id);

    expect(pull).toHaveBeenCalledOnce();
  });

  it('returns parent_repo as a value the caller renders, and does not toast', async () => {
    const root = seedRoot({ path: '/work/mono/sub', label: 'sub', git: true });
    seedRootGit('/work/mono/sub', { branch: 'main', behind: 2 });
    seedRootNested('/work/mono/sub');
    await useRootsStore.getState().loadRoots();
    useUiStore.setState({ toasts: [] });

    const result = await useRootsStore.getState().syncRoot(root.id);

    expect(result && 'code' in result && result.code).toBe('parent_repo');
    const kept = useRootsStore.getState().gitSync[root.id];
    expect(kept && 'code' in kept && kept.code).toBe('parent_repo');
    // A sync's refusal is the sync's answer; what the last READ said stays put.
    expect(useRootsStore.getState().gitRefusals[root.id]).toBeUndefined();
    expect(useUiStore.getState().toasts).toEqual([]);
  });
});
