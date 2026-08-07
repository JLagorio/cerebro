import { childTypeOf } from './createRecord';
import { isSystemProperty } from './properties';
import { nestLevels } from './types';
import type { ColumnSpec, Entry, FieldDef, GroupSpec, Schema, ListSource } from './types';

/** Default column width; a ColumnSpec without one renders at this. */
export const DEFAULT_COL_W = 150;
export const MIN_COL_W = 60;

/** How many of a source's properties a view opens showing. Past this the
 * table is wider than the window before anyone has configured anything. */
export const DEFAULT_COLUMN_COUNT = 6;

/**
 * The columns a view opens with, given what its source actually declares
 * (M19.1).
 *
 * One implementation, because there were three: `typePresentation`, the view
 * settings dialog's seed, and its source-changed handler each sliced the
 * fields themselves — and two of them fell back to a hardcoded
 * `key/status/priority/assignee/due/estimate` when the type declared nothing,
 * so a brand-new type opened on six columns for properties that did not
 * exist. A source that declares nothing gets NO columns: Notion opens a new
 * database on Name and an Add-property button, and so does this.
 */
export function defaultColumnsFor(fields: FieldDef[]): ColumnSpec[] {
  return fields.slice(0, DEFAULT_COLUMN_COUNT).map((f) => ({ field: f.name }));
}

/** Whether a source can be grouped into status bands — the same question the
 * two seed paths were each answering inline. */
export function hasStatusField(fields: FieldDef[]): boolean {
  return fields.some((f) => f.kind === 'status');
}

/**
 * A column's field definition plus who it belongs to.
 *
 * One grid can hold records of several types — a typeless ("Everything") view
 * holds whatever is in the collection, and a grouping chain that descends a
 * relation nests foreign types under the source (M10). So a column is not
 * automatically every row's, and a column's field is not automatically one
 * declaration: `status` may be a `status` on one type and a `select` on
 * another.
 */
export interface ColumnDef extends FieldDef {
  /**
   * The types that declare this field, in the order the chain reaches them.
   * Absent when `undeclared`.
   *
   * What makes a per-column schema operation answerable (M20.2): rename,
   * change kind and delete all write to a TYPE, and before this the table
   * wrote them to the view's source — which under a descent is routinely not
   * the type that declares the column. Exactly one owner is the only case with
   * an unambiguous answer.
   */
  owners?: string[];
  /**
   * Two or more owners declare it with different KINDS.
   *
   * The display keeps the first declaration; each cell resolves its own row's
   * declaration instead of this one, so the flag no longer decides whether a
   * cell may be edited (M20.2) — it says the HEADER is showing one of several
   * answers, which is what the warning beside it means and why per-column
   * schema ops are off.
   */
  heterogeneous?: boolean;
  /**
   * NO type declares this field (M20.1). The column exists because a view file
   * names it, or because some record holds the key — the advisory-schema rule
   * `resolveColumns` documents below.
   *
   * It is the difference between the two ways a row can fail to declare a
   * column. A column that belongs to a TYPE and not to this row's type is that
   * row's business to stay out of: a Work item nested under an Objective must
   * not be offered Objective's `owner`. A column that belongs to no type is
   * nobody's in particular, and every row is equally entitled to it — which is
   * the only thing that keeps a hand-written view column editable.
   */
  undeclared?: boolean;
}

/**
 * The types a grid can actually hold, in the order its chain reaches them
 * (M20.2).
 *
 * A grouping level that DESCENDS a relation nests records of another type
 * under the source — the demo vault's OKR tree is Objective → Key result →
 * Work item — so "the type of this view" stops being one answer the moment a
 * chain has a descent in it. Each level's type comes from the level before:
 * a `reverse` descent names its own type, and a `forward` descent takes the
 * target of the relation the level above declares.
 *
 * A cycle (A descends into B, B back into A) terminates on the `includes`
 * check rather than on depth, because a type contributes its fields once
 * however many times the walk reaches it.
 *
 * Empty for a typeless source: there is no chain to walk from, and the types
 * present are whatever the entries turn out to be.
 */
export function chainTypes(source: ListSource, group: GroupSpec[], schema: Schema): string[] {
  if (source.type === null) return [];
  const out = [source.type];
  let current: string | null = source.type;
  for (const spec of nestLevels(group)) {
    const next: string | null = childTypeOf(spec, current, schema);
    if (next === null) break;
    if (!out.includes(next)) out.push(next);
    current = next;
  }
  return out;
}

