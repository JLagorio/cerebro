// IPC facade for mounted roots (M30). Same shape as ipc.ts: inside Tauri these
// invoke the Rust commands; in the browser, vitest and Playwright they delegate
// to the in-memory mock.
import type { GitRemoteStatus, GitWorkspaceInfo, ModifiedFile, PulseCommit } from '@/engine/git';
import type { DirEntry, FileText, MountRefusal, Root, RootGitRefusal } from '@/engine/roots';
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
 * Root-scoped git reads (M32.9). Each resolves to its value OR a typed
 * `RootGitRefusal` — same contract as `mountRoot`: the caller READS the
 * result. Tauri rejects with the serialized refusal, so the catch is the
 * refusal arm, not an error channel.
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
    return err as RootGitRefusal;
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

export function rootGitPulse(rootId: string): Promise<PulseCommit[] | RootGitRefusal> {
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
