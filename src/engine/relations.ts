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
import { resolveTarget } from './wikilink';

/** targetPath → field name → entries pointing at it through that field. */
export type RelationIndex = Map<string, Map<string, Entry[]>>;

export function buildRelationIndex(entries: Entry[]): RelationIndex {
  const index: RelationIndex = new Map();
  for (const source of entries) {
    for (const [field, targets] of Object.entries(source.relationships)) {
      for (const raw of targets) {
        const target = resolveTarget(raw, entries);
        if (target === null) continue;
        let byField = index.get(target.path);
        if (byField === undefined) {
          byField = new Map();
          index.set(target.path, byField);
        }
        const bucket = byField.get(field);
        if (bucket === undefined) byField.set(field, [source]);
        else if (!bucket.includes(source)) bucket.push(source);
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
 * The records a rollup aggregates over. Forward form is `relation: <field>`;
 * reverse form is `from: { type, field }` — which is what lets a parent roll
 * up children that point at IT, with no duplicate link on the parent.
 */
export function rollupSpec(def: FieldDef): ChildrenSpec | null {
  if (def.from !== undefined && def.from.type !== '' && def.from.field !== '') {
    return { direction: 'reverse', type: def.from.type, field: def.from.field };
  }
  if (def.relation !== undefined && def.relation !== '') {
    return { direction: 'forward', field: def.relation };
  }
  return null;
}
