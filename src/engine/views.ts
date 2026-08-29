import { parse, stringify } from 'yaml';
import { parseAggregateCalc } from './aggregate';
import type {
  CardPreview,
  CardSize,
  ChartAgg,
  ChartHeight,
  ChartKind,
  ChartSort,
  ChartSpec,
  ChildrenSpec,
  ChipStyle,
  ColumnSpec,
  DashboardRow,
  DashboardSpec,
  DashboardWidget,
  FilterGroup,
  FilterOp,
  FilterRule,
  GallerySpec,
  GroupSpec,
  ListDefinition,
  ListFile,
  ListSource,
  Presentation,
  Scalar,
  SortSpec,
  TabDef,
  ViewDefinition,
  ViewTabSource,
  ViewType,
} from './types';
import {
  CARD_PREVIEWS,
  CARD_SIZES,
  CHART_AGGS,
  CHART_HEIGHTS,
  CHART_KINDS,
  CHART_SORTS,
  FILTER_OPS,
  MAX_ROW_WIDGETS,
  ROW_HEIGHT_MAX,
  ROW_HEIGHT_MIN,
  TAB_CONTENTS,
  VIEW_TYPES,
} from './types';

/**
 * What a view looks like before anything is known about its source.
 *
 * Only `type` and `sort` can be decided without a schema. `columns` and
 * `group` both name FIELDS, and no field name can be defaulted from nothing —
 * so both are "nothing decided yet", and the surface that DOES know the source
 * fills them in via `defaultColumnsFor`/`hasStatusField`.
 *
 * M19.1: this used to assert a Jira issue — `group: [{ field: 'status' }]` and
 * columns `key, status, priority, assignee, due, estimate` — as the app-wide
 * default, which is how a fresh type with no fields at all opened on six
 * headers for properties nothing in the vault had. Do not put field names back
 * here; a default that names a field is a default that has guessed a domain.
 */
export const DEFAULT_PRESENTATION: Presentation = {
  type: 'list',
  group: [],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [],
};

/** Deep copy — presentations are edited in component state and must not
 * share array identity with the module-level default. */
export function clonePresentation(p: Presentation): Presentation {
  return {
    ...p,
    group: p.group.map((g) => ({ ...g, ...(g.descend ? { descend: { ...g.descend } } : {}) })),
    sort: p.sort.map((s) => ({ ...s })),
    columns: p.columns.map((c) => ({ ...c })),
    // The layout-specific settings are objects too, and a shallow copy would
    // hand two views the same one — editing the gallery's card size in a
    // duplicated tab would change it in the tab it was duplicated from.
    ...(p.gallery !== undefined ? { gallery: { ...p.gallery } } : {}),
    ...(p.chart !== undefined ? { chart: cloneChart(p.chart) } : {}),
    ...(p.dashboard !== undefined
      ? {
          dashboard: {
            rows: p.dashboard.rows.map((r) => ({ ...r, widgets: r.widgets.map(cloneWidget) })),
            ...(p.dashboard.global !== undefined
              ? { global: cloneFilters(p.dashboard.global) }
              : {}),
          },
        }
      : {}),
    ...(p.whiteboard !== undefined ? { whiteboard: { ...p.whiteboard } } : {}),
  };
}

function cloneChart(c: ChartSpec): ChartSpec {
  return {
    ...c,
    ...(c.hidden !== undefined ? { hidden: [...c.hidden] } : {}),
    ...(c.hiddenG !== undefined ? { hiddenG: [...c.hiddenG] } : {}),
  };
}

/** Deep copy of one widget — exported so `dashboard.ts`'s `duplicateWidget`
 * reuses this instead of a second copy of the same shape-walk. */
export function cloneWidget(w: DashboardWidget): DashboardWidget {
  return {
    ...w,
    ...(w.filter !== undefined ? { filter: cloneFilters(w.filter) } : {}),
    ...(w.kind === 'chart' && w.chart !== undefined ? { chart: cloneChart(w.chart) } : {}),
  };
}

function cloneFilterNode(node: FilterRule | FilterGroup): FilterRule | FilterGroup {
  if ('all' in node) return { all: node.all.map(cloneFilterNode) };
  if ('any' in node) return { any: node.any.map(cloneFilterNode) };
  return { ...node, ...(Array.isArray(node.value) ? { value: [...node.value] } : {}) };
}

/** Deep copy of a filter group — plain JSON, but nested, so a spread is not
 * enough: two views sharing one `all` array would edit each other's rules. */
function cloneFilters(g: FilterGroup): FilterGroup {
  return 'all' in g ? { all: g.all.map(cloneFilterNode) } : { any: g.any.map(cloneFilterNode) };
}

/** The visible columns, in order — what every layout actually renders. */
export function visibleColumns(p: Presentation): ColumnSpec[] {
  return p.columns.filter((c) => c.hidden !== true);
}

/**
 * Clicking a column header (M9.1). Promotes that field to the PRIMARY sort
 * key, flipping direction if it already leads — and keeps the rest of the
 * chain below it rather than discarding a multi-key sort on one click.
 */
export function toggleSort(p: Presentation, field: string): Presentation {
  const leading = p.sort[0];
  const dir: 'asc' | 'desc' = leading?.field === field && leading.dir === 'asc' ? 'desc' : 'asc';
  return { ...p, sort: [{ field, dir }, ...p.sort.filter((s) => s.field !== field)] };
}

/** Promote `field` to the primary sort with an explicit direction (M12.4b —
 * the header menu says which way, unlike the label's toggle). */
export function sortBy(p: Presentation, field: string, dir: 'asc' | 'desc'): Presentation {
  return { ...p, sort: [{ field, dir }, ...p.sort.filter((s) => s.field !== field)] };
}

/**
 * Toggle banding by `field` (M12.4b — the header menu's Group). Relation
 * (nest) levels survive: banding and nesting are different levels of the one
 * chain, and grouping by status must not flatten a hierarchy.
 */
