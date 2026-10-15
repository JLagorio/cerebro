import { kindMeta } from './properties';
import {
  bandContext,
  bandEndpoint,
  bandDayOf,
  dateBandFor,
  dateScale,
  dropDateValue,
  isDateKind,
  type BandContext,
} from './dateBuckets';
import { workState } from './myWork';
import { makeDateValue, serializeDateProperty } from './dates';
import { kindFacts } from './fieldKindTable';
import { humanize } from './schema';
import { bandLevels } from './types';
import { formatWikilink } from './wikilink';
import type {
  DateBucketing,
  Entry,
  FieldDef,
  FieldKind,
  FieldOption,
  Group,
  GroupNode,
  GroupSpec,
  Scalar,
  Schema,
} from './types';

/** The trailing "No <field>" bucket's key. */
export const NO_VALUE_KEY = '__none__';

/** Multi kinds come from the shared schema artifact; an undeclared list
 * keeps the memberships the file holds too (M61.1). */
export function bandsEveryValue(def: FieldDef | null, raw: unknown): boolean {
  return def === null ? Array.isArray(raw) : kindFacts(def.kind).multi && def.limit !== 1;
}

export function bandKeysOf(raw: unknown, def: FieldDef | null): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) return [String(raw)];
  const values = bandsEveryValue(def, raw) ? raw : raw.slice(0, 1);
  return [...new Set(values.filter((value) => value != null && value !== '').map(String))];
}

/**
 * Shared grouping engine for List and Board.
 * - Known option/status groups appear in declared order, empty ones included.
 * - Values outside the declared set become trailing ghost groups (first-seen order).
 * - Entries with no value go to a trailing "No <field>" group.
 * - Entry order within groups preserves the caller's input order (caller sorts first).
 */
export function groupEntries(
  entries: Entry[],
  field: string,
  schema: Schema,
  options: {
    dateBucket?: DateBucketing;
    ctx?: BandContext;
    def?: FieldDef | null;
    deadline?: boolean;
  } = {},
): Group[] {
  const def = options.def ?? bandDef(entries, field, schema);
  if (def !== null && isDateKind(def.kind)) {
    return dateGroups(
      entries,
      field,
      schema,
      def,
      options.dateBucket,
      options.ctx ?? bandContext(),
      options.deadline,
    );
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
  const seenPaths = new Set<string>();
  for (const e of entries) {
    if (seenPaths.has(e.path)) continue;
    seenPaths.add(e.path);
    // The value a filter reads too (M60.1), so a derived relation bands by
    // its linking records and a rollup by its result, not by an empty key.
    const keys = bandKeysOf(schema.fieldValue(e, field), schema.resolveField(e, field).def);
    if (keys.length === 0) {
      ungrouped.push(e);
      continue;
    }
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (bucket === undefined) buckets.set(key, [e]);
      else bucket.push(e);
    }
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
      // Resolve this target alone through the schema's ordinary link display.
      // A type-less projection avoids recomputing a derived field's entire
      // list, and titles containing commas remain whole.
      label:
        schema.resolveField({ ...bucket[0], type: null, relationships: { [field]: [key] } }, field)
          .display || key,
    }));
    labelled.sort((a, b) => a.label.localeCompare(b.label));
    for (const g of labelled) {
      groups.push({ key: g.key, label: g.label, color: null, ghost: false, entries: g.bucket });
    }
  } else {
    const keys = [...buckets.keys()].sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      // M20.5: a checkbox band is keyed by `String(true)`, and printing that
      // raw gave two bands labelled "true" and "false" — the stored value, not
      // what the field means. The property's own name carries the meaning, the
      // way a checkbox row in the detail panel does.
      const label =
        kind === 'checkbox'
          ? key === 'true'
            ? humanize(field)
            : `Not ${humanize(field).toLowerCase()}`
          : key;
      groups.push({ key, label, color: null, ghost: false, entries: buckets.get(key)! });
    }
  }

  if (ungrouped.length > 0) {
    // M20.5: `No due_date`, in a UI that calls the column "Due date"
    // everywhere else. A band label is read, so it gets the same humanizing
    // every other label in the app does.
    groups.push({
      key: NO_VALUE_KEY,
      label: `No ${humanize(field).toLowerCase()}`,
      color: null,
      ghost: false,
      entries: ungrouped,
    });
  }

  return groups;
}

