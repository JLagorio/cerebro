import type { Entry, FieldDef, FieldKind, FieldOption, Group, Schema } from './types';

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
  if (kind === 'status') {
    const space = entries.length > 0 ? schema.spaceForEntry(entries[0]) : null;
    known = schema.statusSetForSpace(space !== null ? space.path : null);
  } else if (def?.options !== undefined && def.options.length > 0) {
    known = def.options;
  }

  // Map preserves insertion order → ghost groups keep first-seen order.
  const buckets = new Map<string, Entry[]>();
  const ungrouped: Entry[] = [];
  for (const e of entries) {
    const raw =
      e.relationships[field] !== undefined ? e.relationships[field] : e.properties[field];
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
