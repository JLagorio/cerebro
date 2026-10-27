import { create } from 'zustand';
import type { ConnectionError } from '@/lib/generated/actions';

export type ManagedAccountMutation =
  | { kind: 'add'; login: string }
  | { kind: 'disable'; connectionId: string; login: string; expectedRevision: number };

interface ManagedAccountSession {
  login: string;
  pending: {
    token: symbol;
    consumer: symbol;
    mutation: ManagedAccountMutation;
    detached: boolean;
  } | null;
  uncertain: ManagedAccountMutation | null;
  feedback: string | null;
}

/** Only app-session metadata: no body, credential, vault or persistent storage.
 * The lock outlives any Settings consumer; reads and rendered rows remain local. */
export const useManagedAccountSession = create<ManagedAccountSession>(() => ({
  login: '',
  pending: null,
  uncertain: null,
  feedback: null,
}));

// Unavailable can also mean a commit lost its acknowledgement. Only these
// definite native refusals permit retry without a reconciliation read.
const REFUSALS: Partial<Record<ConnectionError, string>> = {
  invalid_selection: 'That account selection was refused. Check the GitHub login.',
  stale_revision: 'The account changed. Refresh account status before disabling it.',
  not_found: 'That account selection was not found. Refresh managed accounts.',
  unsupported: 'That account selection is not supported.',
  identity_mismatch: 'The account identity did not match the selection.',
  cancelled: 'The account change was cancelled.',
  source_changed: 'The account source changed. Refresh before trying again.',
  unsafe_path: 'The account change was refused because its storage is unsafe.',
  invalid_config: 'The account change was refused because its configuration is invalid.',
  sign_in_required: 'The account change requires sign-in, which is unavailable here.',
};

export function managedAccountRefusal(error: unknown): string | null {
  return typeof error === 'string' && Object.hasOwn(REFUSALS, error)
    ? (REFUSALS[error as ConnectionError] ?? null)
    : null;
}

function unknownWords(mutation: ManagedAccountMutation): string {
  return mutation.kind === 'add'
    ? `Could not confirm the account selection outcome for ${mutation.login}. Refresh managed accounts and load any remaining accounts before adding again.`
    : `Could not confirm the disable outcome for ${mutation.login}. Select that account and refresh account status before disabling again.`;
}

export function beginManagedAccountMutation(
  mutation: ManagedAccountMutation,
  consumer: symbol,
): symbol | null {
  const session = useManagedAccountSession.getState();
  if (session.pending !== null || session.uncertain !== null) return null;
  const token = Symbol('managed account mutation');
  useManagedAccountSession.setState({
    pending: { token, mutation, consumer, detached: false },
    feedback: null,
  });
  return token;
}

/** Leaving the initiating view does not cancel or release its native write. */
export function detachManagedAccountMutation(consumer: symbol): void {
  const { pending } = useManagedAccountSession.getState();
  if (pending === null || pending.consumer !== consumer || pending.detached) return;
  useManagedAccountSession.setState({
    pending: { ...pending, detached: true },
    uncertain: pending.mutation,
    feedback: unknownWords(pending.mutation),
  });
}

/** Settle the app-session lock even if the initiating React view is gone.
 * A detached success requires an explicit read in the later view; it never
 * publishes the old consumer's rows or selection into that view. */
export function settleManagedAccountMutation(
  token: symbol,
  outcome: 'confirmed' | 'unknown' | 'refused',
  refusal: string | null = null,
): boolean {
  const { pending } = useManagedAccountSession.getState();
  if (pending === null || pending.token !== token) return false;
  const needsRead = outcome === 'unknown' || (outcome === 'confirmed' && pending.detached);
  useManagedAccountSession.setState({
    pending: null,
    uncertain: needsRead ? pending.mutation : null,
    feedback: needsRead ? unknownWords(pending.mutation) : refusal,
  });
  return !pending.detached;
}

/** A read may reconcile only the exact uncertainty it captured, after the
 * native write settled. Failed reads never call this. */
export function reconcileManagedAccountMutation(expected: ManagedAccountMutation): void {
  const session = useManagedAccountSession.getState();
  if (session.pending !== null || session.uncertain !== expected) return;
  useManagedAccountSession.setState({ uncertain: null, feedback: null });
}
