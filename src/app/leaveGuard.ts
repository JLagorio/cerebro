import {
  flushOpenPages,
  flushOpenPageBodies,
  prepareOpenPages,
  unresolvedOpenPages,
} from '@/editor/openPages';
import { useUiStore } from '@/stores/uiStore';

export interface LeaveIntent {
  readonly surface: string;
  isCurrent(): boolean;
}
interface OwnedLeaveIntent extends LeaveIntent {
  surface: string;
}
const requests = new Map<string, OwnedLeaveIntent>();
const reservations = new WeakSet<LeaveIntent>();
let acceptedIntent: LeaveIntent | undefined;

/** Reserve when the person acts, before origin lookup, saves or scans. Passing
 * this intent to requestLeave later must never make an old request newest. */
export function reserveLeaveIntent(surface: string): LeaveIntent {
  const intent: OwnedLeaveIntent = {
    surface,
    isCurrent: () => requests.get(intent.surface) === intent,
  };
  requests.set(surface, intent);
  reservations.add(intent);
  return intent;
}

export function hasPendingLeaveIntent(surface: string): boolean {
  const intent = requests.get(surface);
  return intent !== undefined && reservations.has(intent);
}

export function finishLeaveIntent(intent: LeaveIntent): void {
  reservations.delete(intent);
  if (requests.get(intent.surface) === intent) requests.delete(intent.surface);
}

/** An accepted vault change synchronously resets its panes. Carry only its
 * current intent across those resets; later navigation still supersedes it.
 * The callback is synchronous, so this exemption never spans a save or scan. */
export function acceptLeaveIntent<T>(intent: LeaveIntent, accept: () => T): T | undefined {
  if (!intent.isCurrent()) return undefined;
  const previous = acceptedIntent;
  acceptedIntent = intent;
  try {
    return accept();
  } finally {
    acceptedIntent = previous;
  }
}

export function invalidatePendingLeaves(nextSurface?: string): void {
  const candidate = acceptedIntent ? requests.get(acceptedIntent.surface) : undefined;
  const retain = candidate === acceptedIntent ? candidate : undefined;
  requests.clear();
  if (retain) {
    retain.surface = nextSurface ?? retain.surface;
    requests.set(retain.surface, retain);
  }
}
export const LEAVE_BLOCKED =
  'Changes could not be saved. Retry save or resolve them before leaving.';

/** Clean navigation stays synchronous. A dirty navigation keeps the mounted
 * view and its exact buffers until its current owners have acknowledged them.
 * Later requests supersede earlier requests to the same navigation surface. */
export function requestLeave(
  surface: string | LeaveIntent,
  leave: () => void,
  stillCurrent: () => boolean = () => true,
): boolean {
  const intent = typeof surface === 'string' ? reserveLeaveIntent(surface) : surface;
  if (typeof surface === 'string') reservations.delete(intent);
  const current = () => intent.isCurrent() && stillCurrent();
  if (!current()) {
    finishLeaveIntent(intent);
    return false;
  }
  prepareOpenPages();
  if (unresolvedOpenPages().length === 0) {
    try {
      if (current()) leave();
    } finally {
      finishLeaveIntent(intent);
    }
    return true;
  }
  void flushOpenPages()
    .then((report) => {
      if (!current()) return;
      if (report.unresolvedOwnerIds.length > 0 || unresolvedOpenPages().length > 0) {
        useUiStore.getState().toast(LEAVE_BLOCKED);
        return;
      }
      leave();
    })
    .catch(() => {
      if (current()) useUiStore.getState().toast(LEAVE_BLOCKED);
    })
    .finally(() => finishLeaveIntent(intent));
  return false;
}

/** Mutation/launch callers must read the report too; completing a callback
 * does not establish that the newest draft reached its authoritative writer.
 * Origin-bound callers gate both authorization and notification with their
 * current predicate, including retirement while the flush is pending. */
export async function saveBeforeAction(
  phase: 'all' | 'body' = 'all',
  held: 'block' | 'caller' = 'block',
  stillCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!stillCurrent()) return false;
  try {
    const report = phase === 'body' ? await flushOpenPageBodies() : await flushOpenPages();
    const current = new Map(unresolvedOpenPages().map((state) => [state.participantId, state]));
    const unresolved = report.unresolvedOwnerIds.filter((id) => {
      if (held !== 'caller') return true;
      const state = current.get(id);
      // Existing path-aware mutation planners inspect heldOpenPages again
      // against the exact files they move/write. Preserve that distinction:
      // a held unrelated page cannot prevent adding a separate child page.
      // Failed/expired writes are never delegated to that compatibility check.
      return (
        state?.blocked == null ||
        state.failure !== null ||
        report.outcomes.some(
          (outcome) =>
            outcome.ownerId === id &&
            (outcome.kind === 'failed' ||
              (outcome.kind === 'blocked' && outcome.reason === 'deadline')),
        )
      );
    });
    if (unresolved.length === 0) return stillCurrent();
  } catch {
    // A failed inspection cannot authorize a dependent action.
  }
  if (stillCurrent()) useUiStore.getState().toast(LEAVE_BLOCKED);
  return false;
}
