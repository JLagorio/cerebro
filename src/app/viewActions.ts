/**
 * Saved-view write side (M3.5). Views are YAML files under `views/` (vault
 * global) or `<project>/views/` (scoped). Promoting views to a top-level
 * concept meant every surface needed one hardened path to create, update, and
 * delete them — previously only ProjectPage could write a view at all.
 */

import { serializeView } from '@/engine/views';
import type { ViewDefinition, ViewFile } from '@/engine/types';
import { deleteNote, saveView } from '@/lib/ipc';
import { slugifyViewId } from '@/views/ViewToolbar';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/** `projects/x/project.md` → `projects/x` (a view's scope folder). */
export const projectDirOf = (projectPath: string) => projectPath.replace(/\/project\.md$/, '');

/** Unique id within the scope: "sprint", then "sprint-2". */
export function nextViewId(name: string, taken: Iterable<string>): string {
  const base = slugifyViewId(name) || 'view';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

async function write(
  id: string,
  definition: ViewDefinition,
  project: string | null,
): Promise<boolean> {
  const { vaultPath, rescan } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  if (vaultPath === null) return false;
  try {
    await saveView(vaultPath, id, serializeView(definition), project === null ? null : projectDirOf(project));
  } catch {
    toast(`Couldn't save "${definition.name}"`);
    return false;
  }
  try {
    await rescan();
  } catch {
    toast("Couldn't refresh vault");
  }
  return true;
}

/** Create a view; returns its id so the caller can navigate to it. */
export async function createView(
  definition: ViewDefinition,
  project: string | null = null,
): Promise<string | null> {
  const { views } = useVaultStore.getState();
  const taken = views.filter((v) => v.project === project).map((v) => v.id);
  const id = nextViewId(definition.name, taken);
  return (await write(id, definition, project)) ? id : null;
}

/** Persist edits to an existing view (toolbar changes auto-save through here). */
export async function updateView(view: ViewFile, definition: ViewDefinition): Promise<boolean> {
  return write(view.id, definition, view.project);
}

export async function deleteView(view: ViewFile): Promise<boolean> {
  const { vaultPath, rescan } = useVaultStore.getState();
  const toast = useUiStore.getState().toast;
  if (vaultPath === null) return false;
  const dir = view.project === null ? 'views' : `${projectDirOf(view.project)}/views`;
  try {
    await deleteNote(vaultPath, `${dir}/${view.id}.yml`);
  } catch {
    toast(`Couldn't delete "${view.definition.name}"`);
    return false;
  }
  try {
    await rescan();
  } catch {
    toast("Couldn't refresh vault");
  }
  return true;
}
