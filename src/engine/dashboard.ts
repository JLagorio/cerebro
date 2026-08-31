import { aggregateNumbers, formatNumber } from './properties';
import { humanize } from './schema';
import { evaluateFilters } from './viewFilters';
import { cloneWidget, nextDashboardRowId, nextDashboardWidgetId } from './views';
import { MAX_DASHBOARD_WIDGETS, MAX_ROW_WIDGETS, ROW_HEIGHT_MAX, ROW_HEIGHT_MIN } from './types';
import type {
  ChartAgg,
  DashboardRow,
  DashboardSpec,
  DashboardWidget,
  Entry,
  FilterGroup,
  Schema,
} from './types';

/**
 * The dashboard's number widget (M16.28; a `blocks[]` member until M44.4).
 *
 * It measures the DASHBOARD'S OWN rows — the same filtered, sorted set every
 * other layout of this view would show — so the view's filters scope it. A
 * number that ignored them would be a constant, and a constant does not belong
 * on a dashboard.
 *
 * The arithmetic is `aggregateNumbers`, the same function the chart and the
 * rollup column run. Three implementations of "average these" is how two
 * surfaces end up quoting different figures for one property.
 */

export type NumberBlocked = 'no-value-field' | 'no-numbers' | null;

export interface DashboardNumber {
  /** The measured value; 0 when there is nothing to measure. */
  value: number;
  /** Through the property's own number format, so $ and % survive. */
  display: string;
  /** What the tile is called when the block names nothing. */
  label: string;
  /** How many records went into it — the tile's subtitle. */
  count: number;
  blocked: NumberBlocked;
}

const AGG_LABEL: Record<ChartAgg, string> = {
  count: 'Records',
  sum: 'Sum',
  avg: 'Average',
};

export function dashboardNumber(
  entries: Entry[],
  block: Extract<DashboardWidget, { kind: 'number' }>,
  schema: Schema,
): DashboardNumber {
  const label =
    block.title ??
    (block.agg === 'count' || block.value === undefined
      ? AGG_LABEL[block.agg]
      : `${AGG_LABEL[block.agg]} of ${humanize(block.value)}`);

  if (block.agg === 'count') {
    return {
      value: entries.length,
      display: String(entries.length),
      label,
      count: entries.length,
      blocked: null,
    };
  }
  if (block.value === undefined || block.value === '') {
    return { value: 0, display: '—', label, count: entries.length, blocked: 'no-value-field' };
  }

  const field = block.value;
  const values = entries
    .map((e) => e.properties[field])
    .filter((v) => v !== undefined && v !== null && v !== '');
  const measured = aggregateNumbers(values, block.agg);
  if (measured === null) {
    return { value: 0, display: '—', label, count: entries.length, blocked: 'no-numbers' };
  }

  // The property's own format, from the first record that declares it: a tile
  // reading 2000 beside a table reading $2,000 looks like a different number.
  const def = entries.map((e) => schema.resolveField(e, field).def).find((d) => d !== null) ?? null;
  return {
    value: measured,
    display: def === null ? String(measured) : formatNumber(measured, def),
    label,
    count: values.length,
    blocked: null,
  };
}

// --- filter composition (M44.4) ---------------------------------------------

/**
 * The rows an own-scope widget measures: the dashboard's already-view-
 * filtered entries, through the Global filter, through the widget's own —
 * AND semantics across layers, and a half-built rule filters nothing
 * (`evaluateFilters`'s M16.29 contract, inherited for free by nesting).
 *
 * No filters at all returns the SAME array — a widget that filters nothing
 * must not force every consumer to re-render off a fresh reference.
 */
export function widgetEntries(
  entries: Entry[],
  spec: DashboardSpec,
  widget: DashboardWidget,
  schema: Schema,
): Entry[] {
  const layers = [spec.global, widget.filter].filter((f): f is FilterGroup => f !== undefined);
  if (layers.length === 0) return entries;
  return entries.filter((e) => layers.every((g) => evaluateFilters(e, g, schema)));
}

// --- structure editors (M44.4) ----------------------------------------------

