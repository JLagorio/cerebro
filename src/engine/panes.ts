import type { Selection } from './types';
import { stepLive } from './navHistory';
import { destination, isDestinationKind } from './destinations';
import { deepEqual } from '@/lib/deepEqual';

export const MAX_PANES = 4;
export type PaneId = `p${number}`;
export type EntryStateKey = 'view.search' | 'view.controls' | 'canvas.scroll' | 'pages.browser';
export interface NavSlot {
  selection: Selection;
  byAgent: boolean;
  state?: Partial<Record<EntryStateKey, unknown>>;
}
export interface Pane {
  id: PaneId;
  selection: Selection;
  history: NavSlot[];
  historyIndex: number;
  navSeq: number;
}
export interface PaneLayout {
  panes: Pane[];
  active: PaneId;
  /** Most recently focused first. Every open pane occurs exactly once. */
  focusOrder: PaneId[];
  seq: number;
}
export interface NavOutcome {
  kind: 'navigated' | 'opened' | 'reused' | 'full' | 'unchanged';
  pane: PaneId;
}
export interface PaneMove {
  layout: PaneLayout;
  outcome: NavOutcome;
}
export interface PaneNavigation {
  replace?: boolean;
  byAgent?: boolean;
}

/** A lens changes the visit, never the file it edits. Collection pages use
 * the folder-note carrier; an inferred root collection has no editor. */
export const CLAIM_RULES = {
  home: 'none',
  pages: 'none',
  inbox: 'single',
  mywork: 'none',
  changes: 'none',
  pulse: 'none',
  settings: 'none',
  doc: 'path',
  diagram: 'path',
  file: 'path',
  knowledge: 'path',
  library: 'path',
  collection: 'folder-note',
  list: 'none',
  type: 'none',
  workspace: 'single',
  studio: 'none',
  agents: 'none',
} satisfies Record<Selection['kind'], 'none' | 'single' | 'path' | 'folder-note'>;
export function claimOf(selection: Selection): string | null {
  switch (CLAIM_RULES[selection.kind]) {
    case 'none':
      return null;
    case 'single':
      return isDestinationKind(selection.kind) && destination(selection.kind).single
        ? `place:${selection.kind}`
        : null;
    case 'path':
      return 'path' in selection && selection.path ? selection.path : null;
    case 'folder-note':
      return selection.kind === 'collection' && selection.folder
        ? `${selection.folder}/${selection.folder.split('/').at(-1)}.md`
        : null;
  }
}
export const sameSelection = (a: Selection, b: Selection): boolean => deepEqual(a, b);
export const cleanSelection = (selection: Selection): Selection =>
  Object.fromEntries(
    Object.entries(selection).filter(([, value]) => value !== undefined),
  ) as Selection;
export function makePane(
  id: PaneId,
  selection: Selection = { kind: 'home' },
  byAgent = false,
): Pane {
  return { id, selection, history: [{ selection, byAgent }], historyIndex: 0, navSeq: 0 };
}
export function emptyPanes(seq = 0): PaneLayout {
  const id: PaneId = `p${seq + 1}`;
  return { panes: [makePane(id)], active: id, focusOrder: [id], seq: seq + 1 };
}
export const paneById = (layout: PaneLayout, id: PaneId): Pane | undefined =>
  layout.panes.find((pane) => pane.id === id);
