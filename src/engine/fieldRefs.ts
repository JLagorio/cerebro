/**
 * Every place a stored shape names a field, and what a field rename rewrites
 * (M60.2, DATA-1).
 *
 * A field is named in many places besides its own `fields:` key: a view's
 * filters, sorts, bands, nests, columns, date and dependency axes, gallery
 * cover, chart and dashboard fields; the record layout; other types'
 * rollups and reverse relations. Renaming the key alone left every one of
 * them pointing at nothing, so views went empty. This module is the one
 * classification of those keys and the one walk over them.
 *
 * - The `*_KEYS` tables classify every key of every stored shape as holding
 *   nothing, a field name, a list of field names, a type name, or a nested
 *   shape. Each is `satisfies Record<keyof Shape, Holds>`, so a key added to
 *   a shape fails typecheck until it is classified here, and
 *   `fieldRefs.test.ts` proves the walk reports every classified key.
 * - `viewRefs` lists every name a view stores, in walk order; `mapViewRefs`
 *   rewrites a copy. `refOwner` decides whose field a reference is, so a
 *   rename touches only the references to ITS field.
 * - `planFieldRename` turns a rename into one batch of patch ops (M60.6):
 *   Type docs first, then records, one op per path. What it can't rewrite
 *   safely it flags and leaves alone.
 * - `groupingUses` names every saved view that buckets records by a field
 *   (M60.5): Change type refuses a kind that can't group while one does,
 *   and deleting the field waits while a board or chart does.
 */

import type { BatchOp } from './batch';
import { chainTypes } from './hierarchyOptions';
import { isKnowledgePath } from './okf';
import { buildSchema, serializeLayoutConfig } from './schema';
import { parseTriggers } from './triggers';
import { nestLevels } from './types';
import type {
  ChartSpec,
  ChildrenSpec,
  ColumnSpec,
  DashboardRow,
  DashboardSpec,
  DashboardWidget,
  DashboardWidgetBase,
  DisplayConfig,
  Entry,
  FieldDef,
  FilterGroup,
  FilterRule,
  GallerySpec,
  GroupSpec,
  LayoutConfig,
  LayoutGroup,
  ListDefinition,
  ListFile,
  ListSource,
  Presentation,
  Schema,
  SortSpec,
  TabDef,
  TypeDef,
  ViewDefinition,
  ViewTabSource,
  ViewType,
} from './types';
import { parseViewList, serializeViewList } from './views';

// --- the classification ---------------------------------------------------

/** What one stored key holds. */
export type Holds = 'nothing' | 'field' | 'fields' | 'type' | 'nested';

type WidgetArm<K extends DashboardWidget['kind']> = Exclude<
  keyof Extract<DashboardWidget, { kind: K }>,
  keyof DashboardWidgetBase
>;

export const VIEW_KEYS = {
  id: 'nothing',
  name: 'nothing',
  icon: /* a glyph name, not an Icon call site */ 'nothing',
  filters: 'nested',
  presentation: 'nested',
} as const satisfies Record<keyof ViewDefinition, Holds>;

export const PRESENTATION_KEYS = {
  type: 'nothing',
  group: 'nested',
  sort: 'nested',
  columns: 'nested',
  rowHeight: 'nothing',
  titleWidth: 'nothing',
  frozenColumns: 'nothing',
  titlePosition: 'nothing',
  titleCalc: 'nothing',
  chips: 'nothing',
  cardSize: 'nothing',
  cardPreview: 'nothing',
  colorColumns: 'nothing',
  dateField: 'field',
  zoom: 'nothing',
  dependencyField: 'field',
  gallery: 'nested',
  chart: 'nested',
  dashboard: 'nested',
  whiteboard: 'nothing',
  calendarSpan: 'nothing',
  showWeekends: 'nothing',
  weekStart: 'nothing',
  showTable: 'nothing',
  limit: 'nothing',
} as const satisfies Record<keyof Presentation, Holds>;

/** A nest level's `field` mirrors its `descend.field`, so the walk reports
 * the descent's name once, as the nest; a band level's is the band. */
export const GROUP_KEYS = {
  field: 'field',
  descend: 'nested',
  dir: 'nothing',
  hideEmpty: 'nothing',
} as const satisfies Record<keyof GroupSpec, Holds>;

export const FORWARD_NEST_KEYS = {
  direction: 'nothing',
  field: 'field',
} as const satisfies Record<keyof Extract<ChildrenSpec, { direction: 'forward' }>, Holds>;

export const REVERSE_NEST_KEYS = {
  direction: 'nothing',
  type: 'type',
  field: 'field',
} as const satisfies Record<keyof Extract<ChildrenSpec, { direction: 'reverse' }>, Holds>;

export const SORT_KEYS = {
  field: 'field',
  dir: 'nothing',
} as const satisfies Record<keyof SortSpec, Holds>;

export const COLUMN_KEYS = {
  field: 'field',
  width: 'nothing',
  hidden: 'nothing',
  wrap: 'nothing',
  calc: 'nothing',
} as const satisfies Record<keyof ColumnSpec, Holds>;

/** A rule's `value` is a value, never a name. */
export const FILTER_RULE_KEYS = {
  field: 'field',
  op: 'nothing',
  value: 'nothing',
} as const satisfies Record<keyof FilterRule, Holds>;

