import { MAX_BATCH_OPS, type BatchOp } from './batch';
import { applyEntryPatch } from './entryPatch';
import { isKnowledgePath } from './okf';
import { kindMeta, validatePatch } from './properties';
import { humanize } from './schema';
import type { Entry, FieldDef, Schema } from './types';

export interface BulkRead {
  content: string;
  hash: string;
}
export interface BulkPlan {
  ops: Extract<BatchOp, { op: 'patch' | 'delete' }>[];
  failed: Map<string, string>;
  skipped: string[];
}

export const BULK_UNREADABLE = "couldn't be read";
export const BULK_CHANGED = 'changed since the table showed it';
export const BULK_FAILED = "the change didn't go through";
export const BULK_KNOWLEDGE = 'knowledge pages are changed through review';

const writable = (def: FieldDef) =>
  !kindMeta(def.kind).computed && def.from === undefined && def.kind !== 'files';

/** A typed table offers that type's stored fields. A mixed table offers the
 * union, while the plan still checks every row against its own declaration. */
export function bulkSetFields(
  entries: readonly Entry[],
  schema: Schema,
  sourceType: string | null,
): FieldDef[] {
  const types =
    sourceType === null ? [...new Set(entries.map((entry) => entry.type))] : [sourceType];
  const fields = new Map<string, FieldDef>();
  for (const type of types) {
    if (type === null) continue;
    for (const def of schema.types.get(type)?.fields ?? []) {
      if (writable(def) && !fields.has(def.name)) fields.set(def.name, def);
    }
  }
  return [...fields.values()];
}

function readFailure(entry: Entry, reads: ReadonlyMap<string, BulkRead>): string | null {
  const read = reads.get(entry.path);
  if (read === undefined) return BULK_UNREADABLE;
  return read.hash === entry.hash ? null : BULK_CHANGED;
}

function cap(plan: BulkPlan): BulkPlan {
  if (plan.ops.length <= MAX_BATCH_OPS) return plan;
  for (const op of plan.ops) plan.failed.set(op.path, `more than ${MAX_BATCH_OPS} at once`);
  plan.ops = [];
  return plan;
}

function choiceFailure(entry: Entry, def: FieldDef, value: unknown, schema: Schema): string | null {
  if (!['status', 'select', 'multiselect'].includes(def.kind) || value == null || value === '')
    return null;
  const options = def.kind === 'status' ? schema.statusSetFor(entry) : (def.options ?? []);
  for (const choice of Array.isArray(value) ? value : [value]) {
    if (typeof choice === 'string' && !options.some((option) => option.id === choice)) {
      return `“${choice}” isn't one of ${humanize(def.name)}'s options`;
    }
  }
  return null;
}

/** Judge rows before forming the one atomic batch. A failed row keeps its
 * reason and never blocks an unrelated ready row (M61.2). */
export function planBulkSet(
  entries: readonly Entry[],
  field: string,
  value: unknown,
  schema: Schema,
  reads: ReadonlyMap<string, BulkRead>,
): BulkPlan {
  const plan: BulkPlan = { ops: [], failed: new Map(), skipped: [] };
  for (const entry of new Map(entries.map((row) => [row.path, row])).values()) {
    const def =
      entry.type === null
        ? undefined
        : schema.types.get(entry.type)?.fields.find((candidate) => candidate.name === field);
    const reason = isKnowledgePath(entry.path)
      ? BULK_KNOWLEDGE
      : def === undefined
        ? `${entry.type ?? 'This record'} has no ${humanize(field)}`
        : !writable(def)
          ? `${humanize(field)} is not a stored editable property`
          : (choiceFailure(entry, def, value, schema) ??
            validatePatch(schema, entry, { [field]: value })[0] ??
            readFailure(entry, reads));
    if (reason !== null && reason !== undefined) {
      plan.failed.set(entry.path, reason);
      continue;
    }
    const after = applyEntryPatch(entry, { [field]: value });
    if (
      JSON.stringify(after.properties[field]) === JSON.stringify(entry.properties[field]) &&
      JSON.stringify(after.relationships[field]) === JSON.stringify(entry.relationships[field])
    ) {
      plan.skipped.push(entry.path);
      continue;
    }
    plan.ops.push({
      op: 'patch',
      path: entry.path,
      set: { [field]: value },
      expectHash: reads.get(entry.path)!.hash,
    });
  }
  return cap(plan);
}

export function planBulkDelete(
  entries: readonly Entry[],
  reads: ReadonlyMap<string, BulkRead>,
): BulkPlan {
  const plan: BulkPlan = { ops: [], failed: new Map(), skipped: [] };
  for (const entry of new Map(entries.map((row) => [row.path, row])).values()) {
    const reason = isKnowledgePath(entry.path) ? BULK_KNOWLEDGE : readFailure(entry, reads);
    if (reason !== null) plan.failed.set(entry.path, reason);
    else plan.ops.push({ op: 'delete', path: entry.path, expectHash: reads.get(entry.path)!.hash });
  }
  return cap(plan);
}

export function bulkFailureText(
  action: 'set' | 'delete' | 'duplicate',
  failed: ReadonlyMap<string, string>,
  entries: readonly Entry[],
): string | null {
  if (failed.size === 0) return null;
  const titles = new Map(entries.map((entry) => [entry.path, entry.title]));
  const names = [...failed]
    .slice(0, 3)
    .map(([path, reason]) => `“${titles.get(path) ?? path}” (${reason})`)
    .join(', ');
  const rest = failed.size > 3 ? ` and ${failed.size - 3} more` : '';
  return `Couldn't ${action} ${failed.size}: ${names}${rest}.`;
}
