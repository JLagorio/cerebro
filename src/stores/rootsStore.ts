import { create } from 'zustand';
import * as groups from '@/engine/editorGroups';
import type { EditorGroup, Layout, OpenTab } from '@/engine/editorGroups';
import type { GitRemoteStatus } from '@/engine/git';
import type { DirEntry, MountRefusal, Root, RootGitRefusal } from '@/engine/roots';
import { isRootGitRefusal } from '@/engine/roots';
import * as ipc from '@/lib/rootsIpc';
import { useUiStore } from './uiStore';

export type { EditorGroup, Layout, OpenTab };
export { sameTab, tabKey } from '@/engine/editorGroups';

/** Cache key for a directory within a root. */
const nodeKey = (rootId: string, path: string): string => `${rootId} ${path}`;

interface RootsState {
  roots: Root[];
  /** nodeKey → expanded. */
  expanded: Record<string, boolean>;
  /** nodeKey → its listing, once fetched. */
  children: Record<string, DirEntry[]>;
  /** Editor groups, left to right. See engine/editorGroups.ts. */
  layout: Layout;
  /** rootId → its git status, once loaded. */
  gitStatus: Record<string, GitRemoteStatus>;
  /**
   * rootId → the typed refusal its last git read returned.
   *
   * Refusals are VALUES here, not errors: `no_git_capability` is the ordinary
   * answer for a mounted folder that is not a repository, and toasting it
   * would be an error message on every non-repo root at startup. This is the
   * proposal-channel exemption AGENTS.md carves out, same as `mount`.
   */
  gitRefusals: Record<string, RootGitRefusal>;
  /** rootId → how many files are dirty, once loaded. */
  gitDirty: Record<string, number>;

  loadRoots(): Promise<void>;
  /** Read one root's git status. Never throws; refusals are stored, not thrown. */
  loadGitStatus(rootId: string): Promise<void>;
  /** Resolves to the refusal to be RENDERED, or null on success. Never throws. */
  mount(path: string): Promise<MountRefusal | null>;
  unmount(rootId: string): Promise<void>;
  toggle(rootId: string, path: string): Promise<void>;
  /**
   * Expand every directory above `path` and ask the tree to scroll to it.
   *
   * The counter is the signal, not the path: revealing the SAME file twice has
   * to scroll twice, and a path-valued field would compare equal the second
   * time and do nothing.
   */
  reveal(rootId: string, path: string): Promise<void>;
  revealSeq: number;
  /** The row the last reveal asked for, or null. */
  revealing: OpenTab | null;
  /** Focus a file, opening a tab for it if one is not already open. */
  openFile(rootId: string, path: string, groupId?: string): void;
  closeTab(tab: OpenTab, groupId?: string): void;
  closeOtherTabs(tab: OpenTab, groupId?: string): void;
  closeGroup(groupId: string): void;
  focusGroup(groupId: string): void;
  focusGroupAt(index: number): void;
  splitEditor(tab?: OpenTab, groupId?: string): void;
  moveTab(tab: OpenTab, fromGroupId: string, toGroupId: string, toIndex: number): void;
  /** Drop a tab on a pane's edge: it MOVES into a new pane on that side. */
  splitWithTab(
    tab: OpenTab,
    fromGroupId: string,
    targetGroupId: string,
    side: 'left' | 'right',
  ): void;
  cycleTab(delta: number): void;
}

/**
 * The focused file. A SELECTOR rather than a stored field: `layout` already
 * knows, and a second copy would be one more thing to keep in step with it.
 * The reference it returns is the one held in the layout, so subscribing to it
 * does not re-render on unrelated changes.
 */
export const selectActiveTab = (s: RootsState): OpenTab | null => groups.activeTab(s.layout);

/**
 * The state a fresh workspace starts in.
 *
 * Exported because tests need to get back to it between cases, and spelling it
 * out at each of those call sites is how one of them ends up forgetting a
 * field and leaking a tab into the next test.
 */
export const initialRootsState = (): Pick<
  RootsState,
  | 'roots'
  | 'expanded'
  | 'children'
  | 'layout'
  | 'revealSeq'
  | 'revealing'
  | 'gitStatus'
  | 'gitRefusals'
  | 'gitDirty'
