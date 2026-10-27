import SELECTED_AUTHORITY from '../../shared/workspace/authority.v2.json';
import type {
  AuthorityError,
  SelectedEditorTarget,
  SelectedRecordVersion,
} from '@/lib/generated/workspace';
import {
  acceptLeaveIntent,
  invalidatePendingLeaves,
  LEAVE_BLOCKED,
  type LeaveIntent,
} from '@/app/leaveGuard';
import { inheritedAgentsPatch } from '@/engine/assignment';
import { create } from 'zustand';
import {
  announceExternalWrites,
  editorHoldersOf,
  flushOpenPages,
  flushOpenPageBodies,
  heldOpenPageBodies,
} from '@/editor/openPages';
import {
  batchFailureWords,
  openReportWords,
  type BatchApplied,
  type BatchOp,
} from '@/engine/batch';
import { validatePatch } from '@/engine/properties';
import { UNDO } from '@/engine/undoPlan';
import { buildSchema } from '@/engine/schema';
import { collectionsFromPages, parseCollectionYaml } from '@/engine/collections';
import type { CollectionFile, Entry, Schema, ListFile } from '@/engine/types';
import { parseListYaml } from '@/engine/views';
import * as ipc from '@/lib/ipc';
import { coalescedRefresh, writeFence, type PassOutcome } from '@/lib/trailingRefresh';
import { applyEntryPatch, garbledKey } from '@/engine/entryPatch';
import { useUiStore } from '@/stores/uiStore';
import { useUndoStore } from '@/stores/undoStore';

/** What a batch's caller may ask of it beyond the write (M60.7). */
export interface BatchOptions {
  /** Push the landed change on the undo stack under this label, and toast
   * the label with Undo. Without one the change is not undoable. */
  undo?: string;
  /** Hear a refusal in the backend's words instead of the store's toast:
   * undo words its own refusal. The store still rescans. */
  onRefused?: (message: string) => void;
  /** Authoritative receipt before refresh. Observer failure cannot undo a write. */
  onApplied?: (applied: BatchApplied) => void;
  /** Refuse a retired caller before dispatch. An accepted write keeps its receipt and Undo. */
  stillCurrent?: () => boolean;
}

/** A completed refresh is an observation, never a record version or a write acknowledgement. */
export interface VaultScanObservation {
  vault: string;
  opening: number;
  sequence: number;
  outcome: 'scanned' | 'unavailable';
}

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
  scanObservation: VaultScanObservation | null;
  openVault(
    path: string,
    options?: { stillCurrent?: () => boolean; leaveIntent?: LeaveIntent },
  ): Promise<void>;
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
   * A title edit keeps the file path. Moves use renameKeepingLinks to carry
   * inbound links; this is the title-only edit also used by the detail panel.
   */
  setTitle(path: string, title: string): Promise<boolean>;
  /**
   * Apply a database-wide change as one batch, all or nothing (M60.6): a
   * property rename, kind change or copy, a bulk delete. Open pages land
   * their pending saves first; patch ops show at once (optimistic, fenced);
   * the written pages are announced, so an open page merges the change in
   * place (M55.6), and the vault rescans. Resolves one result per page
   * written, or null when there is no vault, `entries` is another vault's,
   * or the backend refused — which toasts once, in a stale page's title or
   * the backend's words, and rescans. Never throws. No `validatePatch`: a
   * moved value keeps the shape it had. With `undo`, a landed change goes on
   * the undo stack and toasts its label with Undo (M60.7).
   */
  applyBatch(ops: BatchOp[], options?: BatchOptions): Promise<BatchApplied | null>;
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

/**
 * Refuses an inline edit whose path came from another vault's `entries`
 * (see `VaultState.entriesVault`, M53.30): an open is still in flight, or it
 * failed and left the last vault's records on screen. The toast says which,
 * and never stacks under a copy still on screen.
 *
 * null passes. No scan has landed yet, so the app holds no entries to take a
 * path from, and tests seed `entries` without it.
 *
 * Exported for the page actions that move files (app/pageActions.ts, M55.13),
 * which refuse by the same rule. A non-save action may supply its own notice.
 */
