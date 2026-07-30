import { isSystemProperty } from './properties';
import type { ColumnSpec, Entry, FieldDef, Schema, ListSource } from './types';

/** Default column width; a ColumnSpec without one renders at this. */
export const DEFAULT_COL_W = 150;
export const MIN_COL_W = 60;

/**
 * A column's field definition plus whether the records under it agree on
 * what kind it is. A typeless ("Everything") view can put a `status` from
 * one type beside a `status` from another; `heterogeneous` marks that so a
 * cell can refuse to offer an editor that would write the wrong shape.
 */
export interface ColumnDef extends FieldDef {
  heterogeneous?: boolean;
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
export function columnUniverse(
  source: ListSource,
  entries: Entry[],
  schema: Schema,
): ColumnDef[] {
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
      byName.set(name, { name, kind: 'text' });
    }
    for (const name of Object.keys(e.relationships)) {
      if (isSystemProperty(name) || byName.has(name)) continue;
      byName.set(name, { name, kind: 'relation' });
    }
  }

  return [...byName.values()];
}

/**
 * Resolve a view's ordered columns against the available field defs. A
 * column naming a field nothing declares still renders — as text — so a
 * hand-written view file never silently loses a column.
 */
export function resolveColumns(columns: ColumnSpec[], fields: ColumnDef[]): {
  spec: ColumnSpec;
  def: ColumnDef;
  width: number;
}[] {
  return columns
    .filter((c) => c.hidden !== true && c.field !== 'title')
    .map((spec) => ({
      spec,
      def: fields.find((f) => f.name === spec.field) ?? { name: spec.field, kind: 'text' as const },
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
