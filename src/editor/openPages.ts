/**
 * The pages open in the editor, as the rest of the app reaches them (M53.6).
 *
 * Two channels, both module-level because their callers sit nowhere near the
 * editors they need: a panel turn in the assistant, and the bridge that hears
 * the agent's MCP writes.
 *
 * - **Flush.** Every open page registers how to land its pending save. A turn
 *   flushes them all before its child starts, so the agent reads, and appends
 *   to, what is on screen rather than what was on disk half a second ago. A
 *   page that cannot land its save yet says so (`heldOpenPages`).
 * - **External writes.** The agent's MCP writes go through the app's own
 *   `write_file`, which registers each write as the app's, so the watcher
 *   drops the echo. The tools announce what they changed instead, and a page
 *   with that file open hears it here by path, holds its saves until the
 *   vault has caught up, and then merges the write in place (M55.6).
 */

type Flush = () => Promise<void>;

const flushes = new Set<Flush>();

/** Register a page's flush; the returned function unregisters it. */
export function registerFlush(flush: Flush): () => void {
  flushes.add(flush);
  return () => {
    flushes.delete(flush);
  };
}

/** Whether a page currently has a save registered for the Save command. */
export function hasOpenPages(): boolean {
  return flushes.size > 0;
}

type Holding = () => string | null;

const holders = new Set<Holding>();

/**
 * Register how a page says it is holding a save: its path while a save, a
 * merge or a choice waits there, null otherwise. The returned function
 * unregisters it.
 */
export function registerHold(holding: Holding): () => void {
  holders.add(holding);
  return () => {
    holders.delete(holding);
  };
}

/**
 * The open pages a flush could not land (M55.13): each still holds a save
 * while it waits on an outside write, a reconcile or the person's choice. A
 * caller about to move one of these files refuses instead, because the save
 * would land at the old path once it releases.
 */
export function heldOpenPages(): string[] {
  const paths = new Set<string>();
  for (const holding of holders) {
    const path = holding();
    if (path !== null) paths.add(path);
  }
  return [...paths];
}

/** `fn()`, with a synchronous throw turned into a rejection. */
function attempt(fn: () => Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => resolve(fn()));
}

/**
 * Land every open page's pending save. Resolves once all of them have landed
 * or failed, or after `budgetMs`, whichever comes first: a hung save must not
 * hold a turn forever. Never rejects; a page whose save fails toasts it.
 */
export async function flushOpenPages(budgetMs = 5_000): Promise<void> {
  if (flushes.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  try {
    await Promise.race([Promise.allSettled([...flushes].map(attempt)), budget]);
  } finally {
    clearTimeout(timer);
  }
}

/** What a page does when a write to its file is announced. */
export interface ExternalWriteHandlers {
  /** Called synchronously at the announcement: the disk has changed, and
   *  the app's picture of it is about to. */
  pending: () => void;
  /** Called once the vault has caught up with the write, failed or not. */
  settled: () => void;
}

const watchers = new Map<string, Set<ExternalWriteHandlers>>();

/** Hear the writes announced for `path`; the returned function stops. */
export function onExternalWrite(path: string, handlers: ExternalWriteHandlers): () => void {
  let set = watchers.get(path);
  if (set === undefined) {
    set = new Set();
    watchers.set(path, set);
  }
  const own = set;
  own.add(handlers);
  return () => {
    own.delete(handlers);
    if (own.size === 0 && watchers.get(path) === own) watchers.delete(path);
  };
}

/** `catchUp()`, never rejecting. */
const quietly = (catchUp: () => Promise<void>): Promise<void> =>
  attempt(catchUp).catch(() => undefined);

/**
 * Tell the pages showing `paths` that someone else wrote them, then bring the
 * vault up to date with `catchUp`. An empty `paths` is a write somewhere the
 * announcement could not name: it still catches up, and the pages fall back
 * on their entries' content hashes (M55.6). Never rejects.
 *
 * `catchUp` is called once per announcement, synchronously, and coalesces
 * itself: both callers pass the store's rescan, which runs one scan at a time
 * plus one trailing and resolves only after a scan that started after the
 * call (M58.2). A write announced while a scan runs is covered by that
 * trailing scan, so a burst costs two scans.
 */
export async function announceExternalWrites(
  paths: readonly string[],
  catchUp: () => Promise<void>,
): Promise<void> {
  const told = [...new Set(paths)].flatMap((path) => [...(watchers.get(path) ?? [])]);
  for (const handlers of told) handlers.pending();
  try {
    await quietly(catchUp);
  } finally {
    for (const handlers of told) handlers.settled();
  }
}

/** Test isolation: forget every page and its flush. */
export function __resetOpenPages(): void {
  flushes.clear();
  holders.clear();
  watchers.clear();
  editorHolders.clear();
  editorSnapshots.clear();
  editorListeners.clear();
}

/** Live editor owners, separate from pending-save holds. Counts preserve a
 * holder until its final mounted editor releases it. */
const editorHolders = new Map<string, Map<string, number>>();
const editorSnapshots = new Map<string, readonly string[]>();
const editorListeners = new Set<() => void>();
const NO_EDITORS: readonly string[] = [];
export function editorHoldersOf(path: string): readonly string[] {
  return editorSnapshots.get(path) ?? NO_EDITORS;
}
export function subscribeEditorHolders(listener: () => void): () => void {
  editorListeners.add(listener);
  return () => {
    editorListeners.delete(listener);
  };
}
export function holdEditor(path: string, owner: string): () => void {
  const owners = editorHolders.get(path) ?? new Map<string, number>();
  const before = owners.get(owner) ?? 0;
  owners.set(owner, before + 1);
  editorHolders.set(path, owners);
  const publish = () => {
    if (owners.size) editorSnapshots.set(path, [...owners.keys()]);
    else {
      editorHolders.delete(path);
      editorSnapshots.delete(path);
    }
    for (const listener of editorListeners) listener();
  };
  if (before === 0) publish();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = owners.get(owner) ?? 0;
    if (count > 1) owners.set(owner, count - 1);
    else {
      owners.delete(owner);
      publish();
    }
  };
}