/** Union one set of types' declared fields, recording who declares what. */
function unionDeclared(typeNames: Iterable<string>, schema: Schema): Map<string, ColumnDef> {
  const byName = new Map<string, ColumnDef>();
  for (const typeName of typeNames) {
    for (const f of schema.types.get(typeName)?.fields ?? []) {
      const existing = byName.get(f.name);
      if (existing === undefined) {
        byName.set(f.name, { ...f, owners: [typeName] });
        continue;
      }
      existing.owners = [...(existing.owners ?? []), typeName];
      // Same name, different kinds. The first declaration wins the display;
      // each CELL resolves its own row's declaration (M20.2), so the flag
      // reports that the header is showing one of several answers rather than
      // taking every cell read-only.
      if (existing.kind !== f.kind) existing.heterogeneous = true;
    }
  }
  return byName;
}

/**
 * Every property a view could show (M9.2).
 *
 * Replaces three ad-hoc resolutions that disagreed: ProjectPage hardcoded
 * `Work item` regardless of what was on the canvas, CollectionPage resolved
 * typeless views to `[]` (so an "Everything" view had no columns at all),
 * and TypePage used its own lookup.
 *
 * - Typed source → the union across its CHAIN: the source type's declared
 *   fields, then whatever each descended type declares and the ones above it
 *   do not (M20.2). It used to be the source type alone, which is what left a
 *   nested Work item under Objective's columns with no column of its own — it
 *   carries Status, Priority, Assignee, Due, Window and Estimate and the grid
 *   could show none of them, while offering it six columns it does not have.
 * - Typeless source → the union of declared fields across the types actually
 *   present, then undeclared frontmatter keys observed on those records. A
 *   mixed view gets the columns its records really have rather than none.
 */
export function columnUniverse(
  source: ListSource,
  entries: Entry[],
  schema: Schema,
  /** The view's grouping chain; only its relation levels are read. Omitted by
   * callers with no chain to offer, which then get the source type alone. */
  group: GroupSpec[] = [],
): ColumnDef[] {
  const chain = chainTypes(source, group, schema);
  if (chain.length > 0) return [...unionDeclared(chain, schema).values()];

  const present: string[] = [];
  for (const e of entries) {
    if (e.type !== null && !present.includes(e.type)) present.push(e.type);
  }
  const byName = unionDeclared(present, schema);

  // Undeclared frontmatter keys still deserve a column — that is the advisory
  // schema rule the detail panel already follows.
  for (const e of entries) {
    for (const name of Object.keys(e.properties)) {
      if (isSystemProperty(name) || byName.has(name)) continue;
      byName.set(name, { name, kind: 'text', undeclared: true });
    }
    for (const name of Object.keys(e.relationships)) {
      if (isSystemProperty(name) || byName.has(name)) continue;
      byName.set(name, { name, kind: 'relation', undeclared: true });
    }
  }

  return [...byName.values()];
}

/**
 * The type a per-column schema operation writes to, or null when there is no
 * unambiguous one (M20.2).
 *
 * Rename, change kind, insert, duplicate and delete all edit a TYPE doc. The
 * table used to pass the view's SOURCE type to all of them and gate on
 * `sourceType !== null && !heterogeneous` — which is right only while every
 * column belongs to the source. Under a descent it is routinely not: renaming
 * the Work item column `estimate` would have written `estimate` onto
 * Objective, creating a field on a type that never had one and leaving the
 * column it was renamed from untouched.
 */
export function columnOwner(def: ColumnDef): string | null {
  return def.owners?.length === 1 ? def.owners[0] : null;
}

/**
 * Resolve a view's ordered columns against the available field defs. A
 * column naming a field nothing declares still renders — as text — so a
 * hand-written view file never silently loses a column.
 */
export function resolveColumns(
  columns: ColumnSpec[],
  fields: ColumnDef[],
): {
  spec: ColumnSpec;
  def: ColumnDef;
  width: number;
}[] {
  return columns
    .filter((c) => c.hidden !== true && c.field !== 'title')
    .map((spec) => ({
      spec,
      def: fields.find((f) => f.name === spec.field) ?? {
        name: spec.field,
        kind: 'text' as const,
        undeclared: true,
      },
      width: spec.width ?? DEFAULT_COL_W,
    }));
}