export const ALL_GROUP_KEYS = {
  all: 'nested',
} as const satisfies Record<keyof Extract<FilterGroup, { all: unknown }>, Holds>;

export const ANY_GROUP_KEYS = {
  any: 'nested',
} as const satisfies Record<keyof Extract<FilterGroup, { any: unknown }>, Holds>;

export const GALLERY_KEYS = {
  cover: 'field',
  fit: 'nothing',
} as const satisfies Record<keyof GallerySpec, Holds>;

/** `hidden` and `hiddenG` hold band and series VALUES the legend hid. */
export const CHART_KEYS = {
  kind: 'nothing',
  agg: 'nothing',
  value: 'field',
  omitZero: 'nothing',
  horizontal: 'nothing',
  sort: 'nothing',
  cumulative: 'nothing',
  height: 'nothing',
  palette: 'nothing',
  colorByValue: 'nothing',
  hideGrid: 'nothing',
  hideAxis: 'nothing',
  hideLabels: 'nothing',
  smooth: 'nothing',
  area: 'nothing',
  hideDonutCenter: 'nothing',
  legend: 'nothing',
  xField: 'field',
  groupBy: 'field',
  hidden: 'nothing',
  hiddenG: 'nothing',
} as const satisfies Record<keyof ChartSpec, Holds>;

export const DASHBOARD_KEYS = {
  rows: 'nested',
  global: 'nested',
} as const satisfies Record<keyof DashboardSpec, Holds>;

export const DASHBOARD_ROW_KEYS = {
  id: 'nothing',
  h: 'nothing',
  widgets: 'nested',
} as const satisfies Record<keyof DashboardRow, Holds>;

export const WIDGET_BASE_KEYS = {
  id: 'nothing',
  title: 'nothing',
  w: 'nothing',
  filter: 'nested',
} as const satisfies Record<keyof DashboardWidgetBase, Holds>;

/** A `view` widget points at a List by id: no field, no type. */
export const VIEW_WIDGET_KEYS = {
  kind: 'nothing',
  list: 'nothing',
  collection: 'nothing',
  view: 'nothing',
} as const satisfies Record<WidgetArm<'view'>, Holds>;

export const NUMBER_WIDGET_KEYS = {
  kind: 'nothing',
  agg: 'nothing',
  value: 'field',
} as const satisfies Record<WidgetArm<'number'>, Holds>;

export const TABLE_WIDGET_KEYS = {
  kind: 'nothing',
} as const satisfies Record<WidgetArm<'table'>, Holds>;

export const BOARD_WIDGET_KEYS = {
  kind: 'nothing',
  group: 'field',
} as const satisfies Record<WidgetArm<'board'>, Holds>;

export const TIMELINE_WIDGET_KEYS = {
  kind: 'nothing',
} as const satisfies Record<WidgetArm<'timeline'>, Holds>;

export const CHART_WIDGET_KEYS = {
  kind: 'nothing',
  group: 'field',
  chart: 'nested',
} as const satisfies Record<WidgetArm<'chart'>, Holds>;

export const LAYOUT_KEYS = {
  heading: 'fields',
  groups: 'nested',
} as const satisfies Record<keyof LayoutConfig, Holds>;

export const LAYOUT_GROUP_KEYS = {
  id: 'nothing',
  name: 'nothing',
  fields: 'fields',
} as const satisfies Record<keyof LayoutGroup, Holds>;

/** A tab holds no field name: `scope: related` finds its relation by target. */
export const TAB_KEYS = {
  id: 'nothing',
  name: 'nothing',
  icon: /* a glyph name, not an Icon call site */ 'nothing',
  content: 'nothing',
  source: 'nested',
  view: 'nothing',
  scope: 'nothing',
} as const satisfies Record<keyof TabDef, Holds>;

export const TYPE_TAB_SOURCE_KEYS = {
  type: 'type',
} as const satisfies Record<keyof Extract<ViewTabSource, { type: string }>, Holds>;

export const LIST_TAB_SOURCE_KEYS = {
  list: 'nothing',
  collection: 'nothing',
} as const satisfies Record<keyof Extract<ViewTabSource, { list: string }>, Holds>;

/** `name` is the `fields:` key itself. */
export const FIELD_DEF_KEYS = {
  name: 'field',
  kind: 'nothing',
  options: 'nothing',
  target: 'type',
  limit: 'nothing',
  relation: 'field',
  from: 'nested',
  property: 'field',
  calculate: 'nothing',
  format: 'nothing',
  precision: 'nothing',
  dateFormat: 'nothing',
  timeFormat: 'nothing',
  visibility: 'nothing',
} as const satisfies Record<keyof FieldDef, Holds>;

export const FIELD_FROM_KEYS = {
  type: 'type',
  field: 'field',
} as const satisfies Record<keyof NonNullable<FieldDef['from']>, Holds>;

/** `name` is the type's own name, its identity rather than a reference. */
export const TYPE_DEF_KEYS = {
  name: 'nothing',
  icon: /* a glyph name, not an Icon call site */ 'nothing',
  color: 'nothing',
  fields: 'nested',
  statuses: 'nothing',
  folder: 'nothing',
  views: 'nested',
  display: 'nested',
  layout: 'nested',
  tabs: 'nested',
} as const satisfies Record<keyof TypeDef, Holds>;

export const DISPLAY_KEYS = {
  showEmpty: 'nothing',
  showFile: 'nothing',
  showBody: 'nothing',
} as const satisfies Record<keyof DisplayConfig, Holds>;

