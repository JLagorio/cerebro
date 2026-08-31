import { parse, stringify } from 'yaml';
import { isTemplate } from '@/lib/templates';
import type {
  CollectionDefinition,
  CollectionFile,
  CollectionNode,
  Entry,
  ListFile,
  Schema,
} from './types';
import { isDocEntry, typeStyle } from './typeCatalog';

/**
 * Collections (M10): the container model.
 *
 * A Collection contains Lists, Folders, and Docs. It is a FOLDER holding a
 * `collection.yml`, the same shape a project uses — in a markdown app a
 * container on screen should be a container on disk.
 *
 * The concept it replaces was doing two jobs at once. A saved view was both the
 * container ("the thing in the sidebar") and the query ("type + filters"), so
 * there was no way to put two related queries in one place, and no way to keep a
 * doc next to the records it describes. M10 splits them: a Collection contains,
 * a List queries.
 *
 * A Collection carries no query of its own, on purpose. The moment a container
 * also filters, "what is in here" has two answers.
 */

/** The marker file that makes a folder a Collection. */
export const COLLECTION_MARKER = 'collection.yml';
/** Suffix that marks a List file. */
export const LIST_SUFFIX = '.list.yml';

const stem = (path: string) => (path.split('/').pop() ?? path).replace(/\.md$/, '');

/**
 * Title-case a folder slug: "field-ops" → "Field ops".
 *
 * The vault root is a legitimate container — a `*.list.yml` dropped at the top
 * level belongs to it — but its path is the empty string, which is not a name.
 * "Vault" is, and it keeps the root from rendering as a blank sidebar row.
 */