export function groupByField(p: Presentation, field: string): Presentation {
  const nests = p.group.filter((g) => g.descend !== undefined);
  const bandsNow = p.group.filter((g) => g.descend === undefined);
  const already = bandsNow.length === 1 && bandsNow[0].field === field;
  return { ...p, group: already ? nests : [{ field }, ...nests] };
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * Derived, never hand-written (M16.3). This used to be a literal set, and
 * omitting a kind from it made `parseViewType` silently downgrade every saved
 * file of that kind to `list` — a data-losing failure with no error anywhere.
 */
const LAYOUTS = new Set<ViewType>(VIEW_TYPES);

/**
 * The two view kinds M10 retired, and what they become (see types.ts for why).
 * Both keep their grouping chain, which is where a `tree`'s nesting already
 * lived — so an okr-tree.yml opens as a nested table rather than losing its
 * hierarchy, and no saved file has to be hand-edited.
 */
const RETIRED_LAYOUTS: Record<string, ViewType> = { tree: 'table', split: 'table' };

const ZOOMS = new Set(['day', 'week', 'month', 'quarter']);

// Derived from the const arrays for the reason LAYOUTS is: a hand-written
// second copy is a value the parser silently drops the day someone adds one.
const CARD_SIZE_SET = new Set<string>(CARD_SIZES);
const CARD_PREVIEW_SET = new Set<string>(CARD_PREVIEWS);
/**
 * Derived, never hand-written (M16.25). This was a literal array beside the
 * `FilterOp` union, and it is the READ-SIDE allowlist — an operator missing
 * from it made `parseFilterNode` treat the rule as malformed and DROP it, so a
 * saved view reopened with one fewer condition and silently showed records it
 * had been configured to hide.
 */
const KNOWN_OPS = new Set<FilterOp>(FILTER_OPS);

/** Beyond this a nesting chain stops being legible and starts being a cycle. */
export const MAX_NEST_DEPTH = 6;
/** Notion caps sub-grouping here for the same reason: nesting stops reading. */
export const MAX_GROUP_DEPTH = 3;
/**
 * The sort chain's cap (M16.26). The toolbar's chain builder passed `max={4}`
 * and the settings panel's SortPage enforced none, so the same view accepted a
 * fifth sort key from one surface and refused it from the other.
 */
export const MAX_SORT_KEYS = 4;

/**
 * Move one sort key to a new position (M16.26).
 *
 * A sort chain is ORDERED — the first key decides, later ones break its ties —
 * and the only way to demote the leading key was to delete every row and
 * re-add them in the order you wanted. Out-of-range indices return the chain
 * untouched rather than throwing: this is called from a pointer drag, whose
 * slot maths is measured against a DOM that may have re-rendered mid-gesture.
 */
export function moveSortKey(sort: SortSpec[], from: number, to: number): SortSpec[] {
  if (from === to || from < 0 || from >= sort.length || to < 0 || to >= sort.length) return sort;
  const next = [...sort];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Move one view tab to a new position (M16.26).
 *
 * Tab order is the order of the `views:` array on disk, and nothing could
 * write a different one: there was no drag handler, no Move left/right item,
 * and no action. A List that grew a fifth view had it pinned last forever.
 */
export function moveView(views: ViewDefinition[], id: string, to: number): ViewDefinition[] {
  const from = views.findIndex((v) => v.id === id);
  if (from === -1 || from === to || to < 0 || to >= views.length) return views;
  const next = [...views];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Presentation parse (M9.1) — accepts both the v1 keys (`groupBy`, `orderBy`,
 * `visibleFields`, `childrenVia`) and the v2 chains (`group`, `sort`,
 * `columns`, `hierarchy`). A file written by M8 opens here unchanged.
 *
 * When BOTH shapes are present, v2 wins: a file caught mid-migration must not
 * have its new configuration silently overridden by a stale legacy key.
 */
function parsePresentation(raw: unknown): Presentation {
  const obj = asRecord(raw);
  const titleCalc = parseAggregateCalc(obj.titleCalc);
  const gallery = parseGallery(obj.gallery);
  const cardSize = parseCardSize(obj.cardSize) ?? parseCardSize(asRecord(obj.gallery).size);
  const chart = parseChart(obj.chart);
  const dashboard = parseDashboard(obj.dashboard);
  const whiteboard = parseWhiteboard(obj.whiteboard);
  return {
    type: parseViewType(obj.type),
    group: parseGroupChain(obj),
    sort: parseSortChain(obj),
    columns: parseColumns(obj),
    rowHeight:
      obj.rowHeight === 'compact' || obj.rowHeight === 'tall' || obj.rowHeight === 'default'
        ? obj.rowHeight
        : undefined,
    ...(typeof obj.titleWidth === 'number' && Number.isFinite(obj.titleWidth)
      ? { titleWidth: obj.titleWidth }
      : {}),
    // Stored only off the default, so existing files stay untouched. The
    // pre-M16.18 `titleFrozen: false` means the same thing as "no frozen
    // columns" and migrates to it; `titleFrozen: true` was the default and
    // carries no information.
    ...(typeof obj.frozenColumns === 'number' &&
    Number.isInteger(obj.frozenColumns) &&
    obj.frozenColumns >= 0
      ? { frozenColumns: obj.frozenColumns }
      : obj.titleFrozen === false
        ? { frozenColumns: 0 }
        : {}),
    ...(typeof obj.titlePosition === 'number' &&
    Number.isInteger(obj.titlePosition) &&
    obj.titlePosition > 0
      ? { titlePosition: obj.titlePosition }
      : {}),
    ...(titleCalc !== null ? { titleCalc } : {}),
    ...(obj.chips === 'plain' || obj.chips === 'type-icon'
      ? { chips: obj.chips as ChipStyle }
      : {}),
    // Card settings (M16.20). Stored only off their defaults, so a table's
    // YAML never grows three keys about a layout it is not in.
    //
    // The gallery kept its own `gallery.size` until M16.29, when the two
    // spellings of one setting were collapsed onto this key. A file written
    // by the old panel migrates on read rather than losing the choice.
    ...(cardSize !== undefined ? { cardSize } : {}),
    ...(typeof obj.cardPreview === 'string' && CARD_PREVIEW_SET.has(obj.cardPreview)
      ? { cardPreview: obj.cardPreview as CardPreview }
      : {}),
    ...(obj.colorColumns === true ? { colorColumns: true } : {}),
    ...(typeof obj.dateField === 'string' && obj.dateField.trim() !== ''
      ? { dateField: obj.dateField.trim() }
      : {}),
    ...(typeof obj.zoom === 'string' && ZOOMS.has(obj.zoom)
      ? { zoom: obj.zoom as NonNullable<Presentation['zoom']> }
      : {}),
    ...(typeof obj.dependencyField === 'string' && obj.dependencyField.trim() !== ''
      ? { dependencyField: obj.dependencyField.trim() }
      : {}),
    ...(gallery !== undefined ? { gallery } : {}),
    ...(chart !== undefined ? { chart } : {}),
    ...(dashboard !== undefined ? { dashboard } : {}),
    ...(whiteboard !== undefined ? { whiteboard } : {}),
    // M16.23 grid chrome. Every one is stored only off its default, so a view
    // file that never touched them stays byte-identical.
    ...(obj.calendarSpan === 'week' ? { calendarSpan: 'week' as const } : {}),
    ...(obj.showWeekends === false ? { showWeekends: false } : {}),
    ...(obj.weekStart === 'monday' ? { weekStart: 'monday' as const } : {}),
    // showTable has no single default — it is per layout — so unlike the rest
    // it is stored whenever it was decided, either way.
    ...(typeof obj.showTable === 'boolean' ? { showTable: obj.showTable } : {}),
    // A limit of zero or less is dropped on read rather than honoured: it can
    // only come from a hand-edited file, and a canvas emptied by a key nothing
    // on screen mentions has no way back (M16.26).
    ...(typeof obj.limit === 'number' && Number.isFinite(obj.limit) && obj.limit > 0
      ? { limit: Math.floor(obj.limit) }
      : {}),
  };
}

const KINDS = new Set<string>(CHART_KINDS);
const AGGS = new Set<string>(CHART_AGGS);
const CHART_SORT_SET = new Set<string>(CHART_SORTS);
const CHART_HEIGHT_SET = new Set<string>(CHART_HEIGHTS);

/**
 * Gallery card settings (M16.22). Every member is optional and only stored
 * off its default, so a gallery nobody configured writes no `gallery:` key at
 * all — the same rule the date-axis keys follow.
 */
function parseGallery(raw: unknown): GallerySpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = asRecord(raw);
  const spec: GallerySpec = {};
  if (typeof obj.cover === 'string' && obj.cover.trim() !== '') spec.cover = obj.cover.trim();
  if (obj.fit === true) spec.fit = true;
  return Object.keys(spec).length === 0 ? undefined : spec;
}

/** A stored card size, or undefined. Used twice: once for `cardSize`, once for
 * the pre-M16.29 `gallery.size` it absorbed. */
function parseCardSize(raw: unknown): CardSize | undefined {
  return typeof raw === 'string' && CARD_SIZE_SET.has(raw) ? (raw as CardSize) : undefined;
}

/**
 * Chart settings (M16.27). Same rule as the gallery's: members are stored only
 * off their defaults, and an unrecognised one is dropped rather than trusted —
 * a hand-edited `kind: sankey` must not reach the renderer as a chart type
 * nothing draws.
 *
 * Keys are validated by VALUE, never by kind: a hand-switched `kind:` must
 * not silently delete the settings the previous kind wrote — the panel's
 * patch, not the parser, owns kind-scoping (M44.2).
 */
function parseChart(raw: unknown): ChartSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = asRecord(raw);
  const spec: ChartSpec = {};
  if (typeof obj.kind === 'string' && KINDS.has(obj.kind)) spec.kind = obj.kind as ChartKind;
  if (typeof obj.agg === 'string' && AGGS.has(obj.agg)) spec.agg = obj.agg as ChartAgg;
  if (typeof obj.value === 'string' && obj.value.trim() !== '') spec.value = obj.value.trim();
  if (obj.omitZero === true) spec.omitZero = true;
  if (obj.horizontal === true) spec.horizontal = true;
  if (typeof obj.sort === 'string' && CHART_SORT_SET.has(obj.sort))
    spec.sort = obj.sort as ChartSort;
  if (obj.cumulative === true) spec.cumulative = true;
  if (typeof obj.height === 'string' && CHART_HEIGHT_SET.has(obj.height))
    spec.height = obj.height as ChartHeight;
  if (typeof obj.palette === 'string' && obj.palette.trim() !== '')
    spec.palette = obj.palette.trim();
  if (obj.colorByValue === true) spec.colorByValue = true;
  if (obj.hideGrid === true) spec.hideGrid = true;
  if (obj.hideAxis === true) spec.hideAxis = true;
  if (obj.hideLabels === true) spec.hideLabels = true;
  if (obj.smooth === true) spec.smooth = true;
  if (obj.area === true) spec.area = true;
  if (obj.hideDonutCenter === true) spec.hideDonutCenter = true;
  // legend is a real boolean either way: donuts store `legend: false`, bars `legend: true`.
  if (typeof obj.legend === 'boolean') spec.legend = obj.legend;
  if (typeof obj.xField === 'string' && obj.xField.trim() !== '') spec.xField = obj.xField.trim();
  if (typeof obj.groupBy === 'string' && obj.groupBy.trim() !== '')
    spec.groupBy = obj.groupBy.trim();
  // The hidden lists hold band/series KEYS. Only non-blank strings are keys;
  // a list that filters to nothing stores nothing (M44.3).
  if (Array.isArray(obj.hidden)) {
    const keys = obj.hidden.filter((k): k is string => typeof k === 'string' && k.trim() !== '');
    if (keys.length > 0) spec.hidden = keys;
  }
  if (Array.isArray(obj.hiddenG)) {
    const keys = obj.hiddenG.filter((k): k is string => typeof k === 'string' && k.trim() !== '');
    if (keys.length > 0) spec.hiddenG = keys;
  }
  return Object.keys(spec).length === 0 ? undefined : spec;
}

/**
 * The whiteboard's file pointer (M29.45). Only a non-empty string is a
 * pointer; anything else — null, blank, a number, `{}` — parses as "not
 * created yet" (absent), so the serializer never has to remember a null.
 */
function parseWhiteboard(raw: unknown): Presentation['whiteboard'] | undefined {
  const obj = asRecord(raw);
  return typeof obj.file === 'string' && obj.file.trim() !== ''
    ? { file: obj.file.trim() }
    : undefined;
}

/**
 * Dashboard rows of widgets (M44.4; blocks[] was M16.28's shape).
 *
 * Unlike the gallery and chart blocks this one is a LIST, so a malformed
 * member is dropped individually — one hand-edited widget must not take the
 * other five down with it, and a row it empties goes quietly with it. Ids are
 * made unique here for the same reason view ids are: they address a move, a
 * resize and a delete, and two widgets answering to one name means deleting
 * either one deletes whichever sorted first.
 */
function parseDashboard(raw: unknown): DashboardSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = asRecord(raw);
  // Legacy shapes (M16.28): a bare array, or { blocks: [...] } — migrated on
  // read. A wide block keeps its own row; neighbours pair up two to a row,
  // the shape the old auto-fit grid drew. Ids survive so collapse scopes hold.
  if (Array.isArray(raw) || obj.blocks !== undefined) {
    return { rows: pairLegacy(parseLegacyBlocks(Array.isArray(raw) ? raw : obj.blocks)) };
  }
  if (obj.rows === undefined) return undefined;
  if (!Array.isArray(obj.rows)) return { rows: [] };
  const takenRows = new Set<string>();
  const takenWidgets = new Set<string>();
  const rows: DashboardRow[] = [];
  for (const r of obj.rows) {
    const ro = asRecord(r);
    if (!Array.isArray(ro.widgets)) continue;
    const widgets: DashboardWidget[] = [];
    for (const w of ro.widgets) {
      const widget = parseWidget(w, takenWidgets);
      if (widget !== null) widgets.push(widget);
    }
    if (widgets.length === 0) continue;
    const declared = typeof ro.id === 'string' && ro.id.trim() !== '' ? ro.id.trim() : '';
    const id =
      declared !== '' && !takenRows.has(declared)
        ? declared
        : nextId('row', takenRows, rows.length);
    takenRows.add(id);
    rows.push({
      id,
      ...(typeof ro.h === 'number' && Number.isFinite(ro.h)
        ? { h: Math.round(Math.min(ROW_HEIGHT_MAX, Math.max(ROW_HEIGHT_MIN, ro.h))) }
        : {}),
      widgets: widgets.slice(0, MAX_ROW_WIDGETS),
    });
  }
  const global = parseFilters(obj.global);
  return { rows, ...(global !== null ? { global } : {}) };
}

