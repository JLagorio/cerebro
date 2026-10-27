import { useManagedAccountSession } from './managedAccountSession';

/** Test boundary only: a fresh app, never a navigation or consumer remount.
 * Refuse to discard a write still in flight, even during fixture cleanup. */
export function freshManagedAccountApp(): void {
  if (useManagedAccountSession.getState().pending !== null) {
    throw new Error('Settle the managed-account write before starting a fresh app fixture.');
  }
  useManagedAccountSession.setState({ login: '', pending: null, uncertain: null, feedback: null });
}
