/**
 * Editor groups — the side-by-side pane model (M30.24).
 *
 * A workspace holds one or more GROUPS laid left to right. Each group owns its
 * own tab strip and shows exactly one of its tabs. Exactly one group has focus,
 * and that group's active tab is the file the rest of the app calls "open".
 *
 * This is the shape every real editor converged on, and the reason is that the
 * alternative — one tab list plus a "second pane" flag — cannot answer "which
 * tab does closing this one fall back to" once two panes exist.
 *
 * Pure functions over a plain value, so the whole model is testable without a
 * store, a component or a DOM. `rootsStore` holds one `Layout` and delegates.
 *
 * INVARIANTS, maintained by every exported function:
 *   1. There is always at least one group. An empty workspace still needs
 *      somewhere for the next file to open into.
 *   2. No group is empty unless it is the only group.
 *   3. Every group's `active` is one of its own tabs, or null when it has none.
 *   4. `activeGroupId` names a group that exists.
 */

/** One open file. Keyed by root AND path: two repos may both hold a README. */
export interface OpenTab {
  rootId: string;
  path: string;
}

/** One editor group: a tab strip and the pane below it. */
export interface EditorGroup {
  id: string;
  /** Left to right, in the order they were opened or dragged. */
  tabs: OpenTab[];
  /** The tab this group is showing. Null only while the group is empty. */
  active: OpenTab | null;
}

export interface Layout {
  /** Left to right. Never empty. */
  groups: EditorGroup[];
  activeGroupId: string;
  /** Monotonic. Ids are never recycled, so a stale key cannot match a new group. */
  seq: number;
}

export const sameTab = (a: OpenTab, b: OpenTab): boolean =>
  a.rootId === b.rootId && a.path === b.path;

/** A stable React key / DOM id for a tab. */
export const tabKey = (t: OpenTab): string => `${t.rootId}/${t.path}`;

export const emptyLayout = (): Layout => ({
  groups: [{ id: 'g1', tabs: [], active: null }],
  activeGroupId: 'g1',
  seq: 1,
});

const indexOfGroup = (layout: Layout, id: string): number =>
  layout.groups.findIndex((g) => g.id === id);

export const groupById = (layout: Layout, id: string): EditorGroup | null =>
  layout.groups.find((g) => g.id === id) ?? null;

/** The focused group's active tab — what the rest of the app calls "open". */
export const activeTab = (layout: Layout): OpenTab | null =>
  groupById(layout, layout.activeGroupId)?.active ?? null;

/** Every tab in every group, for callers that do not care about panes. */
export const allTabs = (layout: Layout): OpenTab[] => layout.groups.flatMap((g) => g.tabs);

/**
 * Restore invariants 1-4 after an edit, focusing `preferIndex` if the focused
 * group was one of the ones that went away.
 *
 * Passed the index rather than the id on purpose: the group being repaired is
 * usually the one that just disappeared, so its id no longer resolves and only
 * its old POSITION says which neighbour should inherit focus.
 */
function repair(layout: Layout, preferIndex?: number): Layout {
  let groups = layout.groups.filter((g) => g.tabs.length > 0);

  // Invariant 1: never zero groups.
  if (groups.length === 0) {
    const survivor = layout.groups[0];
    groups = [{ id: survivor?.id ?? `g${layout.seq}`, tabs: [], active: null }];
  }

  // Invariant 3: a group shows one of its own tabs.
  groups = groups.map((g) => {
    const current = g.active;
    if (current !== null && g.tabs.some((t) => sameTab(t, current))) return g;
    return { ...g, active: g.tabs[g.tabs.length - 1] ?? null };
  });

  // Invariant 4: focus names a group that exists. When the focused group was
  // dropped, focus falls LEFT — the same direction closing a tab falls.
  let activeGroupId = layout.activeGroupId;
  if (!groups.some((g) => g.id === activeGroupId)) {
    const at =
      preferIndex === undefined ? 0 : Math.max(0, Math.min(preferIndex, groups.length - 1));
    activeGroupId = groups[at]?.id ?? groups[0]?.id ?? activeGroupId;
  }

  return { groups, activeGroupId, seq: layout.seq };
}

