/**
 * A conversation's status in the list (M92.3, §2): whether its turn is
 * running or waiting on the person. Pure: no DOM, no store, no IPC.
 *
 * Only Working and Needs you are chips (Q7, O5). The other three show none
 * and are still three answers (CV-05): `idle` was read and found nothing
 * running or waiting; `unknown` cannot be told, as after a restart, when
 * Rust's journal no longer holds the run a thread left going, so nothing
 * infers Working; `unavailable` is a read that failed, which the list says
 * once under its heading.
 *
 * The precedence: the open thread's own flags; then a waiting card asked in
 * the thread's session, or by the run it left going; then that run, as the
 * journal answers for it. A source that could not be read speaks for every
 * source under it: while the card book is unread or unavailable, a thread
 * that could hold a card is unknown or unavailable, never idle or Working.
 */

export type ThreadStatus = 'working' | 'needs_you' | 'idle' | 'unknown' | 'unavailable';

/** The statuses that draw a chip. */
export type ChipStatus = Extract<ThreadStatus, 'working' | 'needs_you'>;

/** What Rust's journal answers for a run (`agent_events_since`): still
 * going, done, nothing held for it under its key, or the read failed. */
export type RunState = 'running' | 'done' | 'unknown' | 'unavailable';

/** A card the book holds, by what a thread is matched on. */
export interface CardRef {
  /** The Claude Code session the asking run went to. */
  sessionId: string;
  /** The attach key of the run that asked, when its Interaction event
   * named it: a thread left before its run's Init holds no session yet. */
  run?: string;
}

/** The cards waiting on the person, as the book was last read. */
export type CardBook =
  { state: 'read'; cards: readonly CardRef[] } | { state: 'unread' } | { state: 'unavailable' };

/** What a thread's status is read from. */
export interface ThreadFacts {
  /** The open thread's own flags (`useAgentChat`), which outrank every
   * other source; absent for every other thread. A turn still streams
   * while it stops and while a card waits. */
  active?: { streaming: boolean; waiting: boolean };
  /** Its Claude Code session; null until a run named one. */
  sessionId: string | null;
  /** The attach key of the run its saved live turn names (`LiveTurn.attach`:
   * the durable run id in Tauri), never its process tag, which the next
   * launch numbers from 0 again; null when it left none going. */
  liveRun: string | null;
  /** What the journal answered for that run; absent until asked. */
  runState?: RunState;
}

export function statusOf(thread: ThreadFacts, book: CardBook): ThreadStatus {
  const { active } = thread;
  if (active !== undefined) {
    if (active.waiting) return 'needs_you';
    return active.streaming ? 'working' : 'idle';
  }
  // An empty key names nothing, so it matches no card.
  const session = thread.sessionId === '' ? null : thread.sessionId;
  const run = thread.liveRun === '' ? null : thread.liveRun;
  // A card is matched by its session or by the run that asked: a thread
  // with neither can hold none, and has no run to be working.
  if (session === null && run === null) return 'idle';
  if (book.state !== 'read') return book.state === 'unread' ? 'unknown' : 'unavailable';
  const asked = book.cards.some(
    (card) =>
      (session !== null && card.sessionId === session) || (run !== null && card.run === run),
  );
  if (asked) return 'needs_you';
  if (run === null) return 'idle';
  switch (thread.runState) {
    case 'running':
      return 'working';
    case 'done':
      return 'idle';
    case 'unavailable':
      return 'unavailable';
    default:
      return 'unknown';
  }
}

/** The chip a status draws, or null for the three that draw none. */
export function chipOf(status: ThreadStatus): ChipStatus | null {
  return status === 'working' || status === 'needs_you' ? status : null;
}

/** Whether the list says its statuses are unavailable, once, under its
 * heading: a thread's could not be read, or the card book could not, which
 * leaves the list unable to say who needs you even where every thread reads
 * idle. */
export function listUnavailable(statuses: Iterable<ThreadStatus>, book: CardBook): boolean {
  if (book.state === 'unavailable') return true;
  for (const status of statuses) if (status === 'unavailable') return true;
  return false;
}
