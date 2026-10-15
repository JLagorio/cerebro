/**
 * What of a note's frontmatter keyword search reads (M59.2).
 *
 * One rule in both languages: Rust `searchable_fields` (src-tauri/src/search.rs)
 * feeds the agent's search_notes, and this feeds a database view's search, so
 * the two see the same text. src-tauri/fixtures/searchable-values.json states
 * the rule and holds the cases both replay.
 *
 * Properties come in frontmatter order, then relationships in key order. A
 * string gives its trimmed text, a number `String(n)`, a boolean as written, an
 * array item by item, and an object or null nothing; a key's texts join with
 * ", ". Keys starting `_`, page chrome, an Agent record's own memory and a
 * `title` equal to the note's title give nothing.
 *
 * Pure: engine imports only (M53.20).
 */

import { isPageChromeKey } from './pageChrome';
import type { Entry } from './types';

/** An Agent record's own notes (D7): what an agent remembers is never
 *  searchable. Agent is a reserved type name (CV-08). */
const AGENT_MEMORY_KEYS: readonly string[] = ['recent', 'memory', 'preferences'];

export interface SearchableField {
  key: string;
  text: string;
}

/** The texts one frontmatter value gives search. */
export function searchableValues(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? [] : [trimmed];
  }
  if (typeof value === 'number') return Number.isFinite(value) ? [String(value)] : [];
  if (typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(searchableValues);
  return [];
}

/** The frontmatter `entry` offers search, field by field. */
export function searchableFields(
  entry: Pick<Entry, 'title' | 'type' | 'properties' | 'relationships'>,
): SearchableField[] {
  const agent = entry.type === 'Agent';
  const withheld = (key: string) =>
    key.startsWith('_') || isPageChromeKey(key) || (agent && AGENT_MEMORY_KEYS.includes(key));
  const title = entry.title.trim();
  const out: SearchableField[] = [];
  const push = (key: string, texts: string[]) => {
    if (texts.length === 0) return;
    const text = texts.join(', ');
    if (key === 'title' && text === title) return;
    out.push({ key, text });
  };
  for (const [key, value] of Object.entries(entry.properties)) {
    if (!withheld(key)) push(key, searchableValues(value));
  }
  for (const key of Object.keys(entry.relationships).sort()) {
    if (withheld(key)) continue;
    push(
      key,
      (entry.relationships[key] ?? []).map((t) => t.trim()).filter((t) => t !== ''),
    );
  }
  return out;
}
