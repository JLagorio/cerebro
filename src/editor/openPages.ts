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
 *   with that file open hears it here by path. Rust stamps `modifiedAt` to
 *   the second, so a stamp cannot tell a page about a write in the same
 *   second as the last one; a per-path announcement can.
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

/** The catch-up running now, and the one queued behind it. */
let running: Promise<void> | null = null;
let queued: Promise<void> | null = null;

/** `catchUp()`, never rejecting. */
const quietly = (catchUp: () => Promise<void>): Promise<void> =>
  attempt(catchUp).catch(() => undefined);

/**
 * One catch-up running and at most one queued, however many writes arrive.
 *
 * A write announced while a catch-up runs may have landed after that scan
 * read its file, so it needs one that starts later; every write announced in
 * the meantime is covered by the same later one.
 */
function coalesced(catchUp: () => Promise<void>): Promise<void> {
  if (running === null) {
    const run: Promise<void> = quietly(catchUp).finally(() => {
      if (running === run) running = null;
    });
    running = run;
    return run;
  }
  if (queued === null) {
    const next: Promise<void> = running.then(() => {
      queued = null;
      return coalesced(catchUp);
    });
    queued = next;
  }
  return queued;
}

/**
 * Tell the pages showing `paths` that someone else wrote them, then bring the
 * vault up to date with `catchUp`. An empty `paths` is a write somewhere the
 * announcement could not name: it still catches up, and the pages fall back
 * on their stamps. Never rejects.
 */
export async function announceExternalWrites(
  paths: readonly string[],
  catchUp: () => Promise<void>,
): Promise<void> {
  const told = [...new Set(paths)].flatMap((path) => [...(watchers.get(path) ?? [])]);
  for (const handlers of told) handlers.pending();
  try {
    await coalesced(catchUp);
  } finally {
    for (const handlers of told) handlers.settled();
  }
}

/** Test isolation: forget every page and any catch-up in flight. */
export function __resetOpenPages(): void {
  flushes.clear();
  watchers.clear();
  running = null;
  queued = null;
}
