// IPC facade: every vault operation in the app goes through these functions.
// Inside Tauri (detected via __TAURI_INTERNALS__) they invoke the Rust
// commands; in the browser (pnpm dev, vitest, Playwright) they delegate to
// the in-memory mock in mockIpc.ts. Signatures follow the plan's IPC table.
import type { Entry } from '@/engine/types';
import * as mock from './mockIpc';

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function pickVault(): Promise<string | null> {
  return inTauri() ? invokeTauri('pick_vault') : mock.pickVault();
}

/**
 * Copy the demo vault out of the app bundle into a folder the user can edit,
 * and return its path. In the browser the mock vault is already that folder.
 */
export function openDemoVault(): Promise<string> {
  return inTauri() ? invokeTauri('open_demo_vault') : mock.openDemoVault();
}

export function getLastVault(): Promise<string | null> {
  return inTauri() ? invokeTauri('get_last_vault') : mock.getLastVault();
}

export function scanVault(vault: string): Promise<Entry[]> {
  return inTauri() ? invokeTauri('scan_vault', { vault }) : mock.scanVault(vault);
}

export function readNote(vault: string, path: string): Promise<string> {
  return inTauri() ? invokeTauri('read_note', { vault, path }) : mock.readNote(vault, path);
}

export function saveNote(vault: string, path: string, body: string): Promise<void> {
  return inTauri()
    ? invokeTauri('save_note', { vault, path, body })
    : mock.saveNote(vault, path, body);
}

export function updateFrontmatter(
  vault: string,
  path: string,
  patch: Record<string, unknown>,
): Promise<void> {
  return inTauri()
    ? invokeTauri('update_frontmatter', { vault, path, patch })
    : mock.updateFrontmatter(vault, path, patch);
}

/**
 * Record a human verification on a knowledge concept (M5). Separate from
 * updateFrontmatter because that path REFUSES writes under `knowledge/` —
 * the bundle is the agent's to write and yours to verify. Both backends
 * scope this command to the `verified` key.
 */
export function verifyConcept(
  vault: string,
  path: string,
  patch: Record<string, unknown>,
): Promise<void> {
  return inTauri()
    ? invokeTauri('verify_concept', { vault, path, patch })
    : mock.verifyConcept(vault, path, patch);
}

export function createNote(
  vault: string,
  folder: string,
  slug: string,
  frontmatter: Record<string, unknown>,
  body: string,
): Promise<string> {
  return inTauri()
    ? invokeTauri('create_note', { vault, folder, slug, frontmatter, body })
    : mock.createNote(vault, folder, slug, frontmatter, body);
}

export function setNoteTitle(vault: string, path: string, title: string): Promise<void> {
  return inTauri()
    ? invokeTauri('set_note_title', { vault, path, title })
    : mock.setNoteTitle(vault, path, title);
}

export interface RawList {
  id: string;
  yaml: string;
  project: string | null;
  /** Owning Collection's folder; null for a top-level List (M10). */
  collection: string | null;
  /** Vault-relative file path — what rename and delete operate on. */
  path: string;
}

/** Every List in the vault, in all three on-disk shapes (see vault/write.rs). */
export function listViews(vault: string): Promise<RawList[]> {
  return inTauri() ? invokeTauri('list_views', { vault }) : mock.listViews(vault);
}

/** folder scopes the view to a project dir (writes <folder>/views/<id>.yml).
 * Legacy shape — new Lists go through saveList. */
export function saveView(
  vault: string,
  id: string,
  yaml: string,
  folder: string | null = null,
): Promise<void> {
  return inTauri()
    ? invokeTauri('save_view', { vault, id, yaml, folder })
    : mock.saveView(vault, id, yaml, folder);
}

// --- Collections (M10) -----------------------------------------------------

/** Every Collection: each folder holding a `collection.yml`. */
export function listCollections(
  vault: string,
): Promise<{ folder: string; yaml: string }[]> {
  return inTauri() ? invokeTauri('list_collections', { vault }) : mock.listCollections(vault);
}

/** Write `<folder>/collection.yml`, creating the folder. */
export function saveCollection(vault: string, folder: string, yaml: string): Promise<void> {
  return inTauri()
    ? invokeTauri('save_collection', { vault, folder, yaml })
    : mock.saveCollection(vault, folder, yaml);
}

/** Write `<folder>/<id>.list.yml`; folder '' means the vault root. */
export function saveList(
  vault: string,
  folder: string,
  id: string,
  yaml: string,
): Promise<void> {
  return inTauri()
    ? invokeTauri('save_list', { vault, folder, id, yaml })
    : mock.saveList(vault, folder, id, yaml);
}

export function startWatcher(vault: string): Promise<void> {
  return inTauri() ? invokeTauri('start_watcher', { vault }) : mock.startWatcher(vault);
}

// --- Connectors (M13.3) ----------------------------------------------------

/** Raw `.cerebro/connectors.json`, '' when the vault has none. */
export function readConnectors(vault: string): Promise<string> {
  return inTauri() ? invokeTauri('read_connectors', { vault }) : mock.readConnectors(vault);
}

export function saveConnectors(vault: string, json: string): Promise<void> {
  return inTauri()
    ? invokeTauri('save_connectors', { vault, json })
    : mock.saveConnectors(vault, json);
}

// --- Vault format v2 file operations (M2 Task 3) ---

export function createFolder(vault: string, path: string): Promise<void> {
  return inTauri()
    ? invokeTauri('create_folder', { vault, path })
    : mock.createFolder(vault, path);
}

/** Move a note or folder within the vault. Fails if the target exists. */
export function renameNote(vault: string, from: string, to: string): Promise<void> {
  return inTauri()
    ? invokeTauri('rename_note', { vault, from, to })
    : mock.renameNote(vault, from, to);
}

/** Move a note or folder to the OS trash (never a hard delete). */
export function deleteNote(vault: string, path: string): Promise<void> {
  return inTauri() ? invokeTauri('delete_note', { vault, path }) : mock.deleteNote(vault, path);
}

/** All vault directories (for folder trees, including empty folders). */
export function listFolders(vault: string): Promise<string[]> {
  return inTauri() ? invokeTauri('list_folders', { vault }) : mock.listFolders(vault);
}