export const LIST_KEYS = {
  name: 'nothing',
  icon: /* a glyph name, not an Icon call site */ 'nothing',
  color: 'nothing',
  order: 'nothing',
  source: 'nested',
  views: 'nested',
} as const satisfies Record<keyof ListDefinition, Holds>;

export const LIST_SOURCE_KEYS = {
  type: 'type',
  project: 'nothing',
} as const satisfies Record<keyof ListSource, Holds>;

/** Every table, by the shape it classifies. */
export const SHAPES = {
  ViewDefinition: VIEW_KEYS,
  Presentation: PRESENTATION_KEYS,
  GroupSpec: GROUP_KEYS,
  ForwardNest: FORWARD_NEST_KEYS,
  ReverseNest: REVERSE_NEST_KEYS,
  SortSpec: SORT_KEYS,
  ColumnSpec: COLUMN_KEYS,
  FilterRule: FILTER_RULE_KEYS,
  AllGroup: ALL_GROUP_KEYS,
  AnyGroup: ANY_GROUP_KEYS,
  GallerySpec: GALLERY_KEYS,
  ChartSpec: CHART_KEYS,
  DashboardSpec: DASHBOARD_KEYS,
  DashboardRow: DASHBOARD_ROW_KEYS,
  DashboardWidgetBase: WIDGET_BASE_KEYS,
  ViewWidget: VIEW_WIDGET_KEYS,
  NumberWidget: NUMBER_WIDGET_KEYS,
  TableWidget: TABLE_WIDGET_KEYS,
  BoardWidget: BOARD_WIDGET_KEYS,
  TimelineWidget: TIMELINE_WIDGET_KEYS,
  ChartWidget: CHART_WIDGET_KEYS,
  LayoutConfig: LAYOUT_KEYS,
  LayoutGroup: LAYOUT_GROUP_KEYS,
  TabDef: TAB_KEYS,
  TypeTabSource: TYPE_TAB_SOURCE_KEYS,
  ListTabSource: LIST_TAB_SOURCE_KEYS,
  FieldDef: FIELD_DEF_KEYS,
  FieldFrom: FIELD_FROM_KEYS,
  TypeDef: TYPE_DEF_KEYS,
  DisplayConfig: DISPLAY_KEYS,
  ListDefinition: LIST_KEYS,
  ListSource: LIST_SOURCE_KEYS,
} as const satisfies Record<string, Record<string, Holds>>;

// --- the walk over a view -------------------------------------------------

/** Where in a view a name is stored. A closed list. */
export type RefPosition =
  | 'filter'
  | 'sort'
  | 'band'
  | 'nest'
  | 'column'
  | 'dateField'
  | 'dependencyField'
  | 'galleryCover'
  | 'chartValue'
  | 'chartAxis'
  | 'chartSeries'
  | 'dashboardFilter'
  | 'widgetFilter'
  | 'widgetValue'
  | 'widgetGroup';

/** One name a view stores. */
export interface ViewRef {
  name: string;
  /** A field name, or (a reverse nest's `type`) a type name. */
  holds: 'field' | 'type';
  position: RefPosition;
  /** A band's index among the band levels; a nest's among the nest levels. */
  level?: number;
  /** A filter rule's child indices, from its root group down. */
  filterPath?: number[];
  /** The dashboard widget holding it, by id. */
  widget?: string;
}

/** Called once per name, in walk order; answers the name to store. */
type Visit = (ref: ViewRef) => string;

const isRule = (node: FilterRule | FilterGroup): node is FilterRule =>
  'field' in node && 'op' in node;

function walkGroup(
  group: FilterGroup,
  at: { position: RefPosition; widget?: string },
  visit: Visit,
  path: number[],
): FilterGroup {
  const all = 'all' in group;
  const kids = (all ? group.all : group.any).map((kid, i): FilterRule | FilterGroup => {
    const here = [...path, i];
    if (!isRule(kid)) return walkGroup(kid, at, visit, here);
    const field = visit({ name: kid.field, holds: 'field', ...at, filterPath: here });
    return { ...kid, field };
  });
  return all ? { all: kids } : { any: kids };
}

function walkChart(chart: ChartSpec, visit: Visit, widget?: string): ChartSpec {
  const at = widget === undefined ? {} : { widget };
  const out: ChartSpec = { ...chart };
  if (chart.value !== undefined) {
    out.value = visit({ name: chart.value, holds: 'field', position: 'chartValue', ...at });
  }
  if (chart.xField !== undefined) {
    out.xField = visit({ name: chart.xField, holds: 'field', position: 'chartAxis', ...at });
  }
  if (chart.groupBy !== undefined) {
    out.groupBy = visit({ name: chart.groupBy, holds: 'field', position: 'chartSeries', ...at });
  }
  return out;
}

