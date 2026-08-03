import { parse, stringify } from 'yaml';
import type {
  ChildrenSpec,
  ChipStyle,
  ColumnSpec,
  FilterGroup,
  FilterOp,
  FilterRule,
  GroupSpec,
  Presentation,
  Scalar,
  SortSpec,
  ListDefinition,
  ListFile,
  ListSource,
  ViewDefinition,
  ViewType,
} from './types';
import { VIEW_TYPES } from './types';

/** Project default: list grouped by status, modified desc (spec "Collections and views"). */
export const DEFAULT_PRESENTATION: Presentation = {
  type: 'list',
  group: [{ field: 'status' }],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [
    { field: 'key' },
    { field: 'status' },
    { field: 'priority' },
    { field: 'assignee' },
    { field: 'due' },
    { field: 'estimate' },
  ],
};

/** Deep copy — presentations are edited in component state and must not
 * share array identity with the module-level default. */
export function clonePresentation(p: Presentation): Presentation {
  return {
    ...p,
    group: p.group.map((g) => ({ ...g, ...(g.descend ? { descend: { ...g.descend } } : {}) })),
    sort: p.sort.map((s) => ({ ...s })),
    columns: p.columns.map((c) => ({ ...c })),
  };
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

const FILTER_OPS: FilterOp[] = [
  'equals',
  'not_equals',
  'contains',
  'any_of',
  'none_of',
  'is_empty',
  'is_not_empty',
  'before',
  'after',
];

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

/** Beyond this a nesting chain stops being legible and starts being a cycle. */
export const MAX_NEST_DEPTH = 6;
/** Notion caps sub-grouping here for the same reason: nesting stops reading. */
export const MAX_GROUP_DEPTH = 3;

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
    // Both stored only off their defaults, so existing files stay untouched.
    ...(obj.titleFrozen === false ? { titleFrozen: false } : {}),
    ...(typeof obj.titlePosition === 'number' &&
    Number.isInteger(obj.titlePosition) &&
    obj.titlePosition > 0
      ? { titlePosition: obj.titlePosition }
      : {}),
    ...(obj.chips === 'plain' || obj.chips === 'type-icon'
      ? { chips: obj.chips as ChipStyle }
      : {}),
    ...(typeof obj.dateField === 'string' && obj.dateField.trim() !== ''
      ? { dateField: obj.dateField.trim() }
      : {}),
    ...(typeof obj.zoom === 'string' && ZOOMS.has(obj.zoom)
      ? { zoom: obj.zoom as NonNullable<Presentation['zoom']> }
      : {}),
    ...(typeof obj.dependencyField === 'string' && obj.dependencyField.trim() !== ''
      ? { dependencyField: obj.dependencyField.trim() }
      : {}),
    // M16.23 grid chrome. Every one is stored only off its default, so a view
    // file that never touched them stays byte-identical.
    ...(obj.calendarSpan === 'week' ? { calendarSpan: 'week' as const } : {}),
    ...(obj.showWeekends === false ? { showWeekends: false } : {}),
    ...(obj.weekStart === 'monday' ? { weekStart: 'monday' as const } : {}),
  };
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
  } else if (obj.groupBy !== null && obj.hierarchy === undefined && obj.childrenVia === undefined) {
    // No grouping stated at all — the default. An explicit `groupBy: null`,
    // or a file that only declared a hierarchy, means "no bands" rather than
    // "give me the default bands".
    levels.push(...DEFAULT_PRESENTATION.group.map((g) => ({ ...g })));
  }

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
  if (typeof obj.field === 'string' && FILTER_OPS.includes(obj.op as FilterOp)) {
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
    ...(p.titleFrozen === false ? { titleFrozen: false } : {}),
    ...(p.titlePosition !== undefined && p.titlePosition > 0
      ? { titlePosition: p.titlePosition }
      : {}),
    ...(p.chips !== undefined ? { chips: p.chips } : {}),
    // M10 axis configuration — written only when set, so a table's YAML
    // does not carry three keys about date axes it has no use for.
    ...(p.dateField !== undefined ? { dateField: p.dateField } : {}),
    ...(p.zoom !== undefined ? { zoom: p.zoom } : {}),
    ...(p.dependencyField !== undefined ? { dependencyField: p.dependencyField } : {}),
    ...(p.calendarSpan === 'week' ? { calendarSpan: p.calendarSpan } : {}),
    ...(p.showWeekends === false ? { showWeekends: false } : {}),
    ...(p.weekStart === 'monday' ? { weekStart: p.weekStart } : {}),
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