/**
 * Open (or focus) a file in a group, and focus that group.
 *
 * Re-opening an already-open file FOCUSES its tab rather than appending a
 * duplicate — clicking the same README twice is one tab, which is the
 * behaviour every editor has trained the hand for.
 */
export function openInGroup(layout: Layout, tab: OpenTab, groupId?: string): Layout {
  const target = groupId ?? layout.activeGroupId;
  if (groupById(layout, target) === null) return layout;
  const groups = layout.groups.map((g) => {
    if (g.id !== target) return g;
    const already = g.tabs.some((t) => sameTab(t, tab));
    return { ...g, tabs: already ? g.tabs : [...g.tabs, tab], active: tab };
  });
  return repair({ ...layout, groups, activeGroupId: target });
}

/**
 * Close one tab in one group.
 *
 * Focus falls to the LEFT neighbour: closing the tab you are reading should
 * land you on the one you were reading before it, not at the far end of the
 * strip. A group that runs empty is removed, unless it is the last one.
 */
export function closeInGroup(layout: Layout, tab: OpenTab, groupId?: string): Layout {
  const target = groupId ?? layout.activeGroupId;
  const at = indexOfGroup(layout, target);
  if (at === -1) return layout;

  const groups = layout.groups.map((g) => {
    if (g.id !== target) return g;
    const index = g.tabs.findIndex((t) => sameTab(t, tab));
    if (index === -1) return g;
    const tabs = g.tabs.filter((t) => !sameTab(t, tab));
    const wasActive = g.active !== null && sameTab(g.active, tab);
    if (!wasActive) return { ...g, tabs };
    return { ...g, tabs, active: tabs[index - 1] ?? tabs[0] ?? null };
  });

  return repair({ ...layout, groups }, at - 1);
}

/** Close every tab in a group except this one. */
export function closeOthersInGroup(layout: Layout, tab: OpenTab, groupId?: string): Layout {
  const target = groupId ?? layout.activeGroupId;
  const groups = layout.groups.map((g) =>
    g.id === target ? { ...g, tabs: g.tabs.filter((t) => sameTab(t, tab)), active: tab } : g,
  );
  return repair({ ...layout, groups, activeGroupId: target });
}

/** Close a whole group and everything in it. */
export function closeGroup(layout: Layout, groupId: string): Layout {
  const at = indexOfGroup(layout, groupId);
  if (at === -1) return layout;
  const groups = layout.groups.filter((g) => g.id !== groupId);
  if (groups.length === 0) return emptyLayoutKeeping(layout);
  return repair({ ...layout, groups }, at - 1);
}

/** One empty group, but carrying the sequence forward so ids stay unique. */
function emptyLayoutKeeping(layout: Layout): Layout {
  const seq = layout.seq + 1;
  const id = `g${seq}`;
  return { groups: [{ id, tabs: [], active: null }], activeGroupId: id, seq };
}

export const MAX_GROUPS = 4;

/**
 * Split: open a tab in a NEW group immediately to the right of its own.
 *
 * The file stays open in the source group too — that is what makes a split
 * useful for comparing a file against itself, and it is what every editor does.
 *
 * Capped at `MAX_GROUPS`. Panes divide the same pixels, and a fifth column of
 * a 1200px window is narrower than a line of code; refusing is kinder than
 * rendering something unusable.
 */
export function splitGroup(layout: Layout, tab?: OpenTab, groupId?: string): Layout {
  const sourceId = groupId ?? layout.activeGroupId;
  const at = indexOfGroup(layout, sourceId);
  if (at === -1 || layout.groups.length >= MAX_GROUPS) return layout;
  const moving = tab ?? layout.groups[at]?.active ?? null;
  if (moving === null) return layout;

  const seq = layout.seq + 1;
  const id = `g${seq}`;
  const groups = [...layout.groups];
  groups.splice(at + 1, 0, { id, tabs: [moving], active: moving });
  return { groups, activeGroupId: id, seq };
}