function walkWidget(w: DashboardWidget, visit: Visit): DashboardWidget {
  const filter =
    w.filter === undefined
      ? {}
      : { filter: walkGroup(w.filter, { position: 'widgetFilter', widget: w.id }, visit, []) };
  const group = (name: string) =>
    visit({ name, holds: 'field', position: 'widgetGroup', widget: w.id });
  switch (w.kind) {
    case 'number':
      return {
        ...w,
        ...filter,
        ...(w.value === undefined
          ? {}
          : {
              value: visit({
                name: w.value,
                holds: 'field',
                position: 'widgetValue',
                widget: w.id,
              }),
            }),
      };
    case 'board':
      return { ...w, ...filter, ...(w.group === undefined ? {} : { group: group(w.group) }) };
    case 'chart':
      return {
        ...w,
        ...filter,
        ...(w.group === undefined ? {} : { group: group(w.group) }),
        ...(w.chart === undefined ? {} : { chart: walkChart(w.chart, visit, w.id) }),
      };
    case 'view':
    case 'table':
    case 'timeline':
      return { ...w, ...filter };
  }
}

function walkLevel(g: GroupSpec, counters: { band: number; nest: number }, visit: Visit) {
  if (g.descend === undefined) {
    const level = counters.band++;
    return { ...g, field: visit({ name: g.field, holds: 'field', position: 'band', level }) };
  }
  const level = counters.nest++;
  const d = g.descend;
  if (d.direction === 'forward') {
    const field = visit({ name: d.field, holds: 'field', position: 'nest', level });
    return { ...g, field, descend: { ...d, field } };
  }
  const type = visit({ name: d.type, holds: 'type', position: 'nest', level });
  const field = visit({ name: d.field, holds: 'field', position: 'nest', level });
  return { ...g, field, descend: { ...d, type, field } };
}

function walkPresentation(p: Presentation, visit: Visit): Presentation {
  const counters = { band: 0, nest: 0 };
  const group = p.group.map((g) => walkLevel(g, counters, visit));
  const sort = p.sort.map((s) => ({
    ...s,
    field: visit({ name: s.field, holds: 'field', position: 'sort' }),
  }));
  const columns = p.columns.map((c) => ({
    ...c,
    field: visit({ name: c.field, holds: 'field', position: 'column' }),
  }));
  const out: Presentation = { ...p, group, sort, columns };
  if (p.dateField !== undefined) {
    out.dateField = visit({ name: p.dateField, holds: 'field', position: 'dateField' });
  }
  if (p.dependencyField !== undefined) {
    out.dependencyField = visit({
      name: p.dependencyField,
      holds: 'field',
      position: 'dependencyField',
    });
  }
  if (p.gallery !== undefined) {
    const cover = p.gallery.cover;
    out.gallery =
      cover === undefined
        ? { ...p.gallery }
        : {
            ...p.gallery,
            cover: visit({ name: cover, holds: 'field', position: 'galleryCover' }),
          };
  }
  if (p.chart !== undefined) out.chart = walkChart(p.chart, visit);
  if (p.dashboard !== undefined) {
    const d = p.dashboard;
    const rows = d.rows.map((r) => ({ ...r, widgets: r.widgets.map((w) => walkWidget(w, visit)) }));
    out.dashboard =
      d.global === undefined
        ? { ...d, rows }
        : {
            ...d,
            rows,
            global: walkGroup(d.global, { position: 'dashboardFilter' }, visit, []),
          };
  }
  return out;
}

function walkView(view: ViewDefinition, visit: Visit): ViewDefinition {
  const filters =
    view.filters == null ? null : walkGroup(view.filters, { position: 'filter' }, visit, []);
  return { ...view, filters, presentation: walkPresentation(view.presentation, visit) };
}

/** Every name `view` stores, in walk order. */
export function viewRefs(view: ViewDefinition): ViewRef[] {
  const out: ViewRef[] = [];
  walkView(view, (ref) => {
    out.push(ref);
    return ref.name;
  });
  return out;
}

/** A copy of `view` with each name replaced by `fn`'s answer for it. A nest
 * level keeps `field === descend.field`. */
export function mapViewRefs(view: ViewDefinition, fn: (ref: ViewRef) => string): ViewDefinition {
  return walkView(view, fn);
}

/** The filter rule a filter-position ref names, or null. */
export function ruleAt(view: ViewDefinition, ref: ViewRef): FilterRule | null {
  if (ref.filterPath === undefined) return null;
  let root: FilterGroup | null | undefined = null;
  if (ref.position === 'filter') root = view.filters;
  else if (ref.position === 'dashboardFilter') root = view.presentation.dashboard?.global;
  else if (ref.position === 'widgetFilter') {
    const widgets = view.presentation.dashboard?.rows.flatMap((r) => r.widgets) ?? [];
    root = widgets.find((w) => w.id === ref.widget)?.filter;
  }
  let node: FilterRule | FilterGroup | null | undefined = root;
  for (const i of ref.filterPath) {
    if (node === null || node === undefined || isRule(node)) return null;
    node = ('all' in node ? node.all : node.any)[i];
  }
  return node !== null && node !== undefined && isRule(node) ? node : null;
}

// --- the walk over a Type doc and a List ------------------------------------

/** Where outside a view's presentation a name is stored. */
export type SchemaPosition =
  | 'fieldName'
  | 'fieldTarget'
  | 'rollupRelation'
  | 'rollupProperty'
  | 'fromType'
  | 'fromField'
  | 'layoutHeading'
  | 'layoutGroup'
  | 'tabSource'
  | 'listSource';

/** One name a Type doc or a List stores: a view's refs carry the view's id. */
export interface StoredRef extends Omit<ViewRef, 'holds' | 'position'> {
  holds: 'field' | 'fields' | 'type';
  position: RefPosition | SchemaPosition;
  /** The view holding it, by id. */
  view?: string;
  /** The `fields:` key whose spec holds it. */
  field?: string;
}

