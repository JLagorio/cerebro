import { parse, stringify } from 'yaml';
import { isTemplate } from '@/lib/templates';
import { isKnowledgePath } from './okf';
import type {
  CollectionDefinition,
  CollectionFile,
  CollectionNode,
  Entry,
  ListFile,
  Schema,
} from './types';
import { typeStyle } from './typeCatalog';

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

/** Title-case a folder slug: "field-ops" → "Field ops". */
export function humanizeFolder(folder: string): string {
  const name = folder.split('/').pop() ?? folder;
  const spaced = name.replace(/[-_]+/g, ' ').trim();
  return spaced === '' ? folder : spaced.charAt(0).toUpperCase() + spaced.slice(1);
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
  let raw: unknown = null;
  try {
    raw = parse(yamlText);
  } catch {
    raw = null;
  }
  const obj = asRecord(raw);
  return {
    folder,
    definition: {
      name:
        typeof obj.name === 'string' && obj.name.trim() !== ''
          ? obj.name.trim()
          : humanizeFolder(folder),
      icon: typeof obj.icon === 'string' && obj.icon !== '' ? obj.icon : null,
      color: typeof obj.color === 'string' && obj.color !== '' ? obj.color : null,
      order: typeof obj.order === 'number' ? obj.order : null,
    },
  };
}

export function serializeCollection(def: CollectionDefinition): string {
  return stringify({
    name: def.name,
    icon: def.icon,
    color: def.color,
    order: def.order,
  });
}

/** A fresh Collection named by the user. */
export function newCollectionDefinition(name: string): CollectionDefinition {
  return { name, icon: 'folder-open', color: null, order: null };
}

const byOrderThenName = <T extends { order: number | null; name: string }>(a: T, b: T) =>
  (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name);

/**
 * Is this doc something a Collection should show?
 *
 * Type docs are the schema, templates are stationery, and the knowledge bundle
 * has its own surface with its own author — none of them are content a person
 * put in this folder, so listing them here would bury what is.
 */
function isBrowsableDoc(entry: Entry): boolean {
  if (entry.type === 'Type') return false;
  if (isTemplate(entry)) return false;
  if (isKnowledgePath(entry.path)) return false;
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
  const own = lists.filter((l) => l.collection === collection.folder);
  const docs = entries.filter(
    (e) => isBrowsableDoc(e) && isUnder(collection.folder, e.folder),
  );
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
        icon: doc.type === null ? 'file-text' : typeStyle(doc.type, schema).icon,
        color: doc.type === null ? null : typeStyle(doc.type, schema).color,
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
  const rank = (n: CollectionNode) =>
    n.kind === 'folder' ? 0 : n.kind === 'list' ? 1 : 2;
  return [...folders, ...here].sort(
    (a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label),
  );
}

/**
 * The whole sidebar tree: one node per Collection, plus the Lists that belong
 * to no Collection.
 *
 * Those top-level Lists are how a pre-M10 vault surfaces — a `views/*.yml` has
 * no Collection, and force-fitting it into an invented one would rewrite
 * someone's vault to satisfy a rename.
 */
export function collectionsTree(
  collections: CollectionFile[],
  lists: ListFile[],
  entries: Entry[],
  schema: Schema,
): { collections: CollectionNode[]; loose: CollectionNode[] } {
  const sorted = [...collections].sort((a, b) => byOrderThenName(a.definition, b.definition));
  // Only the outermost Collections are roots; a nested one appears inside its
  // parent's subtree, not twice.
  const roots = sorted.filter(
    (c) => !sorted.some((other) => other.folder !== c.folder && isUnder(other.folder, c.folder)),
  );

  const nodes = roots.map((c) => withNested(c, sorted, lists, entries, schema));

  const loose = lists
    .filter((l) => l.collection === null && l.project === null)
    .sort((a, b) => byOrderThenName(a.definition, b.definition))
    .map(
      (list): CollectionNode => ({
        kind: 'list',
        id: list.id,
        label: list.definition.name,
        icon:
          list.definition.icon ??
          (list.definition.source.type === null
            ? 'layout-list'
            : typeStyle(list.definition.source.type, schema).icon),
        color: list.definition.color,
        children: [],
        list,
      }),
    );

  return { collections: nodes, loose };
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