export function holderOf(
  layout: PaneLayout,
  selection: Selection,
  except?: PaneId,
): Pane | undefined {
  const claim = claimOf(selection);
  return claim === null
    ? undefined
    : layout.panes.find((pane) => pane.id !== except && claimOf(pane.selection) === claim);
}
export function focusPane(layout: PaneLayout, id: PaneId): PaneLayout {
  if (!paneById(layout, id) || layout.active === id) return layout;
  return {
    ...layout,
    active: id,
    focusOrder: [id, ...layout.focusOrder.filter((pane) => pane !== id)],
  };
}
const replacePane = (layout: PaneLayout, pane: Pane): PaneLayout => ({
  ...layout,
  panes: layout.panes.map((old) => (old.id === pane.id ? pane : old)),
});
function visit(pane: Pane, selection: Selection, options: PaneNavigation): Pane {
  if (!options.replace && sameSelection(pane.selection, selection)) return pane;
  const byAgent =
    options.byAgent === true ||
    (options.replace === true && pane.history[pane.historyIndex]?.byAgent === true);
  const slot: NavSlot = { selection, byAgent };
  const history = options.replace
    ? pane.history.map((old, index) => (index === pane.historyIndex ? slot : old))
    : [...pane.history.slice(0, pane.historyIndex + 1), slot];
  return {
    ...pane,
    selection,
    history,
    historyIndex: options.replace ? pane.historyIndex : history.length - 1,
    navSeq: pane.navSeq + 1,
  };
}
/** A forwarding selection must not remain as a Back trap when its replace
 * resolves to a file already held elsewhere. Keep its other visits intact. */
function dropForwarder(layout: PaneLayout, pane: Pane): Pane {
  const history = pane.history.filter((_, index) => index !== pane.historyIndex);
  let index = Math.min(pane.historyIndex - 1, history.length - 1);
  while (index >= 0 && holderOf(layout, history[index].selection, pane.id)) index--;
  if (index < 0) index = history.findIndex((slot) => !holderOf(layout, slot.selection, pane.id));
  if (index < 0) return { ...makePane(pane.id), navSeq: pane.navSeq + 1 };
  return {
    ...pane,
    history,
    historyIndex: index,
    selection: history[index].selection,
    navSeq: pane.navSeq + 1,
  };
}
export function navigatePane(
  layout: PaneLayout,
  from: PaneId,
  raw: Selection,
  options: PaneNavigation = {},
): PaneMove {
  const source = paneById(layout, from);
  if (!source) return { layout, outcome: { kind: 'unchanged', pane: layout.active } };
  const selection = cleanSelection(raw);
  const holder = holderOf(layout, selection, from);
  if (holder) {
    let next = options.replace ? replacePane(layout, dropForwarder(layout, source)) : layout;
    // A reused file gets the requested lens as a new visit, never replacing
    // the holder's own history because the source happened to be a forwarder.
    next = replacePane(next, visit(holder, selection, { byAgent: options.byAgent }));
    return { layout: focusPane(next, holder.id), outcome: { kind: 'reused', pane: holder.id } };
  }
  const next = visit(source, selection, options);
  return {
    layout: focusPane(next === source ? layout : replacePane(layout, next), from),
    outcome: { kind: next === source ? 'unchanged' : 'navigated', pane: from },
  };
}
export function openPane(
  layout: PaneLayout,
  from: PaneId,
  raw: Selection,
  capacity = MAX_PANES,
  options: PaneNavigation = {},
): PaneMove {
  if (!paneById(layout, from))
    return { layout, outcome: { kind: 'unchanged', pane: layout.active } };
  const selection = cleanSelection(raw);
  const held = holderOf(layout, selection);
  if (held) {
    const moved = navigatePane(layout, held.id, selection, { byAgent: options.byAgent });
    return { ...moved, outcome: { kind: 'reused', pane: held.id } };
  }
  if (layout.panes.length >= Math.max(1, Math.min(MAX_PANES, capacity))) {
    const moved = navigatePane(layout, from, selection, options);
    return { ...moved, outcome: { kind: 'full', pane: moved.outcome.pane } };
  }
  const id: PaneId = `p${layout.seq + 1}`;
  const panes = [...layout.panes];
  const at = Math.max(
    0,
    panes.findIndex((pane) => pane.id === from),
  );
  panes.splice(at + 1, 0, makePane(id, selection, options.byAgent));
  return {
    layout: { panes, active: id, focusOrder: [id, ...layout.focusOrder], seq: layout.seq + 1 },
    outcome: { kind: 'opened', pane: id },
  };
}
export function closePane(layout: PaneLayout, id: PaneId): PaneLayout {
  const at = layout.panes.findIndex((pane) => pane.id === id);
  if (at < 0) return layout;
  if (layout.panes.length === 1)
    return { ...layout, panes: [{ ...makePane(id), navSeq: layout.panes[0].navSeq + 1 }] };
  const panes = layout.panes.filter((pane) => pane.id !== id);
  const active = layout.active === id ? panes[Math.max(0, at - 1)].id : layout.active;
  return {
    ...layout,
    panes,
    active,
    focusOrder: [active, ...layout.focusOrder.filter((pane) => pane !== id && pane !== active)],
  };
}
export function stepPane(
  layout: PaneLayout,
  id: PaneId,
  direction: -1 | 1,
  isLive: (selection: Selection) => boolean = () => true,
): PaneMove {
  const pane = paneById(layout, id);
  if (!pane) return { layout, outcome: { kind: 'unchanged', pane: layout.active } };
  const stepped = stepLive(
    pane.history,
    pane.historyIndex,
    direction,
    (slot) => isLive(slot.selection),
    (a, b) => sameSelection(a.selection, b.selection),
    (slot) => holderOf(layout, slot.selection, id) !== undefined,
  );
  let next: Pane;
  if (!stepped.slots.length) next = { ...makePane(id), navSeq: pane.navSeq + 1 };
  else {
    const selection = stepped.slots[stepped.index].selection;
    // If the current entry itself died, a nearest survivor may be held. Home
    // is always unclaimed; never acquire someone else's editor as fallback.
    if (holderOf(layout, selection, id))
      next = visit(
        { ...pane, history: stepped.slots, historyIndex: stepped.index, selection },
        { kind: 'home' },
        {},
      );
    else
      next = {
        ...pane,
        history: stepped.slots,
        historyIndex: stepped.index,
        selection,
        navSeq: pane.navSeq + (stepped.moved || !sameSelection(pane.selection, selection) ? 1 : 0),
      };
  }
  return {
    layout: replacePane(layout, next),
    outcome: { kind: next.navSeq === pane.navSeq ? 'unchanged' : 'navigated', pane: id },
  };
}
/** Rewrite one path and its descendants. A folder move carries every visit
 * beneath it, including collection folders and library/knowledge lenses. */
