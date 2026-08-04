import { slugify } from '@/lib/slug';
import type { Entry } from './types';

/**
 * Stable identity for a behaviour record — a Skill or an Agent (M17.8).
 *
 * These two record types are the only ones the app addresses by NAME rather
 * than by path: a skill is invoked as `/handle`, and both are remembered in
 * the run ledger between sessions. Both of those broke on a rename, in
 * different ways and for the same reason — nothing about a skill was stable.
 *
 * - The handle was `slugify(title)`, so renaming "Risk sweep" to "Risk review"
 *   silently retired `/risk-sweep`. Worse, handles are de-duplicated in title
 *   order, so renaming ONE skill could hand a DIFFERENT skill's `-2` suffix to
 *   somebody else — clicking one would invoke the other.
 * - The ledger was keyed by path, and renaming a record renames its file, so a
 *   scheduled skill forgot every fire it had answered and ran one catch-up.
 *
 * A declared `slug:` fixes both, and is opt-in: a record without one behaves
 * exactly as it did, so no existing vault is migrated and no ledger is
 * invalidated. That is why the un-slugged case returns the bare path rather
 * than a prefixed one — the stored keys have to keep matching.
 */
export function recordIdentity(entry: Entry): string {
  const declared = entry.properties.slug;
  const slug = typeof declared === 'string' ? slugify(declared) : '';
  // Prefixed so a slug can never be confused with a path. A scanned entry's
  // path always ends in `.md`, so `slug:x` is not reachable as one.
  return slug === '' ? entry.path : `slug:${slug}`;
}

/** The declared `slug:`, or '' when the record has none. */
export function declaredSlug(entry: Entry): string {
  const declared = entry.properties.slug;
  return typeof declared === 'string' ? slugify(declared) : '';
}