/** Date values belong to bounded calendar intervals, never raw-value bands. */
function dateGroups(
  entries: Entry[],
  field: string,
  schema: Schema,
  def: FieldDef,
  unit: DateBucketing | undefined,
  ctx: BandContext,
  deadline?: boolean,
): Group[] {
  const buckets = new Map<string, Group>();
  const ghosts = new Map<string, Group>();
  const absent: Entry[] = [];
  const seen = new Set<string>();
  const hasDeadline =
    deadline ?? entries.some((entry) => bandEndpoint(entry, field, schema) === 'end');
  if (unit === undefined) {
    for (const b of dateScale(def.kind, ctx, hasDeadline)) {
      if (!b.filledOnly)
        buckets.set(b.key, {
          key: b.key,
          label: b.label,
          color: b.color ?? null,
          ghost: false,
          entries: [],
          ...(b.seedable === false ? { seedable: false as const } : {}),
        });
    }
  }
  for (const entry of entries) {
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    const raw = schema.fieldValue(entry, field);
    if (raw == null || raw === '') {
      absent.push(entry);
      continue;
    }
    const endpoint = bandEndpoint(entry, field, schema);
    const day = bandDayOf(raw, endpoint);
    if (day === null) {
      const label = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
      const key = `invalid:${label}`;
      const group = ghosts.get(key) ?? {
        key,
        label,
        color: null,
        ghost: true,
        seedable: false as const,
        entries: [],
      };
      group.entries.push(entry);
      ghosts.set(key, group);
      continue;
    }
    const b = dateBandFor(day, def.kind, unit, ctx, {
      deadline: endpoint === 'end',
      finished: workState(entry, schema) === 'finished',
    });
    const group = buckets.get(b.key) ?? {
      key: b.key,
      label: b.label,
      color: b.color ?? null,
      ghost: false,
      entries: [],
      ...(b.seedable === false ? { seedable: false as const } : {}),
    };
    group.entries.push(entry);
    buckets.set(b.key, group);
  }
  const order =
    unit === undefined
      ? dateScale(def.kind, ctx, hasDeadline).map((b) => b.key)
      : [...buckets.keys()].sort();
  const groups = order.flatMap((key) => (buckets.has(key) ? [buckets.get(key)!] : []));
  groups.push(...ghosts.values());
  if (absent.length > 0)
    groups.push({
      key: NO_VALUE_KEY,
      label: `No ${humanize(field).toLowerCase()}`,
      color: null,
      ghost: false,
      entries: absent,
    });
  return bandWritable(def)
    ? groups
    : groups.map((group) => ({ ...group, seedable: false as const }));
}

/**
 * The kind a band is grouping by.
 *
 * Resolved the way `groupEntries` resolves it — the FIRST entry that declares
 * the field wins — rather than off `entries[0]`, which is what the board did.
 * On a heterogeneous surface (a Collection holds more than one type) the first
 * record is routinely of a type that does not declare the grouped field at
 * all, so the kind came back `undefined` and every write made through it took
 * the wrong branch.
 *
 * M20.1 moved this out of BoardView, with `bandValueFor` below: the board was
 * the only surface that had the rule, and the table's create path — which is
 * the same question — did not.
 */
export function bandKind(entries: Entry[], field: string, schema: Schema): FieldKind | undefined {
  return bandDef(entries, field, schema)?.kind;
}

/** The def a band resolves against: the first entry that declares `field`,
 * or null when none does (M60.1; `bandKind`'s rule, whole). */
export function bandDef(entries: Entry[], field: string, schema: Schema): FieldDef | null {
  for (const e of entries) {
    const def = schema.resolveField(e, field).def;
    if (def !== null) return def;
  }
  return null;
}

/**
 * Whether a band's value can be written by moving or creating a record in it
 * (M60.1). A computed kind (created and edited time, a rollup) stores nothing,
 * and a relation or person with `from` is derived from the OTHER side's
 * links, so a write would only plant a mirror key nothing reads. An
 * undeclared field (null) is plain frontmatter, and writable.
 */
export function bandWritable(def: FieldDef | null): boolean {
  if (def === null) return true;
  if (kindMeta(def.kind).computed) return false;
  return !((def.kind === 'relation' || def.kind === 'person') && def.from !== undefined);
}

/**
 * The frontmatter value that puts a record in `key`'s band of a field.
 *
 * A band KEY is not a stored VALUE, and every path that treated it as one
 * wrote something the scanner then failed to read back (M20.1). Creating in a
 * relation band wrote `epic: Bonsai` where `epic: "[[Bonsai]]"` belongs, so
 * the property landed under `properties` instead of `relationships`, the link
 * did not exist, and the record did not return to the band it was created in.
 * A checkbox band wrote the STRING `"true"`.
 *
 * `null` means "no value" — the "No <field>" band, which deletes the key on a
 * move and seeds nothing on a create. Multi-value seeds and moves are handled
 * by bandSeedFor and movedBandValue, which keep the field's list shape.
 */