/**
 * One widget. `legacy` reads the M16.28 block vocabulary: number and view
 * only, where any other kind that named a `list` was read as a view — the
 * rows world requires every kind to be spelled out, and drops the rest.
 */
function parseWidget(raw: unknown, taken: Set<string>, legacy = false): DashboardWidget | null {
  const obj = asRecord(raw);
  const declared = typeof obj.id === 'string' && obj.id.trim() !== '' ? obj.id.trim() : '';
  const id =
    declared !== '' && !taken.has(declared) ? declared : nextId('widget', taken, taken.size);
  const filter = parseFilters(obj.filter);
  const base = {
    id,
    ...(typeof obj.title === 'string' && obj.title.trim() !== ''
      ? { title: obj.title.trim() }
      : {}),
    // A weight below one would draw a widget thinner than its equal share;
    // two decimals so a seam drag stores 1.33, not a float tail.
    ...(typeof obj.w === 'number' && Number.isFinite(obj.w) && obj.w >= 1
      ? { w: Math.round(obj.w * 100) / 100 }
      : {}),
    ...(filter !== null ? { filter } : {}),
  };
  if (obj.kind === 'number') {
    taken.add(id);
    const agg: ChartAgg =
      typeof obj.agg === 'string' && AGGS.has(obj.agg) ? (obj.agg as ChartAgg) : 'count';
    return {
      ...base,
      kind: 'number',
      agg,
      ...(agg !== 'count' && typeof obj.value === 'string' && obj.value.trim() !== ''
        ? { value: obj.value.trim() }
        : {}),
    };
  }
  if (!legacy) {
    if (obj.kind === 'table' || obj.kind === 'timeline') {
      taken.add(id);
      return { ...base, kind: obj.kind };
    }
    if (obj.kind === 'board') {
      taken.add(id);
      return {
        ...base,
        kind: 'board',
        ...(typeof obj.group === 'string' && obj.group.trim() !== ''
          ? { group: obj.group.trim() }
          : {}),
      };
    }
    if (obj.kind === 'chart') {
      taken.add(id);
      const chart = parseChart(obj.chart);
      return {
        ...base,
        kind: 'chart',
        ...(typeof obj.group === 'string' && obj.group.trim() !== ''
          ? { group: obj.group.trim() }
          : {}),
        ...(chart !== undefined ? { chart } : {}),
      };
    }
    // A kind nothing draws is dropped like any other malformed widget.
    if (obj.kind !== 'view') return null;
  }
  // A view widget with no List to point at is not a widget — it would render
  // as a permanent "that view is gone" tile nobody deliberately made.
  if (typeof obj.list !== 'string' || obj.list.trim() === '') return null;
  taken.add(id);
  return {
    ...base,
    kind: 'view',
    list: obj.list.trim(),
    ...(typeof obj.collection === 'string' && obj.collection.trim() !== ''
      ? { collection: obj.collection.trim() }
      : {}),
    ...(typeof obj.view === 'string' && obj.view.trim() !== '' ? { view: obj.view.trim() } : {}),
  };
}

