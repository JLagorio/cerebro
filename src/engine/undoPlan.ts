import type { PageAttribution } from './attribution';
import { writerWords } from './attribution';
import type { BatchOp, FileResult } from './batch';
import { isKnowledgePath } from './okf';
import { humanize } from './schema';
import type { Entry } from './types';

/**
 * Undo and redo, planned (M60.7): the revert ops a change's results turn
 * into, and every sentence the person reads around them. Pure: no IPC, no
 * store. `stores/undoStore.ts` holds the stack and runs it.
 *
 * Undo is the revert of a change's results, and redo is the revert of
 * undo's results: each revert's result holds what it overwrote, so the chain
 * runs both ways through one op (batch.rs's module doc holds the rule).
 */

/** A result the change wrote nothing through: both hashes agree and nothing
 * moved through the Trash. A page a revert skipped whole is one. */
export function unchanged(file: FileResult): boolean {
  return file.trashed === null && file.restored === null && file.beforeHash === file.afterHash;
}

/** The results undo can act on: changed pages outside knowledge/, which is
 * never undoable (CV-07). */
export function undoableFiles(files: readonly FileResult[]): FileResult[] {
  return files.filter((file) => !unchanged(file) && !isKnowledgePath(file.path));
}

/** One revert op per changed page, in the change's order. */
export function revertOps(files: readonly FileResult[]): BatchOp[] {
  return undoableFiles(files).map((file) => ({
    op: 'revert',
    path: file.path,
    afterHash: file.afterHash,
    before: file.before,
    keys: file.keys,
    trashed: file.trashed,
    restored: file.restored,
  }));
}

/** The pre-images an entry holds, in UTF-16 units: what the stack's byte cap
 * counts. */
export function entryBytes(files: readonly FileResult[]): number {
  return files.reduce((sum, file) => sum + (file.before?.length ?? 0), 0);
}

// --- Words (Appendix B) ----------------------------------------------------------

const pages = (n: number): string => (n === 1 ? '1 page' : `${n} pages`);

export const renamedLabel = (from: string, to: string, n: number): string =>
  `Renamed “${from}” to “${to}” on ${pages(n)}`;
export const kindChangedLabel = (name: string, kind: string, n: number): string =>
  `Changed “${name}” to ${kind} on ${pages(n)}`;
export const addedFromLabel = (added: string, name: string, n: number): string =>
  `Added “${added}” from “${name}” on ${pages(n)}`;
export const copiedLabel = (name: string, n: number): string => `Copied “${name}” on ${pages(n)}`;
export const deletedPropertyLabel = (name: string): string => `Deleted property “${name}”`;
export const convertedLabel = (type: string): string => `Converted to ${type}`;

export const UNDO = 'Undo';
export const REDO = 'Redo';
export const EVICTED = 'That change is too old to undo here; git still has it.';

export const undidWords = (label: string): string => `Undid: ${label}`;

/** How many named items a sentence shows before "and N more". */
export const NAMED = 3;

/** One kept key, as the person reads it. `who` null names no one. */
export function keptItem(key: string, title: string, who: string | null): string {
  const item = `${humanize(key)} on “${title}”`;
  return who === null ? item : `${item} (${who})`;
}

/** Undo that kept `items` (already in words) because they changed since. */
export function keptWords(label: string, items: readonly string[]): string {
  const k = items.length;
  const shown = items.slice(0, NAMED).join(', ');
  const rest = k - NAMED;
  const more = rest > 0 ? ` and ${rest} more` : '';
  const changes = k === 1 ? '1 change' : `${k} changes`;
  return `${undidWords(label)}. Kept ${changes} made since: ${shown}${more}`;
}

/** Undo refused because a page changed since. */
export function refusedWords(title: string, who: string | null): string {
  return who === null
    ? `Nothing was undone: “${title}” changed since.`
    : `Nothing was undone: “${title}” changed since (${who}).`;
}

/**
 * Who changed a page since the change at `since` (ms), named only from a
 * recorded write (CV-05, M58.1b): a write recorded at or after it names its
 * writer (`writerWords`, "you" for the person); a page changed after the
 * last recorded write reads "changed outside Cerebro". Not recorded, the
 * bundle, an older write and a failed read (`null`) name no one.
 */
export function whoChanged(
  attribution: PageAttribution | null,
  since: number,
  entries: Entry[],
): string | null {
  if (attribution === null) return null;
  switch (attribution.state) {
    case 'recorded': {
      const at = Date.parse(attribution.at);
      if (attribution.actor === null || Number.isNaN(at) || at < since) return null;
      const who = writerWords(attribution.actor, entries);
      return who === 'You' ? 'you' : who;
    }
    case 'unattributed':
      return 'changed outside Cerebro';
    case 'not_recorded':
    case 'knowledge':
      return null;
  }
}
