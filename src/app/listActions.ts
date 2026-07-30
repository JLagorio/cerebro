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
 * The load-bearing rule: a List is UPDATED WHERE IT LIVES. Editing a legacy
 * `views/*.yml` rewrites that file rather than migrating it to a `.list.yml`,
 * because silently relocating someone's file on a toolbar click is not a
 * migration, it is a surprise — and it would break any external reference to it.
 */

import { newCollectionDefinition, serializeCollection } from '@/engine/collections';
import { serializeList } from '@/engine/views';
import type {
  CollectionDefinition,
  CollectionFile,
  ListDefinition,
  ListFile,
} from '@/engine/types';
import { deleteNote, saveCollection, saveList, saveView } from '@/lib/ipc';
import { slugifyListId } from '@/views/ViewToolbar';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** `projects/x/project.md` → `projects/x` (a legacy view's scope folder). */
export const projectDirOf = (projectPath: string) => projectPath.replace(/\/project\.md$/, '');

/** Unique id within the folder: "sprint", then "sprint-2". */
export function nextListId(name: string, taken: Iterable<string>): string {
  const base = slugifyListId(name) || 'list';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

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

async function refresh(): Promise<void> {
  try {
    await useVaultStore.getState().rescan();
  } catch {
    useUiStore.getState().toast("Couldn't refresh vault");
  }
}

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

/**
 * Create a List inside a Collection. Returns its id so the caller can navigate
 * to it.
 *
 * `collection` is REQUIRED — this is the write-side half of "a Collection-less
 * List is forbidden". The read side cannot represent one (see
 * effectiveCollections); this makes sure nothing tries to author one either.
 */
export async function createList(
  definition: ListDefinition,
  collection: string,
): Promise<string | null> {
  const { views } = useVaultStore.getState();
  // Ids are unique per FOLDER, so only the siblings in this collection are taken.
  const taken = views.filter((v) => v.collection === collection).map((v) => v.id);
  const id = nextListId(definition.name, taken);
  return (await writeList(id, definition, { collection })) ? id : null;
}

/** Create a legacy project-scoped view (a project tab). */
export async function createProjectList(
  definition: ListDefinition,
  project: string,
): Promise<string | null> {
  const { views } = useVaultStore.getState();
  const taken = views.filter((v) => v.project === project).map((v) => v.id);
  const id = nextListId(definition.name, taken);
  return (await writeList(id, definition, { collection: null, legacy: { project } }))
    ? id
    : null;
}

/** Persist edits to an existing List — in place, whatever shape it is on disk. */
export async function updateList(list: ListFile, definition: ListDefinition): Promise<boolean> {
  const legacy = isLegacy(list) ? { project: list.project } : undefined;
  return writeList(list.id, definition, { collection: list.collection, legacy });
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
  const folder = nextCollectionFolder(trimmed, collections.map((c) => c.folder));
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
  const { vaultPath } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  if (vaultPath === null) return false;
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
 * Stop a folder being a Collection by removing its marker.
 *
 * Deliberately NOT a recursive delete. The Lists and Docs inside are content;
 * the marker is the only thing that made the folder a container, so removing it
 * un-collects the folder and leaves everything in it on disk. Deleting a
 * container should never be a way to lose work you did not name.
 */
export async function deleteCollection(collection: CollectionFile): Promise<boolean> {
  const { vaultPath } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  if (vaultPath === null) return false;
  try {
    await deleteNote(vaultPath, `${collection.folder}/collection.yml`);
  } catch {
    toast(`Couldn't remove "${collection.definition.name}"`);
    return false;
  }
  await refresh();
  return true;
}