/** The pre-M44.4 per-block parse. `wide` is read for the pairing below and
 * dropped from the widget — row structure encodes width now. */
function parseLegacyBlocks(raw: unknown): { widget: DashboardWidget; wide: boolean }[] {
  if (!Array.isArray(raw)) return [];
  const taken = new Set<string>();
  const blocks: { widget: DashboardWidget; wide: boolean }[] = [];
  for (const entry of raw) {
    const widget = parseWidget(entry, taken, true);
    if (widget !== null) blocks.push({ widget, wide: asRecord(entry).wide === true });
  }
  return blocks;
}

function pairLegacy(blocks: { widget: DashboardWidget; wide: boolean }[]): DashboardRow[] {
  const rows: DashboardRow[] = [];
  let buffer: DashboardWidget[] = [];
  const flush = () => {
    if (buffer.length > 0) rows.push({ id: `row-${rows.length + 1}`, widgets: buffer });
    buffer = [];
  };
  for (const { widget, wide } of blocks) {
    if (wide) {
      flush();
      rows.push({ id: `row-${rows.length + 1}`, widgets: [widget] });
    } else {
      buffer.push(widget);
      if (buffer.length === 2) flush();
    }
  }
  flush();
  return rows;
}

function nextId(prefix: string, taken: Set<string>, index: number): string {
  for (let n = index + 1; ; n += 1) {
    const candidate = `${prefix}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** An id no sibling widget holds — what "add a widget" needs. */
export function nextDashboardWidgetId(spec: DashboardSpec): string {
  const widgets = spec.rows.flatMap((r) => r.widgets);
  return nextId('widget', new Set(widgets.map((w) => w.id)), widgets.length);
}

/** An id no sibling row holds — what a splice-in-a-new-row edit needs. */
export function nextDashboardRowId(spec: DashboardSpec): string {
  return nextId('row', new Set(spec.rows.map((r) => r.id)), spec.rows.length);
}

/**
 * A live kind, a retired kind's replacement, or the default. A file that names
 * no layout keeps landing on DEFAULT_PRESENTATION's — M10 retired two kinds, it
 * did not change what an unconfigured view looks like.
 */
function parseViewType(raw: unknown): ViewType {
  if (typeof raw !== 'string') return DEFAULT_PRESENTATION.type;
  if (LAYOUTS.has(raw as ViewType)) return raw as ViewType;
  return RETIRED_LAYOUTS[raw] ?? DEFAULT_PRESENTATION.type;
}

/**
 * The grouping chain (M9.7). A level is a property to band by, or a relation
 * to descend — `descend:` / `relation:` marks the second kind.
 *
 * Also migrates the two shapes this replaces: v1's single `groupBy`, and
 * M9.1's separate `hierarchy` array, whose levels append to the chain as
 * relation levels.
 */
function parseGroupChain(obj: Record<string, unknown>): GroupSpec[] {
  const levels: GroupSpec[] = [];

  if (Array.isArray(obj.group)) {
    for (const raw of obj.group) {
      if (typeof raw === 'string' && raw.trim() !== '') {
        levels.push({ field: raw.trim() });
        continue;
      }
      const g = asRecord(raw);
      // A relation level: `descend:`/`relation:` holds the spec, and `field`
      // is optional because the spec already names the relation.
      const descend = parseChildrenSpec(g.descend ?? g.relation);
      if (descend !== null) {
        levels.push({ field: descend.field, descend });
        continue;
      }
      if (typeof g.field !== 'string' || g.field.trim() === '') continue;
      const spec: GroupSpec = { field: g.field.trim() };
      if (g.dir === 'asc' || g.dir === 'desc') spec.dir = g.dir;
      if (g.hideEmpty === true) spec.hideEmpty = true;
      levels.push(spec);
    }
  } else if (typeof obj.groupBy === 'string' && obj.groupBy.trim() !== '') {
    levels.push({ field: obj.groupBy.trim() });
  }
  // M19.1: no grouping stated means NO BANDS, the same as an explicit
  // `groupBy: null`. There used to be a third branch here that spread
  // `DEFAULT_PRESENTATION.group` — a hardcoded `status` band — so a file that
  // said nothing got bands, and one that said `groupBy: null` did not, for
  // reasons no reader of the file could see.

  // M9.1 `hierarchy:` and v1 `childrenVia:` become relation levels.
  const legacy: ChildrenSpec[] = Array.isArray(obj.hierarchy)
    ? obj.hierarchy.map(parseChildrenSpec).filter((s): s is ChildrenSpec => s !== null)
    : [];
  const single = parseChildrenSpec(obj.childrenVia);
  if (legacy.length === 0 && single !== null) legacy.push(single);
  for (const descend of legacy) {
    if (levels.some((l) => l.descend !== undefined && sameDescent(l.descend, descend))) continue;
    levels.push({ field: descend.field, descend });
  }

  return capChain(levels);
}

function sameDescent(a: ChildrenSpec, b: ChildrenSpec): boolean {
  if (a.direction !== b.direction) return false;
  if (a.direction === 'reverse' && b.direction === 'reverse') {
    return a.type === b.type && a.field === b.field;
  }
  return a.field === b.field;
}

/**
 * Cap each kind of level separately. Bands stop being legible past three;
 * relation levels are bounded by the cycle guard instead, and a chain that
 * mixes them should not have its nesting truncated by its banding.
 */
function capChain(levels: GroupSpec[]): GroupSpec[] {
  const out: GroupSpec[] = [];
  let bands = 0;
  let nests = 0;
  for (const level of levels) {
    if (level.descend === undefined) {
      if (bands >= MAX_GROUP_DEPTH) continue;
      bands += 1;
    } else {
      if (nests >= MAX_NEST_DEPTH) continue;
      nests += 1;
    }
    out.push(level);
  }
  return out;
}

function parseSortChain(obj: Record<string, unknown>): SortSpec[] {
  const fallback = (): SortSpec[] => DEFAULT_PRESENTATION.sort.map((s) => ({ ...s }));
  if (Array.isArray(obj.sort)) {
    const chain = obj.sort
      .map((raw): SortSpec | null => {
        const s = asRecord(raw);
        if (typeof s.field !== 'string' || s.field.trim() === '') return null;
        return { field: s.field.trim(), dir: s.dir === 'asc' ? 'asc' : 'desc' };
      })
      .filter((s): s is SortSpec => s !== null);
    return chain.length > 0 ? chain : fallback();
  }
  if (obj.orderBy !== undefined) {
    const orderBy = asRecord(obj.orderBy);
    if (typeof orderBy.field === 'string' && orderBy.field.trim() !== '') {
      return [{ field: orderBy.field.trim(), dir: orderBy.dir === 'asc' ? 'asc' : 'desc' }];
    }
  }
  return fallback();
}

function parseColumns(obj: Record<string, unknown>): ColumnSpec[] {
  if (Array.isArray(obj.columns)) {
    return obj.columns
      .map((raw): ColumnSpec | null => {
        if (typeof raw === 'string' && raw.trim() !== '') return { field: raw.trim() };
        const c = asRecord(raw);
        if (typeof c.field !== 'string' || c.field.trim() === '') return null;
        const spec: ColumnSpec = { field: c.field.trim() };
        if (typeof c.width === 'number' && Number.isFinite(c.width)) spec.width = c.width;
        if (c.hidden === true) spec.hidden = true;
        if (c.wrap === true) spec.wrap = true;
        const calc = parseAggregateCalc(c.calc);
        if (calc !== null) spec.calc = calc;
        return spec;
      })
      .filter((c): c is ColumnSpec => c !== null);
  }
  if (Array.isArray(obj.visibleFields)) {
    return obj.visibleFields.map((f) => ({ field: String(f) }));
  }
  return DEFAULT_PRESENTATION.columns.map((c) => ({ ...c }));
}

/** `key_results` (forward) or `{ type, field }` (reverse). The serialized
 * form carries `direction` too; accept it either way. */
function parseChildrenSpec(raw: unknown): ChildrenSpec | null {
  if (typeof raw === 'string' && raw.trim() !== '') {
    return { direction: 'forward', field: raw.trim() };
  }
  const obj = asRecord(raw);
  if (obj.direction === 'forward' && typeof obj.field === 'string' && obj.field !== '') {
    return { direction: 'forward', field: obj.field };
  }
  if (typeof obj.type === 'string' && typeof obj.field === 'string') {
    return { direction: 'reverse', type: obj.type, field: obj.field };
  }
  return null;
}

function parseSource(raw: unknown): ListSource {
  const obj = asRecord(raw);
  return {
    type: typeof obj.type === 'string' && obj.type !== '' ? obj.type : null,
    project: typeof obj.project === 'string' && obj.project !== '' ? obj.project : null,
  };
}

function parseFilterNode(raw: unknown, path: Set<unknown>): FilterRule | FilterGroup | null {
  const obj = asRecord(raw);
  if (Array.isArray(obj.all) || Array.isArray(obj.any)) return parseGroupNode(raw, path);
  if (typeof obj.field === 'string' && KNOWN_OPS.has(obj.op as FilterOp)) {
    const rule: FilterRule = { field: obj.field, op: obj.op as FilterOp };
    if (obj.value !== undefined) rule.value = obj.value as Scalar | Scalar[];
    return rule;
  }
  return null;
}

// Cycle guard (note 13): YAML aliases can make a group node contain itself
// (`filters: &a { all: [ *a ] }`) — recursing into it again would never
// terminate. `path` tracks the group nodes on the current descent; a node
// already on the path is a cycle and is dropped like any malformed node.
// Nodes are removed on the way out so non-cyclic alias reuse still parses.
function parseGroupNode(raw: unknown, path: Set<unknown>): FilterGroup | null {
  const obj = asRecord(raw);
  const branch = Array.isArray(obj.all) ? 'all' : Array.isArray(obj.any) ? 'any' : null;
  if (branch === null) return null;
  if (path.has(obj)) return null;
  path.add(obj);
  const children = (obj[branch] as unknown[])
    .map((node) => parseFilterNode(node, path))
    .filter((node): node is FilterRule | FilterGroup => node !== null);
  path.delete(obj);
  return branch === 'all' ? { all: children } : { any: children };
}

export function parseFilters(raw: unknown): FilterGroup | null {
  return parseGroupNode(raw, new Set());
}

// --- views (M11) -----------------------------------------------------------

/** Slugify a view name into a tab id. */
export function slugifyViewId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A view id not already taken by a sibling tab. */
export function nextViewId(name: string, taken: Iterable<string>): string {
  const base = slugifyViewId(name) || 'view';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Human label for a layout, used to name a view nobody named. */
const LAYOUT_LABEL: Record<ViewType, string> = {
  table: 'Table',
  list: 'List',
  board: 'Board',
  calendar: 'Calendar',
  gantt: 'Gantt',
  timeline: 'Timeline',
  gallery: 'Gallery',
  chart: 'Chart',
  dashboard: 'Dashboard',
  whiteboard: 'Whiteboard',
};

export function layoutLabel(type: ViewType): string {
  return LAYOUT_LABEL[type] ?? 'Table';
}

/**
 * A fresh view tab. `base` seeds it from the view you were looking at, which is
 * what "add a view" means in practice — you want the same columns arranged
 * differently, not a blank slate.
 */
export function newView(
  name: string,
  type: ViewType,
  taken: Iterable<string> = [],
  base?: Presentation,
): ViewDefinition {
  const presentation =
    base === undefined
      ? { ...clonePresentation(DEFAULT_PRESENTATION), type }
      : { ...clonePresentation(base), type };
  const label = name.trim() === '' ? layoutLabel(type) : name.trim();
  return {
    id: nextViewId(label, taken),
    name: label,
    icon: null,
    filters: null,
    presentation,
  };
}

function parseView(raw: unknown, index: number, taken: Set<string>): ViewDefinition {
  const obj = asRecord(raw);
  const presentation = parsePresentation(obj.presentation ?? obj);
  const name =
    typeof obj.name === 'string' && obj.name.trim() !== ''
      ? obj.name.trim()
      : layoutLabel(presentation.type);
  const declared = typeof obj.id === 'string' && obj.id.trim() !== '' ? obj.id.trim() : '';
  // Ids must be unique within the List — they are what a tab is addressed by,
  // and two tabs answering to the same name is a navigation that lands on
  // whichever one sorted first.
  const id =
    declared !== '' && !taken.has(declared)
      ? declared
      : nextViewId(declared !== '' ? declared : name || `view-${index + 1}`, taken);
  taken.add(id);
  return {
    id,
    name,
    icon: typeof obj.icon === 'string' && obj.icon !== '' ? obj.icon : null,
    filters: parseFilters(obj.filters),
    presentation,
  };
}

/**
 * A List's views (M11), migrating the single-view shape every pre-M11 file has.
 *
 * A file with no `views:` carries its `presentation`/`filters` at the top of the
 * definition; those become one view named after their layout. The result is
 * never empty, which is the invariant every consumer relies on.
 */
function parseViews(obj: Record<string, unknown>): ViewDefinition[] {
  if (Array.isArray(obj.views) && obj.views.length > 0) {
    const taken = new Set<string>();
    return obj.views.map((raw, i) => parseView(raw, i, taken));
  }
  const presentation = parsePresentation(obj.presentation);
  return [
    {
      id: 'view',
      name: layoutLabel(presentation.type),
      icon: null,
      filters: parseFilters(obj.filters),
      presentation,
    },
  ];
}

/**
 * Views persisted on a Type doc (M12.3): an array under the `views:`
 * frontmatter key, one entry per tab — the same shape a List keeps. Unlike a
 * List file there is no legacy single-view shape to migrate: absent or
 * malformed simply means "no saved views yet" and the type screen renders
 * its default table.
 */
export function parseViewList(raw: unknown): ViewDefinition[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const taken = new Set<string>();
  return raw.map((r, i) => parseView(r, i, taken));
}

/** ViewDefinition[] → the plain objects stored under `views:` (frontmatter or
 * List YAML alike). Inverse of parseViewList. */
export function serializeViewList(views: ViewDefinition[]): unknown[] {
  return views.map((v) => ({
    id: v.id,
    name: v.name,
    icon: v.icon,
    filters: v.filters,
    presentation: serializePresentation(v.presentation),
  }));
}

const TAB_CONTENT_SET = new Set<string>(TAB_CONTENTS);

/** A view tab's source pointer, judged by VALUE, never by a `kind` key: an
 * object with a non-empty `type` string is a type source (`type` wins when
 * both keys appear — a type IS a database, M39); a non-empty `list` string
 * is a list source, `collection` riding along because list ids are unique
 * per FOLDER (surface.ts doctrine); anything else is `null` — the tab still
 * parses and the RENDERER shows the broken state. Shape-checking only:
 * whether the named type/list still EXISTS is resolution's question, so a
 * well-shaped pointer at a dead target is kept verbatim. */
function parseTabSource(raw: unknown): ViewTabSource | null {
  const obj = asRecord(raw);
  if (typeof obj.type === 'string' && obj.type.trim() !== '') return { type: obj.type.trim() };
  if (typeof obj.list === 'string' && obj.list.trim() !== '') {
    return {
      list: obj.list.trim(),
      collection:
        typeof obj.collection === 'string' && obj.collection.trim() !== ''
          ? obj.collection.trim()
          : null,
    };
  }
  return null;
}

/** A minted `tab-N` id, checked against a `taken` set that already holds
 * every id ANY entry in the list legitimately owns — declared earlier or
 * later — so a blind `tab-${i + 1}` guess can never steal an id another
 * entry declares. */
function mintTabId(i: number, taken: Set<string>): string {
  let n = i + 1;
  while (taken.has(`tab-${n}`)) n += 1;
  return `tab-${n}`;
}

/**
 * Tabs persisted on a Type doc (M44.5): an array under `tabs:`, one entry per
 * record-page tab. Tolerant like every Type-doc block — absent or malformed
 * means "no saved tabs yet" and the page renders its Overview default.
 *
 * Two passes, deliberately: a single forward pass would let a blind mint on
 * entry 1 claim an id entry 3 declares for itself, re-minting the LATER
 * entry instead — and since a tab's id is what `_sections` keys per-record
 * content by, that's not a cosmetic collision, it's content silently
 * reattaching to the wrong tab. Pass one reserves every validly declared id
 * (first occurrence wins a duplicate, same as before); pass two hands each
 * entry its reservation or, lacking one, the first `tab-N` nothing already
 * answers to.
 */
export function parseTabList(raw: unknown): TabDef[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const items = raw.map((r) => asRecord(r));
  const declaredIds = items.map((obj) =>
    typeof obj.id === 'string' && obj.id.trim() !== '' ? obj.id.trim() : '',
  );
  const taken = new Set<string>();
  const owns = declaredIds.map((id) => {
    if (id === '' || taken.has(id)) return false;
    taken.add(id);
    return true;
  });

  return items.map((obj, i) => {
    const id = owns[i] ? declaredIds[i] : mintTabId(i, taken);
    taken.add(id);
    const content: TabDef['content'] =
      typeof obj.content === 'string' && TAB_CONTENT_SET.has(obj.content)
        ? (obj.content as TabDef['content'])
        : 'sections';
    const tab: TabDef = {
      id,
      name:
        typeof obj.name === 'string' && obj.name.trim() !== '' ? obj.name.trim() : `Tab ${i + 1}`,
      icon: typeof obj.icon === 'string' && obj.icon.trim() !== '' ? obj.icon.trim() : null,
      content,
    };
    if (content === 'view') {
      // A view tab MISSING a source still parses — `source: null`, rendered
      // broken — never dropped: dropping would eat the declared id, and the
      // id is what `_sections` keys per-record content by (M45.4).
      tab.source = parseTabSource(obj.source);
      if (typeof obj.view === 'string' && obj.view.trim() !== '') tab.view = obj.view.trim();
      if (obj.scope === 'related') tab.scope = 'related';
    }
    // Non-view tabs SHED stray pointer keys: no arm reads a source on a
    // sections tab, so persisting one would be noise the serializer writes
    // back forever — normalize-on-parse, same as the content fallback.
    return tab;
  });
}

/** TabDef[] → the plain objects stored under `tabs:`. Inverse of parseTabList.
 * The M45.4 pointer keys are emitted only when SET — and a null source
 * serializes as NO source key, not `source: null`: null on disk would be an
 * invented value, and parseTabList regains `source: null` from the absent
 * key on a view tab, so nothing is lost. A list source's `collection` rides
 * along only when non-null, for the same reason. */
export function serializeTabList(tabs: TabDef[]): unknown[] {
  return tabs.map((t) => {
    const out: Record<string, unknown> = {
      id: t.id,
      name: t.name,
      icon: t.icon,
      content: t.content,
    };
    if (t.source != null) {
      out.source =
        'type' in t.source
          ? { type: t.source.type }
          : t.source.collection != null
            ? { list: t.source.list, collection: t.source.collection }
            : { list: t.source.list };
    }
    if (t.view !== undefined) out.view = t.view;
    if (t.scope !== undefined) out.scope = t.scope;
    return out;
  });
}

/** The view a selection names, or the first tab when it names none. */
export function resolveView(def: ListDefinition, viewId?: string | null): ViewDefinition {
  if (viewId != null) {
    const hit = def.views.find((v) => v.id === viewId);
    if (hit !== undefined) return hit;
  }
  return def.views[0];
}

/** Replace one view in a definition, leaving the rest untouched. */
export function replaceView(
  def: ListDefinition,
  viewId: string,
  next: ViewDefinition,
): ListDefinition {
  return { ...def, views: def.views.map((v) => (v.id === viewId ? next : v)) };
}

/** Tolerant by design: a saved view file never fails to load (advisory schema rule). */
export function parseListYaml(
  id: string,
  yamlText: string,
  /**
   * Where the file lives. All three keys are optional so a test can parse a
   * bare string, and a caller that only knows the project (the legacy shape)
   * can still say so.
   */
  location: { project?: string | null; collection?: string | null; path?: string } = {},
): ListFile {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch {
    raw = null;
  }
  const obj = asRecord(raw);
  return {
    id,
    project: location.project ?? null,
    collection: location.collection ?? null,
    // Defaulted rather than required so a test can parse a bare string; the
    // store always passes the real path from the scan.
    path: location.path ?? `${id}.list.yml`,
    definition: {
      name: typeof obj.name === 'string' && obj.name.trim() !== '' ? obj.name : id,
      icon: typeof obj.icon === 'string' ? obj.icon : null,
      color: typeof obj.color === 'string' ? obj.color : null,
      order: typeof obj.order === 'number' ? obj.order : null,
      source: parseSource(obj.source),
      views: parseViews(obj),
    },
  };
}

function serializePresentation(p: Presentation): Record<string, unknown> {
  return {
    type: p.type,
    group: p.group,
    sort: p.sort,
    columns: p.columns,
    ...(p.rowHeight !== undefined ? { rowHeight: p.rowHeight } : {}),
    ...(p.titleWidth !== undefined ? { titleWidth: p.titleWidth } : {}),
    ...(p.frozenColumns !== undefined ? { frozenColumns: p.frozenColumns } : {}),
    ...(p.titlePosition !== undefined && p.titlePosition > 0
      ? { titlePosition: p.titlePosition }
      : {}),
    ...(p.titleCalc !== undefined ? { titleCalc: p.titleCalc } : {}),
    ...(p.chips !== undefined ? { chips: p.chips } : {}),
    ...(p.cardSize !== undefined ? { cardSize: p.cardSize } : {}),
    ...(p.cardPreview !== undefined ? { cardPreview: p.cardPreview } : {}),
    ...(p.colorColumns === true ? { colorColumns: true } : {}),
    // M10 axis configuration — written only when set, so a table's YAML
    // does not carry three keys about date axes it has no use for.
    ...(p.dateField !== undefined ? { dateField: p.dateField } : {}),
    ...(p.zoom !== undefined ? { zoom: p.zoom } : {}),
    ...(p.dependencyField !== undefined ? { dependencyField: p.dependencyField } : {}),
    // Same rule for the layout-specific blocks (M16.22): written only when the
    // layout that reads them has been configured.
    ...(p.gallery !== undefined ? { gallery: p.gallery } : {}),
    ...(p.chart !== undefined ? { chart: p.chart } : {}),
    ...(p.dashboard !== undefined ? { dashboard: p.dashboard } : {}),
    // M29.45: written only once the file exists. A null pointer is the
    // in-memory "create me" state and carries no information worth storing.
    ...(p.whiteboard !== undefined && p.whiteboard.file !== null
      ? { whiteboard: { file: p.whiteboard.file } }
      : {}),
    ...(p.calendarSpan === 'week' ? { calendarSpan: p.calendarSpan } : {}),
    ...(p.showWeekends === false ? { showWeekends: false } : {}),
    ...(p.weekStart === 'monday' ? { weekStart: p.weekStart } : {}),
    ...(p.showTable !== undefined ? { showTable: p.showTable } : {}),
    ...(p.limit !== undefined ? { limit: p.limit } : {}),
  };
}

/**
 * v2 keys only (M9.1), now with M11's `views:` — the legacy single-view keys
 * are read, never written back, so a List converges on one shape the first time
 * it is edited.
 */
export function serializeList(def: ListDefinition): string {
  return stringify({
    name: def.name,
    icon: def.icon,
    color: def.color,
    order: def.order,
    source: def.source,
    views: serializeViewList(def.views),
  });
}
