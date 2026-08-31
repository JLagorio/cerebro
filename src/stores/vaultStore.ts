import { create } from 'zustand';
import { validatePatch } from '@/engine/properties';
import { buildSchema } from '@/engine/schema';
import { collectionsFromPages, parseCollectionYaml } from '@/engine/collections';
import type { CollectionFile, Entry, Scalar, Schema, ListFile } from '@/engine/types';
import { parseListYaml } from '@/engine/views';
import * as ipc from '@/lib/ipc';
import { extractWikilinks } from '@/lib/mockParse';
import { useUiStore } from '@/stores/uiStore';

export interface VaultState {
  vaultPath: string | null;
  entries: Entry[];
  /** Every List in the vault (M10) — what saved views became. */
  views: ListFile[];
  /** Every Collection: the containers Lists and Docs live in (M10). */
  collections: CollectionFile[];
  folders: string[]; // all vault directories incl. empty ones (M2 Task 10 file trees)
  status: 'idle' | 'scanning' | 'ready' | 'error';
  error: string | null;
  openVault(path: string): Promise<void>;
  rescan(): Promise<void>;
  /**
   * Writes a frontmatter patch, or `false` when it was refused or failed —
   * never throws (store-layer invariant). The boolean exists so an inline
   * editor can keep the text it was given rather than discarding a draft the
   * schema turned away (M20.3); callers with nothing to undo still `void` it.
   */
  patchFrontmatter(path: string, patch: Record<string, unknown>): Promise<boolean>;
  /**
   * Rename a record by rewriting its body's first H1 — which IS its title
   * (M19.3). Returns whether the write landed.
   *
   * Deliberately NOT `renameNote`: that moves the file, and `resolveTarget`
   * matches a wikilink on the filename stem FIRST, so moving the file would
   * dangle every link that names it. This is the same write the detail panel
   * has always made, now reachable from a table cell.
   */
  setTitle(path: string, title: string): Promise<boolean>;
  createItem(args: {
    folder: string;
    slug: string;
    frontmatter: Record<string, unknown>;
    body?: string;
  }): Promise<string>;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Re-derive an entry's properties/relationships from an optimistic patch:
// null deletes the field, values containing [[wikilinks]] become
// relationships, everything else lands in properties. Mirrors the split the
// Rust parser performs on the next scan, so the optimistic entry and the
// rescanned entry agree.
function applyPatch(entry: Entry, patch: Record<string, unknown>): Entry {
  const properties = { ...entry.properties };
  const relationships = { ...entry.relationships };
  for (const [key, value] of Object.entries(patch)) {
    delete properties[key];
    delete relationships[key];
    if (value === null || value === undefined) continue;
    const links = extractWikilinks(value);
    if (links !== null) relationships[key] = links;
    else properties[key] = value as Scalar | Scalar[];
  }
  return { ...entry, properties, relationships, modifiedAt: new Date().toISOString() };
}

/** Read and parse the Lists and Collections in one pass — both surfaces are
 * needed together to build the sidebar tree, so fetching them apart would let
 * the two halves disagree for a frame. */
async function loadCollections(
  vault: string,
  /** Scanned pages, so a Collection declared by its own page is found (M47.5). */
  entries: Entry[],
): Promise<{ views: ListFile[]; collections: CollectionFile[] }> {
  const [rawLists, rawCollections] = await Promise.all([
    ipc.listViews(vault),
    ipc.listCollections(vault),
  ]);
  return {
    views: rawLists.map((v) =>
      parseListYaml(v.id, v.yaml, {
        project: v.project,
        collection: v.collection,
        path: v.path,
      }),
    ),
    // A page wins over a marker for the same folder (M47.5). Both can only
    // coexist mid-conversion, and the page is the form being converted TO —
    // preferring the marker would make a conversion look like it had not
    // happened.
    collections: (() => {
      const fromPages = collectionsFromPages(entries);
      const claimed = new Set(fromPages.map((c) => c.folder));
      const fromYaml = rawCollections
        .map((c) => parseCollectionYaml(c.folder, c.yaml))
        .filter((c) => !claimed.has(c.folder));
      return [...fromPages, ...fromYaml];
    })(),
  };
}

let watcherBound = false;

export const useVaultStore = create<VaultState>()((set, get) => ({
  vaultPath: null,
  entries: [],
  views: [],
  collections: [],
  folders: [],
  status: 'idle',
  error: null,

  async openVault(path) {
    set({ vaultPath: path, status: 'scanning', error: null });
    try {
      const entries = await ipc.scanVault(path);
      const { views, collections } = await loadCollections(path, entries);
      const folders = await ipc.listFolders(path);
      await ipc.startWatcher(path);
      if (inTauri() && !watcherBound) {
        const { listen } = await import('@tauri-apps/api/event');
        await listen('vault-changed', () => {
          // rescan() contains its own failures (toast + keep the last good
          // snapshot, M14.8) — a transient scan error on a watcher event must
          // not flip the whole app into the dead error shell.
          void get().rescan();
        });
        // Only latch after listen resolves: a failed bind must leave the
        // next openVault free to retry, or the watcher is dead for the whole
        // app lifetime.
        watcherBound = true;
      }
      set({ entries, views, collections, folders, status: 'ready' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ status: 'error', error: message });
      // Deviation (Task 23, execution-log note 15a, reported): status:'error'
      // was displayed nowhere — a stale last-vault boot landed in a dead
      // empty shell. Toast the failure so the ToastHost surfaces it; recovery
      // lives in Settings ("Change vault…"), which also shows this error.
      useUiStore.getState().toast(`Couldn't open vault: ${message}`);
    }
  },

  async rescan() {
    const vault = get().vaultPath;
    if (vault === null) return;
    // Store-layer invariant (M14.8): actions never throw. Before this, a
    // scan failure was toasted, swallowed, or an unhandled rejection
    // depending on which of a dozen call sites you arrived through — and a
    // rescan inside another action's catch block could throw OUT of it.
    try {
      const entries = await ipc.scanVault(vault);
      const { views, collections } = await loadCollections(vault, entries);
      const folders = await ipc.listFolders(vault);
      set({ entries, views, collections, folders, status: 'ready' });
    } catch {
      // The store keeps its last good snapshot; disk truth returns on the
      // next successful scan (watcher event, write, or vault reopen).
      useUiStore.getState().toast("Couldn't refresh vault");
    }
  },

  async patchFrontmatter(path, patch) {
    const vault = get().vaultPath;
    if (vault === null) return false;
    // Normalize once for both the optimistic update and the disk write:
    // undefined means delete, but JSON serialization to Tauri drops
    // undefined keys silently and the mock's yaml doc.set would write
    // `key: null` — null is the one delete spelling every backend honors.
    const normalized = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value]),
    );
    // Schema enforcement (M2.x properties engine): declared fields must
    // match their YAML-declared shape or the write never reaches disk.
    const target = get().entries.find((e) => e.path === path);
    if (target !== undefined) {
      const errors = validatePatch(getSchema(get().entries), target, normalized);
      if (errors.length > 0) {
        useUiStore.getState().toast(errors[0]);
        return false;
      }
    }
    // Optimistic: local state updates synchronously, before the disk write.
    set({ entries: get().entries.map((e) => (e.path === path ? applyPatch(e, normalized) : e)) });
    try {
      await ipc.updateFrontmatter(vault, path, normalized);
      // The mock backend has no watcher, so reconcile by rescanning after
      // the write. In Tauri no reconcile pass runs at all — the watcher
      // DISCARDS our own write's event (own-write suppression) — so the
      // optimistic entry stands; that is correct because applyPatch
      // classifies values exactly like the parser will on the next scan.
      if (!inTauri()) await get().rescan();
    } catch {
      // Deviation (Task 17, per execution-log deferred note from Task 11
      // review): surface silent write failures to the user via a toast.
      useUiStore.getState().toast(`Couldn't save changes to ${path}`);
      await get().rescan(); // disk truth wins: revert the optimistic update
      return false;
    }
    return true;
  },

