import { create } from 'zustand';
import type { DirEntry, IndexedDoc, MountRefusal, Root } from '@/engine/roots';
import * as ipc from '@/lib/rootsIpc';

/** Cache key for a directory within a root. */
const nodeKey = (rootId: string, path: string): string => `${rootId} ${path}`;

interface RootsState {
  roots: Root[];
  /** nodeKey → expanded. */
  expanded: Record<string, boolean>;
  /** nodeKey → its listing, once fetched. */
  children: Record<string, DirEntry[]>;
  open: { rootId: string; path: string } | null;
  docs: IndexedDoc[];

  loadRoots(): Promise<void>;
  /** Resolves to the refusal to be RENDERED, or null on success. Never throws. */
  mount(path: string): Promise<MountRefusal | null>;
  unmount(rootId: string): Promise<void>;
  toggle(rootId: string, path: string): Promise<void>;
  openFile(rootId: string, path: string): void;
  loadDocs(): Promise<void>;
}

export const useRootsStore = create<RootsState>((set, get) => ({
  roots: [],
  expanded: {},
  children: {},
  open: null,
  docs: [],

  async loadRoots() {
    set({ roots: await ipc.listRoots() });
  },

  /**
   * Mount is a PROPOSAL CHANNEL, not a plain human-UI action: it returns a
   * typed refusal the caller renders as a card. AGENTS.md exempts exactly this
   * shape from the never-throw/toast invariant, because collapsing
   * `knowledge_root_exists` into null throws away the whole point of typing it.
   */
  async mount(path) {
    const result = await ipc.mountRoot(path);
    if ('code' in result) return result;
    set({ roots: [...get().roots, result] });
    return null;
  },

  async unmount(rootId) {
    await ipc.unmountRoot(rootId);
    set({
      roots: get().roots.filter((r) => r.id !== rootId),
      open: get().open?.rootId === rootId ? null : get().open,
      docs: get().docs.filter((d) => d.root !== rootId),
    });
  },

  async toggle(rootId, path) {
    const key = nodeKey(rootId, path);
    if (get().expanded[key] === true) {
      // Keep the cached listing — collapsing is not a reason to re-read disk.
      set({ expanded: { ...get().expanded, [key]: false } });
      return;
    }
    if (get().children[key] === undefined) {
      const listing = await ipc.listDir(rootId, path);
      set({ children: { ...get().children, [key]: listing } });
    }
    set({ expanded: { ...get().expanded, [key]: true } });
  },

  openFile(rootId, path) {
    set({ open: { rootId, path } });
  },

  async loadDocs() {
    const all = await Promise.all(get().roots.map((r) => ipc.indexRootMarkdown(r.id)));
    set({ docs: all.flat() });
  },
}));
