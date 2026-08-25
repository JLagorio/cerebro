import { isTemplate } from '@/lib/templates';
import { hasStatusField } from './columns';
import type { Entry, Schema, StatusDef } from './types';

/**
 * My work (M43) — the vault's open work, capability-gated.
 *
 * An entry belongs iff its TYPE declares a status field (a record with a
 * status field is task-like — never routed by type name) and its current
 * status resolves against the entry's status set to a group of 'active'. A
 * value that does not resolve (a typo, a retired status, no value yet) is
 * unresolvable, not active: the entry is excluded, so the nav count counts
 * exactly what the page shows. No assignee filter — a vault has one author.
 */
export interface OpenWorkRow {
  entry: Entry;
  status: StatusDef;
}

export function openWork(entries: Entry[], schema: Schema): OpenWorkRow[] {
  const rows: OpenWorkRow[] = [];
  for (const e of entries) {
    if (e.type === null || isTemplate(e)) continue;
    const def = schema.types.get(e.type);
    if (def === undefined || !hasStatusField(def.fields)) continue;
    const field = def.fields.find((f) => f.kind === 'status');
    if (field === undefined) continue;
    const raw = e.properties[field.name];
    if (raw === undefined || raw === null || raw === '') continue;
    const id = String(Array.isArray(raw) ? raw[0] : raw);
    const status = schema.statusSetFor(e).find((s) => s.id === id);
    if (status === undefined || status.group !== 'active') continue;
    rows.push({ entry: e, status });
  }
  return rows;
}
