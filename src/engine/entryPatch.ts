import { parseWikilinks } from './wikilink';
import type { Entry, Scalar } from './types';

/** Apply an optimistic or draft patch with the scanner's property/link split.
 * Null deletes; wikilinks become bracket-stripped relationships. The caller
 * supplies the edit time, so constructing an unsaved draft reads no clock.
 * The hash stays unknown until the writer answers (M55.2, M61.2). */
export function applyEntryPatch(
  entry: Entry,
  patch: Record<string, unknown>,
  modifiedAt = entry.modifiedAt,
): Entry {
  const properties = { ...entry.properties };
  const relationships = { ...entry.relationships };
  for (const [key, value] of Object.entries(patch)) {
    delete properties[key];
    delete relationships[key];
    if (value === null || value === undefined) continue;
    const links = parseWikilinks(value);
    if (links !== null) relationships[key] = links;
    else properties[key] = value as Scalar | Scalar[];
  }
  return { ...entry, properties, relationships, modifiedAt, hash: null };
}

/** What a map or list reads as once something has passed it through `String`. */
const GARBLED = '[object Object]';

/**
 * The first key of a patch whose value is a map that something stringified on
 * its way to disk — "[object Object]", alone or in a list — or null. No person
 * types that text; a writer that sends it is destroying the map it replaces
 * (2026-10-18: a capture's `generated:` map reached disk as that string), so
 * the stores refuse the whole write rather than land it.
 */
export function garbledKey(patch: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(patch)) {
    if (value === GARBLED) return key;
    if (Array.isArray(value) && value.includes(GARBLED)) return key;
  }
  return null;
}