export function refusedAcrossVaults(
  { vaultPath, entriesVault, status }: VaultState,
  notice?: string,
): boolean {
  if (entriesVault === null || entriesVault === vaultPath) return false;
  const message =
    notice ??
    (status === 'error'
      ? "Not saved — the vault didn't open"
      : 'Not saved — the vault is still opening');
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

/** A startup hint only: the native opener revalidates authority and recovery.
 * Ordinary rescans keep this refusal and never dispatch recovery themselves. */
function selectedRecoveryRequired(value: unknown): value is AuthorityError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    value.code === 'capability_unavailable' &&
    'kind' in value &&
    value.kind === 'recovery_required' &&
    'message' in value &&
    typeof value.message === 'string' &&
    'retryable' in value &&
    value.retryable === false
  );
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
let vaultSwitchTicket = 0;
let watcherQueue: Promise<unknown> = Promise.resolve();
// Also counts direct path changes, including an away/back pair batched by React.
// This scopes presentation reads only; it is not native workspace authority.
let vaultOpening = 0;
export function getVaultOpening(): number {
  return vaultOpening;
}

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
  const opening = vaultOpening;
  const ticket = openTicket;
  let read: Awaited<ReturnType<typeof readVault>> | null = null;
  try {
    read = await readVault(vault);
  } catch {
    // A failed whole-vault read retains the snapshot. Its ordered observation
    // still lets a mounted selected owner ask its existing body reader.
  }
  // A switch mid-scan: this is the old vault's snapshot, and the open in
  // flight sets the new one's. A newer scan already landed: this one would
  // roll it back (see `landedScan`).
  if (
    useVaultStore.getState().vaultPath !== vault ||
    opening !== vaultOpening ||
    ticket !== openTicket ||
    scan < landedScan
  )
    return 'done';
  // A write began or settled while this read: it may predate the write.
  if (writes.moved(mark)) return 'again';
  const scanObservation: VaultScanObservation = {
    vault,
    opening,
    sequence: scan,
    outcome: read === null ? 'unavailable' : 'scanned',
  };
  if (read === null) useVaultStore.setState({ scanObservation });
  else {
    landedScan = scan;
    useVaultStore.setState({ ...read, entriesVault: vault, status: 'ready', scanObservation });
  }
  // It read past a write that outlived WRITE_WAIT_MS: that write's settle
  // scans once more.
  if (mark.pending > 0) writes.owe();
  return read === null ? 'failed' : 'done';
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
  scanObservation: null,

  async openVault(path, options) {
    const current = () =>
      options?.stillCurrent?.() !== false && options?.leaveIntent?.isCurrent() !== false;
    if (!current()) return;
    const requested = ++vaultSwitchTicket;
    if (get().vaultPath !== null) {
      const report = await flushOpenPages();
      if (requested !== vaultSwitchTicket || !current()) return;
      if (report.unresolvedOwnerIds.length > 0) {
        useUiStore.getState().toast(LEAVE_BLOCKED);
        return;
      }
    }
    if (!current()) return;
    const accept = () => {
      invalidatePendingLeaves();
      const ticket = ++openTicket;
      // M60.7: undo is per vault and per session; another vault's entries
      // would revert whatever sits at their paths here.
      if (get().vaultPath !== path) useUndoStore.getState().clear();
      else {
        // A same-path reopen is a new presentation lifetime too. Different
        // paths advance the same lifetime through the subscription below.
        vaultOpening += 1;
      }
      set({ vaultPath: path, status: 'scanning', error: null, scanObservation: null });
      return ticket;
    };
    const ticket = options?.leaveIntent ? acceptLeaveIntent(options.leaveIntent, accept) : accept();
    if (ticket === undefined) return;
    const superseded = () => ticket !== openTicket;
    // M56.6: who answers in this vault's panel is read now, before the panel
    // can mount, so a handoff that opens the panel finds the binding.
    void useUiStore.getState().loadPanelAgent(path);
    // Its own scan, not a rescan pass: it lands only after its watcher
    // starts (M49), while rescans inside that window land early (M53.8). It
    // still obeys the ticket order and the write fence.
    const scan = ++scanTicket;
    const mark = writes.mark();
    try {
      let snapshot: Awaited<ReturnType<typeof readVault>> | null = null;
      try {
        snapshot = await readVault(path);
      } catch (error) {
        // A selected pending journal refuses all ordinary readers. Its existing
        // startup owner must recover before this open can have a snapshot.
        if (!selectedRecoveryRequired(error)) throw error;
      }
      if (superseded()) return;
      const started = watcherQueue.then(() => (superseded() ? undefined : ipc.startWatcher(path)));
      watcherQueue = started.catch(() => undefined);
      const report = await started;
      if (superseded()) return;
      // M60.6: the open put back a change an earlier run left unfinished,
      // so the read above predates the rollback. Say so, and hand off to a
      // rescan pass, which reads the pages as they are now.
      const putBack = report == null ? null : openReportWords(report);
      if (putBack !== null) useUiStore.getState().toast(putBack);
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
      if (superseded() || scan < landedScan) return;
      if (snapshot === null) {
        try {
          snapshot = await readVault(path);
        } catch (error) {
          // A newer successful read already owns the presentation. Otherwise
          // this first usable read failing is an open failure, never emptiness.
          if (superseded() || scan < landedScan) return;
          throw error;
        }
        if (superseded() || scan < landedScan) return;
      }
      // An inline edit was pending or settled while this read (a Reopen
      // racing an edit), or the open rolled a stopped change back: the read
      // may predate either, so a rescan pass, which waits for the write,
      // lands the vault and sets 'ready' instead.
      if (mark.pending > 0 || writes.moved(mark) || putBack !== null) {
        await get().rescan();
        return;
      }
      landedScan = scan;
      set({ ...snapshot, entriesVault: path, status: 'ready' });
    } catch (err) {
      if (superseded()) return;
      const message =
        err instanceof Error
          ? err.message
          : typeof err === 'object' &&
              err !== null &&
              'message' in err &&
              typeof err.message === 'string'
            ? err.message
            : String(err);
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

  // Human filing inherits agents in this same patch, before validation and
  // the optimistic update. Batch replay and non-human writers add nothing.
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
    const garbled = garbledKey(normalized);
    if (garbled !== null) {
      useUiStore.getState().toast(`Couldn't save ${garbled}: its value came through garbled`);
      return false;
    }
    const target = get().entries.find((e) => e.path === path);
    if (target?.authority?.kind === 'sqlite_metadata') {
      if (
        Object.keys(normalized).length !== 1 ||
        !Object.hasOwn(normalized, 'full_width') ||
        (normalized.full_width !== true && normalized.full_width !== null)
      ) {
        useUiStore.getState().toast('This metadata action is unavailable for this workspace');
        return false;
      }
      // The body owner publishes its verified version before its callback
      // resolves. No metadata hold may precede this existing body-only barrier.
      const ticket = openTicket;
      const report = await flushOpenPageBodies();
      if (report.unresolvedOwnerIds.length > 0 || heldOpenPageBodies().includes(path)) {
        useUiStore.getState().toast(LEAVE_BLOCKED);
        return false;
      }
      if (openTicket !== ticket || get().vaultPath !== vault || refusedAcrossVaults(get()))
        return false;
      const current = get().entries.find((entry) => entry.path === path);
      const expected = current?.authority;
      if (
        expected?.kind !== 'sqlite_metadata' ||
        expected.workspaceId !== target.authority.workspaceId ||
        expected.recordId !== target.authority.recordId
      )
        return false;
      let ack: Awaited<ReturnType<typeof ipc.setPageFullWidth>>;
      try {
        ack = await fencedWrite(
          () => undefined,
          () =>
            ipc.setPageFullWidth(
              vault,
              path,
              expected,
              normalized.full_width === true ? 'wide' : 'default',
            ),
        );
      } catch {
        useUiStore.getState().toast(`Couldn't save changes to ${path}`);
        return false;
      }
      // The native receipt is authoritative even if the following refresh fails.
      if (get().vaultPath === vault && get().entriesVault === vault) {
        set({
          entries: get().entries.map((entry) => {
            const version = entry.authority;
            if (
              entry.path !== path ||
              version?.recordId !== ack.version.recordId ||
              version.workspaceId !== ack.version.workspaceId ||
              (version.metadataRevision !== expected.metadataRevision &&
                version.metadataRevision !== ack.version.metadataRevision)
            )
              return entry;
            const properties = { ...entry.properties };
            if (ack.fullWidth) properties.full_width = true;
            else delete properties.full_width;
            // A known width ACK does not supply a complete metadata snapshot.
            // Keep a carrier only when its native metadata hash already matches;
            // otherwise exact properties remain unavailable until actual rescan.
            const canonicalProperties =
              version.metadataHash === ack.version.metadataHash
                ? entry.canonicalProperties
                : undefined;
            return {
              ...entry,
              properties,
              canonicalProperties,
              authority: ack.version,
              hash: ack.version.bodyHash,
            };
          }),
        });
        try {
          await get().rescan();
        } catch {
          useUiStore.getState().toast("Couldn't refresh vault");
        }
      }
      return true;
    }
    // Schema enforcement (M2.x properties engine): declared fields must
    // match their YAML-declared shape or the write never reaches disk.
    if (target !== undefined) {
      const type = Object.hasOwn(normalized, 'type')
        ? typeof normalized.type === 'string'
          ? normalized.type
          : null
        : target.type;
      Object.assign(
        normalized,
        inheritedAgentsPatch(target, type, normalized, state.entries, getSchema(state.entries)),
      );
      const errors = validatePatch(getSchema(get().entries), target, normalized);
      if (errors.length > 0) {
        useUiStore.getState().toast(errors[0]);
        return false;
      }
    }
    // Optimistic: local state updates synchronously, before the disk write,
    // inside the write fence, so no scan read before the write lands over it.
    const optimistic =
      target === undefined ? null : applyEntryPatch(target, normalized, new Date().toISOString());
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
      // are right because applyEntryPatch classifies values exactly like the
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
    const ticket = openTicket;
    const sameVault = () => openTicket === ticket && get().vaultPath === vault;
    // A table can rename a page whose body is open elsewhere. Settle that
    // owner's existing writes before taking the title write, then hold new
    // saves through the write and rescan. Otherwise a delayed body save can
    // put the previous H1 back after the table reports success.
    if (editorHoldersOf(path).length > 0 || heldOpenPageBodies().includes(path)) {
      const report = await flushOpenPageBodies();
      if (report.unresolvedOwnerIds.length > 0) {
        useUiStore.getState().toast(LEAVE_BLOCKED);
        return false;
      }
      if (!sameVault() || refusedAcrossVaults(get())) return false;
      if (heldOpenPageBodies().includes(path)) {
        useUiStore.getState().toast('Save or resolve the open page before renaming it');
        return false;
      }
      const current = get().entries.find((entry) => entry.path === path);
      if (current === undefined) return false;
      if (current.title === trimmed) return true;
    }
    let saved = false;
    await announceExternalWrites([path], async () => {
      try {
        await fencedWrite(
          () =>
            set({
              entries: get().entries.map((entry) =>
                entry.path === path ? { ...entry, title: trimmed, hash: null } : entry,
              ),
            }),
          () => ipc.setNoteTitle(vault, path, trimmed),
        );
        // Reconcile the owning editor before releasing its held save. The
        // title feeds links and dossiers too, so this scan is required in
        // Tauri even when its watcher suppresses our own write's echo.
        if (sameVault()) await get().rescan();
        saved = true;
      } catch {
        useUiStore.getState().toast("Couldn't rename record");
        if (sameVault()) await get().rescan();
      }
    });
    return saved;
  },

  async applyBatch(ops, options = {}) {
    if (options.stillCurrent?.() === false) return null;
    const state = get();
    const vault = state.vaultPath;
    if (vault === null) return null;
    if (refusedAcrossVaults(state)) return null;
    for (const op of ops) {
      const garbled = op.op === 'patch' ? garbledKey(op.set) : null;
      if (garbled !== null) {
        useUiStore.getState().toast(`Couldn't save ${garbled}: its value came through garbled`);
        return null;
      }
    }
    const ticket = openTicket;
    const sameVault = () => openTicket === ticket && get().vaultPath === vault;
    const report = await flushOpenPageBodies();
    if (report.unresolvedOwnerIds.length > 0) {
      useUiStore.getState().toast(LEAVE_BLOCKED);
      return null;
    }
    if (!sameVault() || options.stillCurrent?.() === false || refusedAcrossVaults(get()))
      return null;
    const titleOf = (path: string) => get().entries.find((e) => e.path === path)?.title ?? path;
    // Hold existing editor owners before the IPC can replace their bytes.
    // Import deduplication chooses its final path in Rust, so conservatively
    // include the current corpus for an import instead of duplicating that
    // source-identity planner in the UI.
    const paths = new Set(ops.flatMap((op) => (op.op === 'rename' ? [op.from, op.to] : [op.path])));
    if (ops.some((op) => op.op === 'import')) {
      for (const entry of get().entries) paths.add(entry.path);
    }
    const result: { applied: BatchApplied | null } = { applied: null };
    await announceExternalWrites([...paths], async () => {
      try {
        result.applied = await fencedWrite(
          () => {
            const patches = ops.filter((op) => op.op === 'patch');
            if (patches.length === 0) return;
            set({
              entries: get().entries.map((entry) =>
                patches
                  .filter((op) => op.path === entry.path)
                  .reduce(
                    (shown, op) => applyEntryPatch(shown, op.set, new Date().toISOString()),
                    entry,
                  ),
              ),
            });
          },
          () => ipc.applyBatch(vault, ops),
        );
        try {
          options.onApplied?.(result.applied);
        } catch {
          if (sameVault())
            useUiStore.getState().toast('Changes saved, but the save status could not be updated.');
        }
        if (sameVault()) {
          try {
            await get().rescan();
          } catch {
            if (sameVault())
              useUiStore.getState().toast('Changes saved, but the view could not be refreshed.');
          }
        }
      } catch (err) {
        if (!sameVault()) return;
        const message = err instanceof Error ? err.message : String(err);
        if (options.onRefused !== undefined) options.onRefused(message);
        else useUiStore.getState().toast(batchFailureWords(message, titleOf));
        try {
          await get().rescan(); // disk truth wins: revert the optimistic update
        } catch {
          // The original refusal is authoritative; a failed refresh cannot replace it.
        }
      }
    });
    const applied = result.applied;
    if (applied === null || !sameVault()) return applied;
    const label = options.undo;
    if (label !== undefined) {
      const id = useUndoStore.getState().pushBatch(label, vault, applied.files);
      useUiStore
        .getState()
        .toast(
          label,
          id === null
            ? undefined
            : { action: { label: UNDO, run: () => void useUndoStore.getState().undoEntry(id) } },
        );
    }
    return applied;
  },

  // The documented EXCEPTION to the never-throw invariant (M14.8): callers
  // need the created path to navigate, and each of them wants its own
  // context-specific failure message — so failure stays an exception the
  // caller catches, not a null every caller would have to branch on anyway.
  // Every call site awaits inside try/catch; keep it that way.
  // A human creation receives newly filed host agents in its one create write.
  async createItem({ folder, slug, frontmatter, body = '' }) {
    const vault = get().vaultPath;
    if (vault === null) throw new Error('No vault open');
    const state = get();
    if (refusedAcrossVaults(state)) throw new Error('The vault is still opening');
    const inherited = inheritedAgentsPatch(
      null,
      typeof frontmatter.type === 'string' ? frontmatter.type : null,
      frontmatter,
      state.entries,
      getSchema(state.entries),
    );
    const path = await ipc.createNote(vault, folder, slug, { ...frontmatter, ...inherited }, body);
    // Rescan unconditionally: the watcher never reports our own writes (its
    // own-write suppression discards the event), so without this the created
    // note would exist on disk but never enter the store in Tauri. Safe — a
    // create has no optimistic state to clobber.
    await get().rescan();
    return path;
  },
}));