export function remapSelection(selection: Selection, from: string, to: string): Selection {
  const swap = (path: string) =>
    path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
  if ('path' in selection && selection.path !== undefined && selection.kind !== 'workspace')
    return { ...selection, path: swap(selection.path) };
  if (selection.kind === 'collection') return { ...selection, folder: swap(selection.folder) };
  return selection;
}
export function remapPaths(layout: PaneLayout, from: string, to: string): PaneLayout {
  return {
    ...layout,
    panes: layout.panes.map((pane) => ({
      ...pane,
      selection: remapSelection(pane.selection, from, to),
      history: pane.history.map((slot) => ({
        ...slot,
        selection: remapSelection(slot.selection, from, to),
      })),
    })),
  };
}
export function checkLayout(layout: PaneLayout): string[] {
  const errors: string[] = [];
  const ids = layout.panes.map((pane) => pane.id);
  if (!ids.length || ids.length > MAX_PANES) errors.push('pane count');
  if (new Set(ids).size !== ids.length) errors.push('duplicate pane ids');
  if (!ids.includes(layout.active)) errors.push('active pane missing');
  if (
    layout.focusOrder[0] !== layout.active ||
    layout.focusOrder.length !== ids.length ||
    new Set(layout.focusOrder).size !== ids.length ||
    layout.focusOrder.some((id) => !ids.includes(id))
  )
    errors.push('focus order');
  const claims = new Set<string>();
  for (const pane of layout.panes) {
    if (!/^p[1-9][0-9]*$/.test(pane.id) || Number(pane.id.slice(1)) > layout.seq)
      errors.push('pane sequence');
    if (
      !pane.history.length ||
      pane.historyIndex < 0 ||
      pane.historyIndex >= pane.history.length ||
      !Number.isInteger(pane.historyIndex)
    )
      errors.push('history cursor');
    else if (!sameSelection(pane.selection, pane.history[pane.historyIndex].selection))
      errors.push('current selection');
    const claim = claimOf(pane.selection);
    if (claim !== null) {
      if (claims.has(claim)) errors.push('duplicate claim');
      claims.add(claim);
    }
  }
  return errors;
}
