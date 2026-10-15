import type { DateValue } from '@/engine/dates';
import { isKnowledgePath } from '@/engine/okf';
import { planDetach } from '@/engine/recurrence';
import { buildSchema } from '@/engine/schema';
import { isReservedTypeName } from '@/engine/typeCatalog';
import { flushOpenPages, heldOpenPages } from '@/editor/openPages';
import { isTemplate } from '@/lib/templates';
import { readNoteSource, scanVault } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';

const CHANGED = 'This event changed. Reopen the calendar and try again.';

/** One event becomes one ordinary page in the same undoable batch that
 * excludes it from its series. Nothing navigates until both writes land. */
export async function detachOccurrence(
  path: string,
  occurrence: DateValue,
): Promise<string | null> {
  const initial = useVaultStore.getState();
  const vault = initial.vaultPath;
  if (vault === null || refusedAcrossVaults(initial)) return null;
  const sameVault = () => useVaultStore.getState().vaultPath === vault;
  const current = () => sameVault() && !refusedAcrossVaults(useVaultStore.getState());
  const toast = (message: string) => {
    if (sameVault()) useUiStore.getState().toast(message);
  };
  try {
    await flushOpenPages();
    if (!current()) return null;
    if (heldOpenPages().includes(path)) {
      toast(
        'This page has changes waiting on you. Settle them before making this event its own page.',
      );
      return null;
    }
    // A failed scan must stop here instead of planning from the store's last
    // good snapshot: that can choose a taken name or an obsolete schema.
    const entries = await scanVault(vault);
    if (!current()) return null;
    const series = entries.find((entry) => entry.path === path);
    if (
      series === undefined ||
      series.parseError !== null ||
      isKnowledgePath(path) ||
      isTemplate(series) ||
      (series.type !== null && isReservedTypeName(series.type))
    ) {
      toast(CHANGED);
      return null;
    }
    const source = await readNoteSource(vault, path);
    if (!current()) return null;
    if (series.hash !== null && series.hash !== source.hash) {
      toast(CHANGED);
      return null;
    }
    const plan = planDetach(series, source, occurrence, entries, buildSchema(entries));
    if (plan === null) {
      toast(CHANGED);
      return null;
    }
    if (heldOpenPages().includes(path)) {
      toast(
        'This page has changes waiting on you. Settle them before making this event its own page.',
      );
      return null;
    }
    const applied = await useVaultStore.getState().applyBatch(plan.ops, { undo: plan.label });
    if (applied === null || !current()) return null;
    useNavStore.getState().navigate({ kind: 'doc', path: plan.path });
    return plan.path;
  } catch (error) {
    toast(
      `Couldn't make this event its own page: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
