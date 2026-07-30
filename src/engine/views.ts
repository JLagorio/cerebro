import { parse, stringify } from 'yaml';
import type {
  ChildrenSpec,
  ColumnSpec,
  FilterGroup,
  FilterOp,
  FilterRule,
  GroupSpec,
  Presentation,
  Scalar,
  SortSpec,
  ViewDefinition,
  ViewFile,
  ViewSource,
} from './types';

/** Project default: list grouped by status, modified desc (spec "Collections and views"). */
export const DEFAULT_PRESENTATION: Presentation = {
  type: 'list',
  group: [{ field: 'status' }],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [
    { field: 'key' }, { field: 'status' }, { field: 'priority' },
    { field: 'assignee' }, { field: 'due' }, { field: 'estimate' },
  ],
  hierarchy: [],
};

/** Deep copy — presentations are edited in component state and must not
 * share array identity with the module-level default. */
export function clonePresentation(p: Presentation): Presentation {
  return {
    ...p,
    group: p.group.map((g) => ({ ...g })),
    sort: p.sort.map((s) => ({ ...s })),
    columns: p.columns.map((c) => ({ ...c })),
    hierarchy: p.hierarchy.map((h) => ({ ...h })),
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
  const dir: 'asc' | 'desc' =
    leading?.field === field && leading.dir === 'asc' ? 'desc' : 'asc';
  return { ...p, sort: [{ field, dir }, ...p.sort.filter((s) => s.field !== field)] };
}

const FILTER_OPS: FilterOp[] = [
  'equals', 'not_equals', 'contains', 'any_of', 'none_of',
  'is_empty', 'is_not_empty', 'before', 'after',
];

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

const LAYOUTS = new Set(['list', 'board', 'split', 'table', 'tree', 'calendar']);
/** Beyond this a hierarchy stops being legible and starts being a cycle. */
export const MAX_HIERARCHY_DEPTH = 6;
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
    type: typeof obj.type === 'string' && LAYOUTS.has(obj.type)
      ? (obj.type as Presentation['type'])
      : 'list',
    group: parseGroupChain(obj),
    sort: parseSortChain(obj),
    columns: parseColumns(obj),
    hierarchy: parseHierarchy(obj),
    rowHeight:
      obj.rowHeight === 'compact' || obj.rowHeight === 'tall' || obj.rowHeight === 'default'
        ? obj.rowHeight
        : undefined,
  };
}

function parseGroupChain(obj: Record<string, unknown>): GroupSpec[] {
  if (Array.isArray(obj.group)) {
    return obj.group
      .map((raw): GroupSpec | null => {
        if (typeof raw === 'string' && raw.trim() !== '') return { field: raw.trim() };
        const g = asRecord(raw);
        if (typeof g.field !== 'string' || g.field.trim() === '') return null;
        const spec: GroupSpec = { field: g.field.trim() };
        if (g.dir === 'asc' || g.dir === 'desc') spec.dir = g.dir;
        if (g.hideEmpty === true) spec.hideEmpty = true;
        return spec;
      })
      .filter((g): g is GroupSpec => g !== null)
      .slice(0, MAX_GROUP_DEPTH);
  }
  // v1: `groupBy: status` | `groupBy: null` (explicitly flat) | absent.
  if (typeof obj.groupBy === 'string' && obj.groupBy.trim() !== '') {
    return [{ field: obj.groupBy.trim() }];
  }
  if (obj.groupBy === null) return [];
  return DEFAULT_PRESENTATION.group.map((g) => ({ ...g }));
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

function parseHierarchy(obj: Record<string, unknown>): ChildrenSpec[] {
  if (Array.isArray(obj.hierarchy)) {
    return obj.hierarchy
      .map(parseChildrenSpec)
      .filter((s): s is ChildrenSpec => s !== null)
      .slice(0, MAX_HIERARCHY_DEPTH);
  }
  const single = parseChildrenSpec(obj.childrenVia);
  return single === null ? [] : [single];
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

function parseSource(raw: unknown): ViewSource {
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

/** Tolerant by design: a saved view file never fails to load (advisory schema rule). */
export function parseViewYaml(id: string, yamlText: string, project: string | null = null): ViewFile {
  let raw: unknown = null;
  try {
    raw = parse(yamlText);
  } catch {
    raw = null;
  }
  const obj = asRecord(raw);
  return {
    id,
    project,
    definition: {
      name: typeof obj.name === 'string' && obj.name.trim() !== '' ? obj.name : id,
      icon: typeof obj.icon === 'string' ? obj.icon : null,
      color: typeof obj.color === 'string' ? obj.color : null,
      order: typeof obj.order === 'number' ? obj.order : null,
      source: parseSource(obj.source),
      filters: parseFilters(obj.filters),
      presentation: parsePresentation(obj.presentation),
    },
  };
}

/** v2 keys only (M9.1) — the legacy keys are read, never written back, so a
 * view converges on one shape the first time it is edited. */
export function serializeView(def: ViewDefinition): string {
  const p = def.presentation;
  return stringify({
    name: def.name,
    icon: def.icon,
    color: def.color,
    order: def.order,
    source: def.source,
    filters: def.filters,
    presentation: {
      type: p.type,
      group: p.group,
      sort: p.sort,
      columns: p.columns,
      hierarchy: p.hierarchy,
      ...(p.rowHeight !== undefined ? { rowHeight: p.rowHeight } : {}),
    },
  });
}
