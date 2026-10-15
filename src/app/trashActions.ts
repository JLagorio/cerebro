/**
 * The vault's Trash (M60.8), for every surface that deletes or restores.
 *
 * A delete moves the page (or folder) and its comments into
 * `.trash/<stamp>/`; Settings → Recently deleted lists what waits there and
 * restores it byte for byte. These are human actions, so none throws
 * (CV-03): each catches, toasts once, rescans so the store shows what the
 * disk holds, and returns null. Call sites keep their own navigation.
 *
 * A move to the Trash is undoable (M60.7): `trashPath` pushes it on the undo
 * stack and its toast carries Undo, which restores the item.
 */

import { couldntMoveToast, movedToast, restoredToast, type TrashedItem } from '@/engine/trash';
import { UNDO } from '@/engine/undoPlan';
import { deleteNote, listTrash, restoreFromTrash } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Move `path` to the Trash, naming it `label` in the toast. Returns the item
 * Settings can restore, or null when refused or failed — including while the
 * store still holds another vault's pages (`refusedAcrossVaults`).
 */
export async function trashPath(path: string, label: string): Promise<TrashedItem | null> {
  const state = useVaultStore.getState();
  const vault = state.vaultPath;
  if (vault === null) return null;
  if (refusedAcrossVaults(state)) return null;
  const { toast } = useUiStore.getState();
  try {
    const item = await deleteNote(vault, path);
    const moved = movedToast(label);
    const id = useUndoStore.getState().pushTrash(moved, vault, item);
    toast(
      moved,
      id === null
        ? undefined
        : { action: { label: UNDO, run: () => void useUndoStore.getState().undoEntry(id) } },
    );
    await useVaultStore.getState().rescan();
    return item;
  } catch (err) {
    toast(`${couldntMoveToast(label)}: ${reasonOf(err)}`);
    await useVaultStore.getState().rescan();
    return null;
  }
}

/**
 * Put `item` back where it came from. Returns the path it restored, or null
 * when refused (something now sits there, or it can't be read) or failed.
 * `quiet` leaves the success toast to the caller (undo says "Undid: …");
 * a refusal still toasts.
 */
export async function restoreItem(
  item: TrashedItem,
  options: { quiet?: boolean } = {},
): Promise<string | null> {
  const vault = useVaultStore.getState().vaultPath;
  if (vault === null) return null;
  const { toast } = useUiStore.getState();
  try {
    const path = await restoreFromTrash(vault, item.stamp);
    if (options.quiet !== true) toast(restoredToast(item.title === '' ? path : item.title));
    await useVaultStore.getState().rescan();
    return path;
  } catch (err) {
    toast(reasonOf(err));
    await useVaultStore.getState().rescan();
    return null;
  }
}

/** What Settings shows: the items, newest first, or why they can't be read. */
export type TrashRead =
  { kind: 'ready'; items: TrashedItem[] } | { kind: 'unavailable'; reason: string };

/** Read `vault`'s Trash. A failed read is unavailable with its reason, never
 * an empty Trash (CV-05). */
export async function loadTrash(vault: string): Promise<TrashRead> {
  try {
    return { kind: 'ready', items: await listTrash(vault) };
  } catch (err) {
    return { kind: 'unavailable', reason: reasonOf(err) };
  }
}