const inView = (view: ViewDefinition): StoredRef[] =>
  viewRefs(view).map((ref) => ({ ...ref, view: view.id }));

/** Every name a parsed Type doc stores, in walk order. */
export function typeDefRefs(def: TypeDef): StoredRef[] {
  const out: StoredRef[] = [];
  for (const f of def.fields) {
    const at = { field: f.name };
    out.push({ name: f.name, holds: 'field', position: 'fieldName', ...at });
    if (f.target !== undefined) {
      out.push({ name: f.target, holds: 'type', position: 'fieldTarget', ...at });
    }
    if (f.relation !== undefined) {
      out.push({ name: f.relation, holds: 'field', position: 'rollupRelation', ...at });
    }
    if (f.from !== undefined) {
      out.push({ name: f.from.type, holds: 'type', position: 'fromType', ...at });
      out.push({ name: f.from.field, holds: 'field', position: 'fromField', ...at });
    }
    if (f.property !== undefined) {
      out.push({ name: f.property, holds: 'field', position: 'rollupProperty', ...at });
    }
  }
  for (const view of def.views) out.push(...inView(view));
  for (const name of def.layout.heading) {
    out.push({ name, holds: 'fields', position: 'layoutHeading' });
  }
  for (const group of def.layout.groups) {
    for (const name of group.fields) out.push({ name, holds: 'fields', position: 'layoutGroup' });
  }
  for (const tab of def.tabs) {
    if (tab.source != null && 'type' in tab.source) {
      out.push({ name: tab.source.type, holds: 'type', position: 'tabSource' });
    }
  }
  return out;
}

/** Every name a List stores, in walk order. */
export function listRefs(def: ListDefinition): StoredRef[] {
  const out: StoredRef[] = [];
  if (def.source.type !== null) {
    out.push({ name: def.source.type, holds: 'type', position: 'listSource' });
  }
  for (const view of def.views) out.push(...inView(view));
  return out;
}

// --- whose field a reference is -------------------------------------------

/** Who owns a reference: one type, several that can't be told apart, or
 * nobody (no type in the chain declares it, or it names a type). */
export type RefOwner = { owner: string } | { ambiguous: string[] } | null;

/** Positions that read the view's own source records first. Columns and
 * the date and dependency axes read whichever row they sit on. */
const SOURCE_SCOPED: ReadonlySet<RefPosition> = new Set<RefPosition>([
  'filter',
  'sort',
  'band',
  'galleryCover',
  'chartValue',
  'chartAxis',
  'chartSeries',
  'dashboardFilter',
  'widgetFilter',
  'widgetValue',
  'widgetGroup',
]);

/** The view a ref was read from, and the source it looks at. */
export interface RefScope {
  source: ListSource;
  group: GroupSpec[];
}

const declares = (schema: Schema, type: string, name: string): boolean =>
  schema.types.get(type)?.fields.some((f) => f.name === name) ?? false;

/**
 * Whose field `ref` names. A nest's owner is exact: a reverse nest's own
 * `type`, a forward nest's the chain type holding the relation. Anything else
 * belongs to the one type in the view's chain that declares it; when several
 * do, a source-scoped ref belongs to the source if the source declares it,
 * and is otherwise ambiguous.
 */
export function refOwner(ref: ViewRef, scope: RefScope, schema: Schema): RefOwner {
  if (ref.holds !== 'field') return null;
  const nests = nestLevels(scope.group);
  const chain = chainTypes(scope.source.type, nests, schema);
  if (ref.position === 'nest') {
    const level = ref.level ?? -1;
    const spec = nests[level];
    if (spec === undefined) return null;
    if (spec.direction === 'reverse') return { owner: spec.type };
    const holder = chain[level];
    return holder === null || holder === undefined ? null : { owner: holder };
  }
  const types = [...new Set(chain.filter((t): t is string => t !== null))];
  const declarers = types.filter((t) => declares(schema, t, ref.name));
  if (declarers.length === 0) return null;
  if (declarers.length === 1) return { owner: declarers[0] };
  const source = scope.source.type;
  if (SOURCE_SCOPED.has(ref.position) && source !== null && declarers.includes(source)) {
    return { owner: source };
  }
  return { ambiguous: declarers };
}

const ownedBy = (owner: RefOwner, type: string): boolean =>
  owner !== null && 'owner' in owner && owner.owner === type;

const maybeOwnedBy = (owner: RefOwner, type: string): boolean =>
  owner !== null && 'ambiguous' in owner && owner.ambiguous.includes(type);

// --- the rename plan ------------------------------------------------------

/** Why a reference was left as it was. */
export type RenameFlagKind =
  'list' | 'trigger' | 'untargetedRollup' | 'ambiguous' | 'knowledge' | 'yamlError';

/** One reference a rename left as it was, and the file holding it. */
export interface RenameFlag {
  kind: RenameFlagKind;
  path: string;
  /** The view or field it sits in, when there is one. */
  detail?: string;
}

export interface RenameCounts {
  /** Type docs the batch rewrites. */
  typeDocs: number;
  /** Saved views whose stored names change. */
  views: number;
  /** Records and templates whose value moves to the new key. */
  records: number;
}

