import { create } from 'zustand';
import { validatePatch } from '@/engine/properties';
import { buildSchema } from '@/engine/schema';
import type { Entry, Scalar, Schema, ViewFile } from '@/engine/types';
import { parseViewYaml } from '@/engine/views';
import * as ipc from '@/lib/ipc';
import { extractWikilinks } from '@/lib/mockParse';
import { useUiStore } from '@/stores/uiStore';

export interface VaultState {
  vaultPath: string | null;
  entries: Entry[];
  views: ViewFile[];
  folders: string[];   // all vault directories incl. empty ones (M2 Task 10 file trees)
  status: 'idle' | 'scanning' | 'ready' | 'error';
  error: string | null;
  openVault(path: string): Promise<void>;
  rescan(): Promise<void>;
  patchFrontmatter(path: string, patch: Record<string, unknown>): Promise<void>;
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

let watcherBound = false;

export const useVaultStore = create<VaultState>()((set, get) => ({
  vaultPath: null,
  entries: [],
  views: [],
  folders: [],
  status: 'idle',
  error: null,

  async openVault(path) {
    set({ vaultPath: path, status: 'scanning', error: null });
    try {
      const entries = await ipc.scanVault(path);
      const views = (await ipc.listViews(path)).map((v) => parseViewYaml(v.id, v.yaml, v.project));
      const folders = await ipc.listFolders(path);
      await ipc.startWatcher(path);
      if (inTauri() && !watcherBound) {
        const { listen } = await import('@tauri-apps/api/event');
        await listen('vault-changed', () => {
          get()
            .rescan()
            .catch((err) => {
              set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
            });
        });
        // Only latch after listen resolves: a failed bind must leave the
        // next openVault free to retry, or the watcher is dead for the whole
        // app lifetime.
        watcherBound = true;
      }
      set({ entries, views, folders, status: 'ready' });
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
    const entries = await ipc.scanVault(vault);
    const views = (await ipc.listViews(vault)).map((v) => parseViewYaml(v.id, v.yaml, v.project));
    const folders = await ipc.listFolders(vault);
    set({ entries, views, folders, status: 'ready' });
  },

  async patchFrontmatter(path, patch) {
    const vault = get().vaultPath;
    if (vault === null) return;
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
        return;
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
    }
  },

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
