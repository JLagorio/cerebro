/** A later run an agent booked for itself in runtime.db (M63.8). */
export interface Followup {
  followupId: string;
  actor: string;
  note: string;
  dueAt: string;
  requestedAt: string;
  requestedByRun: string;
  state: 'pending' | 'claimed' | 'fired' | 'cancelled';
  claimedAt: string | null;
  runId: string | null;
  endedAt: string | null;
  cancelReason: 'person' | 'agent_gone' | 'paused' | null;
}

export type FollowupClaim =
  | { state: 'claimed'; row: Followup }
  | { state: 'not_waiting' }
  | { state: 'cancelled'; reason: 'agent_gone' | 'paused' };

/** A crashed claimant gets ten minutes; the runtime still owns the claim. */
export function followupDue(row: Followup, now: Date): boolean {
  return (
    Date.parse(row.dueAt) <= now.getTime() &&
    (row.state === 'pending' ||
      (row.state === 'claimed' &&
        row.claimedAt !== null &&
        Date.parse(row.claimedAt) + 10 * 60_000 <= now.getTime()))
  );
}

export function waitingFollowup(row: Followup): boolean {
  return row.state === 'pending' || row.state === 'claimed';
}