export type RenamePlan =
  | { ok: true; ops: BatchOp[]; flagged: RenameFlag[]; counts: RenameCounts }
  | { ok: false; refusal: { code: 'collision'; holders: number } };

export interface RenameRequest {
  /** The type whose field is renamed. */
  type: string;
  /** The `fields:` key as declared. */
  from: string;
  /** The new key, already normalized. */
  to: string;
}

export interface RenameVault {
  entries: Entry[];
  schema: Schema;
  lists: ListFile[];
}

const asObject = (raw: unknown): Record<string, unknown> | null =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;

const holdsKey = (e: Entry, key: string): boolean => key in e.properties || key in e.relationships;

/** The Type doc declaring `type`: exact title first, then ignoring case. */
function typeDocOf(entries: Entry[], type: string): Entry | null {
  return (
    entries.find((e) => e.type === 'Type' && e.title === type) ??
    entries.find((e) => e.type === 'Type' && e.title.toLowerCase() === type.toLowerCase()) ??
    null
  );
}

/** The type a relation's records are: its target, or a derived relation's
 * source type. Undefined when it names neither. */
const relationTargetOf = (rel: FieldDef): string | undefined => rel.target ?? rel.from?.type;

/**
 * The `fields:` mapping of a Type doc after the rename, from a copy of its
 * raw specs so keys the model does not parse survive. Answers null when
 * nothing changes.
 */
function renamedFields(
  doc: Entry,
  def: TypeDef | undefined,
  own: boolean,
  req: RenameRequest,
  flag: (kind: RenameFlagKind, detail: string) => void,
): Record<string, unknown> | null {
  const raw = asObject((doc.properties as Record<string, unknown>).fields);
  if (raw === null) return null;
  const { type, from, to } = req;
  const declared = (name: string) => def?.fields.find((f) => f.name === name);
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(raw)) {
    const key = own && name === from ? to : name;
    if (key !== name) changed = true;
    const f = declared(name);
    const obj = asObject(spec);
    if (f === undefined || obj === null) {
      out[key] = spec;
      continue;
    }
    const next: Record<string, unknown> = { ...obj };
    if (f.kind === 'rollup' && f.relation === from && own) next.relation = to;
    if (f.kind === 'rollup' && f.from === undefined && f.relation !== undefined) {
      const rel = declared(f.relation);
      const target = rel === undefined ? undefined : relationTargetOf(rel);
      if (f.property === from && target === type) next.property = to;
      else if (f.property === from && rel !== undefined && target === undefined) {
        flag('untargetedRollup', name);
      }
    }
    if (f.from !== undefined && f.from.type === type) {
      if (f.from.field === from) next.from = { ...asObject(obj.from), field: to };
      if (f.kind === 'rollup' && f.property === from) next.property = to;
    }
    if (JSON.stringify(next) !== JSON.stringify(obj)) changed = true;
    out[key] = next;
  }
  return changed ? out : null;
}

/** The layout after the rename, or null when it names no `from`. */
function renamedLayout(layout: LayoutConfig, from: string, to: string): LayoutConfig | null {
  const swap = (names: string[]) => names.map((n) => (n === from ? to : n));
  const next: LayoutConfig = {
    heading: swap(layout.heading),
    groups: layout.groups.map((g) => ({ ...g, fields: swap(g.fields) })),
  };
  return JSON.stringify(next) === JSON.stringify(layout) ? null : next;
}

/**
 * A record's value for `key` as frontmatter spells it. The scan hands links
 * back bracket-stripped, so they are re-wrapped: one link as a scalar, the
 * way a single relation or person is written, several as a list. A list
 * that held one link comes back a scalar, which reads the same.
 */
function storedValue(record: Entry, key: string): unknown {
  const targets = record.relationships[key];
  if (targets === undefined) return record.properties[key];
  const links = targets.map((t) => `[[${t}]]`);
  return links.length === 1 ? links[0] : links;
}

const patchOp = (entry: Entry, set: Record<string, unknown>): BatchOp =>
  entry.hash === null
    ? { op: 'patch', path: entry.path, set }
    : { op: 'patch', path: entry.path, set, expectHash: entry.hash };

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/**
 * Plan renaming `type`'s field `from` to `to` as one batch.
 *
 * Refused whole as `collision` when a record of the type already holds `to`:
 * the move would overwrite its value. Otherwise, one patch op per path, Type
 * docs first and then records, each sorted by path and hashed when the scan
 * knows the bytes (D2 (c)):
 *
 * - the type's own doc: the key renamed in place, and its layout;
 * - every Type doc: a rollup's `relation` on the type itself, a rollup's
 *   `property` read through a relation that targets the type, a `from` that
 *   points at the field, a reverse rollup's `property`, and every saved view's
 *   references the owner rule gives to the type;
 * - every record and template of the type outside knowledge/: the value moved
 *   from `from` to `to` (`storedValue`).
 *
 * Flagged and never written: List files that name it, Agent triggers that
 * name it (a trigger names a field without a type), rollups reading it
 * through a relation with no target, view references several chain types
 * could own, knowledge/ pages, and Type docs with YAML errors.
 */
