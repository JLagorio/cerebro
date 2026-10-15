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
import type { Thumbnail } from '@/engine/thumbs';
import { isRootGitRefusal } from '@/engine/roots';
import * as mock from './mockRoots';
import * as mockBytes from './mockBytes';
import { isFileActionRefusal, type FileActionResult } from '@/engine/fileActions';
import { fileUrlFor, isFileRefusal, type FileProbe, type FileRefusal } from '@/engine/fileBytes';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function desktopFileActions(): boolean {
  return inTauri();
}
export function fileThumbnail(rootId: string, path: string, size: number): Promise<Thumbnail> {
  return inTauri()
    ? invokeTauri('file_thumbnail', { rootId, path, size })
    : mock.fileThumbnail(rootId, path, size);
}
export async function openFileOutside(rootId: string, path: string): Promise<FileActionResult> {
  if (!inTauri()) return mock.fileAction(rootId, path);
  try {
    return await invokeTauri<FileActionResult>('open_file_outside', { rootId, path });
  } catch (error) {
    if (isFileActionRefusal(error)) return error;
    throw error;
  }
}
export async function revealFile(rootId: string, path: string): Promise<FileActionResult> {
  if (!inTauri()) return mock.fileAction(rootId, path);
  try {
    return await invokeTauri<FileActionResult>('reveal_file', { rootId, path });
  } catch (error) {
    if (isFileActionRefusal(error)) return error;
    throw error;
  }
}
export async function quickLookFile(rootId: string, path: string): Promise<FileActionResult> {
  if (!inTauri()) return mock.fileAction(rootId, path);
  try {
    return await invokeTauri<FileActionResult>('quick_look_file', { rootId, path });
  } catch (error) {
    if (isFileActionRefusal(error)) return error;
    throw error;
  }
}
export async function saveFileCopy(rootId: string, path: string): Promise<FileActionResult> {
  if (!inTauri()) return mock.fileAction(rootId, path);
  try {
    return await invokeTauri<FileActionResult>('save_file_copy', { rootId, path });
  } catch (error) {
    if (isFileActionRefusal(error)) return error;
    throw error;
  }
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

export async function probeFile(rootId: string, path: string): Promise<FileProbe | FileRefusal> {
  if (!inTauri()) return mockBytes.probeFile(rootId, path);
  try {
    return await invokeTauri<FileProbe>('probe_file', { rootId, path });
  } catch (error) {
    if (isFileRefusal(error)) return error;
    throw error;
  }
}
export async function readFileBytes(
  rootId: string,
  path: string,
): Promise<Uint8Array | FileRefusal> {
  if (!inTauri()) return mockBytes.readFileBytes(rootId, path);
  try {
    const bytes = await invokeTauri<ArrayBuffer | number[]>('read_file_bytes', { rootId, path });
    return new Uint8Array(bytes);
  } catch (error) {
    if (isFileRefusal(error)) return error;
    throw error;
  }
}
let mediaRevision = 0;
const mediaSession = crypto.randomUUID();
/** A fresh resource identity prevents WebKit reusing another vault's decoded image. */
export async function fileUrl(rootId: string, path: string): Promise<string | FileRefusal> {
  return inTauri()
    ? fileUrlFor(rootId, path, `${mediaSession}-${++mediaRevision}`)
    : mockBytes.fileUrl(rootId, path);
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