/**
 * Every dashboard structure edit is pure and returns this — never a thrown
 * error — so the DnD handler and the widget menu can both toast the SAME
 * refusal sentence instead of each inventing their own wording.
 */
export type DashboardEdit = { ok: true; spec: DashboardSpec } | { ok: false; reason: string };

const ROW_FULL = 'A row holds at most four widgets';
/** Exported so the add popover's inline capacity note quotes the SAME sentence
 * `addWidget`/`duplicateWidget` refuse with — one rule, one wording. */
export const DASHBOARD_FULL = 'A dashboard holds at most twelve widgets';

/** Total widgets across every row — what the panel's nav-row count reads and
 * what `addWidget`/`duplicateWidget` cap against. */
export function widgetCount(spec: DashboardSpec): number {
  return spec.rows.reduce((n, r) => n + r.widgets.length, 0);
}

function findRowIndex(spec: DashboardSpec, widgetId: string): number {
  return spec.rows.findIndex((r) => r.widgets.some((w) => w.id === widgetId));
}

/** Drops any row an edit emptied — an empty row is not a row anyone asked
 * for, it is the shape a move or a delete leaves behind. */
function withoutEmptyRows(rows: DashboardRow[]): DashboardRow[] {
  return rows.filter((r) => r.widgets.length > 0);
}

/**
 * Adds `widget` to `rowId`, or to a fresh trailing row when `rowId` is
 * `'new-row'` (or names no row that exists — the popover's "no room left"
 * fallback lands here too). Refuses at either cap, dashboard-wide first: a
 * dashboard sitting exactly at its own ceiling can have every row full at
 * once, and the wider rule is the one worth naming.
 */
export function addWidget(
  spec: DashboardSpec,
  rowId: string,
  widget: DashboardWidget,
): DashboardEdit {
  if (widgetCount(spec) >= MAX_DASHBOARD_WIDGETS) return { ok: false, reason: DASHBOARD_FULL };
  const idx = rowId === 'new-row' ? -1 : spec.rows.findIndex((r) => r.id === rowId);
  if (idx === -1) {
    return {
      ok: true,
      spec: { ...spec, rows: [...spec.rows, { id: nextDashboardRowId(spec), widgets: [widget] }] },
    };
  }
  if (spec.rows[idx].widgets.length >= MAX_ROW_WIDGETS) return { ok: false, reason: ROW_FULL };
  const rows = spec.rows.map((r, i) => (i === idx ? { ...r, widgets: [...r.widgets, widget] } : r));
  return { ok: true, spec: { ...spec, rows } };
}

/** Removes a widget wherever it sits; a row left with nothing in it does not
 * survive the edit. A missing id is a no-op — same spec reference, matching
 * every sibling editor's no-op discipline — and only the row that actually
 * held the widget is rebuilt; every other row keeps its identity. */
export function removeWidget(spec: DashboardSpec, id: string): DashboardEdit {
  const rowIdx = findRowIndex(spec, id);
  if (rowIdx === -1) return { ok: true, spec };
  const widgets = spec.rows[rowIdx].widgets.filter((w) => w.id !== id);
  const rows =
    widgets.length === 0
      ? spec.rows.filter((_, i) => i !== rowIdx)
      : spec.rows.map((r, i) => (i === rowIdx ? { ...r, widgets } : r));
  return { ok: true, spec: { ...spec, rows } };
}

/**
 * Removes the widget from wherever it is, then inserts it at `toSlot` in
 * `toRowId` — remove-then-insert, so a same-row move naturally counts the
 * row WITHOUT the moving widget (it was already taken out before the cap is
 * checked). A move never changes the dashboard-wide total, so only the row
 * cap can refuse it. An unknown target row is a no-op — the caller (the drag
 * handler, the menu) is expected to name a row that exists.
 */
