/**
 * The pages open in the editor, as the rest of the app reaches them (M53.6).
 *
 * Two channels, both module-level because their callers sit nowhere near the
 * editors they need: a panel turn in the assistant, and the bridge that hears
 * the agent's MCP writes.
 *
 * - **Flush.** Every open page registers how to land its pending save. A turn
 *   flushes them all before its child starts, so the agent reads, and appends
 *   to, what is on screen rather than what was on disk half a second ago.
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
  watchers.clear();
}
