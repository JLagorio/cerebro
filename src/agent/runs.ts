import type { Place } from '@/engine/place';

/**
 * What the assistant is doing right now (M17.7).
 *
 * This replaces `agentBusy`, one unowned boolean written from eight places
 * across two hooks, and `learningPath`, a second unowned string that answered
 * a different half of the same question. Both were artefacts of there being
 * exactly one child process: with one run, "something is running" and "which
 * run" collapse into a flag and a path, and anybody could set either.
 *
 * M17.3 made runs concurrent, which makes a flag a lie the moment two things
 * are in flight. More to the point, a flag cannot answer the question the user
 * actually asked us to answer — *I started a task and then walked away* — and
 * a list can: what is running, what it is about, where it came from, and a way
 * back to it.
 */

export type RunOwner =
  /** A turn someone typed and is watching. */
  | 'chat'
  /** A background job: distilling, a scheduled skill, an agent record. */
  | 'job';

export interface RunRecord {
  /**
   * UI-side identity, minted when the task starts.
   *
   * Deliberately not the backend run id: a task exists from the moment Send is
   * pressed, and the child does not exist until a skill body has been read and
   * the MCP handshake has completed. Keying on the backend id would leave that
   * window invisible, which is exactly the window a first send spends in.
   */
  id: string;
  owner: RunOwner;
  /** What to call it in the list. A question, or the job's subject. */
  label: string;
  /** Where it belongs, so the list can take you back there. */
  place: Place | null;
  /** The note a background job is reading — what `learningPath` used to be,
   * now attached to the run that is actually reading it. */
  path: string | null;
  /** Which conversation a chat run belongs to, so the list can open it. */
  conversationId: string | null;
  /** The child, once it exists. Null while starting up; what Stop needs. */
  run: number | null;
  startedAt: number;
}

let seq = 0;
export function newRunId(): string {
  seq += 1;
  return `r${seq}`;
}

/**
 * Should the background runner hold off?
 *
 * Two reasons in one answer. A `chat` run means someone is waiting for a
 * reply, and this is not the moment to spend the machine on a distill — a
 * courtesy since M17.3, not a lock, because two runs no longer collide. A
 * `job` run means the queue is already draining, and it drains one at a time
 * on purpose: it is unattended work, so there is nothing to be gained by
 * doing more of it at once.
 *
 * Derived rather than flagged, and that matters beyond tidiness: this is a
 * store value, so it re-renders when a run starts or ends, which is what tells
 * the runner it is free again. `agentBusy` did that job by accident.
 */
export function shouldYield(runs: readonly RunRecord[]): boolean {
  return runs.length > 0;
}

/** The note a background job is reading, if one is. Replaces `learningPath`;
 * the caller asks by path because that is the only question anyone had. */
export function isBeingRead(runs: readonly RunRecord[], path: string): boolean {
  return runs.some((r) => r.owner === 'job' && r.path === path);
}
