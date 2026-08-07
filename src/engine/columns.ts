import { isSystemProperty } from './properties';
import type { ColumnSpec, Entry, FieldDef, Schema, ListSource } from './types';

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
 * A column's field definition plus whether the records under it agree on
 * what kind it is. A typeless ("Everything") view can put a `status` from
 * one type beside a `status` from another; `heterogeneous` marks that so a
 * cell can refuse to offer an editor that would write the wrong shape.
 */
export interface ColumnDef extends FieldDef {
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
 * Every property a view could show (M9.2).
 *
 * Replaces three ad-hoc resolutions that disagreed: ProjectPage hardcoded
 * `Work item` regardless of what was on the canvas, CollectionPage resolved
 * typeless views to `[]` (so an "Everything" view had no columns at all),
 * and TypePage used its own lookup.
 *
 * - Typed source → that type's declared fields, in declared order.
 * - Typeless source → the union of declared fields across the types actually
 *   present, then undeclared frontmatter keys observed on those records. A
 *   mixed view gets the columns its records really have rather than none.
 */
export function columnUniverse(source: ListSource, entries: Entry[], schema: Schema): ColumnDef[] {
  if (source.type !== null) {
    return schema.types.get(source.type)?.fields ?? [];
  }

  const byName = new Map<string, ColumnDef>();
  const seenTypes = new Set<string>();

  for (const e of entries) {
    if (e.type === null || seenTypes.has(e.type)) continue;
    seenTypes.add(e.type);
    for (const f of schema.types.get(e.type)?.fields ?? []) {
      const existing = byName.get(f.name);
      if (existing === undefined) {
        byName.set(f.name, { ...f });
      } else if (existing.kind !== f.kind) {
        // Same name, different kinds across types. First declaration wins the
        // display; the flag tells cells to fall back to read-only rather than
        // graft one type's editor onto another type's value.
        existing.heterogeneous = true;
      }
    }
  }

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
