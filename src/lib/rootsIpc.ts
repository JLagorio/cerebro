// IPC facade for mounted roots (M30). Same shape as ipc.ts: inside Tauri these
// invoke the Rust commands; in the browser, vitest and Playwright they delegate
// to the in-memory mock.
import type { DirEntry, FileText, MountRefusal, Root } from '@/engine/roots';
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