  async setTitle(path, title) {
    const vault = get().vaultPath;
    const target = get().entries.find((e) => e.path === path);
    const trimmed = title.trim();
    // A blank title would leave the record with nothing to be called, and an
    // unchanged one is a write with no content — both are "nothing happened",
    // not failures, so neither toasts.
    if (vault === null || target === undefined || trimmed === '' || trimmed === target.title) {
      return false;
    }
    // Optimistic, like patchFrontmatter: `title` is a top-level Entry field
    // rather than frontmatter, so applyPatch is not involved.
    set({ entries: get().entries.map((e) => (e.path === path ? { ...e, title: trimmed } : e)) });
    try {
      await ipc.setNoteTitle(vault, path, trimmed);
    } catch {
      useUiStore.getState().toast("Couldn't rename record");
      await get().rescan(); // disk truth wins: revert the optimistic update
      return false;
    }
    // Unconditionally, unlike patchFrontmatter's `!inTauri()` guard: a title
    // feeds derived state the optimistic update does not reach — wikilink
    // resolution and the dossiers keyed off it. `rescan` catches and toasts
    // its own failure, so a refresh that fails must not report the rename
    // as failed; it already landed on disk.
    await get().rescan();
    return true;
  },

  // The documented EXCEPTION to the never-throw invariant (M14.8): callers
  // need the created path to navigate, and each of them wants its own
  // context-specific failure message — so failure stays an exception the
  // caller catches, not a null every caller would have to branch on anyway.
  // Every call site awaits inside try/catch; keep it that way.
  async createItem({ folder, slug, frontmatter, body = '' }) {
    const vault = get().vaultPath;
    if (vault === null) throw new Error('No vault open');
    const path = await ipc.createNote(vault, folder, slug, frontmatter, body);
    // Rescan unconditionally: the watcher never reports our own writes (its
    // own-write suppression discards the event), so without this the created
    // note would exist on disk but never enter the store in Tauri. Safe — a
    // create has no optimistic state to clobber.
    await get().rescan();
    return path;
  },
}));

let schemaCache: { entries: Entry[]; schema: Schema } | null = null;

/** Memoized buildSchema: recomputes only when the entries array identity changes. */
export function getSchema(entries: Entry[]): Schema {
  if (schemaCache === null || schemaCache.entries !== entries) {
    schemaCache = { entries, schema: buildSchema(entries) };
  }
  return schemaCache.schema;
}

export function useSchema(): Schema {
  return getSchema(useVaultStore((s) => s.entries));
}

export function useEntry(path: string | null): Entry | null {
  return useVaultStore((s) =>
    path === null ? null : (s.entries.find((e) => e.path === path) ?? null),
  );
}
