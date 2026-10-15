import type { BatchApplied } from '@/engine/batch';
import { IMPORT_MAX_BYTES } from '@/engine/fileKinds';
import { parseIcs, type IcsCalendar } from '@/engine/ics';
import { planIcsImport, type IcsMapping } from '@/engine/icsImport';
import { buildSchema } from '@/engine/schema';
import { scanVault } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';

export async function readIcsFile(
  file: Pick<File, 'size' | 'arrayBuffer'>,
): Promise<{ ok: true; content: string } | { ok: false; reason: string }> {
  if (file.size > IMPORT_MAX_BYTES)
    return { ok: false, reason: 'The calendar is larger than 16 MiB.' };
  try {
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > IMPORT_MAX_BYTES)
      return { ok: false, reason: 'The calendar is larger than 16 MiB.' };
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, reason: 'The calendar is not valid UTF-8 text.' };
    }
    const parsed = parseIcs(content);
    return parsed.problem ? { ok: false, reason: parsed.problem } : { ok: true, content };
  } catch {
    return { ok: false, reason: "Couldn't read the calendar. Choose it again." };
  }
}
export function describeIcsImport(applied: BatchApplied): string {
  const counts = new Map<string, number>();
  for (const row of applied.imports ?? [])
    counts.set(row.outcome, (counts.get(row.outcome) ?? 0) + 1);
  const labels: Record<string, string> = {
    created: 'imported',
    replaced: 'updated',
    unchanged: 'already imported, unchanged',
    kept: 'kept with your changes',
    duplicate: 'duplicates skipped',
  };
  return (
    [...counts].map(([key, count]) => `${count} ${labels[key]}`).join('; ') || 'No events changed'
  );
}
/** Re-read schema before applying the preview. A vault round trip or a closed
 * owner retires this action permanently, including its navigation and toast. */
export async function importIcs(
  calendar: IcsCalendar,
  mapping: IcsMapping,
  owned: () => boolean = () => true,
  shouldNavigate: () => boolean = () => true,
): Promise<BatchApplied | null> {
  const state = useVaultStore.getState(),
    vault = state.vaultPath;
  if (!vault || refusedAcrossVaults(state) || !owned()) return null;
  let live = true;
  const unsubscribe = useVaultStore.subscribe((next, previous) => {
    if (next.vaultPath !== previous.vaultPath) live = false;
  });
  const current = () => live && owned() && useVaultStore.getState().vaultPath === vault;
  try {
    const entries = await scanVault(vault);
    if (!current()) return null;
    const plan = planIcsImport(calendar, mapping, entries, buildSchema(entries));
    if (plan.problem || !plan.ops.length) {
      useUiStore.getState().toast(plan.problem ?? 'No events can be imported from this calendar.');
      return null;
    }
    const applied = await useVaultStore
      .getState()
      .applyBatch(plan.ops, { undo: `Imported ${plan.ops.length} events` });
    if (!applied || !current()) return null;
    if (shouldNavigate()) useNavStore.getState().navigate({ kind: 'type', name: mapping.type });
    useUiStore.getState().toast(describeIcsImport(applied));
    return applied;
  } catch (error) {
    if (current())
      useUiStore
        .getState()
        .toast(
          `Couldn't import the calendar: ${error instanceof Error ? error.message : String(error)}`,
        );
    return null;
  } finally {
    unsubscribe();
  }
}