export function moveWidget(
  spec: DashboardSpec,
  id: string,
  toRowId: string,
  toSlot: number,
): DashboardEdit {
  const sourceIdx = findRowIndex(spec, id);
  if (sourceIdx === -1) return { ok: true, spec };
  const widget = spec.rows[sourceIdx].widgets.find((w) => w.id === id);
  if (widget === undefined) return { ok: true, spec };
  // Only the source row is rebuilt here — every sibling row keeps its
  // identity, the same discipline `moveToOwnRow` and `duplicateWidget`
  // already follow. The rows renderer keys widgets and rows by id, so a
  // rebuilt-but-unchanged row is a wasted re-render, not just wasted work.
  const withoutSource = spec.rows.map((r, i) =>
    i === sourceIdx ? { ...r, widgets: r.widgets.filter((w) => w.id !== id) } : r,
  );
  const targetIdx = withoutSource.findIndex((r) => r.id === toRowId);
  if (targetIdx === -1) return { ok: true, spec };
  const targetRow = withoutSource[targetIdx];
  if (targetRow.widgets.length >= MAX_ROW_WIDGETS) return { ok: false, reason: ROW_FULL };
  const slot = Math.max(0, Math.min(toSlot, targetRow.widgets.length));
  const widgets = [...targetRow.widgets.slice(0, slot), widget, ...targetRow.widgets.slice(slot)];
  const rows = withoutEmptyRows(
    withoutSource.map((r, i) => (i === targetIdx ? { ...r, widgets } : r)),
  );
  return { ok: true, spec: { ...spec, rows } };
}

/** Splices a fresh row holding just this widget in AFTER the row it came
 * from — "give this its own row" reads top-to-bottom as staying put. */
export function moveToOwnRow(spec: DashboardSpec, id: string): DashboardEdit {
  const sourceIdx = findRowIndex(spec, id);
  if (sourceIdx === -1) return { ok: true, spec };
  const widget = spec.rows[sourceIdx].widgets.find((w) => w.id === id);
  if (widget === undefined) return { ok: true, spec };
  const rows = [...spec.rows];
  rows[sourceIdx] = {
    ...rows[sourceIdx],
    widgets: rows[sourceIdx].widgets.filter((w) => w.id !== id),
  };
  rows.splice(sourceIdx + 1, 0, { id: nextDashboardRowId(spec), widgets: [widget] });
  return { ok: true, spec: { ...spec, rows: withoutEmptyRows(rows) } };
}

/** Moves the widget onto a fresh row at the very end — the drag handler's
 * `slot:new-row` target (Task 6), and the same shape `moveToOwnRow` builds,
 * just appended instead of spliced beside the source. */
export function moveToEnd(spec: DashboardSpec, id: string): DashboardEdit {
  const sourceIdx = findRowIndex(spec, id);
  if (sourceIdx === -1) return { ok: true, spec };
  const widget = spec.rows[sourceIdx].widgets.find((w) => w.id === id);
  if (widget === undefined) return { ok: true, spec };
  // Only the source row is rebuilt — the same touched-rows-only discipline
  // moveWidget and removeWidget follow; every other row keeps its identity.
  const rows = withoutEmptyRows(
    spec.rows.map((r, i) =>
      i === sourceIdx ? { ...r, widgets: r.widgets.filter((w) => w.id !== id) } : r,
    ),
  );
  return {
    ok: true,
    spec: { ...spec, rows: [...rows, { id: nextDashboardRowId(spec), widgets: [widget] }] },
  };
}

/** Move-left/move-right within one row — `delta` is -1 or +1; clamped at the
 * row's own ends rather than wrapping or crossing into a neighbour row. */
export function moveWithinRow(spec: DashboardSpec, id: string, delta: number): DashboardEdit {
  const rowIdx = findRowIndex(spec, id);
  if (rowIdx === -1) return { ok: true, spec };
  const row = spec.rows[rowIdx];
  const from = row.widgets.findIndex((w) => w.id === id);
  const to = Math.max(0, Math.min(row.widgets.length - 1, from + delta));
  if (to === from) return { ok: true, spec };
  const widgets = [...row.widgets];
  const [moved] = widgets.splice(from, 1);
  widgets.splice(to, 0, moved);
  const rows = spec.rows.map((r, i) => (i === rowIdx ? { ...r, widgets } : r));
  return { ok: true, spec: { ...spec, rows } };
}

