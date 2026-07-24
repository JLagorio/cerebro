import { create } from 'zustand';
import { buildSchema } from '@/engine/schema';
import type { Entry, Scalar, Schema, ViewFile } from '@/engine/types';
import { parseViewYaml } from '@/engine/views';
import * as ipc from '@/lib/ipc';
import { extractWikilinks } from '@/lib/mockParse';

export interface VaultState {
  vaultPath: string | null;
  entries: Entry[];
  views: ViewFile[];
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
  status: 'idle',
  error: null,

  async openVault(path) {
    set({ vaultPath: path, status: 'scanning', error: null });
    try {
      const entries = await ipc.scanVault(path);
      const views = (await ipc.listViews(path)).map((v) => parseViewYaml(v.id, v.yaml));
      await ipc.startWatcher(path);
      if (inTauri() && !watcherBound) {
        watcherBound = true;
        const { listen } = await import('@tauri-apps/api/event');
        await listen('vault-changed', () => {
          void get().rescan();
        });
      }
      set({ entries, views, status: 'ready' });
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  },

  async rescan() {
    const vault = get().vaultPath;
    if (vault === null) return;
    const entries = await ipc.scanVault(vault);
    const views = (await ipc.listViews(vault)).map((v) => parseViewYaml(v.id, v.yaml));
    set({ entries, views, status: 'ready' });
  },

  async patchFrontmatter(path, patch) {
    const vault = get().vaultPath;
    if (vault === null) return;
    // Optimistic: local state updates synchronously, before the disk write.
    set({ entries: get().entries.map((e) => (e.path === path ? applyPatch(e, patch) : e)) });
    try {
      await ipc.updateFrontmatter(vault, path, patch);
      // In Tauri the watcher's vault-changed event reconciles; the mock has
      // no watcher, so reconcile on write completion.
      if (!inTauri()) await get().rescan();
    } catch {
      await get().rescan(); // disk truth wins: revert the optimistic update
    }
  },

  async createItem({ folder, slug, frontmatter, body = '' }) {
    const vault = get().vaultPath;
    if (vault === null) throw new Error('No vault open');
    const path = await ipc.createNote(vault, folder, slug, frontmatter, body);
    if (!inTauri()) await get().rescan();
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