useVaultStore.subscribe((next, previous) => {
  if (next.vaultPath === previous.vaultPath) return;
  vaultOpening += 1;
  if (next.scanObservation !== null) useVaultStore.setState({ scanObservation: null });
});

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

/** Publish only verified body-version facts onto an already matching Entry.
 * Different metadata needs its actual reread; preserving old properties while
 * stamping a new metadata hash would misrepresent the canonical projection. */
export function acceptSelectedEditorVersion(
  vault: string,
  path: string,
  target: SelectedEditorTarget,
  version: SelectedRecordVersion,
): boolean {
  const state = useVaultStore.getState();
  if (
    state.vaultPath !== vault ||
    state.entriesVault !== vault ||
    version.kind !== 'sqlite_metadata' ||
    version.workspaceId !== target.workspaceId ||
    version.recordId !== target.recordId
  )
    return false;
  const entry = state.entries.find((candidate) => candidate.path === path);
  const previous = entry?.authority;
  if (
    entry === undefined ||
    previous?.kind !== 'sqlite_metadata' ||
    previous.workspaceId !== target.workspaceId ||
    previous.recordId !== target.recordId ||
    previous.metadataHash !== version.metadataHash
  )
    return false;
  const validRevision = (value: string) =>
    value.length <= SELECTED_AUTHORITY.revision.max.length &&
    new RegExp(SELECTED_AUTHORITY.revision.pattern).test(value) &&
    BigInt(value) <= BigInt(SELECTED_AUTHORITY.revision.max);
  if (!validRevision(previous.metadataRevision) || !validRevision(version.metadataRevision))
    return false;
  const comparison = BigInt(version.metadataRevision) - BigInt(previous.metadataRevision);
  if (comparison < 0n || (comparison === 0n && previous.bodyHash !== version.bodyHash))
    return false;
  if (comparison === 0n) return true;
  useVaultStore.setState({
    entries: state.entries.map((candidate): Entry =>
      candidate === entry
        ? {
            ...candidate,
            authority: { ...version },
            // A version acknowledgement does not replace a separately read
            // body. Keep its observed hash and re-pair only that known image.
            hash: candidate.bodyObservation?.observedBodyHash ?? version.bodyHash,
            ...(candidate.bodyObservation === undefined
              ? {}
              : {
                  bodyObservation: {
                    ...candidate.bodyObservation,
                    coherence:
                      candidate.bodyObservation.observedBodyHash === version.bodyHash
                        ? 'paired'
                        : 'external_change',
                  },
                }),
          }
        : candidate,
    ),
  });
  return true;
}
