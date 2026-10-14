import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteResult } from '@/engine/git';
import { DIVERGED_MESSAGE, type RootGitRefusal } from '@/engine/roots';

const { invokeSpy } = vi.hoisted(() => ({ invokeSpy: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeSpy }));
const { openSpy } = vi.hoisted(() => ({ openSpy: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openSpy }));

import { initialRootsState, useRootsStore } from '@/stores/rootsStore';
import { useUiStore } from '@/stores/uiStore';
import { pickDirectory, rootGitFetch, rootGitPulse, rootGitRemoteStatus } from './rootsIpc';

const TAURI = '__TAURI_INTERNALS__';

beforeEach(() => {
  (window as unknown as Record<string, unknown>)[TAURI] = {};
  useRootsStore.setState(initialRootsState());
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  invokeSpy.mockReset();
  openSpy.mockReset();
  delete (window as unknown as Record<string, unknown>)[TAURI];
});

function remote(status: RemoteResult['status'], message = ''): RemoteResult {
  return { status, message, updatedFiles: [], conflictFiles: [] };
}

/** Which commands one sync asked the backend for, in order. */
function asked(): string[] {
  return invokeSpy.mock.calls.map(([cmd]) => cmd as string);
}

/**
 * Inside Tauri a root git command's `Err` arrives as a rejection (M53.2). A
 * `RootGitRefusal` is a value the caller reads; any other rejection is a
 * transport failure, and storing it as a refusal would hide it from the toast
 * the store keeps for exactly that.
 */
describe('root git IPC inside Tauri', () => {
  it('resolves a refusal-shaped rejection as the value', async () => {
    const refusal: RootGitRefusal = {
      code: 'no_git_capability',
      message: 'notes is not a git repository',
    };
    invokeSpy.mockRejectedValueOnce(refusal);

    await expect(rootGitRemoteStatus('root-1')).resolves.toEqual(refusal);
    expect(invokeSpy).toHaveBeenCalledWith('root_git_remote_status', { rootId: 'root-1' });
  });

  it('rethrows a rejection that is not a refusal', async () => {
    invokeSpy.mockRejectedValueOnce('Command root_git_fetch not found');
    await expect(rootGitFetch('root-1')).rejects.toBe('Command root_git_fetch not found');

    // Half a refusal is not one either.
    invokeSpy.mockRejectedValueOnce({ code: 'git_error' });
    await expect(rootGitFetch('root-1')).rejects.toEqual({ code: 'git_error' });
  });

  it('passes a success through untouched', async () => {
    invokeSpy.mockResolvedValueOnce({ tracked: true, commits: [] });
    await expect(rootGitPulse('root-1')).resolves.toEqual({ tracked: true, commits: [] });
  });

  it('a transport failure reaches the store toast and is stored as nothing', async () => {
    const failure = 'invalid args `rootId` for command `root_git_remote_status`';
    invokeSpy.mockRejectedValue(failure);

    await useRootsStore.getState().loadGitStatus('root-1');

    expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
      `Could not read git status: ${failure}`,
    ]);
    expect(useRootsStore.getState().gitRefusals['root-1']).toBeUndefined();
    expect(useRootsStore.getState().gitStatus['root-1']).toBeUndefined();

    // The last sync's answer goes with it: the toast says what happened now.
    useRootsStore.setState({ gitSync: { 'root-1': remote('auth_error') } });
    await expect(useRootsStore.getState().syncRoot('root-1')).resolves.toBeNull();
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
      `Could not sync: ${failure}`,
    );
    expect(useRootsStore.getState().gitSync['root-1']).toBeUndefined();
  });

  it('a refusal is stored as a value and never toasted', async () => {
    const refusal: RootGitRefusal = {
      code: 'parent_repo',
      message: 'this root sits inside a larger repository',
    };
    invokeSpy.mockRejectedValueOnce(refusal);

    await expect(useRootsStore.getState().syncRoot('root-1')).resolves.toEqual(refusal);

    expect(useRootsStore.getState().gitSync['root-1']).toEqual(refusal);
    expect(useUiStore.getState().toasts).toEqual([]);
  });
});

/**
 * What a sync ASKS for is only visible here, at the invoke seam: the mock
 * backend answers a diverged pull with the same `rejected` the store gives
 * without asking, so a mock-backed test cannot tell the two apart.
 */
describe('root sync asks only what it must', () => {
  it('a failed fetch is the whole answer: no status read, no pull, no toast', async () => {
    const hint =
      'Git could not authenticate with the remote. Check your credential helper or SSH key.';
    invokeSpy.mockResolvedValueOnce(remote('auth_error', hint));

    await expect(useRootsStore.getState().syncRoot('root-1')).resolves.toEqual(
      remote('auth_error', hint),
    );

    expect(asked()).toEqual(['root_git_fetch']);
    expect(useRootsStore.getState().gitSync['root-1']).toEqual(remote('auth_error', hint));
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  it('a diverged root is never pulled, and is answered as the pull would be', async () => {
    invokeSpy.mockImplementation((cmd: string) => {
      if (cmd === 'root_git_fetch') return Promise.resolve(remote('updated', 'Fetched'));
      if (cmd === 'root_git_remote_status') {
        return Promise.resolve({
          branch: 'main',
          ahead: 1,
          behind: 1,
          hasRemote: true,
          hasUpstream: true,
          upstream: 'origin/main',
        });
      }
      if (cmd === 'root_git_modified_files') return Promise.resolve([]);
      return Promise.reject(`unexpected ${cmd}`);
    });

    await useRootsStore.getState().syncRoot('root-1');

    expect(asked()).not.toContain('root_git_pull_ff');
    expect(useRootsStore.getState().gitSync['root-1']).toEqual(
      remote('rejected', DIVERGED_MESSAGE),
    );
  });
});

/**
 * Workspace → Mount's folder picker, bound in the adapter (M53.20). The
 * browser has none, so there a pick reads as a cancel instead of rejecting
 * with nobody to catch it.
 */
describe('pickDirectory', () => {
  it('opens the native folder picker inside Tauri', async () => {
    openSpy.mockResolvedValueOnce('/repos/brain');
    await expect(pickDirectory()).resolves.toBe('/repos/brain');
    expect(openSpy).toHaveBeenCalledWith({ directory: true, multiple: false });
  });

  it('reads a cancelled picker as null', async () => {
    openSpy.mockResolvedValueOnce(null);
    await expect(pickDirectory()).resolves.toBeNull();
  });

  it('resolves null in the browser without reaching for the plugin', async () => {
    delete (window as unknown as Record<string, unknown>)[TAURI];
    await expect(pickDirectory()).resolves.toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });
});