export function bandValueFor(key: string, kind: FieldKind | undefined): Scalar | undefined {
  if (key === NO_VALUE_KEY) return null;
  // Person/relation bands key by the wikilink STEM, so a bare-stem write
  // destroys the link on disk (the field leaves `relationships` after a
  // rescan). Wrap those back up.
  if (kind === 'person' || kind === 'relation') return formatWikilink(key);
  // `String(true)` is what put the key in this band; a string is not what the
  // field holds.
  if (kind === 'checkbox') return key === 'true';
  return key;
}

/** The value a newly created record inherits from a writable band. */
export function bandSeedFor(key: string, def: FieldDef | null): unknown {
  if (key === NO_VALUE_KEY) return null;
  if (!bandWritable(def)) return undefined;
  if (isDateKind(def?.kind)) {
    return bandDayOf(key) === key
      ? serializeDateProperty(makeDateValue(key), def?.kind === 'daterange' ? 'daterange' : 'date')
      : undefined;
  }
  return def?.kind === 'multiselect' ? [key] : bandValueFor(key, def?.kind);
}

/** Move only the membership the person grabbed, retaining all other values
 * in order. The computed/derived write refusal is shared by both board axes. */
export function movedBandValue(
  entry: Entry,
  field: string,
  from: string,
  to: string,
  schema: Schema,
): { value: unknown } | { refused: string } {
  const def = schema.resolveField(entry, field).def;
  if (!bandWritable(def)) return { refused: "Can't move cards grouped by a computed property" };
  const raw = schema.fieldValue(entry, field);
  if (isDateKind(def?.kind)) {
    if (to === NO_VALUE_KEY) return { value: null };
    if (bandDayOf(to) !== to)
      return { refused: "Choose a day to move this record; this band doesn't name one date" };
    return {
      value: dropDateValue(
        raw,
        to,
        def?.kind === 'daterange' ? 'daterange' : 'date',
        bandEndpoint(entry, field, schema),
      ),
    };
  }
  if (!bandsEveryValue(def, raw)) return { value: bandValueFor(to, def?.kind) ?? null };
  const values = (Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]) as Scalar[];
  const next = values.flatMap((value): Scalar[] => {
    if (value == null || value === '') return [];
    if (String(value) !== from) return [value];
    return to === NO_VALUE_KEY ? [] : [to];
  });
  if (from === NO_VALUE_KEY && to !== NO_VALUE_KEY) next.push(to);
  const seen = new Set<string>();
  const unique = next.filter((value) => {
    const key = String(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length === 0) return { value: null };
  return {
    value:
      def?.kind === 'person' || def?.kind === 'relation' || entry.relationships[field] !== undefined
        ? unique.map((value) => formatWikilink(String(value)))
        : unique,
  };
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
  ctx = bandContext(),
  defs = bandLevels(group).map((spec) => bandDef(entries, spec.field, schema)),
  seedable = true,
  deadlines = bandLevels(group).map((spec) =>
    entries.some((entry) => bandEndpoint(entry, spec.field, schema) === 'end'),
  ),
): GroupNode[] {
  // M9.7: only the property levels band. Relation levels nest, which is a
  // different rendering — they are handed to the row walker instead.
  const specs = bandLevels(group);
  const spec = specs[depth];
  if (spec === undefined) return [];

  const flat = groupEntries(entries, spec.field, schema, {
    dateBucket: spec.dateBucket,
    ctx,
    def: defs[depth],
    deadline: deadlines[depth],
  });
  const ordered = spec.dir === 'desc' ? [...flat].reverse() : flat;
  const isLeaf = depth === specs.length - 1;

  const nodes: GroupNode[] = [];
  for (const g of ordered) {
    if (spec.hideEmpty === true && g.entries.length === 0) continue;
    // Path, not key, identifies a node: the same status key appears under
    // every assignee, and a collapse map keyed on `key` alone would toggle
    // all of them together.
    const path = parentPath === '' ? g.key : `${parentPath}/${g.key}`;
    const children = isLeaf
      ? []
      : groupTree(
          g.entries,
          specs,
          schema,
          depth + 1,
          path,
          ctx,
          defs,
          seedable && g.seedable !== false,
          deadlines,
        );
    nodes.push({
      ...g,
      ...(!seedable ? { seedable: false as const } : {}),
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
