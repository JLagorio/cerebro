/**
 * Relation resolution in both directions (M3.5).
 *
 * Links live on one side of a pair: an Objective may list its key results, or
 * each Key result may point at its objective. Rollups and hierarchy views need
 * "the children of X" regardless of which side holds the link, so everything
 * goes through `childrenOf` here rather than reading `entry.relationships`
 * directly. Reverse lookups use a prebuilt index — without one, a tree of N
 * rows would rescan every entry per row.
 */

import type { ChildrenSpec, Entry, FieldDef } from './types';
import { resolveTarget, targetIndexFor } from './wikilink';

/** targetPath → field name → entries pointing at it through that field. */
export type RelationIndex = Map<string, Map<string, Entry[]>>;

/**
 * Built in one pass over the vault, resolving through the shared target index
 * (M60.9), so it costs O(links) rather than a vault scan per link.
 */
export function buildRelationIndex(entries: readonly Entry[]): RelationIndex {
  const targets = targetIndexFor(entries);
  const index: RelationIndex = new Map();
  for (const source of entries) {
    for (const [field, raws] of Object.entries(source.relationships)) {
      for (const raw of raws) {
        const target = targets.resolveLink(raw)?.entry;
        if (target === undefined) continue;
        let byField = index.get(target.path);
        if (byField === undefined) {
          byField = new Map();
          index.set(target.path, byField);
        }
        const bucket = byField.get(field);
        // Sources arrive in entry order and a field's targets consecutively,
        // so a repeat of this source can only be the last one pushed.
        if (bucket === undefined) byField.set(field, [source]);
        else if (bucket[bucket.length - 1] !== source) bucket.push(source);
      }
    }
  }
  return index;
}

/** Records that hang off `entry` under `spec`, in vault order. */
export function childrenOf(
  entry: Entry,
  spec: ChildrenSpec,
  entries: Entry[],
  index?: RelationIndex,
): Entry[] {
  if (spec.direction === 'forward') {
    return (entry.relationships[spec.field] ?? [])
      .map((raw) => resolveTarget(raw, entries))
      .filter((e): e is Entry => e !== null);
  }
  const byField = index?.get(entry.path);
  if (byField !== undefined) {
    return (byField.get(spec.field) ?? []).filter((e) => e.type === spec.type);
  }
  // No index (tests, one-off calls): fall back to a scan.
  return entries.filter(
    (e) =>
      e.type === spec.type &&
      (e.relationships[spec.field] ?? []).some((raw) => resolveTarget(raw, entries) === entry),
  );
}

/**
 * Children at one level of a hierarchy chain (M9.1). Returns [] past the end
 * of the chain, which is what terminates the descent.
 *
 * The one-spec `childrenOf` above was applied at EVERY depth by the tree
 * view, so `Objective → Key result` worked and `Key result → Work item`
 * could never render: depth 1 re-ran the depth-0 spec. A chain gives each
 * level its own relation, which is the whole point of a hierarchy whose
 * levels are different types.
 */
export function childrenAt(
  entry: Entry,
  hierarchy: ChildrenSpec[],
  depth: number,
  entries: Entry[],
  index?: RelationIndex,
): Entry[] {
  const spec = hierarchy[depth];
  if (spec === undefined) return [];
  return childrenOf(entry, spec, entries, index);
}

/**
 * The relation records a rollup aggregates over; cached mail has no ChildrenSpec. Forward form is `relation: <field>`;
 * reverse form is `from: { type, field }` — which is what lets a parent roll
 * up children that point at IT, with no duplicate link on the parent.
 */
export function rollupSpec(def: FieldDef): ChildrenSpec | null {
  if (def.source === 'correspondence') return null;
  if (def.from !== undefined && def.from.type !== '' && def.from.field !== '') {
    return { direction: 'reverse', type: def.from.type, field: def.from.field };
  }
  if (def.relation !== undefined && def.relation !== '') {
    return { direction: 'forward', field: def.relation };
  }
  return null;
}
