import { withInheritedAgents } from '@/engine/assignment';
import { flushOpenPages, heldOpenPages } from '@/editor/openPages';
import { MAX_BATCH_OPS, type BatchOp } from '@/engine/batch';
import {
  BULK_CHANGED,
  BULK_FAILED,
  BULK_KNOWLEDGE,
  BULK_UNREADABLE,
  type BulkRead,
} from '@/engine/bulkPlan';
import type { FiledUnder } from '@/engine/createRecord';
import { fileUnderPatch, pointsAt, unfileFromPatch } from '@/engine/linkDelta';
import { isKnowledgePath } from '@/engine/okf';
import { validatePatch } from '@/engine/properties';
import type { Entry, FieldDef, Schema } from '@/engine/types';
import { resolveTarget } from '@/engine/wikilink';
import { useUiStore } from '@/stores/uiStore';
import { refusedAcrossVaults, useVaultStore } from '@/stores/vaultStore';
import { readRows, type BulkResult } from './bulkActions';

type PatchOp = Extract<BatchOp, { op: 'patch' }>;
export interface AddExistingResult extends BulkResult {
  moved: number;
}

const ownerField = (entry: Entry, field: string, schema: Schema): FieldDef | undefined =>
  entry.type === null
    ? undefined
    : schema.types.get(entry.type)?.fields.find((def) => def.name === field);

function readFailure(entry: Entry, reads: ReadonlyMap<string, BulkRead>): string | null {
  if (isKnowledgePath(entry.path)) return BULK_KNOWLEDGE;
  if (heldOpenPages().includes(entry.path)) return 'has changes waiting on you';
  const read = reads.get(entry.path);
  if (read === undefined) return BULK_UNREADABLE;
  return read.hash === entry.hash ? null : BULK_CHANGED;
}

/** Selection retains the versions shown in the picker. Only ready rows join
 * the one batch, so an intervening edit remains both untouched and selected. */
export async function addExistingToHost(
  filing: FiledUnder,
  selected: readonly Entry[],
  schema: Schema,
): Promise<AddExistingResult> {
  const rows = [...new Map(selected.map((entry) => [entry.path, entry])).values()];
  const failAll = (): AddExistingResult => ({
    failed: new Map(rows.map((entry) => [entry.path, BULK_FAILED])),
    moved: 0,
  });
  const state = useVaultStore.getState();
  const vault = state.vaultPath;
  if (vault === null || refusedAcrossVaults(state)) return failAll();
  try {
    await flushOpenPages();
    if (useVaultStore.getState().vaultPath !== vault) return failAll();
    const reads = await readRows(vault, rows);
    const current = useVaultStore.getState();
    if (current.vaultPath !== vault || refusedAcrossVaults(current)) return failAll();
    if (!current.entries.some((entry) => entry.path === filing.host.path)) return failAll();
    const failed = new Map<string, string>();
    const moved = new Set<string>();
    const ops: PatchOp[] = [];
    for (const entry of rows) {
      const def = ownerField(entry, filing.field, schema);
      const reason = readFailure(entry, reads);
      if (reason !== null) failed.set(entry.path, reason);
      else if (def?.kind !== 'relation' || def.from !== undefined)
        failed.set(entry.path, `${filing.field} is not a stored relation`);
      else {
        const set = fileUnderPatch(entry, def, filing.host, current.entries);
        if (set === null) continue;
        const invalid = validatePatch(schema, entry, set)[0];
        if (invalid !== undefined) {
          failed.set(entry.path, invalid);
          continue;
        }
        ops.push({ op: 'patch', path: entry.path, set, expectHash: reads.get(entry.path)!.hash });
        if (def.limit === 1 && (entry.relationships[filing.field]?.length ?? 0) > 0)
          moved.add(entry.path);
      }
    }
    if (ops.length > MAX_BATCH_OPS) {
      for (const op of ops) failed.set(op.path, `more than ${MAX_BATCH_OPS} at once`);
      return { failed, moved: 0 };
    }
    if (ops.length > 0) {
      const applied = await current.applyBatch(withInheritedAgents(ops, current.entries, schema), {
        undo: `Added ${ops.length} records to “${filing.host.title}”`,
      });
      if (applied === null) {
        for (const op of ops) failed.set(op.path, BULK_FAILED);
        return { failed, moved: 0 };
      }
    }
    return { failed, moved: moved.size };
  } catch {
    return failAll();
  }
}

/** A reciprocal edit changes only the stored owning side, atomically. There
 * is no extra copy of the relationship on the page showing the derived field. */
export async function writeReciprocal(
  host: Entry,
  from: { type: string; field: string },
  next: readonly string[],
  entries: readonly Entry[],
  schema: Schema,
): Promise<boolean> {
  const fail = () => {
    useUiStore.getState().toast("Couldn't update related records");
    return false;
  };
  const state = useVaultStore.getState();
  const vault = state.vaultPath;
  if (vault === null || refusedAcrossVaults(state)) return fail();
  try {
    const wanted = new Set<string>();
    for (const raw of next) {
      const target = resolveTarget(raw, entries);
      if (target === null || target.type !== from.type) return fail();
      wanted.add(target.path);
    }
    const changes: { entry: Entry; set: Record<string, unknown> }[] = [];
    for (const entry of entries) {
      if (entry.type !== from.type) continue;
      const def = ownerField(entry, from.field, schema);
      if (!wanted.has(entry.path) && !pointsAt(entry, from.field, host, entries)) continue;
      if (def?.kind !== 'relation' || def.from !== undefined) return fail();
      const set = wanted.has(entry.path)
        ? fileUnderPatch(entry, def, host, entries)
        : unfileFromPatch(entry, from.field, host, entries);
      if (set !== null) changes.push({ entry, set });
    }
    if (changes.length === 0) return true;
    if (changes.length > MAX_BATCH_OPS) return fail();
    await flushOpenPages();
    if (useVaultStore.getState().vaultPath !== vault) return false;
    const reads = await readRows(
      vault,
      changes.map(({ entry }) => entry),
    );
    const current = useVaultStore.getState();
    if (current.vaultPath !== vault || refusedAcrossVaults(current)) return false;
    if (!current.entries.some((entry) => entry.path === host.path)) return fail();
    const ops: PatchOp[] = [];
    for (const { entry, set } of changes) {
      if (readFailure(entry, reads) !== null || validatePatch(schema, entry, set).length > 0)
        return fail();
      ops.push({ op: 'patch', path: entry.path, set, expectHash: reads.get(entry.path)!.hash });
    }
    return (await current.applyBatch(withInheritedAgents(ops, current.entries, schema))) !== null;
  } catch {
    return fail();
  }
}