/** Columns not currently shown, for the "add a column" picker. */
export function hiddenColumns(columns: ColumnSpec[], fields: ColumnDef[]): ColumnDef[] {
  const shown = new Set(columns.filter((c) => c.hidden !== true).map((c) => c.field));
  return fields.filter((f) => !shown.has(f.name));
}

/** Toggle a field's presence, preserving position when it comes back. */
export function toggleColumn(columns: ColumnSpec[], field: string): ColumnSpec[] {
  const existing = columns.find((c) => c.field === field);
  if (existing === undefined) return [...columns, { field }];
  return columns.map((c) => (c.field === field ? { ...c, hidden: c.hidden !== true } : c));
}

/** Move a column to an absolute index among the VISIBLE columns (M12.8 —
 * the settings panel's drag reorder drops on a slot, not a direction). */
export function moveColumnTo(columns: ColumnSpec[], field: string, to: number): ColumnSpec[] {
  const visible = columns.filter((c) => c.hidden !== true);
  const from = visible.findIndex((c) => c.field === field);
  if (from === -1) return columns;
  const clamped = Math.max(0, Math.min(to, visible.length - 1));
  if (clamped === from) return columns;
  const reordered = [...visible];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(clamped, 0, moved);
  return [...reordered, ...columns.filter((c) => c.hidden === true)];
}

/** Move a column to a new index among the VISIBLE columns. */
export function moveColumn(columns: ColumnSpec[], field: string, delta: number): ColumnSpec[] {
  const visible = columns.filter((c) => c.hidden !== true);
  const from = visible.findIndex((c) => c.field === field);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= visible.length) return columns;
  const reordered = [...visible];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  // Splice the reordered visible run back around the hidden entries, which
  // keep their slots so re-showing one lands where it was.
  const hidden = columns.filter((c) => c.hidden === true);
  return [...reordered, ...hidden];
}

/** Set an explicit width, clamped. Undefined clears it back to auto. */
export function setColumnWidth(
  columns: ColumnSpec[],
  field: string,
  width: number | undefined,
): ColumnSpec[] {
  return columns.map((c) => {
    if (c.field !== field) return c;
    if (width === undefined) {
      const { width: _drop, ...rest } = c;
      return rest;
    }
    return { ...c, width: Math.max(MIN_COL_W, Math.round(width)) };
  });
}

/** Toggle wrapping for one column (M12.4b — the header menu's Wrap content). */
export function setColumnWrap(columns: ColumnSpec[], field: string): ColumnSpec[] {
  const existing = columns.find((c) => c.field === field);
  if (existing === undefined) return [...columns, { field, wrap: true }];
  return columns.map((c) => (c.field === field ? { ...c, wrap: c.wrap !== true } : c));
}

/** True when every column the view shows already wraps — what "Wrap all
 * columns" reports back, and what decides whether pressing it wraps or
 * unwraps. */
export function allColumnsWrap(columns: ColumnSpec[]): boolean {
  const shown = columns.filter((c) => c.hidden !== true);
  return shown.length > 0 && shown.every((c) => c.wrap === true);
}

/**
 * Wrap every column, or unwrap them all when they already are (M16.29).
 *
 * Off is stored as an ABSENT key rather than `wrap: false`, so unwrapping
 * leaves the view file as it was rather than growing a line per column. One
 * implementation, because this is offered from two places now — the table's
 * own header and view settings — and two copies of "are they all wrapped?"
 * would eventually disagree about a hidden column.
 */
export function wrapAllColumns(columns: ColumnSpec[]): ColumnSpec[] {
  const on = !allColumnsWrap(columns);
  return columns.map((c) => {
    if (on) return { ...c, wrap: true };
    const { wrap: _drop, ...rest } = c;
    return rest;
  });
}

/**
 * Insert a column beside another (M12.4b — Insert left / Insert right). A
 * spec the view already holds (even hidden) is moved rather than duplicated.
 */
export function insertColumn(
  columns: ColumnSpec[],
  field: string,
  anchor: string,
  side: 'left' | 'right',
): ColumnSpec[] {
  const rest = columns.filter((c) => c.field !== field);
  const at = rest.findIndex((c) => c.field === anchor);
  if (at === -1) return [...rest, { field }];
  const index = side === 'left' ? at : at + 1;
  const existing = columns.find((c) => c.field === field);
  let spec: ColumnSpec = { field };
  if (existing !== undefined) {
    const { hidden: _shown, ...kept } = existing;
    spec = kept;
  }
  const next = [...rest];
  next.splice(index, 0, spec);
  return next;
}
