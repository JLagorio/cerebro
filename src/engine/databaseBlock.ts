import { parse, stringify } from 'yaml';
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
 * The one exception is an EMPTY fence, which is how an unset block — the
 * picker, before anything is chosen — is written; `markdown.ts` reads it back
 * as that picker, and an empty body holds no text to lose.
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
 * behaviour that cannot lose someone's text — except an EMPTY fence, the
 * unset block's own spelling, which `markdown.ts` promotes to the picker.
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
 *
 * Through the YAML writer, never interpolated: a database is named whatever
 * its author typed, and `Books: 2026`, `Notes #1`, `2026` or `true` written
 * raw read back as a parse error, a truncated name, a number or a boolean —
 * each one a pointer lost on the next load. The writer quotes only a value
 * that needs it, so `database: Reading list` stays as a person would type it.
 */
export function serializeDatabaseRef(ref: DatabaseRef): string {
  const body =
    ref.view === null ? { database: ref.database } : { database: ref.database, view: ref.view };
  return stringify(body, { lineWidth: 0 }).trimEnd();
}

/** The slice of an editor block `pointerOccurrence` reads. */
interface BlockLike {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  children?: BlockLike[];
}

/**
 * Which copy of its pointer a block is: 0 for the first block in document
 * order showing this database and view, 1 for the second, and so on.
 *
 * What keeps two embeds of one view on a page from sharing a fold. Not the
 * block id — BlockNote mints fresh ids on every parse, so a fold keyed on one
 * would not survive a reload and would leave a dead key behind each time. The
 * ordinal is what the page itself says, so it does both.
 */
export function pointerOccurrence(
  blocks: BlockLike[],
  id: string,
  keyOf: (block: BlockLike) => string = (b) =>
    `${String(b.props?.database ?? '')}:${String(b.props?.view ?? '')}`,
): number {
  const embeds: BlockLike[] = [];
  const walk = (list: BlockLike[]) => {
    for (const b of list) {
      if (b.type === 'database') embeds.push(b);
      if (b.children !== undefined) walk(b.children);
    }
  };
  walk(blocks);
  const self = embeds.find((b) => b.id === id);
  if (self === undefined) return 0;
  const key = keyOf(self);
  return embeds.filter((b) => keyOf(b) === key).indexOf(self);
}

/**
 * What a block's folds are keyed on: the database and the view it actually
 * DRAWS. Resolved, not raw, because two pointers can draw one view — one that
 * names none and one that names the first, or two naming views that are gone
 * and both fall back — and counting them apart would let them share a fold.
 */
export function foldKey(database: string, view: string, schema: Schema): string {
  if (database === '') return ':';
  const resolved = resolveDatabaseRef({ database, view: view === '' ? null : view }, schema);
  if (resolved.kind === 'no-database') return `${database}:`;
  return `${database}:${resolved.kind === 'no-view' ? resolved.fallback.id : resolved.view.id}`;
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
