import { saveBeforeAction } from '@/app/leaveGuard';
import { PEOPLE_PACK } from '@/engine/packPeople';
import { planPack, type Pack } from '@/engine/packs';
import { heldOpenPages } from '@/editor/openPages';
import { scanVault } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';
/** Fresh reads and their hashes protect existing declarations; one batch supplies Undo. */
export async function installPack(pack: Pack = PEOPLE_PACK): Promise<boolean> {
  const state = useVaultStore.getState(),
    vault = state.vaultPath;
  if (vault === null || refusedAcrossVaults(state)) return false;
  let live = true;
  const unsubscribe = useVaultStore.subscribe((next, previous) => {
    if (next.vaultPath !== previous.vaultPath) live = false;
  });
  const current = () => live && useVaultStore.getState().vaultPath === vault;
  try {
    if (!(await saveBeforeAction('all', 'caller'))) return false;
    if (!current()) return false;
    if (heldOpenPages().length > 0)
      throw new Error('Finish saving the open pages before installing the pack.');
    const entries = await scanVault(vault);
    if (!current()) return false;
    const plan = planPack(pack, entries);
    if (plan.conflicts.length > 0) throw new Error(plan.conflicts.join(' '));
    if (plan.ops.length === 0) return true;
    if (heldOpenPages().length > 0)
      throw new Error('An open page has a save waiting. Try again after it saves.');
    return (
      (await useVaultStore.getState().applyBatch(plan.ops, { undo: `Installed ${pack.name}` })) !==
        null && current()
    );
  } catch (error) {
    if (current())
      useUiStore
        .getState()
        .toast(
          `Couldn't install ${pack.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
    return false;
  } finally {
    unsubscribe();
  }
}