export function humanizeFolder(folder: string): string {
  const name = folder.split('/').pop() ?? folder;
  const spaced = name.replace(/[-_]+/g, ' ').trim();
  if (spaced === '') return 'Vault';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/** Tolerant by design, like every other vault file: a Collection never fails
 * to load. A malformed `collection.yml` still yields a usable container named
 * after its folder — the alternative is a folder that vanishes from the
 * sidebar because someone fat-fingered its icon. */
export function parseCollectionYaml(folder: string, yamlText: string): CollectionFile {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch {
    raw = null;
  }
  const obj = asRecord(raw);
  return {
    folder,
    // Parsing a marker means one exists.
    declared: true,
    definition: {
      name:
        typeof obj.name === 'string' && obj.name.trim() !== ''
          ? obj.name.trim()
          : humanizeFolder(folder),
      icon: typeof obj.icon === 'string' && obj.icon !== '' ? obj.icon : null,
      color: typeof obj.color === 'string' && obj.color !== '' ? obj.color : null,
      order: typeof obj.order === 'number' ? obj.order : null,
      description:
        typeof obj.description === 'string' && obj.description.trim() !== ''
          ? obj.description
          : null,
    },
  };
}

/**
 * The type that marks a page as its folder's container (M47.5).
 *
 * `collection.yml` said this with a marker FILE. A page says it the way every
 * other page in the vault says what it is — with `type:` — so a container
 * becomes an ordinary markdown page that can carry prose and database blocks
 * above the things it contains. That is the point of the milestone: the empty
 * collection page used to tell you to go somewhere else precisely because it
 * had nothing of its own to hold.
 *
 * Routing on this name is metamodel, not domain. The "no type special-casing"
 * rule governs behaviour keyed to a DOMAIN type — a record with a status field
 * is task-like, and nothing may ask whether it is called Task. `Type` has
 * always been exempt for the same reason this is: it describes structure
 * rather than participating in it.
 */
export const COLLECTION_TYPE = 'Collection';

/**
 * Collections declared by a page rather than by a marker file.
 *
 * A folder note (`delivery/delivery.md`) carrying `type: Collection` IS its
 * folder's container, and its frontmatter holds what `collection.yml` did.
 * Tolerant on the same terms as the marker: a page declaring nothing but the
 * type still yields a usable container named after its folder.
 */
export function collectionsFromPages(entries: Entry[]): CollectionFile[] {
  const out: CollectionFile[] = [];
  for (const e of entries) {
    if (e.type !== COLLECTION_TYPE) continue;
    // Only a FOLDER NOTE speaks for its folder. A page called `delivery.md`
    // sitting somewhere else describes nothing but itself, and adopting it
    // would let a stray file rename a container it is not even in.
    if (e.filename !== `${e.folder.split('/').pop() ?? ''}.md`) continue;
    const obj = e.properties as Record<string, unknown>;
    out.push({
      folder: e.folder,
      declared: true,
      definition: {
        // A page already has a title, so the frontmatter only has to carry a
        // name when it differs. Making the user write it twice is what a
        // config file does, not what a page does.
        name:
          typeof obj.name === 'string' && obj.name.trim() !== ''
            ? obj.name.trim()
            : e.title !== ''
              ? e.title
              : humanizeFolder(e.folder),
        icon: typeof obj.icon === 'string' && obj.icon !== '' ? obj.icon : null,
        color: typeof obj.color === 'string' && obj.color !== '' ? obj.color : null,
        order: typeof obj.order === 'number' ? obj.order : null,
        description:
          typeof obj.description === 'string' && obj.description.trim() !== ''
            ? obj.description
            : null,
      },
    });
  }
  return out;
}

export function serializeCollection(def: CollectionDefinition): string {
  return stringify({
    name: def.name,
    icon: def.icon,
    color: def.color,
    order: def.order,
    description: def.description,
  });
}

/** A fresh Collection named by the user. */
export function newCollectionDefinition(name: string): CollectionDefinition {
  return { name, icon: 'folder-open', color: null, order: null, description: null };
}

const byOrderThenName = <T extends { order: number | null; name: string }>(a: T, b: T) =>
  (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name);

/**
 * Is this doc something a Collection should show?
 *
 * M12.1: only DOCS are docs. Typed records used to appear here as "docs" of
 * their collection while the Docs tab excluded them — the same file was a doc
 * in one tree and not the other. Records reach a Collection through its Lists;
 * the doc rows are for prose. Templates are stationery, and `isDocEntry`
 * already rules out records, Type docs, and the knowledge bundle.
 */
function isBrowsableDoc(entry: Entry): boolean {
  if (!isDocEntry(entry)) return false;
  if (isTemplate(entry)) return false;
  // A project.md and a collection's own marker describe the container, not its
  // contents — the container itself is already the node they'd sit under.
  return entry.filename !== 'project.md';
}

const dirOf = (path: string) => {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
};

const isUnder = (folder: string, dir: string) =>
  folder === '' ? true : dir === folder || dir.startsWith(`${folder}/`);

/**
 * Build the tree for one Collection: its Lists, its sub-Folders, and its Docs,
 * recursively.
 *
 * Folders are derived from the paths of what they contain rather than from a
 * folder listing, so an empty directory does not appear as an empty node — a
 * sidebar full of folders holding nothing is noise, and a folder only becomes
 * meaningful once something is in it.
 */
export function collectionTree(
  collection: CollectionFile,
  lists: ListFile[],
  entries: Entry[],
  schema: Schema,
  nested: CollectionFile[] = [],
): CollectionNode {
  // Ownership is by PATH, not by the scan's `collection` field: that field names
  // the nearest DECLARED marker, and an undeclared Collection has none — so
  // matching on it would leave an implicit container's own Lists out of it.
  // M12.5: project-scoped Lists belong to their folder like any other.
  const own = lists.filter((l) => isUnder(collection.folder, dirOf(l.path)));
  const docs = entries.filter((e) => isBrowsableDoc(e) && isUnder(collection.folder, e.folder));
  // A nested Collection owns its own subtree, so this one must not also claim
  // the descendants inside it.
  const claimed = nested
    .filter((c) => c.folder !== collection.folder && isUnder(collection.folder, c.folder))
    .map((c) => c.folder);
  const outside = (dir: string) => !claimed.some((c) => isUnder(c, dir));

  return {
    kind: 'collection',
    id: collection.folder,
    label: collection.definition.name,
    icon: collection.definition.icon ?? 'folder-open',
    color: collection.definition.color,
    children: folderChildren(
      collection.folder,
      own.filter((l) => outside(dirOf(l.path))),
      docs.filter((d) => outside(d.folder)),
      schema,
    ),
  };
}

/** The children directly at `dir`, plus a folder node per deeper directory. */
function folderChildren(
  dir: string,
  lists: ListFile[],
  docs: Entry[],
  schema: Schema,
): CollectionNode[] {
  const here: CollectionNode[] = [];

  // Sub-folders: the next path segment below `dir` for anything deeper.
  const deeper = new Map<string, { lists: ListFile[]; docs: Entry[] }>();
  const bucket = (folder: string) => {
    const rest = dir === '' ? folder : folder.slice(dir.length + 1);
    const segment = rest.split('/')[0];
    const key = dir === '' ? segment : `${dir}/${segment}`;
    let slot = deeper.get(key);
    if (slot === undefined) {
      slot = { lists: [], docs: [] };
      deeper.set(key, slot);
    }
    return slot;
  };

  for (const list of lists) {
    const folder = dirOf(list.path);
    if (folder === dir) {
      here.push({
        kind: 'list',
        id: list.id,
        label: list.definition.name,
        icon:
          list.definition.icon ??
          (list.definition.source.type === null
            ? 'layout-list'
            : typeStyle(list.definition.source.type, schema).icon),
        color:
          list.definition.color ??
          (list.definition.source.type === null
            ? null
            : typeStyle(list.definition.source.type, schema).color),
        children: [],
        list,
      });
    } else {
      bucket(folder).lists.push(list);
    }
  }

  for (const doc of docs) {
    if (doc.folder === dir) {
      here.push({
        kind: 'doc',
        id: doc.path,
        label: doc.title || stem(doc.path),
        // Docs are untyped by definition now (M12.1), so there is no type
        // style to borrow.
        icon: 'file-text',
        color: null,
        children: [],
        path: doc.path,
      });
    } else {
      bucket(doc.folder).docs.push(doc);
    }
  }

  const folders: CollectionNode[] = [...deeper.entries()].map(([folder, slot]) => ({
    kind: 'folder' as const,
    id: folder,
    label: humanizeFolder(folder),
    icon: 'folder',
    color: null,
    children: folderChildren(folder, slot.lists, slot.docs, schema),
  }));

  // Folders, then Lists, then Docs — containers above contents, and the
  // databases above the prose, which is the order people scan for.
  const rank = (n: CollectionNode) => (n.kind === 'folder' ? 0 : n.kind === 'list' ? 1 : 2);
  return [...folders, ...here].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/**
 * Every Collection the vault effectively has: the ones that declare a
 * `collection.yml`, plus one per folder that holds a List without already
 * sitting inside a declared Collection, plus — M12.5 — one per legacy
 * project folder (a folder holding `project.md` was a container all along).
 *
 * **A Collection-less List is not representable.** This is the enforcement
 * point for that rule, and it works by construction rather than by migration: a
 * folder holding a List *is* a container, so it is one. Nothing is written to
 * disk to make that true, and no List can be orphaned. Retiring projects used
 * the same move: nothing rewrites the vault — a project folder simply reads as
 * the Collection it always was, named after its project.md.
 *
 * The marker is therefore only ever a carrier for name/icon/color/order — never
 * the thing that makes a folder a container. An undeclared Collection is named
 * after its folder and becomes declared the moment anyone renames or restyles
 * it, which is when there is finally something to store.
 */
export function effectiveCollections(
  declared: CollectionFile[],
  lists: ListFile[],
  entries: Entry[] = [],
): CollectionFile[] {
  const byFolder = new Map(declared.map((c) => [c.folder, c]));

  const adopt = (folder: string, name: string) => {
    if (byFolder.has(folder)) return;
    // Already inside a declared Collection higher up: that one owns it.
    if (declared.some((c) => isUnder(c.folder, folder))) return;
    byFolder.set(folder, {
      folder,
      declared: false,
      definition: { name, icon: null, color: null, order: null, description: null },
    });
  };

  for (const list of lists) {
    // M12.5: project-scoped Lists used to be project tabs; with projects
    // retired they are ordinary Lists, and their folder is their container.
    adopt(dirOf(list.path), humanizeFolder(dirOf(list.path)));
  }

  for (const e of entries) {
    if (e.filename !== 'project.md') continue;
    // A Type doc that happens to be named project.md (types/project.md is
    // the conventional home of a "Project" Type) is schema, not a marker —
    // adopting it would turn the types/ folder into a phantom Collection.
    if (e.type === 'Type') continue;
    adopt(e.folder, e.title !== '' ? e.title : humanizeFolder(e.folder));
  }

  return [...byFolder.values()].sort((a, b) => byOrderThenName(a.definition, b.definition));
}

/**
 * The sidebar tree: one node per root Collection. Nothing sits outside one,
 * because `effectiveCollections` guarantees every List has a home.
 */
export function collectionsTree(
  collections: CollectionFile[],
  lists: ListFile[],
  entries: Entry[],
  schema: Schema,
): CollectionNode[] {
  const all = effectiveCollections(collections, lists, entries);
  // Only the outermost Collections are roots; a nested one appears inside its
  // parent's subtree, not twice.
  const roots = all.filter(
    (c) => !all.some((other) => other.folder !== c.folder && isUnder(other.folder, c.folder)),
  );
  return roots.map((c) => withNested(c, all, lists, entries, schema));
}

/** A Collection's node with any Collections nested inside it grafted in. */
function withNested(
  collection: CollectionFile,
  all: CollectionFile[],
  lists: ListFile[],
  entries: Entry[],
  schema: Schema,
): CollectionNode {
  const node = collectionTree(collection, lists, entries, schema, all);
  const children = all.filter(
    (c) =>
      c.folder !== collection.folder &&
      isUnder(collection.folder, c.folder) &&
      // Direct descendants only — deeper ones are grafted by their own parent.
      !all.some(
        (mid) =>
          mid.folder !== collection.folder &&
          mid.folder !== c.folder &&
          isUnder(collection.folder, mid.folder) &&
          isUnder(mid.folder, c.folder),
      ),
  );
  return {
    ...node,
    children: [
      ...children.map((c) => withNested(c, all, lists, entries, schema)),
      ...node.children,
    ],
  };
}

/** Count of everything inside a node, recursively — what a collapsed row reports. */
export function nodeCount(node: CollectionNode): number {
  return node.children.reduce(
    (sum, child) => sum + (child.kind === 'folder' ? 0 : 1) + nodeCount(child),
    0,
  );
}
