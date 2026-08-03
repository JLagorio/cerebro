import type { Entry, FilterGroup, FilterRule, Scalar, Schema } from './types';

function fieldValue(entry: Entry, field: string): unknown {
  if (field in entry.relationships) return entry.relationships[field];
  if (field in entry.properties) return entry.properties[field];
  if (field === 'type') return entry.type;
  if (field === 'title') return entry.title;
  return undefined;
}

function isEmptyValue(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

/** Scalar equality, or membership when the field value is an array. */
function matchesEquals(v: unknown, target: unknown): boolean {
  return asList(v).some((x) => x !== undefined && x !== null && x === target);
}

/** Case-insensitive substring; any element for arrays. */
function matchesContains(v: unknown, target: unknown): boolean {
  if (target === undefined || target === null) return false;
  const needle = String(target).toLowerCase();
  return asList(v).some(
    (x) => x !== undefined && x !== null && String(x).toLowerCase().includes(needle),
  );
}

/** Set intersection between the field value(s) and the rule value(s). */
function matchesAnyOf(v: unknown, target: unknown): boolean {
  const targets = Array.isArray(target) ? target : [target];
  return asList(v).some((x) => x !== undefined && x !== null && targets.includes(x as Scalar));
}

function firstScalar(v: unknown): unknown {
  return Array.isArray(v) ? (v.length > 0 ? v[0] : undefined) : v;
}

function evalRule(entry: Entry, rule: FilterRule): boolean {
  const v = fieldValue(entry, rule.field);
  switch (rule.op) {
    case 'is_empty':
      return isEmptyValue(v);
    case 'is_not_empty':
      return !isEmptyValue(v);
    case 'equals':
      return matchesEquals(v, rule.value);
    case 'not_equals':
      return !matchesEquals(v, rule.value);
    case 'contains':
      return matchesContains(v, rule.value);
    case 'any_of':
      return matchesAnyOf(v, rule.value);
    case 'none_of':
      return !matchesAnyOf(v, rule.value);
    case 'before': {
      const s = firstScalar(v);
      return typeof s === 'string' && typeof rule.value === 'string' && s < rule.value;
    }
    case 'after': {
      const s = firstScalar(v);
      return typeof s === 'string' && typeof rule.value === 'string' && s > rule.value;
    }
  }
}

function isGroup(node: FilterRule | FilterGroup): node is FilterGroup {
  return 'all' in node || 'any' in node;
}

export function evaluateFilters(entry: Entry, group: FilterGroup, schema: Schema): boolean {
  const evalNode = (node: FilterRule | FilterGroup): boolean =>
    isGroup(node) ? evaluateFilters(entry, node, schema) : evalRule(entry, node);
  if ('all' in group) return group.all.every(evalNode);
  return group.any.some(evalNode);
}
