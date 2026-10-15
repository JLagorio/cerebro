import type { Entry, FieldDef } from './types';
import { formatWikilink, linkTargetOf, resolveTarget } from './wikilink';

/** Stored links may use a title, key, folder or stem. Identity is the page. */
export function pointsAt(
  record: Entry,
  field: string,
  host: Entry,
  entries: readonly Entry[],
): boolean {
  return (record.relationships[field] ?? []).some(
    (raw) => resolveTarget(raw, entries)?.path === host.path,
  );
}

/** A single owning link moves the record; a multi-link appends only once. */
export function fileUnderPatch(
  record: Entry,
  def: FieldDef,
  host: Entry,
  entries: readonly Entry[],
): Record<string, unknown> | null {
  if (pointsAt(record, def.name, host, entries)) return null;
  const links = def.limit === 1 ? [] : (record.relationships[def.name] ?? []);
  return { [def.name]: [...links, linkTargetOf(host)].map(formatWikilink) };
}

/** Remove every spelling of this page, preserving other links and their order. */
export function unfileFromPatch(
  record: Entry,
  field: string,
  host: Entry,
  entries: readonly Entry[],
): Record<string, unknown> | null {
  const before = record.relationships[field] ?? [];
  const after = before.filter((raw) => resolveTarget(raw, entries)?.path !== host.path);
  if (after.length === before.length) return null;
  return { [field]: after.length === 0 ? null : after.map(formatWikilink) };
}
