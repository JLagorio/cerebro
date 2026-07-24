import { parse, stringify } from 'yaml';
import type {
  FilterGroup,
  FilterOp,
  FilterRule,
  Presentation,
  Scalar,
  ViewDefinition,
  ViewFile,
} from './types';

/** Project default: list grouped by status, modified desc (spec "Collections and views"). */
export const DEFAULT_PRESENTATION: Presentation = {
  type: 'list',
  groupBy: 'status',
  orderBy: { field: 'modifiedAt', dir: 'desc' },
  visibleFields: ['key', 'status', 'priority', 'assignee', 'due', 'estimate'],
};

const FILTER_OPS: FilterOp[] = [
  'equals', 'not_equals', 'contains', 'any_of', 'none_of',
  'is_empty', 'is_not_empty', 'before', 'after',
];

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function parsePresentation(raw: unknown): Presentation {
  const obj = asRecord(raw);
  const orderBy = asRecord(obj.orderBy);
  return {
    type: obj.type === 'board' ? 'board' : 'list',
    groupBy:
      typeof obj.groupBy === 'string'
        ? obj.groupBy
        : obj.groupBy === null
          ? null
          : DEFAULT_PRESENTATION.groupBy,
    orderBy: {
      field:
        typeof orderBy.field === 'string' ? orderBy.field : DEFAULT_PRESENTATION.orderBy.field,
      dir: orderBy.dir === 'asc' ? 'asc' : 'desc',
    },
    visibleFields: Array.isArray(obj.visibleFields)
      ? obj.visibleFields.map(String)
      : [...DEFAULT_PRESENTATION.visibleFields],
  };
}

function parseFilterNode(raw: unknown): FilterRule | FilterGroup | null {
  const obj = asRecord(raw);
  if (Array.isArray(obj.all) || Array.isArray(obj.any)) return parseFilters(raw);
  if (typeof obj.field === 'string' && FILTER_OPS.includes(obj.op as FilterOp)) {
    const rule: FilterRule = { field: obj.field, op: obj.op as FilterOp };
    if (obj.value !== undefined) rule.value = obj.value as Scalar | Scalar[];
    return rule;
  }
  return null;
}

export function parseFilters(raw: unknown): FilterGroup | null {
  const obj = asRecord(raw);
  const branch = Array.isArray(obj.all) ? 'all' : Array.isArray(obj.any) ? 'any' : null;
  if (branch === null) return null;
  const children = (obj[branch] as unknown[])
    .map(parseFilterNode)
    .filter((node): node is FilterRule | FilterGroup => node !== null);
  return branch === 'all' ? { all: children } : { any: children };
}

/** Tolerant by design: a saved view file never fails to load (advisory schema rule). */
export function parseViewYaml(id: string, yamlText: string): ViewFile {
  let raw: unknown = null;
  try {
    raw = parse(yamlText);
  } catch {
    raw = null;
  }
  const obj = asRecord(raw);
  return {
    id,
    definition: {
      name: typeof obj.name === 'string' && obj.name.trim() !== '' ? obj.name : id,
      icon: typeof obj.icon === 'string' ? obj.icon : null,
      color: typeof obj.color === 'string' ? obj.color : null,
      order: typeof obj.order === 'number' ? obj.order : null,
      filters: parseFilters(obj.filters),
      presentation: parsePresentation(obj.presentation),
    },
  };
}

export function serializeView(def: ViewDefinition): string {
  return stringify({
    name: def.name,
    icon: def.icon,
    color: def.color,
    order: def.order,
    filters: def.filters,
    presentation: def.presentation,
  });
}
