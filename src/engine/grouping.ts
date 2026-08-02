import { bandLevels } from './types';
import type {
  Entry,
  FieldDef,
  FieldKind,
  FieldOption,
  Group,
  GroupNode,
  GroupSpec,
  Schema,
} from './types';

function firstValue(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (Array.isArray(raw)) return raw.length > 0 ? String(raw[0]) : null;
  return String(raw);
}

/**
 * Shared grouping engine for List and Board.
 * - Known option/status groups appear in declared order, empty ones included.
 * - Values outside the declared set become trailing ghost groups (first-seen order).
 * - Entries with no value go to a trailing "No <field>" group.
 * - Entry order within groups preserves the caller's input order (caller sorts first).
 */
export function groupEntries(entries: Entry[], field: string, schema: Schema): Group[] {
  let def: FieldDef | null = null;
  for (const e of entries) {
    const found = schema.resolveField(e, field).def;
    if (found !== null) {
      def = found;
      break;
    }
  }
  const kind: FieldKind = def?.kind ?? 'text';

  let known: FieldOption[] = [];
  if (kind === 'status' && entries.length > 0) {
    known = schema.statusSetFor(entries[0]);
  } else if (def?.options !== undefined && def.options.length > 0) {
    known = def.options;
  }

  // Map preserves insertion order → ghost groups keep first-seen order.
  const buckets = new Map<string, Entry[]>();
  const ungrouped: Entry[] = [];
  for (const e of entries) {
    const raw = e.relationships[field] !== undefined ? e.relationships[field] : e.properties[field];
    const key = firstValue(raw);
    if (key === null) {
      ungrouped.push(e);
      continue;
    }
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [e]);
    else bucket.push(e);
  }

  const groups: Group[] = [];

  if (known.length > 0) {
    for (const option of known) {
      groups.push({
        key: option.id,
        label: option.label,
        color: option.color,
        ghost: false,
        entries: buckets.get(option.id) ?? [],
      });
      buckets.delete(option.id);
    }
    for (const [key, bucket] of buckets) {
      groups.push({ key, label: key, color: null, ghost: true, entries: bucket });
    }
  } else if (kind === 'person' || kind === 'relation') {
    const labelled = [...buckets.entries()].map(([key, bucket]) => ({
      key,
      bucket,
      // resolveField display for the bucket's first entry starts with this key's
      // resolved title (key = first target by construction)
      label: schema.resolveField(bucket[0], field).display.split(', ')[0] || key,
    }));
    labelled.sort((a, b) => a.label.localeCompare(b.label));
    for (const g of labelled) {
      groups.push({ key: g.key, label: g.label, color: null, ghost: false, entries: g.bucket });
    }
  } else {
    const keys = [...buckets.keys()].sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      groups.push({ key, label: key, color: null, ghost: false, entries: buckets.get(key)! });
    }
  }

  if (ungrouped.length > 0) {
    groups.push({
      key: '__none__',
      label: `No ${field}`,
      color: null,
      ghost: false,
      entries: ungrouped,
    });
  }

  return groups;
}

/**
 * Nested grouping (M9.1). Applies the chain of specs level by level: the
 * first partitions the whole list, the second partitions inside each of
 * those, and so on. `groupEntries` is the depth-0 case and every rule it
 * establishes — declared option order, empty declared groups, trailing ghost
 * groups, the pinned `__none__` bucket — applies unchanged at every level.
 *
 * `entries` lands on LEAF nodes only, so a renderer walks to the bottom to
 * find rows. `count` is recursive, so a collapsed parent still reports how
 * much is inside it.
 *
 * An empty chain returns [] — callers treat that as "flat, render `entries`
 * directly" rather than synthesising a single wrapper group.
 */
export function groupTree(
  entries: Entry[],
  group: GroupSpec[],
  schema: Schema,
  depth = 0,
  parentPath = '',
): GroupNode[] {
  // M9.7: only the property levels band. Relation levels nest, which is a
  // different rendering — they are handed to the row walker instead.
  const specs = bandLevels(group);
  const spec = specs[depth];
  if (spec === undefined) return [];

  const flat = groupEntries(entries, spec.field, schema);
  const ordered = spec.dir === 'desc' ? [...flat].reverse() : flat;
  const isLeaf = depth === specs.length - 1;

  const nodes: GroupNode[] = [];
  for (const g of ordered) {
    if (spec.hideEmpty === true && g.entries.length === 0) continue;
    // Path, not key, identifies a node: the same status key appears under
    // every assignee, and a collapse map keyed on `key` alone would toggle
    // all of them together.
    const path = parentPath === '' ? g.key : `${parentPath}/${g.key}`;
    const children = isLeaf ? [] : groupTree(g.entries, specs, schema, depth + 1, path);
    nodes.push({
      ...g,
      depth,
      field: spec.field,
      path,
      children,
      count: g.entries.length,
      // Interior nodes hand their rows to the children; keeping both would
      // let a renderer draw every entry twice.
      entries: isLeaf ? g.entries : [],
    });
  }
  return nodes;
}

/** Depth-first walk of the leaves, in render order. */
export function leafNodes(nodes: GroupNode[]): GroupNode[] {
  const out: GroupNode[] = [];
  const walk = (list: GroupNode[]) => {
    for (const n of list) {
      if (n.children.length === 0) out.push(n);
      else walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
