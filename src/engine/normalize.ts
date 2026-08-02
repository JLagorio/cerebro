import type { Scalar } from './types';
import { parseWikilinks } from './wikilink';

function normalizeScalar(value: unknown): Scalar {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  return null; // plain objects and anything else have no scalar form
}

/** Normalizes a raw frontmatter value: trim, '' → null, dates stay/become ISO strings. */
export function normalizeValue(value: unknown): Scalar | Scalar[] {
  if (Array.isArray(value)) return value.map(normalizeScalar);
  return normalizeScalar(value);
}

function isPlainObject(value: unknown): boolean {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Splits a parsed frontmatter mapping into Entry.properties / Entry.relationships,
 * mirroring the Rust parser (used by mockIpc in browser mode).
 * - Wikilink-valued keys go to relationships (ADR-0010).
 * - Nested mappings (`fields`, `statuses`, ...) pass through untouched — schema.ts parses them.
 * - The `type` key is excluded; Entry.type is extracted separately.
 */
export function normalizeFrontmatter(fm: Record<string, unknown>): {
  properties: Record<string, Scalar | Scalar[]>;
  relationships: Record<string, string[]>;
} {
  const properties: Record<string, Scalar | Scalar[]> = {};
  const relationships: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (key === 'type') continue;
    const targets = parseWikilinks(value);
    if (targets !== null) {
      relationships[key] = targets;
      continue;
    }
    if (isPlainObject(value) || (Array.isArray(value) && value.some(isPlainObject))) {
      properties[key] = value as Scalar | Scalar[];
      continue;
    }
    properties[key] = normalizeValue(value);
  }
  return { properties, relationships };
}
