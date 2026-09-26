/**
 * The write side of Collections and Lists (M10).
 *
 * A List is a database: `<collection>/<id>.list.yml`, or a legacy
 * `views/<id>.yml` / `<project>/views/<id>.yml`. A Collection is the container
 * it lives in: a folder holding `collection.yml`.
 *
 * Every write goes through here so there is one hardened path — before M3.5
 * only ProjectPage could write a view at all, and the M10 rename would
 * otherwise have needed the same fix in four places.
 *
 * M47.6 removed the CREATE half. A saved view belongs to the database it
 * queries (`views:` on its Type doc, written by saveTypeViews), so nothing
 * authors a new `*.list.yml` any more. What survives here is the read-write
 * half: a List already on disk still opens, still gains and loses view tabs,
 * and is still updated where it lives.
 *
 * The load-bearing rule: a List is UPDATED WHERE IT LIVES. Editing a legacy
 * `views/*.yml` rewrites that file rather than migrating it to a `.list.yml`,
 * because silently relocating someone's file on a toolbar click is not a
 * migration, it is a surprise — and it would break any external reference to it.
 */

import { newCollectionDefinition, serializeCollection } from '@/engine/collections';
import { nextViewId, replaceView, serializeList } from '@/engine/views';
import type {
  CollectionDefinition,
  CollectionFile,
  ListDefinition,
  ListFile,
  ViewDefinition,
} from '@/engine/types';
import { deleteNote, listCollections, saveCollection, saveList, saveView } from '@/lib/ipc';
import { slugify } from '@/lib/slug';
import { slugifyListId } from '@/views/ViewToolbar';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** `projects/x/project.md` → `projects/x` (a legacy view's scope folder). */
export const projectDirOf = (projectPath: string) => projectPath.replace(/\/project\.md$/, '');

/** Unique folder for a new Collection, alongside the ones that exist. */
export function nextCollectionFolder(name: string, taken: Iterable<string>): string {
  const base = slugifyListId(name) || 'collection';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

// rescan() toasts its own failures and never throws (M14.8).
const refresh = (): Promise<void> => useVaultStore.getState().rescan();

// --- Lists -----------------------------------------------------------------

/**
 * Write a List to a specific location. `legacy` carries the pre-M10 shape so an
 * existing file is updated in place rather than moved.
 */
async function writeList(
  id: string,
  definition: ListDefinition,
  location: { collection: string | null; legacy?: { project: string | null } },
): Promise<boolean> {
  const { vaultPath } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  if (vaultPath === null) return false;
  const yaml = serializeList(definition);
  try {
    if (location.legacy !== undefined) {
      const { project } = location.legacy;
      await saveView(vaultPath, id, yaml, project === null ? null : projectDirOf(project));
    } else {
      await saveList(vaultPath, location.collection ?? '', id, yaml);
    }
  } catch {
    toast(`Couldn't save "${definition.name}"`);
    return false;
  }
  await refresh();
  return true;
}

/** Persist edits to an existing List — in place, whatever shape it is on disk.
 * This is the surviving consumer of the `legacy` shape: creating project
 * views died with M12.5, but a pre-M10 file on disk is still UPDATED where
 * it lives rather than silently relocated. */
export async function updateList(list: ListFile, definition: ListDefinition): Promise<boolean> {
  const legacy = isLegacy(list) ? { project: list.project } : undefined;
  return writeList(list.id, definition, { collection: list.collection, legacy });
}

/** Persist edits to ONE of a List's view tabs (M11), leaving its siblings alone. */
export async function updateView(
  list: ListFile,
  viewId: string,
  view: ViewDefinition,
): Promise<boolean> {
  return updateList(list, replaceView(list.definition, viewId, view));
}

/** Append a view tab. Returns its id so the caller can switch to it. */
export async function addView(list: ListFile, view: ViewDefinition): Promise<string | null> {
  // Re-key against the siblings that actually exist: the caller built this
  // view from a stale copy if the file changed underneath it.
  const id = nextViewId(
    view.name,
    list.definition.views.map((v) => v.id),
  );
  const next: ListDefinition = {
    ...list.definition,
    views: [...list.definition.views, { ...view, id }],
  };
  return (await updateList(list, next)) ? id : null;
}

/**
 * Remove a view tab.
 *
 * Refuses to remove the last one: a List with no views is not representable
 * (see ListDefinition.views), and the way to get rid of the last view is to
 * delete the List it is the only way of looking at.
 */
export async function deleteView(list: ListFile, viewId: string): Promise<boolean> {
  if (list.definition.views.length <= 1) {
    useUiStore.getState().toast('A list keeps at least one view');
    return false;
  }
  const next: ListDefinition = {
    ...list.definition,
    views: list.definition.views.filter((v) => v.id !== viewId),
  };
  return updateList(list, next);
}

/** Duplicate a view tab, named "<name> copy". */
export async function duplicateView(list: ListFile, viewId: string): Promise<string | null> {
  const source = list.definition.views.find((v) => v.id === viewId);
  if (source === undefined) return null;
  return addView(list, { ...source, name: `${source.name} copy` });
}

/** A List still living in a pre-M10 `views/` directory. */
function isLegacy(list: ListFile): boolean {
  return list.path.startsWith('views/') || list.path.includes('/views/');
}

export async function deleteList(list: ListFile): Promise<boolean> {
  const { vaultPath } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  if (vaultPath === null) return false;
  try {
    // `path` comes from the scan, so this deletes the file that actually exists
    // rather than one reconstructed from the id and a guess at its shape.
    await deleteNote(vaultPath, list.path);
  } catch {
    toast(`Couldn't delete "${list.definition.name}"`);
    return false;
  }
  await refresh();
  return true;
}

// --- Collections -----------------------------------------------------------

/**
 * Create a Collection. Returns its folder — the Collection's identity — so the
 * caller can navigate to it.
 */
export async function createCollection(name: string): Promise<string | null> {
  const { vaultPath, collections } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  if (vaultPath === null) return null;
  const trimmed = name.trim();
  if (trimmed === '') return null;
  const folder = nextCollectionFolder(
    trimmed,
    collections.map((c) => c.folder),
  );
  try {
    await saveCollection(vaultPath, folder, serializeCollection(newCollectionDefinition(trimmed)));
  } catch {
    toast(`Couldn't create "${trimmed}"`);
    return null;
  }
  await refresh();
  return folder;
}

/**
 * Update a Collection's own definition — name, icon, color, order.
 *
 * The FOLDER never changes here. Renaming a Collection renames what it is
 * called, not where it lives: moving the folder would have to move every List
 * and Doc inside it, and a display name is not worth that blast radius.
 */
export async function updateCollection(
  collection: CollectionFile,
  definition: CollectionDefinition,
): Promise<boolean> {
  // Writing the marker is also what turns an IMPLIED Collection (a folder that
  // is one because it holds Lists) into a declared one — the first rename is
  // the first moment there is anything about it worth storing.
  const { vaultPath, entries, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  if (vaultPath === null) return false;
  // A collection its PAGE declares is edited on that page (M47.5). Written to
  // a marker instead, the edit was ignored — the page wins — and left a stray
  // `collection.yml` behind. `patchFrontmatter` toasts its own failure.
  if (collection.page !== undefined) {
    const title = entries.find((e) => e.path === collection.page)?.title;
    const ok = await patchFrontmatter(collection.page, {
      // The page's title already names it; `name:` is only a deviation.
      name: definition.name === title ? null : definition.name,
      icon: definition.icon,
      color: definition.color,
      order: definition.order,
      description: definition.description,
    });
    // `collections` is derived at scan time, and in Tauri `patchFrontmatter`
    // does not rescan (own-write suppression) — without this the sidebar and
    // the page keep the old name until something unrelated rescans.
    if (ok) await refresh();
    return ok;
  }
  try {
    await saveCollection(vaultPath, collection.folder, serializeCollection(definition));
  } catch {
    toast(`Couldn't save "${definition.name}"`);
    return false;
  }
  await refresh();
  return true;
}

/**
 * Stop a folder being a Collection by removing what declares it — its
 * `collection.yml`, or the `type: Collection` on its folder note (M47.5).
 *
 * Deliberately NOT a recursive delete. The Lists and Docs inside are content;
 * the declaration is the only thing that made the folder a container, so
 * removing it un-collects the folder and leaves everything in it on disk. Deleting a
 * container should never be a way to lose work you did not name.
 */
export async function deleteCollection(collection: CollectionFile): Promise<boolean> {
  const { vaultPath, patchFrontmatter } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  if (vaultPath === null) return false;
  // A page-declared collection has no marker to delete — deleting one failed
  // and the collection stayed. What un-collects it is its page no longer
  // saying so: the page keeps its prose and becomes an ordinary page, and
  // everything in the folder stays, as "keeps contents" promises.
  if (collection.page !== undefined) {
    // A rename made before edits reached the page could have written a stray
    // marker beside it, and a surviving one brings the collection straight
    // back the moment the page stops claiming the folder. Deleted only when
    // it is really there, and a failure to delete it is a failure.
    let stray: boolean;
    try {
      stray = (await listCollections(vaultPath)).some((m) => m.folder === collection.folder);
    } catch {
      toast(`Couldn't remove "${collection.definition.name}"`);
      return false;
    }
    if (!(await patchFrontmatter(collection.page, { type: null }))) return false;
    if (stray) {
      try {
        await deleteNote(vaultPath, `${collection.folder}/collection.yml`);
      } catch {
        toast(`Couldn't remove the old collection.yml in ${collection.folder}`);
        await refresh();
        return false;
      }
    }
    await refresh();
    return true;
  }
  try {
    await deleteNote(vaultPath, `${collection.folder}/collection.yml`);
  } catch {
    toast(`Couldn't remove "${collection.definition.name}"`);
    return false;
  }
  await refresh();
  return true;
}

/**
 * A new page inside a container (M47.5).
 *
 * The gap this milestone opened with: a Collection's `+` offered exactly one
 * thing, "New list", and its empty state told you to go and use it. There was
 * no way to put a DOC in a collection at all — a container documented as
 * holding "Lists, Folders, and Docs" could only be given one of the three.
 *
 * Untitled and opened immediately rather than behind a name dialog. A page you
 * are already typing into is the shortest path to having written something,
 * and the H1 IS the name — asking for one up front is the ceremony this
 * milestone exists to remove.
 */
export async function createPageIn(folder: string, title = 'Untitled'): Promise<string | null> {
  const { entries, createItem } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  const taken = new Set(entries.filter((e) => e.folder === folder).map((e) => e.filename));
  const base = slugify(title) || 'page';
  let slug = base;
  for (let n = 2; taken.has(`${slug}.md`); n += 1) slug = `${base}-${n}`;
  try {
    return await createItem({ folder, slug, frontmatter: {}, body: `# ${title}\n` });
  } catch {
    toast("Couldn't create the page");
    return null;
  }
}
