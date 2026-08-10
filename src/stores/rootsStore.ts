import { create } from 'zustand';
import type { DirEntry, IndexedDoc, MountRefusal, Root } from '@/engine/roots';
import * as ipc from '@/lib/rootsIpc';

/** Cache key for a directory within a root. */
const nodeKey = (rootId: string, path: string): string => `${rootId} ${path}`;

/** One open editor tab. */
export interface OpenTab {
  rootId: string;
  path: string;
}

export const sameTab = (a: OpenTab, b: OpenTab): boolean =>
  a.rootId === b.rootId && a.path === b.path;

interface RootsState {
  roots: Root[];
  /** nodeKey → expanded. */
  expanded: Record<string, boolean>;
  /** nodeKey → its listing, once fetched. */
  children: Record<string, DirEntry[]>;
  /** The focused tab, or null when nothing is open. */
  open: OpenTab | null;
  /** Every open tab, in the order they were opened. */
  tabs: OpenTab[];
  docs: IndexedDoc[];

  loadRoots(): Promise<void>;
  /** Resolves to the refusal to be RENDERED, or null on success. Never throws. */
  mount(path: string): Promise<MountRefusal | null>;
  unmount(rootId: string): Promise<void>;
  toggle(rootId: string, path: string): Promise<void>;
  /** Focus a file, opening a tab for it if one is not already open. */
  openFile(rootId: string, path: string): void;
  closeTab(tab: OpenTab): void;
  closeOtherTabs(tab: OpenTab): void;
  loadDocs(): Promise<void>;
}

export const useRootsStore = create<RootsState>((set, get) => ({
  roots: [],
  expanded: {},
  children: {},
  open: null,
  tabs: [],
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
    // Tabs belonging to the departed root go with it: a tab that cannot resolve
    // its root would render a not-found placeholder forever.
    const tabs = get().tabs.filter((t) => t.rootId !== rootId);
    const open = get().open;
    set({
      roots: get().roots.filter((r) => r.id !== rootId),
      tabs,
      open: open === null || open.rootId === rootId ? (tabs[tabs.length - 1] ?? null) : open,
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

  /**
   * Focus a file, opening a tab if one is not already open.
   *
   * Re-opening an already-open file FOCUSES its tab rather than appending a
   * duplicate — clicking the same README twice in the tree is one tab, which
   * is the behaviour every editor has trained the hand for.
   */
  openFile(rootId, path) {
    const tab = { rootId, path };
    const already = get().tabs.some((t) => sameTab(t, tab));
    set({ open: tab, tabs: already ? get().tabs : [...get().tabs, tab] });
  },

  /**
   * Close a tab. When it was the focused one, focus its LEFT neighbour —
   * closing the tab you are reading should land you on the one you were
   * reading before it, not at the far end of the strip.
   */
  closeTab(tab) {
    const tabs = get().tabs;
    const index = tabs.findIndex((t) => sameTab(t, tab));
    if (index === -1) return;
    const remaining = tabs.filter((t) => !sameTab(t, tab));
    const wasFocused = get().open !== null && sameTab(get().open as OpenTab, tab);
    if (!wasFocused) {
      set({ tabs: remaining });
      return;
    }
    const next = remaining[index - 1] ?? remaining[0] ?? null;
    set({ tabs: remaining, open: next });
  },

  closeOtherTabs(tab) {
    set({ tabs: get().tabs.filter((t) => sameTab(t, tab)), open: tab });
  },

  async loadDocs() {
    const all = await Promise.all(get().roots.map((r) => ipc.indexRootMarkdown(r.id)));
    set({ docs: all.flat() });
  },
}));