export function planFieldRename(req: RenameRequest, vault: RenameVault): RenamePlan {
  const { type, from, to } = req;
  const { entries, schema, lists } = vault;
  const own = typeDocOf(entries, type);
  const ownName = own?.title ?? type;
  const flagged: RenameFlag[] = [];

  const records = entries.filter((e) => e.type === type && e.type !== 'Type' && e !== own);
  const holders = records.filter((e) => holdsKey(e, to)).length;
  if (holders > 0) return { ok: false, refusal: { code: 'collision', holders } };

  const docOps: BatchOp[] = [];
  let views = 0;
  const typeDocs = entries.filter((e) => e.type === 'Type').sort(byPath);
  for (const doc of typeDocs) {
    const isOwn = doc === own;
    if (doc.parseError !== null) {
      if (!isOwn) flagged.push({ kind: 'yamlError', path: doc.path });
      continue;
    }
    const def = schema.types.get(doc.title);
    const docFlags: RenameFlag[] = [];
    const set: Record<string, unknown> = {};
    const fields = renamedFields(doc, def, isOwn, { type: ownName, from, to }, (kind, detail) =>
      docFlags.push({ kind, path: doc.path, detail }),
    );
    if (fields !== null) set.fields = fields;

    const stored = def?.views ?? [];
    let viewsChanged = 0;
    const next = stored.map((view) => {
      const scope: RefScope = {
        source: { type: doc.title, project: null },
        group: view.presentation.group,
      };
      const mapped = mapViewRefs(view, (ref) => {
        if (ref.holds !== 'field' || ref.name !== from) return ref.name;
        const owner = refOwner(ref, scope, schema);
        if (ownedBy(owner, ownName)) return to;
        if (maybeOwnedBy(owner, ownName)) {
          docFlags.push({ kind: 'ambiguous', path: doc.path, detail: view.id });
        }
        return ref.name;
      });
      if (JSON.stringify(mapped) !== JSON.stringify(view)) viewsChanged += 1;
      return mapped;
    });
    if (viewsChanged > 0) set.views = serializeViewList(next);

    if (isOwn && def !== undefined) {
      const layout = renamedLayout(def.layout, from, to);
      if (layout !== null) set.layout = serializeLayoutConfig(layout);
    }

    const writes = Object.keys(set).length > 0;
    if (writes && !isOwn && isKnowledgePath(doc.path)) {
      flagged.push({ kind: 'knowledge', path: doc.path });
      continue;
    }
    flagged.push(...docFlags);
    if (!writes) continue;
    views += viewsChanged;
    docOps.push(patchOp(doc, set));
  }

  const recordOps: BatchOp[] = [];
  for (const record of [...records].sort(byPath)) {
    if (!holdsKey(record, from)) continue;
    if (isKnowledgePath(record.path)) {
      flagged.push({ kind: 'knowledge', path: record.path });
      continue;
    }
    recordOps.push(patchOp(record, { [to]: storedValue(record, from), [from]: null }));
  }

  for (const agent of entries.filter((e) => e.type === 'Agent').sort(byPath)) {
    const when = (agent.properties as Record<string, unknown>).when;
    if (parseTriggers(when).some((t) => t.field === from)) {
      flagged.push({ kind: 'trigger', path: agent.path });
    }
  }

  for (const list of [...lists].sort(byPath)) {
    const source = list.definition.source;
    const names = list.definition.views.some((view) =>
      viewRefs(view).some((ref) => {
        if (ref.holds !== 'field' || ref.name !== from) return false;
        if (source.type === null) return true;
        const owner = refOwner(ref, { source, group: view.presentation.group }, schema);
        return ownedBy(owner, ownName) || maybeOwnedBy(owner, ownName);
      }),
    );
    if (names) flagged.push({ kind: 'list', path: list.path });
  }

  return {
    ok: true,
    ops: [...docOps, ...recordOps],
    flagged: dedupeFlags(flagged),
    counts: { typeDocs: docOps.length, views, records: recordOps.length },
  };
}