> => ({
  roots: [],
  expanded: {},
  children: {},
  layout: groups.emptyLayout(),
  revealSeq: 0,
  revealing: null,
  gitStatus: {},
  gitRefusals: {},
  gitDirty: {},
});

export const useRootsStore = create<RootsState>((set, get) => ({
  ...initialRootsState(),

  async loadRoots() {
    set({ roots: await ipc.listRoots() });
  },

  /**
   * A refusal is stored and rendered; only a TRANSPORT failure (invoke itself
   * rejecting with something that is not a refusal) follows the human-UI
   * rule of catch/toast/null. Mixing those two up in either direction is a
   * review-blocking defect per AGENTS.md.
   */
  async loadGitStatus(rootId) {
    let result: GitRemoteStatus | RootGitRefusal;
    try {
      result = await ipc.rootGitRemoteStatus(rootId);
    } catch (err) {
      useUiStore.getState().toast(`Could not read git status: ${String(err)}`);
      return;
    }
    if (isRootGitRefusal(result)) {
      const { [rootId]: _drop, ...status } = get().gitStatus;
      set({ gitStatus: status, gitRefusals: { ...get().gitRefusals, [rootId]: result } });
      return;
    }
    // Success clears any stale refusal: capability is re-probed live on the
    // Rust side, so a folder that became a repo must stop rendering
    // yesterday's answer.
    const { [rootId]: _stale, ...refusals } = get().gitRefusals;
    set({ gitStatus: { ...get().gitStatus, [rootId]: result }, gitRefusals: refusals });

    // The dirty count is a second read; a refusal here is not worth
    // overwriting a status we already have, so it only ever adds a count.
    const dirty = await ipc.rootGitModifiedFiles(rootId).catch(() => null);
    if (dirty !== null && !isRootGitRefusal(dirty)) {
      set({ gitDirty: { ...get().gitDirty, [rootId]: dirty.length } });
    }
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
      layout: groups.dropRoot(get().layout, rootId),
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

  async reveal(rootId, path) {
    // The root itself, then each directory above the file, outermost first —
    // a child listing cannot be fetched before its parent has been.
    const segments = path.split('/').slice(0, -1);
    const ancestors = [''];
    for (const segment of segments) {
      ancestors.push(
        ancestors[ancestors.length - 1] === ''
          ? segment
          : `${ancestors[ancestors.length - 1]}/${segment}`,
      );
    }
    for (const dir of ancestors) {
      if (get().expanded[nodeKey(rootId, dir)] !== true) await get().toggle(rootId, dir);
    }
    set({ revealSeq: get().revealSeq + 1, revealing: { rootId, path } });
  },

  openFile(rootId, path, groupId) {
    set({ layout: groups.openInGroup(get().layout, { rootId, path }, groupId) });
  },

  closeTab(tab, groupId) {
    set({ layout: groups.closeInGroup(get().layout, tab, groupId) });
  },

  closeOtherTabs(tab, groupId) {
    set({ layout: groups.closeOthersInGroup(get().layout, tab, groupId) });
  },

  closeGroup(groupId) {
    set({ layout: groups.closeGroup(get().layout, groupId) });
  },

  focusGroup(groupId) {
    set({ layout: groups.focusGroup(get().layout, groupId) });
  },

  focusGroupAt(index) {
    set({ layout: groups.focusGroupAt(get().layout, index) });
  },

  splitEditor(tab, groupId) {
    set({ layout: groups.splitGroup(get().layout, tab, groupId) });
  },

  moveTab(tab, fromGroupId, toGroupId, toIndex) {
    set({ layout: groups.moveTab(get().layout, tab, fromGroupId, toGroupId, toIndex) });
  },

  splitWithTab(tab, fromGroupId, targetGroupId, side) {
    set({ layout: groups.splitWithTab(get().layout, tab, fromGroupId, targetGroupId, side) });
  },

  cycleTab(delta) {
    set({ layout: groups.cycleTab(get().layout, delta) });
  },
}));