/**
 * Focus a group by id. Unknown ids are ignored rather than clearing focus.
 *
 * Focusing the group that ALREADY has focus returns the very same layout, not
 * an equal one. Panes call this on every pointer-down to follow the click, and
 * a fresh object there re-rendered the pane between `mousedown` and `mouseup` —
 * which replaced the node under the pointer, so no `click` was ever produced
 * and links inside a document silently stopped working.
 */
export function focusGroup(layout: Layout, groupId: string): Layout {
  if (layout.activeGroupId === groupId) return layout;
  return groupById(layout, groupId) === null ? layout : { ...layout, activeGroupId: groupId };
}

/** Focus the nth group, 0-based. Out of range is a no-op, as in VS Code. */
export function focusGroupAt(layout: Layout, index: number): Layout {
  const group = layout.groups[index];
  if (group === undefined || group.id === layout.activeGroupId) return layout;
  return { ...layout, activeGroupId: group.id };
}

/**
 * Move a tab within its strip, or into another group.
 *
 * `toIndex` is an index into the destination's tab list AFTER the tab has been
 * taken out of it — the coordinate a drop indicator naturally produces, and the
 * only one that behaves the same whether the tab is arriving or just shifting.
 */
export function moveTab(
  layout: Layout,
  tab: OpenTab,
  fromGroupId: string,
  toGroupId: string,
  toIndex: number,
): Layout {
  const from = groupById(layout, fromGroupId);
  const to = groupById(layout, toGroupId);
  if (from === null || to === null) return layout;
  if (!from.tabs.some((t) => sameTab(t, tab))) return layout;

  const fromAt = indexOfGroup(layout, fromGroupId);
  const removedIndex = from.tabs.findIndex((t) => sameTab(t, tab));

  const groups = layout.groups.map((g) => {
    if (g.id === fromGroupId && g.id === toGroupId) {
      const rest = g.tabs.filter((t) => !sameTab(t, tab));
      const index = Math.max(0, Math.min(toIndex, rest.length));
      rest.splice(index, 0, tab);
      return { ...g, tabs: rest, active: tab };
    }
    if (g.id === fromGroupId) {
      const tabs = g.tabs.filter((t) => !sameTab(t, tab));
      const wasActive = g.active !== null && sameTab(g.active, tab);
      return wasActive
        ? { ...g, tabs, active: tabs[removedIndex - 1] ?? tabs[0] ?? null }
        : { ...g, tabs };
    }
    if (g.id === toGroupId) {
      const rest = g.tabs.filter((t) => !sameTab(t, tab));
      const index = Math.max(0, Math.min(toIndex, rest.length));
      rest.splice(index, 0, tab);
      return { ...g, tabs: rest, active: tab };
    }
    return g;
  });

  return repair({ ...layout, groups, activeGroupId: toGroupId }, fromAt - 1);
}

/**
 * Forget every tab belonging to a root, for when it is unmounted.
 *
 * A tab that cannot resolve its root would render a not-found placeholder for
 * the rest of the session.
 */
export function dropRoot(layout: Layout, rootId: string): Layout {
  const groups = layout.groups.map((g) => ({
    ...g,
    tabs: g.tabs.filter((t) => t.rootId !== rootId),
  }));
  return repair({ ...layout, groups });
}

/** Step the focused group's active tab by `delta`, wrapping at both ends. */
export function cycleTab(layout: Layout, delta: number): Layout {
  const group = groupById(layout, layout.activeGroupId);
  if (group === null || group.tabs.length === 0 || group.active === null) return layout;
  const at = group.tabs.findIndex((t) => sameTab(t, group.active as OpenTab));
  const count = group.tabs.length;
  const next = group.tabs[(((at + delta) % count) + count) % count];
  if (next === undefined) return layout;
  const groups = layout.groups.map((g) => (g.id === group.id ? { ...g, active: next } : g));
  return { ...layout, groups };
}
