import { isTemplate } from '@/lib/templates';
import { bandContext, dateBandFor, type BandContext } from './dateBuckets';
import { readDateValue, type DateEndpoint } from './dateGrammar';
import type { Entry, Schema, StatusDef } from './types';

/**
 * My work (M43) — the vault's open work, capability-gated.
 *
 * An entry belongs iff its TYPE declares a status field (a record with a
 * status field is task-like — never routed by type name) and its current
 * status resolves against the entry's status set to a group of 'active'. A
 * value that does not resolve (a typo, a retired status, no value yet) is
 * unresolvable, not active: the entry is excluded, so the nav count counts
 * exactly what the page shows. Declared deadline sections precede remaining
 * database sections. No assignee filter — a vault has one author.
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
    if (def === undefined) continue;
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

/** The first declared status field decides work state, through this record's
 * own status set (including project overrides). Unknown is never finished. */
export function workState(entry: Entry, schema: Schema): 'open' | 'finished' | 'unknown' {
  const def = entry.type === null ? undefined : schema.types.get(entry.type);
  const field = def?.fields.find((candidate) => candidate.kind === 'status');
  if (field === undefined) return 'unknown';
  const raw = schema.fieldValue(entry, field.name);
  const value = Array.isArray(raw) ? raw[0] : raw;
  const status = schema.statusSetFor(entry).find((candidate) => candidate.id === String(value));
  return status === undefined ? 'unknown' : status.group === 'active' ? 'open' : 'finished';
}

export interface WorkSectionRow extends OpenWorkRow {
  deadline: DateEndpoint | null;
  unreadable?: true;
}

export interface WorkSection {
  bucket: string;
  label: string;
  type: string | null;
  rows: WorkSectionRow[];
}

/** Date sections first, then invalid values, then undated work by database.
 * Reading a deadline range uses its end, matching the board's deadline band. */
export function workSections(
  entries: Entry[],
  schema: Schema,
  ctx: BandContext = bandContext(),
): WorkSection[] {
  const dated = new Map<string, WorkSection>();
  const databases = new Map<string, WorkSection>();
  const unreadable: WorkSectionRow[] = [];
  for (const row of openWork(entries, schema)) {
    const type = row.entry.type!;
    const field = schema.types.get(type)?.deadline;
    const raw = field == null ? null : schema.fieldValue(row.entry, field);
    const parsed = readDateValue(raw);
    const endpoint = parsed?.end ?? parsed?.start ?? null;
    const item: WorkSectionRow = { ...row, deadline: endpoint };
    if (endpoint !== null) {
      const band = dateBandFor(endpoint.date, 'date', undefined, ctx, { deadline: true });
      const bucket =
        band.key === ctx.today ? 'today' : band.label.toLowerCase().replaceAll(' ', '_');
      const section = dated.get(bucket) ?? { bucket, label: band.label, type: null, rows: [] };
      section.rows.push(item);
      dated.set(bucket, section);
    } else if (raw != null && raw !== '') {
      unreadable.push({ ...item, unreadable: true });
    } else {
      const section = databases.get(type) ?? { bucket: type, label: type, type, rows: [] };
      section.rows.push(item);
      databases.set(type, section);
    }
  }
  const byTitle = (a: WorkSectionRow, b: WorkSectionRow) =>
    (a.entry.type ?? '').localeCompare(b.entry.type ?? '') ||
    a.entry.title.localeCompare(b.entry.title) ||
    a.entry.path.localeCompare(b.entry.path);
  for (const section of dated.values())
    section.rows.sort(
      (a, b) =>
        a.deadline!.date.localeCompare(b.deadline!.date) ||
        (a.deadline!.time ?? '').localeCompare(b.deadline!.time ?? '') ||
        byTitle(a, b),
    );
  const statusIndex = (row: WorkSectionRow) =>
    schema.statusSetFor(row.entry).findIndex((status) => status.id === row.status.id);
  for (const section of databases.values())
    section.rows.sort((a, b) => statusIndex(a) - statusIndex(b) || byTitle(a, b));
  const result = ['overdue', 'today', 'tomorrow', 'this_week', 'next_week', 'later'].flatMap(
    (bucket) => (dated.has(bucket) ? [dated.get(bucket)!] : []),
  );
  if (unreadable.length > 0)
    result.push({
      bucket: 'unreadable',
      label: 'Not a date',
      type: null,
      rows: unreadable.sort(byTitle),
    });
  result.push(...[...databases.values()].sort((a, b) => a.label.localeCompare(b.label)));
  return result;
}
