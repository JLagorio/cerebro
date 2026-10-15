import type { Selection } from './types';
import { readSelection, restorablePlace } from './placeResolves';
import { claimOf, MAX_PANES, type PaneLayout } from './panes';

export interface StoredPane {
  /** The current visit in entries, never a runtime pane id. */
  index: number;
  entries: Selection[];
}
export interface StoredLayout {
  v: 1;
  active: number;
  panes: StoredPane[];
}
export const PANE_HISTORY_LIMIT = 30;
/** Stored lenses are explicit so adding a Selection kind requires deciding
 * which parts describe a place at the next launch. Thread/run highlights and
 * the Inbox's local row selection belong only to the current session. */
const STORED_FIELDS = {
  home: [],
  inbox: [],
  mywork: [],
  changes: [],
  pulse: [],
  settings: [],
  doc: ['path', 'tab'],
  diagram: ['path'],
  file: ['path'],
  collection: ['folder'],
  type: ['name', 'view'],
  list: ['id', 'view', 'collection'],
  knowledge: ['nav', 'path'],
  library: ['tab', 'path'],
  workspace: ['root', 'path'],
  studio: ['project'],
  agents: ['actor'],
} satisfies Record<Selection['kind'], readonly string[]>;
const object = (raw: unknown): raw is Record<string, unknown> =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw);
export function isStoredSelection(raw: unknown): raw is Selection {
  const selection = readSelection(raw);
  if (selection === null || !object(raw)) return false;
  const fields: readonly string[] = STORED_FIELDS[selection.kind];
  if (!Object.keys(raw).every((key) => key === 'kind' || fields.includes(key))) return false;
  return (
    selection.kind !== 'knowledge' ||
    selection.nav?.tab !== 'runs' ||
    selection.nav.run === undefined
  );
}
function readLayout(raw: unknown): StoredLayout | null {
  if (
    !object(raw) ||
    raw.v !== 1 ||
    !Number.isInteger(raw.active) ||
    !Array.isArray(raw.panes) ||
    raw.panes.length === 0
  )
    return null;
  if ((raw.active as number) < 0 || (raw.active as number) >= raw.panes.length) return null;
  const panes: StoredPane[] = [];
  for (const pane of raw.panes) {
    if (
      !object(pane) ||
      !Array.isArray(pane.entries) ||
      pane.entries.length === 0 ||
      !Number.isInteger(pane.index) ||
      (pane.index as number) < 0 ||
      (pane.index as number) >= pane.entries.length ||
      !pane.entries.every(isStoredSelection)
    )
      return null;
    panes.push({
      index: pane.index as number,
      entries: pane.entries.map((entry) => restorablePlace(readSelection(entry)!)),
    });
  }
  return { v: 1, active: raw.active as number, panes };
}
export function readStoredLayouts(raw: string | null): Record<string, StoredLayout> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    if (!object(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([vault, value]) => {
        const layout = readLayout(value);
        return layout === null ? [] : [[vault, layout]];
      }),
    );
  } catch {
    return {};
  }
}
function windowStart(length: number, current: number, limit: number): number {
  return Math.max(0, Math.min(current - Math.floor(limit / 2), length - limit));
}
export function toStored(layout: PaneLayout): StoredLayout {
  return {
    v: 1,
    active: layout.panes.findIndex((pane) => pane.id === layout.active),
    panes: layout.panes.map((pane) => {
      const start = windowStart(pane.history.length, pane.historyIndex, PANE_HISTORY_LIMIT);
      return {
        index: pane.historyIndex - start,
        entries: pane.history
          .slice(start, start + PANE_HISTORY_LIMIT)
          .map((slot) => restorablePlace(slot.selection)),
      };
    }),
  };
}
/** Drop missing visits before picking the current one. Earlier panes keep a
 * file claim; a later pane steps back to a free visit, or disappears. */
export function pruneLayout(
  saved: StoredLayout,
  resolves: (selection: Selection) => boolean,
): StoredLayout | null {
  let rows = saved.panes.flatMap((pane, source) => {
    const live = pane.entries.flatMap((selection, index) =>
      resolves(selection) ? [{ selection, index }] : [],
    );
    if (!live.length) return [];
    const before = live.filter((entry) => entry.index <= pane.index).length;
    return [
      { source, index: Math.max(0, before - 1), entries: live.map((entry) => entry.selection) },
    ];
  });
  if (!rows.length) return null;
  const near = (sources: number[]) => {
    const exact = sources.indexOf(saved.active);
    if (exact >= 0) return exact;
    const before = sources.filter((source) => source < saved.active).length;
    return Math.max(0, before - 1);
  };
  const start = windowStart(rows.length, near(rows.map((row) => row.source)), MAX_PANES);
  rows = rows.slice(start, start + MAX_PANES);
  const held = new Set<string>();
  rows = rows.flatMap((row) => {
    let index = row.index;
    while (index >= 0) {
      const claim = claimOf(row.entries[index]);
      if (claim === null || !held.has(claim)) {
        if (claim !== null) held.add(claim);
        const start = windowStart(row.entries.length, index, PANE_HISTORY_LIMIT);
        return [
          {
            ...row,
            index: index - start,
            entries: row.entries.slice(start, start + PANE_HISTORY_LIMIT),
          },
        ];
      }
      index--;
    }
    return [];
  });
  if (!rows.length) return null;
  return {
    v: 1,
    active: near(rows.map((row) => row.source)),
    panes: rows.map(({ index, entries }) => ({ index, entries })),
  };
}