function dedupeFlags(flags: RenameFlag[]): RenameFlag[] {
  const seen = new Set<string>();
  return flags.filter((f) => {
    const key = `${f.kind}\u0000${f.path}\u0000${f.detail ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a refused rename says. */
export function renameRefusalWords(holders: number, to: string): string {
  const who = holders === 1 ? '1 record already has' : `${holders} records already have`;
  return `${who} “${to}”. Nothing was renamed.`;
}

/** What a rename that left references alone says, one sentence per kind in
 * a fixed order, or null when it flagged nothing. */
export function renameFlagWords(flags: RenameFlag[], from: string): string | null {
  const n = (kind: RenameFlagKind) => flags.filter((f) => f.kind === kind).length;
  const lines: string[] = [];
  const list = n('list');
  if (list > 0) {
    lines.push(`${count(list, 'list file still names', 'list files still name')} “${from}”.`);
  }
  const trigger = n('trigger');
  if (trigger > 0) {
    lines.push(
      `${count(trigger, 'agent trigger still names', 'agent triggers still name')} “${from}”.`,
    );
  }
  const rollup = n('untargetedRollup');
  if (rollup > 0) {
    lines.push(
      `${count(rollup, 'rollup reads', 'rollups read')} “${from}” through a relation with no target.`,
    );
  }
  const ambiguous = n('ambiguous');
  if (ambiguous > 0) {
    lines.push(
      `${count(ambiguous, 'view names', 'views name')} a “${from}” more than one type declares.`,
    );
  }
  const knowledge = n('knowledge');
  if (knowledge > 0) {
    lines.push(
      `${count(knowledge, 'knowledge page still holds', 'knowledge pages still hold')} “${from}”.`,
    );
  }
  const yaml = n('yamlError');
  if (yaml > 0) {
    lines.push(
      `${count(yaml, 'type doc has YAML errors and was', 'type docs have YAML errors and were')} not checked.`,
    );
  }
  return lines.length === 0 ? null : lines.map((l) => `Not changed: ${l}`).join(' ');
}

// --- groupings ------------------------------------------------------------

/** How a view uses the field to bucket its records. */
export type GroupingRole = 'group' | 'chart-axis' | 'chart-series';

/** One view that groups by the field. */
export interface GroupingUse {
  /** The file holding the view: the Type doc's path, or the List file's. */
  file: string;
  viewId: string;
  /** The view's name, as its tab shows it. */
  view: string;
  layout: ViewType;
  role: GroupingRole;
  /** The dashboard widget that groups, or null for the view itself. */
  widget: string | null;
}

const SCHEMAS = new WeakMap<Entry[], Schema>();

function schemaOf(entries: Entry[]): Schema {
  let schema = SCHEMAS.get(entries);
  if (schema === undefined) {
    schema = buildSchema(entries);
    SCHEMAS.set(entries, schema);
  }
  return schema;
}

function usesIn(
  file: string,
  views: ViewDefinition[],
  source: ListSource,
  type: string,
  field: string,
  schema: Schema,
): GroupingUse[] {
  const out: GroupingUse[] = [];
  const statusField =
    source.type === null
      ? undefined
      : schema.types.get(source.type)?.fields.find((f) => f.kind === 'status')?.name;
  for (const v of views) {
    const p = v.presentation;
    const scope: RefScope = { source, group: p.group };
    const mine = (ref: ViewRef) => {
      if (ref.holds !== 'field' || ref.name !== field) return false;
      const owner = refOwner(ref, scope, schema);
      return ownedBy(owner, type) || maybeOwnedBy(owner, type);
    };
    const refs = viewRefs(v).filter(mine);
    const at = (role: GroupingRole, widget: string | null = null) =>
      out.push({ file, viewId: v.id, view: v.name, layout: p.type, role, widget });
    const own = (position: RefPosition) =>
      refs.some((r) => r.position === position && r.widget === undefined);
    if (own('band')) at('group');
    if (own('chartAxis')) at('chart-axis');
    if (own('chartSeries')) at('chart-series');
    for (const row of p.dashboard?.rows ?? []) {
      for (const w of row.widgets) {
        const of = (position: RefPosition) =>
          refs.some((r) => r.position === position && r.widget === w.id);
        // A board widget naming no group bands by its source's status field.
        const byDefault =
          w.kind === 'board' &&
          w.group === undefined &&
          statusField === field &&
          source.type === type;
        if (of('widgetGroup') || byDefault) at('group', w.id);
        if (of('chartAxis')) at('chart-axis', w.id);
        if (of('chartSeries')) at('chart-series', w.id);
      }
    }
  }
  return out;
}

/**
 * Every saved view that groups the records of `typeName` by its field
 * `field`: a band level of its grouping chain (table, list, board, gantt and
 * the chart's default axis all read it), a chart's own axis or series, and a
 * dashboard widget's board or chart grouping (a board widget naming none
 * bands by its source's status field). A level that DESCENDS a relation is
 * not a grouping by value, so it is not counted.
 *
 * It reads every Type doc's views and every List, and counts a reference
 * when `refOwner` gives it to the type (or can't tell it from another type
 * that declares the same name): a view over another type reaches this one
 * through its nesting chain.
 */
export function groupingUses(
  entries: Entry[],
  lists: ListFile[],
  typeName: string,
  field: string,
  schema: Schema = schemaOf(entries),
): GroupingUse[] {
  const out: GroupingUse[] = [];
  const own = typeDocOf(entries, typeName);
  const type = own?.title ?? typeName;
  const docs = entries.filter((e) => e.type === 'Type');
  for (const doc of own === null ? docs : [own, ...docs.filter((d) => d !== own)]) {
    const raw = (doc.properties as Record<string, unknown>).views;
    const source = { type: doc.title, project: null };
    out.push(...usesIn(doc.path, parseViewList(raw), source, type, field, schema));
  }
  for (const list of lists) {
    const source = list.definition.source;
    if (source.type === null) continue;
    out.push(...usesIn(list.path, list.definition.views, source, type, field, schema));
  }
  return out;
}

/** The groupings that block deleting a field: boards and charts, as views
 * or as dashboard widgets. A table or list band falls back to raw values. */
export function deleteBlockers(uses: GroupingUse[]): GroupingUse[] {
  return uses.filter((u) =>
    u.widget === null ? u.layout === 'board' || u.layout === 'chart' : u.layout === 'dashboard',
  );
}

/** What a refused delete says, naming the first blocking view. */
export function deleteBlockedWords(field: string, blockers: GroupingUse[]): string {
  const views = [...new Map(blockers.map((u) => [`${u.file}\u0000${u.viewId}`, u])).values()];
  const first = views[0];
  const noun = first.widget !== null ? 'dashboard' : first.layout;
  const more = views.length - 1;
  return more === 0
    ? `Can't delete “${field}”: the ${noun} “${first.view}” groups by it. Regroup that view first.`
    : `Can't delete “${field}”: the ${noun} “${first.view}” and ${more} more group by it. Regroup those views first.`;
}
