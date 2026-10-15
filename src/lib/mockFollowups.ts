import { dateEpoch } from '@/engine/dateGrammar';
import { agentRef, isAgentEntry } from '@/engine/agents';
import {
  followupDue,
  waitingFollowup,
  type Followup,
  type FollowupClaim,
} from '@/engine/followups';
import { cleanCauseValue, refuseIfAgentPaused, scanVault } from './mockIpc';

interface StoredFollowup extends Followup {
  vault: string;
}
export type SeedFollowup = Pick<StoredFollowup, 'vault' | 'actor' | 'dueAt'> &
  Partial<StoredFollowup>;
const rows = new Map<string, StoredFollowup>();
let readable = true;
let sequence = 0;
const snapshot = (row: StoredFollowup): Followup => {
  const { vault: _vault, ...value } = row;
  return value;
};
const requireRead = () => {
  if (!readable) throw new Error('no runtime database for this workspace');
};
export function resetFollowups(): void {
  rows.clear();
  readable = true;
}
export function __seedFollowups(input: readonly SeedFollowup[] | null): void {
  rows.clear();
  readable = input !== null;
  for (const seed of input ?? []) {
    sequence++;
    const followupId = seed.followupId ?? sequence.toString(16).padStart(32, '0');
    rows.set(followupId, {
      followupId,
      note: 'check the vendor reply',
      requestedAt: new Date().toISOString(),
      requestedByRun: 'earlier-run',
      state: 'pending',
      claimedAt: null,
      runId: null,
      endedAt: null,
      cancelReason: null,
      ...seed,
    });
  }
}
/** Replayed against Rust by fixtures/followup-cases.json (D3). */
export async function scheduleMockFollowup(
  vault: string,
  actor: string,
  run: string,
  at: unknown,
  note: unknown,
  now = new Date(),
): Promise<{ row: Followup; waiting: number }> {
  const entries = await scanVault(vault);
  if (
    !actor.startsWith('process:') ||
    [...actor].length > 128 ||
    run === '' ||
    entries.filter((entry) => isAgentEntry(entry) && agentRef(entry).actor === actor).length !== 1
  )
    throw new Error("Only an agent's own run can book a follow-up, and only for itself.");
  if (!readable) throw new Error('Follow-ups need the runtime database, which is not open.');

  const cleaned = cleanCauseValue(note, 500);
  if (
    typeof note !== 'string' ||
    [...note].length < 1 ||
    [...note].length > 500 ||
    cleaned === undefined
  )
    throw new Error('A follow-up needs a note of 1 to 500 characters.');
  // Require RFC 3339's seconds and offset, then use the shared strict date
  // reader so JavaScript cannot roll an impossible day into the next month.
  const timestamp =
    typeof at === 'string' &&
    /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(at)
      ? dateEpoch(at.toUpperCase())
      : null;
  if (timestamp === null) throw new Error('Use an RFC 3339 time with an offset for the follow-up.');
  if (timestamp < now.getTime() + 5 * 60_000)
    throw new Error('A follow-up must be at least 5 minutes from now.');
  if (timestamp > now.getTime() + 30 * 24 * 60 * 60_000)
    throw new Error('A follow-up can be at most 30 days from now.');
  const waiting = [...rows.values()]
    .filter((row) => row.vault === vault && row.actor === actor && waitingFollowup(row))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.followupId.localeCompare(b.followupId));
  if (waiting.length >= 3)
    throw new Error(
      `You already have 3 follow-ups waiting:\n${waiting.map((row) => `- ${row.dueAt}: ${JSON.stringify(cleanCauseValue(row.note, 80))}`).join('\n')}`,
    );
  const row: StoredFollowup = {
    vault,
    actor,
    followupId: (++sequence).toString(16).padStart(32, '0'),
    note: cleaned,
    dueAt: new Date(timestamp).toISOString(),
    requestedAt: now.toISOString(),
    requestedByRun: run,
    state: 'pending',
    claimedAt: null,
    runId: null,
    endedAt: null,
    cancelReason: null,
  };
  rows.set(row.followupId, row);
  return { row: snapshot(row), waiting: waiting.length + 1 };
}
export async function agentScheduleFollowup(
  vault: string,
  args: { at?: unknown; note?: unknown },
  stamp: { actor: string; runId: string },
): Promise<string> {
  const { row, waiting } = await scheduleMockFollowup(
    vault,
    stamp.actor,
    stamp.runId,
    args.at,
    args.note,
  );
  return `Booked a follow-up for ${row.dueAt} (UTC). Once it is due, it starts a run of you with your note as its subject, as soon as Cerebro is open and Learn on its own is on. Waiting now: ${waiting} of 3.`;
}
export async function listFollowups(vault: string, now = new Date()): Promise<Followup[]> {
  requireRead();
  const since = now.getTime() - 7 * 24 * 60 * 60_000;
  return [...rows.values()]
    .filter(
      (row) =>
        row.vault === vault &&
        (waitingFollowup(row) ||
          (row.state === 'cancelled' &&
            row.cancelReason !== 'person' &&
            row.endedAt !== null &&
            Date.parse(row.endedAt) >= since)),
    )
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.followupId.localeCompare(b.followupId))
    .map(snapshot);
}
export async function claimFollowup(
  vault: string,
  id: string,
  now = new Date(),
): Promise<FollowupClaim> {
  requireRead();
  // Resolve the record before the conditional update, so two async scans still
  // compete for one pending row when they return to this synchronous section.
  const entries = await scanVault(vault);
  const row = rows.get(id);
  if (row === undefined || row.vault !== vault || !followupDue(row, now))
    return { state: 'not_waiting' };
  const owners = entries.filter(
    (entry) => isAgentEntry(entry) && agentRef(entry).actor === row.actor,
  );
  let reason: 'agent_gone' | 'paused' | null = owners.length === 1 ? null : 'agent_gone';
  if (reason === null) {
    let paused = owners[0].properties.paused === true;
    try {
      refuseIfAgentPaused(vault, row.actor);
    } catch {
      paused = true;
    }
    if (paused) reason = 'paused';
  }
  if (reason !== null) {
    Object.assign(row, {
      state: 'cancelled',
      cancelReason: reason,
      endedAt: now.toISOString(),
      claimedAt: null,
    });
    return { state: 'cancelled', reason };
  }
  Object.assign(row, { state: 'claimed', claimedAt: now.toISOString() });
  return { state: 'claimed', row: snapshot(row) };
}
export async function cancelFollowup(
  vault: string,
  id: string,
  now = new Date(),
): Promise<boolean> {
  requireRead();
  const row = rows.get(id);
  if (row === undefined || row.vault !== vault || row.state !== 'pending') return false;
  Object.assign(row, { state: 'cancelled', cancelReason: 'person', endedAt: now.toISOString() });
  return true;
}
export function readyMockFollowup(
  vault: string,
  actor: string,
  id: string,
  now = new Date(),
): Followup | null {
  requireRead();
  const row = rows.get(id);
  return row !== undefined &&
    row.vault === vault &&
    row.actor === actor &&
    row.state === 'claimed' &&
    Date.parse(row.dueAt) <= now.getTime()
    ? snapshot(row)
    : null;
}
export function releaseMockFollowup(vault: string, id: string): boolean {
  const row = rows.get(id);
  if (row === undefined || row.vault !== vault || row.state !== 'claimed') return false;
  Object.assign(row, { state: 'pending', claimedAt: null });
  return true;
}
export function fireMockFollowup(
  vault: string,
  actor: string,
  id: string,
  runId: string,
  now = new Date(),
): boolean {
  const ready = readyMockFollowup(vault, actor, id, now);
  if (ready === null) return false;
  Object.assign(rows.get(id)!, { state: 'fired', runId, endedAt: now.toISOString() });
  return true;
}
export function unfireMockFollowup(vault: string, id: string, runId: string): boolean {
  const row = rows.get(id);
  if (row === undefined || row.vault !== vault || row.state !== 'fired' || row.runId !== runId)
    return false;
  Object.assign(row, { state: 'pending', claimedAt: null, runId: null, endedAt: null });
  return true;
}
if (typeof window !== 'undefined') {
  Object.assign(window, {
    __cerebroSeedFollowups: __seedFollowups,
    __cerebroMockFollowups: () => [...rows.values()].map((row) => ({ ...row })),
  });
}
