import { folderNote } from './docPages';
import type { CollectionFile, Entry, ListFile, Schema, ViewDefinition } from './types';

/**
 * The M10 container formats, converted to pages (M47.5).
 *
 * `collection.yml` is the frontmatter of a folder note that was never
 * written, and a `*.list.yml` is a `ViewDefinition` that `TypeDef.views`
 * already holds. Neither is a second model — they are the same two ideas,
 * stored beside the page instead of in it, which is what made the app feel
 * like it had two lanes.
 *
 * This module only PLANS. It reads and returns what would change; nothing
 * here writes, and nothing here decides when a conversion happens. That split
 * is deliberate: rewriting files in somebody's vault is not a decision a pure
 * function should be making on its own, and keeping the plan inspectable is
 * what lets a caller show it before doing it.
 */

/** A `collection.yml` folded into its folder's page. */
export interface FolderNotePlan {
  /** The folder whose page this is. */
  folder: string;
  /** Where the page lives, existing or to be created. */
  path: string;
  /** Frontmatter keys to write. Only what the collection actually declared. */
  frontmatter: Record<string, unknown>;
  /** The `collection.yml` this replaces. */
  retires: string;
  /** True when the folder already has a page and this merges into it. */
  merges: boolean;
}

/** A `*.list.yml` folded into its source database's saved views. */
export interface DatabaseViewsPlan {
  /** The database gaining the views — a Type doc title. */
  database: string;
  /** Its views after the merge, in order: the ones it had, then the new. */
  views: ViewDefinition[];
  /** The list files this replaces. */
  retires: string[];
}

/** A list the converter deliberately leaves alone, and why. */
export interface KeptList {
  path: string;
  reason: string;
}

export interface MigrationPlan {
  folderNotes: FolderNotePlan[];
  databases: DatabaseViewsPlan[];
  kept: KeptList[];
}

/** True when the plan would change nothing — the vault is already converted. */
export const isMigrated = (plan: MigrationPlan): boolean =>
  plan.folderNotes.length === 0 && plan.databases.length === 0;

/**
 * Deviations only, like every other writer in the app: a collection that
 * declared no icon must not put `icon: null` into somebody's page. The name
 * is the exception — a folder note without one would fall back to the folder
 * slug, which is exactly the styling the `collection.yml` existed to override.
 */
function collectionFrontmatter(c: CollectionFile): Record<string, unknown> {
  const fm: Record<string, unknown> = { name: c.definition.name };
  if (c.definition.icon !== null) fm.icon = c.definition.icon;
  if (c.definition.color !== null) fm.color = c.definition.color;
  if (c.definition.order !== null) fm.order = c.definition.order;
  if (c.definition.description !== null) fm.description = c.definition.description;
  return fm;
}

/**
 * A list's views, renamed so they stay distinguishable once several lists have
 * merged into one database.
 *
 * Three lists over Work item, each with a view called "Table", would otherwise
 * arrive as three tabs called Table. The LIST's name is the one that carried
 * meaning — "At risk", "This month" — so a list contributing a single view
 * lends it its own name, and a multi-view list qualifies each.
 */
function viewsFrom(list: ListFile, taken: Set<string>): ViewDefinition[] {
  const listName = list.definition.name;
  return list.definition.views.map((v, i) => {
    const name = list.definition.views.length === 1 ? listName : `${listName} · ${v.name}`;
    // Ids are unique per database now, not per file, so two lists that both
    // called a view `table` cannot both keep it.
    let id = `${list.id}${list.definition.views.length === 1 ? '' : `-${v.id}`}`;
    let n = 2;
    while (taken.has(id)) id = `${list.id}-${i}-${n++}`;
    taken.add(id);
    return { ...v, id, name };
  });
}

/**
 * What converting this vault would do.
 *
 * Idempotent by construction: a `collection.yml` that is gone contributes no
 * folder note, and a list that is gone contributes no views. Running the plan
 * against an already-converted vault returns an empty plan, which
 * `isMigrated` answers.
 */
export function planMigration(
  entries: Entry[],
  collections: CollectionFile[],
  lists: ListFile[],
  schema: Schema,
): MigrationPlan {
  const folderNotes = collections
    // An UNDECLARED collection is a folder that is one only because it holds
    // lists (`declared: false`). There is no `collection.yml` to retire and
    // nothing stored about it, so converting it would invent a page nobody
    // asked for.
    .filter((c) => c.declared)
    .map((c) => {
      const existing = folderNote(c.folder, entries);
      const base = c.folder.split('/').pop() ?? c.folder;
      return {
        folder: c.folder,
        path: existing?.path ?? `${c.folder}/${base}.md`,
        frontmatter: collectionFrontmatter(c),
        retires: `${c.folder}/collection.yml`,
        merges: existing !== null,
      };
    });

  const kept: KeptList[] = [];
  const byDatabase = new Map<string, ListFile[]>();
  for (const list of lists) {
    const type = list.definition.source.type;
    if (type === null) {
      // D9. A List over "Everything" queries across every database and so
      // belongs to none; there is nowhere in the new model to put it, and
      // dropping it would destroy a query somebody wrote. It keeps its file.
      kept.push({
        path: list.path,
        reason: 'It queries every database, so it belongs to none.',
      });
      continue;
    }
    if (!schema.types.has(type)) {
      // The list names a type with no Type doc — a ghost. Writing views onto
      // a database that does not exist would create one as a side effect of a
      // migration, which is not a migration's job.
      kept.push({
        path: list.path,
        reason: `No database named "${type}" — nothing to move its views onto.`,
      });
      continue;
    }
    byDatabase.set(type, [...(byDatabase.get(type) ?? []), list]);
  }

  const databases = [...byDatabase.entries()].map(([database, group]) => {
    const existing = schema.types.get(database)?.views ?? [];
    const taken = new Set(existing.map((v) => v.id));
    return {
      database,
      views: [...existing, ...group.flatMap((l) => viewsFrom(l, taken))],
      retires: group.map((l) => l.path),
    };
  });

  return { folderNotes, databases, kept };
}
