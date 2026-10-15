import { withInheritedAgents } from '@/engine/assignment';
import { flushOpenPages, heldOpenPages } from '@/editor/openPages';
import {
  BULK_FAILED,
  BULK_KNOWLEDGE,
  planBulkDelete,
  planBulkSet,
  type BulkPlan,
  type BulkRead,
} from '@/engine/bulkPlan';
import { humanize } from '@/engine/schema';
import { movedRecordsToast, movedToast } from '@/engine/trash';
import { isKnowledgePath } from '@/engine/okf';
import type { Entry, Schema } from '@/engine/types';
import { readNoteSource } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';
import { duplicateRecordQuietly } from './recordActions';

export interface BulkResult {
  failed: Map<string, string>;
}

/** Eight reads at a time; absent entries name a failed read, never empty bytes.
 * Keep the table's entries: rescanning before comparison would erase the
 * version the person selected and hide an intervening edit. */
export async function readRows(
  vault: string,
  entries: readonly Entry[],
): Promise<Map<string, BulkRead>> {
  const reads = new Map<string, BulkRead>();
  const unique = [...new Map(entries.map((entry) => [entry.path, entry])).values()];
  for (let offset = 0; offset < unique.length; offset += 8) {
    await Promise.all(
      unique.slice(offset, offset + 8).map(async (entry) => {
        try {
          reads.set(entry.path, await readNoteSource(vault, entry.path));
        } catch {
          /* The planner records this page's failed read. */
        }
      }),
    );
    if (useVaultStore.getState().vaultPath !== vault) break;
  }
  return reads;
}

const failAll = (entries: readonly Entry[], reason = BULK_FAILED): BulkResult => ({
  failed: new Map(entries.map((entry) => [entry.path, reason])),
});

async function applyPlanned(
  entries: readonly Entry[],
  build: (reads: ReadonlyMap<string, BulkRead>) => BulkPlan,
  label: (plan: BulkPlan) => string,
): Promise<BulkResult> {
  const state = useVaultStore.getState();
  const vault = state.vaultPath;
  if (vault === null || refusedAcrossVaults(state)) return failAll(entries);
  try {
    await flushOpenPages();
    if (useVaultStore.getState().vaultPath !== vault) return failAll(entries);
    const reads = await readRows(vault, entries);
    if (useVaultStore.getState().vaultPath !== vault) return failAll(entries);
    const plan = build(reads);
    const held = new Set(heldOpenPages());
    plan.ops = plan.ops.filter((op) => {
      if (!held.has(op.path)) return true;
      plan.failed.set(op.path, 'has changes waiting on you');
      return false;
    });
    if (plan.ops.length > 0) {
      const applied = await useVaultStore.getState().applyBatch(plan.ops, { undo: label(plan) });
      if (applied === null) for (const op of plan.ops) plan.failed.set(op.path, BULK_FAILED);
    }
    if (plan.skipped.length > 0 && useVaultStore.getState().vaultPath === vault)
      useUiStore.getState().toast(`${plan.skipped.length} already had it.`);
    return { failed: plan.failed };
  } catch {
    return failAll(entries);
  }
}

export function bulkSetField(
  entries: readonly Entry[],
  field: string,
  value: unknown,
  schema: Schema,
): Promise<BulkResult> {
  return applyPlanned(
    entries,
    (reads) => {
      const plan = planBulkSet(entries, field, value, schema, reads);
      plan.ops = withInheritedAgents(
        plan.ops,
        useVaultStore.getState().entries,
        schema,
      ) as typeof plan.ops;
      return plan;
    },
    (plan) => `Set “${humanize(field)}” on ${plan.ops.length} records`,
  );
}

export function bulkDelete(entries: readonly Entry[]): Promise<BulkResult> {
  return applyPlanned(
    entries,
    (reads) => planBulkDelete(entries, reads),
    (plan) =>
      plan.ops.length === 1
        ? movedToast(entries.find((entry) => entry.path === plan.ops[0].path)!.title)
        : movedRecordsToast(plan.ops.length),
  );
}

export async function bulkDuplicate(entries: readonly Entry[]): Promise<BulkResult> {
  const state = useVaultStore.getState();
  const vault = state.vaultPath;
  if (vault === null || refusedAcrossVaults(state)) return failAll(entries);
  const failed = new Map<string, string>();
  let made = 0;
  try {
    await flushOpenPages();
    for (const entry of new Map(entries.map((row) => [row.path, row])).values()) {
      if (useVaultStore.getState().vaultPath !== vault) failed.set(entry.path, BULK_FAILED);
      else if (isKnowledgePath(entry.path)) failed.set(entry.path, BULK_KNOWLEDGE);
      else if (heldOpenPages().includes(entry.path))
        failed.set(entry.path, 'has changes waiting on you');
      else if ((await duplicateRecordQuietly(entry)) === null) failed.set(entry.path, BULK_FAILED);
      else made += 1;
    }
    if (made > 0 && useVaultStore.getState().vaultPath === vault)
      useUiStore.getState().toast(`Duplicated ${made} records`);
    return { failed };
  } catch {
    return failAll(entries);
  }
}