/** A deep copy beside the source, with a fresh id — same caps as `addWidget`
 * since a duplicate IS an add. */
export function duplicateWidget(spec: DashboardSpec, id: string): DashboardEdit {
  if (widgetCount(spec) >= MAX_DASHBOARD_WIDGETS) return { ok: false, reason: DASHBOARD_FULL };
  const rowIdx = findRowIndex(spec, id);
  if (rowIdx === -1) return { ok: true, spec };
  const row = spec.rows[rowIdx];
  if (row.widgets.length >= MAX_ROW_WIDGETS) return { ok: false, reason: ROW_FULL };
  const source = row.widgets.find((w) => w.id === id);
  if (source === undefined) return { ok: true, spec };
  const copy = { ...cloneWidget(source), id: nextDashboardWidgetId(spec) };
  const at = row.widgets.findIndex((w) => w.id === id);
  const widgets = [...row.widgets.slice(0, at + 1), copy, ...row.widgets.slice(at + 1)];
  const rows = spec.rows.map((r, i) => (i === rowIdx ? { ...r, widgets } : r));
  return { ok: true, spec: { ...spec, rows } };
}

/**
 * What the widget menu's Rename, Filter and Band-by write with. The keys are
 * the CONFIG a widget carries, never its identity or position — those belong
 * to the structural editors above.
 */
export interface WidgetPatch {
  title?: string;
  filter?: FilterGroup;
  /** The board's band / the chart's axis. The menu only offers it on the
   * kinds that read it; a stray key on another kind is dropped by the parser
   * on the next read, the same way any hand-edited stray is. */
  group?: string;
}

/**
 * Patches one widget in place. A key handed `undefined` is DELETED — an
 * emptied filter must leave the YAML rather than linger as `filter: null`,
 * which is a rule nobody wrote. Only the touched row is rebuilt, matching
 * every sibling editor's discipline.
 */
export function updateWidget(spec: DashboardSpec, id: string, patch: WidgetPatch): DashboardEdit {
  const rowIdx = findRowIndex(spec, id);
  if (rowIdx === -1) return { ok: true, spec };
  const apply = (w: DashboardWidget): DashboardWidget => {
    const next: Record<string, unknown> = { ...w };
    for (const key of Object.keys(patch) as (keyof WidgetPatch)[]) {
      const value = patch[key];
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    // The cast is honest: every WidgetPatch key is optional on the widget
    // shape, so add/replace/delete all stay inside the union member `w` is.
    return next as unknown as DashboardWidget;
  };
  const rows = spec.rows.map((r, i) =>
    i === rowIdx ? { ...r, widgets: r.widgets.map((w) => (w.id === id ? apply(w) : w)) } : r,
  );
  return { ok: true, spec: { ...spec, rows } };
}

/** Clamped into the sane band, rounded — same rule the parser applies to a
 * hand-edited YAML height, so a resize and a hand edit agree. */
export function setRowHeight(spec: DashboardSpec, rowId: string, h: number): DashboardEdit {
  const idx = spec.rows.findIndex((r) => r.id === rowId);
  if (idx === -1) return { ok: true, spec };
  const clamped = Math.round(Math.min(ROW_HEIGHT_MAX, Math.max(ROW_HEIGHT_MIN, h)));
  const rows = spec.rows.map((r, i) => (i === idx ? { ...r, h: clamped } : r));
  return { ok: true, spec: { ...spec, rows } };
}

/** Floored at 1 — a weight below one would draw a widget thinner than an
 * equal share — and rounded to two decimals so a seam drag settles on 1.33,
 * not a float tail. */
export function setWidgetWeight(spec: DashboardSpec, id: string, w: number): DashboardEdit {
  const rowIdx = findRowIndex(spec, id);
  if (rowIdx === -1) return { ok: true, spec };
  const weight = Math.round(Math.max(1, w) * 100) / 100;
  const rows = spec.rows.map((r, i) =>
    i === rowIdx
      ? { ...r, widgets: r.widgets.map((w2) => (w2.id === id ? { ...w2, w: weight } : w2)) }
      : r,
  );
  return { ok: true, spec: { ...spec, rows } };
}
