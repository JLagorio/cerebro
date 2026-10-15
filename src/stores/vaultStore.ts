import { create } from 'zustand';
import { validatePatch } from '@/engine/properties';
import { buildSchema } from '@/engine/schema';
import { collectionsFromPages, parseCollectionYaml } from '@/engine/collections';
import type { CollectionFile, Entry, Scalar, Schema, ListFile } from '@/engine/types';
import { parseListYaml } from '@/engine/views';
import * as ipc from '@/lib/ipc';
import { coalescedRefresh, writeFence, type PassOutcome } from '@/lib/trailingRefresh';
import { parseWikilinks } from '@/engine/wikilink';
import { useUiStore } from '@/stores/uiStore';

export interface VaultState {
  vaultPath: string | null;
  entries: Entry[];
  /**
   * The vault `entries` was scanned from — written in the same `set` as every
   * scanned `entries`, and null until a first scan lands (AUTOMATION-2b).
   *
   * Not always `vaultPath`. An open moves `vaultPath` at once but lands the
   * new vault's entries only after its scan and its watcher start, which can
   * take a minute (M49); until then `entries` is the LAST vault's, unless a
   * rescan inside that window lands the new vault's early — it scans
   * `vaultPath` — and the open's older scan is then dropped (`landedScan`).
   * An open that fails leaves `entries` the last vault's.
   * A reader that diffs one scan against the next, or acts on `entries` as
   * the open vault's, checks this first: the trigger diff, run across a
   * switch, read every note in the new vault as just created.
   *
   * So does any writer that names a path from `entries`: while the two
   * differ, that path is a page in the last vault, and a write under
   * `vaultPath` lands on whatever sits at the same path in the new one.
   * `patchFrontmatter` and `setTitle` refuse to write then (M53.30).
   */
  entriesVault: string | null;
  /** Every List in the vault (M10) — what saved views became. */
  views: ListFile[];
  /** Every Collection: the containers Lists and Docs live in (M10). */
  collections: CollectionFile[];
  folders: string[]; // all vault directories incl. empty ones (M2 Task 10 file trees)
  status: 'idle' | 'scanning' | 'ready' | 'error';
  error: string | null;
  openVault(path: string): Promise<void>;
  /**
   * Reread the open vault (M58.2). One scan runs at a time, plus at most one
   * trailing behind it, however many callers ask. Resolves once a scan that
   * started after the call has landed, failed or found the vault moved, so
   * `await rescan()` after a write always sees that write. Never rejects: a
   * failed cycle toasts once and keeps the last good snapshot.
   *
   * Never gated on window visibility or focus: triggers ride on rescans, and
   * a hidden window still runs its automations.
   */
  rescan(): Promise<void>;
  /**
   * Writes a frontmatter patch, or `false` when it was refused or failed —
   * never throws (store-layer invariant). It refuses a patch the schema turns
   * away, and any patch while `entries` is another vault's (`entriesVault`).
   * The boolean exists so an inline editor can keep the text it was given
   * rather than discarding a draft the schema turned away (M20.3); callers
   * with nothing to undo still `void` it.
   */
  patchFrontmatter(path: string, patch: Record<string, unknown>): Promise<boolean>;
  /**
   * Rename a record by rewriting its body's first H1 — which IS its title
   * (M19.3). Returns whether the write landed; like `patchFrontmatter`, it
   * refuses while `entries` is another vault's.
   *
   * Deliberately NOT `renameNote`: that moves the file, and `resolveTarget`
   * matches a wikilink on the filename stem FIRST, so moving the file would
   * dangle every link that names it. This is the same write the detail panel
   * has always made, now reachable from a table cell.
   */
  setTitle(path: string, title: string): Promise<boolean>;
  createItem(args: {
    folder: string;
    slug: string;
    frontmatter: Record<string, unknown>;
    body?: string;
  }): Promise<string>;
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// Re-derive an entry's properties/relationships from an optimistic patch:
// null deletes the field, values containing [[wikilinks]] become
// relationships, everything else lands in properties. Mirrors the split the
// Rust parser performs on the next scan, so the optimistic entry and the
// rescanned entry agree on every field but the hash, which only the write
// knows: until it answers, the hash is null, and a trigger compares nothing
// (M55.2).
function applyPatch(entry: Entry, patch: Record<string, unknown>): Entry {
  const properties = { ...entry.properties };
  const relationships = { ...entry.relationships };
  for (const [key, value] of Object.entries(patch)) {
    delete properties[key];
    delete relationships[key];
    if (value === null || value === undefined) continue;
    const links = parseWikilinks(value);
    if (links !== null) relationships[key] = links;
    else properties[key] = value as Scalar | Scalar[];
  }
  return {
    ...entry,
    properties,
    relationships,
    modifiedAt: new Date().toISOString(),
    hash: null,
  };
}

/**
 * Refuses an inline edit whose path came from another vault's `entries`
 * (see `VaultState.entriesVault`, M53.30): an open is still in flight, or it
 * failed and left the last vault's records on screen. The toast says which,
 * and never stacks under a copy still on screen: a type rename retags its
 * records one patch at a time, so each refusal would add another.
 *
 * null passes. No scan has landed yet, so the app holds no entries to take a
 * path from, and tests seed `entries` without it.
 *
 * Exported for the page actions that move files (app/pageActions.ts, M55.13),
 * which refuse by the same rule.
 */
export function refusedAcrossVaults({ vaultPath, entriesVault, status }: VaultState): boolean {
  if (entriesVault === null || entriesVault === vaultPath) return false;
  const message =
    status === 'error'
      ? "Not saved — the vault didn't open"
      : 'Not saved — the vault is still opening';
  const ui = useUiStore.getState();
  if (!ui.toasts.some((t) => t.message === message)) ui.toast(message);
  return true;
}

/** Read and parse the Lists and Collections in one pass — both surfaces are
 * needed together to build the sidebar tree, so fetching them apart would let
 * the two halves disagree for a frame. */
async function loadCollections(
  vault: string,
  /** Scanned pages, so a Collection declared by its own page is found (M47.5). */
  entries: Entry[],
): Promise<{ views: ListFile[]; collections: CollectionFile[] }> {
  const [rawLists, rawCollections] = await Promise.all([
    ipc.listViews(vault),
    ipc.listCollections(vault),
  ]);
  return {
    views: rawLists.map((v) =>
      parseListYaml(v.id, v.yaml, {
        project: v.project,
        collection: v.collection,
        path: v.path,
      }),
    ),
    // A page wins over a marker for the same folder (M47.5). Both can only
    // coexist mid-conversion, and the page is the form being converted TO —
    // preferring the marker would make a conversion look like it had not
    // happened.
    collections: (() => {
      const fromPages = collectionsFromPages(entries);
      const claimed = new Set(fromPages.map((c) => c.folder));
      const fromYaml = rawCollections
        .map((c) => parseCollectionYaml(c.folder, c.yaml))
        .filter((c) => !claimed.has(c.folder));
      return [...fromPages, ...fromYaml];
    })(),
  };
}

/** One read of a vault: everything a scan lands, shared by openVault and rescan. */
async function readVault(vault: string): Promise<{
  entries: Entry[];
  views: ListFile[];
  collections: CollectionFile[];
  folders: string[];
}> {
  const entries = await ipc.scanVault(vault);
  const { views, collections } = await loadCollections(vault, entries);
  const folders = await ipc.listFolders(vault);
  return { entries, views, collections, folders };
}

let watcherBound = false;

/**
 * The newest open wins (M49). `openVault` shows the shell the moment it sets
 * `vaultPath`, so a person can pick another vault while the first open is
 * still inside `start_watcher` — which is also where the ledger starts
 * recording, and that can take a minute on a vault with history. Two opens
 * in flight used to finish in whatever order the backend did: measured
 * 2026-09-28, a window titled `test` held the demo vault's entries (its pages
 * "couldn't be loaded") and recorded the demo vault, refusing every Keep.
 *
 * So each open takes a ticket and a superseded one stops before it writes
 * anything, and `start_watcher` calls run one after another in the order
 * they were asked for: the backend records ONE vault, the last one started.
 */
let openTicket = 0;
let watcherQueue: Promise<unknown> = Promise.resolve();

/**
 * Scans land newer over older, never the reverse (AUTOMATION-2b). Each scan
 * takes a ticket as it STARTS and lands only if no scan that started after
 * it has landed first. `rescan` scans `vaultPath`, which an open moves
 * before its own scan lands, so a rescan inside that window — a job
 * finishing, a watcher event, an edit — lands the new vault's entries first,
 * and the open's scan, taken before it, used to land over them. The store
 * went back in time, and the trigger diff read the difference as fresh edits,
 * or a file deleted in between as created. Rescans never overlap (they run
 * one at a time, `refresh`), so only an open's scan and a rescan can cross.
 *
 * An optimistic inline edit (`patchFrontmatter`, `setTitle`) writes `entries`
 * without a ticket, so the write fence guards it instead (M58.2): a rescan
 * waits for pending writes before it reads, and one that read while a write
 * began or ended is discarded and read again. A scan read before an inline
 * edit never lands over it.
 */
let scanTicket = 0;
let landedScan = 0;

/**
 * How long a rescan waits on a pending inline write before it reads anyway:
 * the open pages' flush budget. An IPC write slower than that has hung, and
 * the store shows disk truth until it answers; its late answer scans again.
 */
export const WRITE_WAIT_MS = 5_000;

/** The inline writes in flight (M58.2). A scan that lands while one is still
 *  pending is owed another once it settles. */
const newFence = () => writeFence(() => void useVaultStore.getState().rescan());
let writes = newFence();

/**
 * The one rescan: one pass at a time plus one trailing (M58.2). Store-layer
 * invariant (M14.8): actions never throw. Before it, a scan failure was
 * toasted, swallowed, or an unhandled rejection depending on which of a dozen
 * call sites you arrived through. The cycle catches every pass, keeps the
 * last good snapshot, and toasts once per failed cycle, from here.
 */
const newRefresh = () =>
  coalescedRefresh(scanPass, () => useUiStore.getState().toast("Couldn't refresh vault"));
let refresh = newRefresh();

/** One rescan pass: wait out pending writes, read, and land only what is
 *  newer than the store and read after every write it could have missed. */
async function scanPass(): Promise<PassOutcome> {
  await writes.settled(WRITE_WAIT_MS);
  const vault = useVaultStore.getState().vaultPath;
  if (vault === null) return 'done';
  // After the wait: a ticket or mark taken before it would let a write that
  // landed during the wait look older than this read.
  const scan = ++scanTicket;
  const mark = writes.mark();
  let read: Awaited<ReturnType<typeof readVault>>;
  try {
    read = await readVault(vault);
  } catch {
    // The store keeps its last good snapshot; disk truth returns on the next
    // successful scan (watcher event, write, or vault reopen).
    return 'failed';
  }
  // A switch mid-scan: this is the old vault's snapshot, and the open in
  // flight sets the new one's. A newer scan already landed: this one would
  // roll it back (see `landedScan`).
  if (useVaultStore.getState().vaultPath !== vault || scan < landedScan) return 'done';
  // A write began or settled while this read: it may predate the write.
  if (writes.moved(mark)) return 'again';
  landedScan = scan;
  useVaultStore.setState({ ...read, entriesVault: vault, status: 'ready' });
  // It read past a write that outlived WRITE_WAIT_MS: that write's settle
  // scans once more.
  if (mark.pending > 0) writes.owe();
  return 'done';
}

/**
 * An optimistic edit and its disk write, inside the write fence: no rescan
 * reads while it is pending, and one that read across it is read again. The
 * fence ends before the caller's own rescan, which would otherwise wait out
 * WRITE_WAIT_MS on its own write. The one way to fence a write; M60's batch
 * writer and undo reuse it.
 */
async function fencedWrite<T>(apply: () => void, write: () => Promise<T>): Promise<T> {
  const end = writes.begin();
  try {
    apply();
    return await write();
  } finally {
    end();
  }
}

/** Test isolation: forget every pending write and any rescan in flight. */
export function __resetRescans(): void {
  writes = newFence();
  refresh = newRefresh();
}

export const useVaultStore = create<VaultState>()((set, get) => ({
  vaultPath: null,
  entries: [],
  entriesVault: null,
  views: [],
  collections: [],
  folders: [],
  status: 'idle',
  error: null,

  async openVault(path) {
    const ticket = ++openTicket;
    const superseded = () => ticket !== openTicket;
    set({ vaultPath: path, status: 'scanning', error: null });
    // M56.6: who answers in this vault's panel is read now, before the panel
    // can mount, so a handoff that opens the panel finds the binding.
    void useUiStore.getState().loadPanelAgent(path);
    // Its own scan, not a rescan pass: it lands only after its watcher
    // starts (M49), while rescans inside that window land early (M53.8). It
    // still obeys the ticket order and the write fence.
    const scan = ++scanTicket;
    const mark = writes.mark();
    try {
      const { entries, views, collections, folders } = await readVault(path);
      if (superseded()) return;
      const started = watcherQueue.then(() => ipc.startWatcher(path));
      watcherQueue = started.catch(() => undefined);
      await started;
      if (superseded()) return;
      if (inTauri() && !watcherBound) {
        await ipc.listenVaultChanged(() => {
          // rescan() contains its own failures (one toast per failed cycle,
          // the last good snapshot kept) — a transient scan error on a
          // watcher event must not flip the whole app into the dead error
          // shell.
          void get().rescan();
        });
        // Only latch after listen resolves: a failed bind must leave the
        // next openVault free to retry, or the watcher is dead for the whole
        // app lifetime.
        watcherBound = true;
      }
      // A rescan inside the window already landed a newer snapshot of this
      // vault, and `status: 'ready'` with it (see `landedScan`).
      if (scan < landedScan) return;
      // An inline edit was pending or settled while this read (a Reopen
      // racing an edit): the read may predate it, so a rescan pass, which
      // waits for the write, lands the vault and sets 'ready' instead.
      if (mark.pending > 0 || writes.moved(mark)) {
        await get().rescan();
        return;
      }
      landedScan = scan;
      set({ entries, entriesVault: path, views, collections, folders, status: 'ready' });
    } catch (err) {
      if (superseded()) return;
      const message = err instanceof Error ? err.message : String(err);
      set({ status: 'error', error: message });
      // Deviation (Task 23, execution-log note 15a, reported): status:'error'
      // was displayed nowhere — a stale last-vault boot landed in a dead
      // empty shell. Toast the failure so the ToastHost surfaces it; recovery
      // lives in Settings ("Change vault…"), which also shows this error.
      useUiStore.getState().toast(`Couldn't open vault: ${message}`);
    }
  },

  // A stable identity: tests that stub `rescan` through setState still
  // intercept every internal caller, which all go through get().rescan().
  rescan: () => refresh(),

  async patchFrontmatter(path, patch) {
    const state = get();
    const vault = state.vaultPath;
    if (vault === null) return false;
    // Before validation as well: the schema would be built from that other
    // vault's entries too.
    if (refusedAcrossVaults(state)) return false;
    // Normalize once for both the optimistic update and the disk write:
    // undefined means delete, but JSON serialization to Tauri drops
    // undefined keys silently and the mock's yaml doc.set would write
    // `key: null` — null is the one delete spelling every backend honors.
    const normalized = Object.fromEntries(
      Object.entries(patch).map(([key, value]) => [key, value === undefined ? null : value]),
    );
    // Schema enforcement (M2.x properties engine): declared fields must
    // match their YAML-declared shape or the write never reaches disk.
    const target = get().entries.find((e) => e.path === path);
    if (target !== undefined) {
      const errors = validatePatch(getSchema(get().entries), target, normalized);
      if (errors.length > 0) {
        useUiStore.getState().toast(errors[0]);
        return false;
      }
    }
    // Optimistic: local state updates synchronously, before the disk write,
    // inside the write fence, so no scan read before the write lands over it.
    const optimistic = target === undefined ? null : applyPatch(target, normalized);
    try {
      const hash = await fencedWrite(
        () => {
          if (optimistic !== null) {
            set({ entries: get().entries.map((e) => (e.path === path ? optimistic : e)) });
          }
        },
        () => ipc.updateFrontmatter(vault, path, normalized),
      );
      // The write names the bytes it landed (M55.2). The optimistic entry
      // takes that hash only while it still stands: only a scan that read
      // after the write can land first, and it read the disk itself, so it
      // wins. (A second edit on the same path also replaced it.)
      if (hash !== null && optimistic !== null && get().entries.includes(optimistic)) {
        set({
          entries: get().entries.map((e) => (e === optimistic ? { ...optimistic, hash } : e)),
        });
      }
      // The mock backend has no watcher, so reconcile by rescanning after
      // the write. In Tauri no reconcile pass runs at all — the watcher
      // DISCARDS our own write's event (own-write suppression) — so the
      // optimistic entry stands with the hash the write answered; its fields
      // are right because applyPatch classifies values exactly like the
      // parser will on the next scan. A knowledge capture answers no hash,
      // so that entry's hash stays null until the next rescan.
      if (!inTauri()) await get().rescan();
    } catch {
      // Deviation (Task 17, per execution-log deferred note from Task 11
      // review): surface silent write failures to the user via a toast.
      useUiStore.getState().toast(`Couldn't save changes to ${path}`);
      await get().rescan(); // disk truth wins: revert the optimistic update
      return false;
    }
    return true;
  },

  async setTitle(path, title) {
    const state = get();
    const vault = state.vaultPath;
    const target = state.entries.find((e) => e.path === path);
    const trimmed = title.trim();
    // A blank title would leave the record with nothing to be called, and an
    // unchanged one is a write with no content — both are "nothing happened",
    // not failures, so neither toasts.
    if (vault === null || target === undefined || trimmed === '' || trimmed === target.title) {
      return false;
    }
    // After those, unlike patchFrontmatter: a title cell commits on every
    // blur, so one clicked and left unchanged mid-open must not toast.
    if (refusedAcrossVaults(state)) return false;
    // Optimistic and fenced, like patchFrontmatter: `title` is a top-level
    // Entry field rather than frontmatter, so applyPatch is not involved. The
    // new bytes' hash is not known until the rescan below reads them (M55.2).
    try {
      await fencedWrite(
        () =>
          set({
            entries: get().entries.map((e) =>
              e.path === path ? { ...e, title: trimmed, hash: null } : e,
            ),
          }),
        () => ipc.setNoteTitle(vault, path, trimmed),
      );
    } catch {
      useUiStore.getState().toast("Couldn't rename record");
      await get().rescan(); // disk truth wins: revert the optimistic update
      return false;
    }
    // Unconditionally, unlike patchFrontmatter's `!inTauri()` guard: a title
    // feeds derived state the optimistic update does not reach — wikilink
    // resolution and the dossiers keyed off it. `rescan` catches and toasts
    // its own failure, so a refresh that fails must not report the rename
    // as failed; it already landed on disk.
    await get().rescan();
    return true;
  },

  // The documented EXCEPTION to the never-throw invariant (M14.8): callers
  // need the created path to navigate, and each of them wants its own
  // context-specific failure message — so failure stays an exception the
  // caller catches, not a null every caller would have to branch on anyway.
  // Every call site awaits inside try/catch; keep it that way.
  async createItem({ folder, slug, frontmatter, body = '' }) {
    const vault = get().vaultPath;
    if (vault === null) throw new Error('No vault open');
    const path = await ipc.createNote(vault, folder, slug, frontmatter, body);
    // Rescan unconditionally: the watcher never reports our own writes (its
    // own-write suppression discards the event), so without this the created
    // note would exist on disk but never enter the store in Tauri. Safe — a
    // create has no optimistic state to clobber.
    await get().rescan();
    return path;
  },
}));

let schemaCache: { entries: Entry[]; schema: Schema } | null = null;

/** Memoized buildSchema: recomputes only when the entries array identity changes. */
export function getSchema(entries: Entry[]): Schema {
  if (schemaCache === null || schemaCache.entries !== entries) {
    schemaCache = { entries, schema: buildSchema(entries) };
  }
  return schemaCache.schema;
}

export function useSchema(): Schema {
  return getSchema(useVaultStore((s) => s.entries));
}

export function useEntry(path: string | null): Entry | null {
  return useVaultStore((s) =>
    path === null ? null : (s.entries.find((e) => e.path === path) ?? null),
  );
}
