import { create } from 'zustand';
import { restoreItem } from '@/app/trashActions';
import { undoRename } from '@/app/renameActions';
import type { PageAttribution } from '@/engine/attribution';
import { stalePath, type FileResult } from '@/engine/batch';
import type { TrashedItem } from '@/engine/trash';
import { isKnowledgePath } from '@/engine/okf';
import {
  entryBytes,
  renameBytes,
  undoableRename,
  type RenameChange,
  EVICTED,
  keptItem,
  keptWords,
  NAMED,
  REDO,
  refusedWords,
  revertOps,
  UNDO,
  undidWords,
  undoableFiles,
  whoChanged,
} from '@/engine/undoPlan';
import * as ipc from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Undo and redo of the person's own changes (M60.7, CV-39): the batches a
 * labelled `applyBatch` lands, link-keeping renames, and the pages
 * `trashPath` moves to the Trash, from this session only. Never knowledge/
 * file restoration (CV-07), never a proposal
 * decision, never an agent's write: nothing else pushes here.
 *
 * `past` holds what undo takes, newest last; `future` what redo takes. A
 * push clears `future`. Undo takes its entry off the stack at once, so a
 * second press takes the next while the first is in flight. A request that
 * failed (no answer, or the backend couldn't finish) puts the entry back
 * where it was; one the backend refused (a page changed since, a path now
 * taken) or that kept every change drops off. An entry undone moves to the
 * other side as its inverse, the revert of its result, under the same id,
 * so the Undo and Redo toasts of one change name one entry.
 *
 * Session-only, capped at `MAX_ENTRIES` and `MAX_BYTES` of pre-images, the
 * oldest out; cleared when the vault changes. Nothing here throws (CV-03).
 */

export const MAX_ENTRIES = 50;
export const MAX_BYTES = 32 * 1024 * 1024;

/** How many pages changed since are asked who changed them, before undo. */
const ASKED = 10;

interface EntryBase {
  id: number;
  label: string;
  vault: string;
  /** When the change landed (ms): a writer recorded after it changed a page
   * since. */
  at: number;
}

/** A batch's results (undo or redo reverts them), or a Trash move (undo
 * restores the item; redo moves its path to the Trash again). */
export type UndoEntry =
  | (EntryBase & { kind: 'batch'; files: FileResult[] })
  | (EntryBase & { kind: 'trash'; item: TrashedItem })
  | (EntryBase & { kind: 'rename'; change: RenameChange });

type Side = 'past' | 'future';

interface UndoState {
  past: UndoEntry[];
  future: UndoEntry[];
  /** Push a landed batch. Unchanged pages and knowledge/ paths are dropped;
   * returns the entry's id, or null when nothing was left to undo. */
  pushBatch(label: string, vault: string, files: FileResult[]): number | null;
  /** Push a Trash move; null for a knowledge/ path. */
  pushTrash(label: string, vault: string, item: TrashedItem): number | null;
  /** Push a human link-keeping rename; knowledge file writes never enter. */
  pushRename(label: string, vault: string, change: RenameChange): number | null;
  /** Undo the newest change. False when the stack is empty or it failed. */
  undo(): Promise<boolean>;
  /** Redo the newest undone change. */
  redo(): Promise<boolean>;
  /** Undo one entry from anywhere in `past` (a toast's Undo). */
  undoEntry(id: number): Promise<boolean>;
  /** Redo one entry from anywhere in `future` (a toast's Redo). */
  redoEntry(id: number): Promise<boolean>;
  clear(): void;
}

let nextId = 1;

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Drop the oldest entries until both caps hold, `past` first. */
function capped(past: UndoEntry[], future: UndoEntry[]): Pick<UndoState, 'past' | 'future'> {
  const bytes = (entry: UndoEntry) =>
    entry.kind === 'batch'
      ? entryBytes(entry.files)
      : entry.kind === 'rename'
        ? renameBytes(entry.change)
        : 0;
  let total = [...past, ...future].reduce((sum, entry) => sum + bytes(entry), 0);
  const p = [...past];
  const f = [...future];
  while (p.length + f.length > MAX_ENTRIES || (total > MAX_BYTES && p.length + f.length > 0)) {
    const out = p.length > 0 ? p.shift() : f.shift();
    if (out !== undefined) total -= bytes(out);
  }
  return { past: p, future: f };
}

const titleOf = (path: string): string =>
  useVaultStore.getState().entries.find((e) => e.path === path)?.title ?? path;

async function attributionOf(vault: string, path: string): Promise<PageAttribution | null> {
  try {
    return await ipc.pageAttribution(vault, path);
  } catch {
    // A failed read names no one (CV-05): the sentence drops the writer.
    return null;
  }
}

/** Who changed each page the store's scan says moved off what the change
 * wrote, asked before undo writes anything: once undo has written a page,
 * its last writer is undo itself. */
async function askBefore(
  entry: UndoEntry & { kind: 'batch' },
): Promise<Map<string, string | null>> {
  const { entries } = useVaultStore.getState();
  const moved = entry.files
    .filter((file) => file.afterHash !== null)
    .filter((file) => entries.find((e) => e.path === file.path)?.hash !== file.afterHash)
    .slice(0, ASKED);
  const named = await Promise.all(
    moved.map(async (file) => {
      const attribution = await attributionOf(entry.vault, file.path);
      return [file.path, whoChanged(attribution, entry.at, entries)] as const;
    }),
  );
  return new Map(named);
}

/** What one run of an entry came to. */
type Outcome =
  { kind: 'done'; inverse: UndoEntry | null } | { kind: 'retry' } | { kind: 'dropped' };

/** Revert a batch entry: undo from `past`, redo from `future`. */
async function runBatch(entry: UndoEntry & { kind: 'batch' }, from: Side): Promise<Outcome> {
  const { toast } = useUiStore.getState();
  const asked = await askBefore(entry);
  const heard: { refusal: string | null } = { refusal: null };
  const applied = await useVaultStore.getState().applyBatch(revertOps(entry.files), {
    onRefused: (message) => {
      heard.refusal = message;
    },
  });
  if (applied === null) {
    const message = heard.refusal;
    if (message === null) return { kind: 'retry' };
    if (message.startsWith("Couldn't")) {
      toast(message);
      return { kind: 'retry' };
    }
    const stale = stalePath(message);
    if (stale === null) {
      toast(message);
    } else {
      const who = asked.has(stale)
        ? (asked.get(stale) ?? null)
        : whoChanged(
            await attributionOf(entry.vault, stale),
            entry.at,
            useVaultStore.getState().entries,
          );
      toast(refusedWords(titleOf(stale), who));
    }
    return { kind: 'dropped' };
  }
  const kept: string[] = [];
  for (const file of applied.files) {
    for (const key of file.skipped?.keys ?? []) {
      const who = kept.length < NAMED ? (asked.get(file.path) ?? null) : null;
      kept.push(keptItem(key, titleOf(file.path), who));
    }
  }
  const files = undoableFiles(applied.files);
  const inverse: UndoEntry | null = files.length === 0 ? null : { ...entry, at: Date.now(), files };
  if (from === 'past') {
    const words = kept.length > 0 ? keptWords(entry.label, kept) : undidWords(entry.label);
    toast(words, redoAction(inverse));
  } else {
    toast(entry.label, undoAction(inverse));
  }
  return inverse === null ? { kind: 'dropped' } : { kind: 'done', inverse };
}

/** Undo a Trash move (restore the item), or redo it (trash its path again,
 * under a new stamp). */
async function runTrash(entry: UndoEntry & { kind: 'trash' }, from: Side): Promise<Outcome> {
  const { toast } = useUiStore.getState();
  if (from === 'past') {
    const path = await restoreItem(entry.item, { quiet: true });
    if (path === null) return { kind: 'dropped' };
    const inverse: UndoEntry = { ...entry, at: Date.now() };
    toast(undidWords(entry.label), redoAction(inverse));
    return { kind: 'done', inverse };
  }
  try {
    const item = await ipc.deleteNote(entry.vault, entry.item.path);
    await useVaultStore.getState().rescan();
    const inverse: UndoEntry = { ...entry, at: Date.now(), item };
    toast(entry.label, undoAction(inverse));
    return { kind: 'done', inverse };
  } catch (err) {
    toast(reasonOf(err));
    await useVaultStore.getState().rescan();
    return { kind: 'dropped' };
  }
}

/** Moves reverse as one checked batch; edited pages stay and are named. */
async function runRename(entry: UndoEntry & { kind: 'rename' }, from: Side): Promise<Outcome> {
  const result = await undoRename(entry.vault, entry.change, entry.at);
  if (result.kind !== 'done') return result;
  const inverse: UndoEntry | null = undoableRename(result.inverse)
    ? { ...entry, at: Date.now(), change: result.inverse }
    : null;
  const words =
    from === 'past'
      ? result.kept.length > 0
        ? keptWords(entry.label, result.kept)
        : undidWords(entry.label)
      : result.kept.length > 0
        ? `${entry.label}. Kept changes made since: ${result.kept.join(', ')}`
        : entry.label;
  useUiStore.getState().toast(words, from === 'past' ? redoAction(inverse) : undoAction(inverse));
  return inverse === null ? { kind: 'dropped' } : { kind: 'done', inverse };
}

function undoAction(entry: UndoEntry | null) {
  if (entry === null) return undefined;
  return { action: { label: UNDO, run: () => void useUndoStore.getState().undoEntry(entry.id) } };
}

function redoAction(entry: UndoEntry | null) {
  if (entry === null) return undefined;
  return { action: { label: REDO, run: () => void useUndoStore.getState().redoEntry(entry.id) } };
}

export const useUndoStore = create<UndoState>()((set, get) => {
  /** Take entry `id` off `from` at once, run it, and settle where it goes. */
  async function take(from: Side, id: number): Promise<boolean> {
    const side = get()[from];
    const at = side.findIndex((entry) => entry.id === id);
    if (at === -1) return false;
    const entry = side[at];
    set({ [from]: side.filter((e) => e.id !== id) } as Partial<UndoState>);
    let outcome: Outcome;
    try {
      // Another vault's entry: nothing to put it back on, and its paths
      // would land on whatever sits there now.
      if (entry.vault !== useVaultStore.getState().vaultPath) {
        outcome = { kind: 'dropped' };
      } else {
        outcome =
          entry.kind === 'batch'
            ? await runBatch(entry, from)
            : entry.kind === 'rename'
              ? await runRename(entry, from)
              : await runTrash(entry, from);
      }
    } catch (err) {
      useUiStore.getState().toast(reasonOf(err));
      outcome = { kind: 'retry' };
    }
    // The vault switch clears history even when an earlier request was
    // already in flight. Never repopulate either stack with its old entry.
    if (entry.vault !== useVaultStore.getState().vaultPath) return false;
    if (outcome.kind === 'retry') {
      const now = [...get()[from]];
      now.splice(Math.min(at, now.length), 0, entry);
      set({ [from]: now } as Partial<UndoState>);
      return false;
    }
    if (outcome.kind === 'done' && outcome.inverse !== null) {
      const to: Side = from === 'past' ? 'future' : 'past';
      const { past, future } = get();
      set(
        to === 'future'
          ? capped(past, [...future, outcome.inverse])
          : capped([...past, outcome.inverse], future),
      );
      return true;
    }
    return false;
  }

  return {
    past: [],
    future: [],

    pushBatch(label, vault, files) {
      const kept = undoableFiles(files);
      if (kept.length === 0) return null;
      const entry: UndoEntry = {
        id: nextId++,
        label,
        vault,
        at: Date.now(),
        kind: 'batch',
        files: kept,
      };
      set(capped([...get().past, entry], []));
      return entry.id;
    },

    pushTrash(label, vault, item) {
      if (isKnowledgePath(item.path)) return null;
      const entry: UndoEntry = { id: nextId++, label, vault, at: Date.now(), kind: 'trash', item };
      set(capped([...get().past, entry], []));
      return entry.id;
    },

    pushRename(label, vault, change) {
      if (!undoableRename(change)) return null;
      const entry: UndoEntry = {
        id: nextId++,
        label,
        vault,
        at: Date.now(),
        kind: 'rename',
        change,
      };
      set(capped([...get().past, entry], []));
      return entry.id;
    },

    async undo() {
      const newest = get().past.at(-1);
      return newest === undefined ? false : take('past', newest.id);
    },

    async redo() {
      const newest = get().future.at(-1);
      return newest === undefined ? false : take('future', newest.id);
    },

    async undoEntry(id) {
      if (get().past.some((entry) => entry.id === id)) return take('past', id);
      // Already undone: its Redo toast carries it now.
      if (!get().future.some((entry) => entry.id === id)) useUiStore.getState().toast(EVICTED);
      return false;
    },

    async redoEntry(id) {
      if (get().future.some((entry) => entry.id === id)) return take('future', id);
      if (!get().past.some((entry) => entry.id === id)) useUiStore.getState().toast(EVICTED);
      return false;
    },

    clear() {
      set({ past: [], future: [] });
    },
  };
});
