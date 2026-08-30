import { parse } from 'yaml';
import type { Schema, ViewDefinition } from './types';
import { typeViews } from './typeCatalog';

/**
 * The database block's pointer (M47.2).
 *
 * A page shows a database by NAMING it, never by carrying it: the fence holds
 * a reference and the rows stay files. That is decision D7 of the M47 spec,
 * and it is not a size optimisation — a block that embedded row data would be
 * a second copy of the vault that can disagree with the vault.
 *
 * On disk:
 *
 *     ```cerebro-database
 *     database: Reading list
 *     view: shelf
 *     ```
 *
 * Parsed with the vault's YAML, like every other hand-editable file we read,
 * and tolerant on the same terms: a fence that says nothing usable is not a
 * database block, and the editor leaves it as the code block it already is.
 */

/** The fence language that marks a database block on disk. */
export const DATABASE_FENCE = 'cerebro-database';

export interface DatabaseRef {
  /** The database's name — the title of its Type doc. */
  database: string;
  /**
   * Which saved view to show. Null means the block never named one and takes
   * the database's first.
   */
  view: string | null;
}

const str = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * A fence body into a pointer, or null when it does not name a database.
 *
 * Null rather than a `{ database: '' }` shape on purpose: a pointer with no
 * target is not a broken pointer, it is not a pointer. The caller's job is to
 * leave that fence alone as an ordinary code block, which is the only
 * behaviour that cannot lose someone's text.
 */
export function parseDatabaseRef(body: string): DatabaseRef | null {
  let raw: unknown;
  try {
    raw = parse(body);
  } catch {
    // A hand-edited fence with broken YAML stays a code block, visibly holding
    // what the user typed, rather than becoming a database block that renders
    // an error where their text used to be.
    return null;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const database = str((raw as Record<string, unknown>).database);
  if (database === null) return null;
  return { database, view: str((raw as Record<string, unknown>).view) };
}

/**
 * A pointer back to a fence body.
 *
 * `view:` is written whenever the block knows one, including when it is the
 * first — this is the one place the deviations-only rule does NOT apply. The
 * fallback for an absent `view:` is POSITIONAL ("the database's first"), so
 * omitting the id of a view that happens to be first today would let
 * reordering that database's tabs silently change what this page shows.
 */
export function serializeDatabaseRef(ref: DatabaseRef): string {
  const lines = [`database: ${ref.database}`];
  if (ref.view !== null) lines.push(`view: ${ref.view}`);
  return lines.join('\n');
}

export type ResolvedDatabaseBlock =
  | { kind: 'ok'; database: string; view: ViewDefinition }
  /** No database of that name — the page points at something that is not there. */
  | { kind: 'no-database'; database: string }
  /**
   * The database is here and the named view is not. Carries the view it would
   * fall back to, so a caller can still render something, but stays a distinct
   * kind: "show the Board" with no Board is not the same sentence as "show
   * whatever is first", and a surface that silently substituted one for the
   * other would be confidently showing the wrong data.
   */
  | { kind: 'no-view'; database: string; view: string; fallback: ViewDefinition };

/**
 * A pointer against the vault's schema.
 *
 * Never returns "empty" for a failure. A database that is not there and a
 * database with no rows are opposite sentences, and the caller needs to be
 * able to tell them apart — the same rule that made `section-unavailable` a
 * distinct state from an empty section.
 */
export function resolveDatabaseRef(ref: DatabaseRef, schema: Schema): ResolvedDatabaseBlock {
  if (!schema.types.has(ref.database)) return { kind: 'no-database', database: ref.database };
  // `typeViews` synthesizes a default table for a database that has saved
  // none, so this list is never empty and `views[0]` is always a real view.
  const views = typeViews(ref.database, schema);
  const first = views[0] as ViewDefinition;
  if (ref.view === null) return { kind: 'ok', database: ref.database, view: first };
  const hit = views.find((v) => v.id === ref.view);
  if (hit === undefined) {
    return { kind: 'no-view', database: ref.database, view: ref.view, fallback: first };
  }
  return { kind: 'ok', database: ref.database, view: hit };
}
