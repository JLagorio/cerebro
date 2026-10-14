// IPC facade for mounted roots (M30). Same shape as ipc.ts: inside Tauri these
// invoke the Rust commands; in the browser, vitest and Playwright they delegate
// to the in-memory mock. pickDirectory is the exception: the dialog plugin's
// folder picker, which the browser does not have.
import type {
  GitRemoteStatus,
  GitWorkspaceInfo,
  ModifiedFile,
  RemoteResult,
  VaultPulse,
} from '@/engine/git';
import type { DirEntry, FileText, MountRefusal, Root, RootGitRefusal } from '@/engine/roots';
import { isRootGitRefusal } from '@/engine/roots';
import * as mock from './mockRoots';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function listRoots(): Promise<Root[]> {
  return inTauri() ? invokeTauri('list_roots') : mock.listRoots();
}

/**
 * Mount a directory. Resolves to a `Root` OR a typed `MountRefusal` — the
 * caller is expected to READ the result, not toast it away. A
 * `knowledge_root_exists` refusal is a card the user has to see.
 */
export async function mountRoot(path: string): Promise<Root | MountRefusal> {
  if (!inTauri()) return mock.mountRoot(path);
  try {
    return await invokeTauri<Root>('mount_root', { path });
  } catch (err) {
    // Tauri rejects with the serialized MountRefusal payload.
    return err as MountRefusal;
  }
}

/**
 * The native folder picker that chooses what to mount; null when cancelled.
 * The browser has no picker, so there it resolves null, the same answer as a
 * cancel.
 */
export async function pickDirectory(): Promise<string | null> {
  if (!inTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === 'string' ? picked : null;
}

export function unmountRoot(rootId: string): Promise<void> {
  return inTauri() ? invokeTauri('unmount_root', { rootId }) : mock.unmountRoot(rootId);
}

export function listDir(rootId: string, path: string): Promise<DirEntry[]> {
  return inTauri() ? invokeTauri('list_dir', { rootId, path }) : mock.listDir(rootId, path);
}

export function readFileText(rootId: string, path: string): Promise<FileText> {
  return inTauri()
    ? invokeTauri('read_file_text', { rootId, path })
    : mock.readFileText(rootId, path);
}

/**
 * Root-scoped git (M32.9). Each call resolves to its value OR a typed
 * `RootGitRefusal` — same contract as `mountRoot`: the caller READS the
 * result. Tauri rejects with the serialized refusal, so a refusal-shaped
 * rejection is the refusal arm. Anything else is a transport failure (an
 * unregistered command, arguments that do not deserialize) and is rethrown,
 * for the store's catch to toast rather than to store as a refusal it is not.
 */
async function invokeRootGit<T>(
  cmd: string,
  args: Record<string, unknown>,
  fallback: () => Promise<T | RootGitRefusal>,
): Promise<T | RootGitRefusal> {
  if (!inTauri()) return fallback();
  try {
    return await invokeTauri<T>(cmd, args);
  } catch (err) {
    if (isRootGitRefusal(err)) return err;
    throw err;
  }
}

export function rootGitWorkspaceInfo(rootId: string): Promise<GitWorkspaceInfo | RootGitRefusal> {
  return invokeRootGit('root_git_workspace_info', { rootId }, () =>
    mock.rootGitWorkspaceInfo(rootId),
  );
}

export function rootGitRemoteStatus(rootId: string): Promise<GitRemoteStatus | RootGitRefusal> {
  return invokeRootGit('root_git_remote_status', { rootId }, () =>
    mock.rootGitRemoteStatus(rootId),
  );
}

export function rootGitModifiedFiles(rootId: string): Promise<ModifiedFile[] | RootGitRefusal> {
  return invokeRootGit('root_git_modified_files', { rootId }, () =>
    mock.rootGitModifiedFiles(rootId),
  );
}

export function rootGitPulse(rootId: string): Promise<VaultPulse | RootGitRefusal> {
  return invokeRootGit('root_git_pulse', { rootId }, () => mock.rootGitPulse(rootId));
}

export function rootGitFileUrl(
  rootId: string,
  path: string,
): Promise<string | null | RootGitRefusal> {
  return invokeRootGit('root_git_file_url', { rootId, path }, () =>
    mock.rootGitFileUrl(rootId, path),
  );
}

/**
 * The two mutations (M32.11). They go through the SYNC gate on the Rust side,
 * which additionally refuses a root nested inside a larger repository
 * (`parent_repo`). The outcome is a value the caller renders.
 */
export function rootGitFetch(rootId: string): Promise<RemoteResult | RootGitRefusal> {
  return invokeRootGit('root_git_fetch', { rootId }, () => mock.rootGitFetch(rootId));
}

export function rootGitPullFf(rootId: string): Promise<RemoteResult | RootGitRefusal> {
  return invokeRootGit('root_git_pull_ff', { rootId }, () => mock.rootGitPullFf(rootId));
}
