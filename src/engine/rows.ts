import { groupTree } from './grouping';
import { childrenAt } from './relations';
import { nestLevels } from './types';
import type { Entry, GroupNode, GroupSpec, Schema } from './types';

/**
 * The one row model every record view renders from (M10).
 *
 * M9.7 unified grouping and hierarchy into a single chain — a level bands by a
 * property value or descends a relation. But only TreeView ever walked the
 * descents, so "the view that can nest" was still its own view kind while a
 * Table could not nest at all. That is backwards: nesting is a property of the
 * chain, not a kind of view.
 *
 * This module closes it. It flattens a chain of BOTH level kinds into one
 * ordered row list, so Table, List, and Gantt render hierarchy by consuming
 * this rather than each re-implementing a graph walk — which is also why
 * `TreeView` could be deleted instead of ported three times.
 *
 * Bands apply first, in chain order; nesting then happens INSIDE each band
 * leaf. That is the only composition that reads as a sentence: "in-progress
 * work, nested under the objective it serves". The reverse — bands recomputed
 * at every depth of a descent — describes nothing anyone asked for.
 */

/** Relation graphs can contain cycles (A → B → A); depth alone must bound the walk. */
export const MAX_ROW_DEPTH = 6;

/** A group header. `node.count` is recursive, so a collapsed band still says
 * how much is inside it. */
export interface BandRow {
  kind: 'band';
  node: GroupNode;
  depth: number;
  key: string;
}

export interface EntryRow {
  kind: 'row';
  entry: Entry;
  /** Nesting depth inside its band — 0 for a record at the top of the run. */
  depth: number;
  childCount: number;
  key: string;
}

/**
 * The create-record affordance at the end of a run. It is part of the row model
 * rather than something each view appends, because *where* it goes and *what it
 * inherits* are both facts about the grouping: a new record typed into the
 * "At risk" band is an at-risk record.
 */
export interface AddRow {
  kind: 'add';
  /** The band to inherit from; null in an ungrouped run. */
  band: { field: string; key: string; label: string } | null;
  depth: number;
  key: string;
}

export type RenderRow = BandRow | EntryRow | AddRow;

export interface BuildRowsArgs {
  /** Already filtered and sorted — this module never reorders. */
  entries: Entry[];
  group: GroupSpec[];
  schema: Schema;
  /**
   * Emit an AddRow after each visible run. Off by default: a calendar or board
   * places creation on its own geometry and would have to filter these out.
   */
  addRows?: boolean;
  /**
   * The whole vault. Children are resolved wherever they live, not only among
   * the rows the source selected — a filter of "my open work" should still be
   * able to nest under an objective that the filter itself excluded.
   */
  allEntries?: Entry[];
  /** Collapse predicate over `RenderRow.key`. */
  isCollapsed?: (key: string) => boolean;
}

const expanded = () => false;

/**
 * Band and row keys are namespaced (`band:` / `row:`) because one collapse map
 * per surface holds both, and a band path and a row path are otherwise the
 * same shape of string.
 */
export function buildRows({
  entries,
  group,
  schema,
  addRows = false,
  allEntries = entries,
  isCollapsed = expanded,
}: BuildRowsArgs): RenderRow[] {
  const nesting = nestLevels(group);
  const out: RenderRow[] = [];

  const emitRows = (run: Entry[], prefix: string) => {
    const walk = (list: Entry[], depth: number, keyPrefix: string, seen: Set<string>) => {
      for (const entry of list) {
        const key = `row:${keyPrefix}/${entry.path}`;
        // Each depth follows its OWN level of the chain, which is what lets
        // consecutive levels be different types: Objective → Key result →
        // Work item. Re-running level 0 at every depth (the pre-M9.1 bug)
        // makes anything past the first hop invisible.
        const kids =
          depth >= MAX_ROW_DEPTH || seen.has(entry.path)
            ? []
            : childrenAt(entry, nesting, depth, allEntries, schema.relations);
        out.push({ kind: 'row', entry, depth, childCount: kids.length, key });
        if (kids.length > 0 && !isCollapsed(key)) {
          walk(kids, depth + 1, key, new Set([...seen, entry.path]));
        }
      }
    };
    walk(run, 0, prefix, new Set());
  };

  const bands = groupTree(entries, group, schema);
  // No band levels — or nothing to band, because grouping an empty list yields
  // no bands and a canvas with no headers at all reads as broken rather than
  // as empty.
  if (bands.length === 0) {
    emitRows(entries, '');
    if (addRows) out.push({ kind: 'add', band: null, depth: 0, key: 'add:' });
    return out;
  }

  const walkBands = (nodes: GroupNode[]) => {
    for (const node of nodes) {
      const key = `band:${node.path}`;
      out.push({ kind: 'band', node, depth: node.depth, key });
      if (isCollapsed(key)) continue;
      if (node.children.length > 0) {
        walkBands(node.children);
        continue;
      }
      emitRows(node.entries, node.path);
      if (addRows) {
        out.push({
          kind: 'add',
          band: { field: node.field, key: node.key, label: node.label },
          depth: node.depth + 1,
          key: `add:${node.path}`,
        });
      }
    }
  };
  walkBands(bands);
  return out;
}

/** Just the record rows, in render order — what keyboard navigation counts. */
export function entryRows(rows: RenderRow[]): EntryRow[] {
  return rows.filter((r): r is EntryRow => r.kind === 'row');
}

/** True when the chain nests, i.e. some level descends a relation. */
export function hasNesting(group: GroupSpec[]): boolean {
  return nestLevels(group).length > 0;
}
