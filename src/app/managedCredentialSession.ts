import type { ConnectionStatus, CredentialAcquisitionView } from '@/lib/generated/actions';
import { beginGhImport, cancelCredentialAcquisition, credentialAcquisition } from '@/lib/ipc';

export type CredentialSelection = Pick<
  ConnectionStatus,
  'connectionId' | 'login' | 'revision' | 'revocationGeneration'
>;
export interface CredentialImportState {
  selection: CredentialSelection | null;
  attempt: CredentialAcquisitionView | null;
  phase: 'idle' | 'starting' | 'pending' | 'terminal' | 'unknown';
  busy: boolean;
  failure: string | null;
}
export interface CredentialImportApi {
  begin: typeof beginGhImport;
  read: typeof credentialAcquisition;
  cancel: typeof cancelCredentialAcquisition;
}

/** App-session metadata only. No credential, vault or persistent browser storage. */
export function createCredentialImportSession(api: CredentialImportApi) {
  let state: CredentialImportState = {
    selection: null,
    attempt: null,
    phase: 'idle',
    busy: false,
    failure: null,
  };
  const listeners = new Set<() => void>();
  const publish = (next: Partial<CredentialImportState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const matches = (
    value: CredentialAcquisitionView,
    original: CredentialSelection,
    id?: string,
  ): boolean =>
    value !== null &&
    typeof value === 'object' &&
    typeof value.attemptId === 'string' &&
    value.attemptId.length > 0 &&
    value.attemptId.length <= 128 &&
    (id === undefined || value.attemptId === id) &&
    value.connectionId === original.connectionId &&
    value.host === 'github.com' &&
    value.login === original.login &&
    // Native begin_import increments the account revision before minting its ticket.
    value.expectedRevision === original.revision + 1 &&
    value.revocationGeneration === original.revocationGeneration &&
    ['pending', 'installed', 'cancelled', 'failed'].includes(value.state) &&
    (value.state !== 'installed' || value.error === null);
  const accept = (value: CredentialAcquisitionView) => {
    // Keep the finite native contract, never extra response fields or arbitrary
    // exception text, even if a transport returns a larger object.
    const attempt: CredentialAcquisitionView = {
      attemptId: value.attemptId,
      connectionId: value.connectionId,
      host: value.host,
      login: value.login,
      expectedRevision: value.expectedRevision,
      revocationGeneration: value.revocationGeneration,
      state: value.state,
      observedAt: value.observedAt,
      error:
        value.error === 'unavailable' || credentialImportRefusal(value.error) !== null
          ? value.error
          : null,
    };
    publish({
      attempt,
      busy: false,
      failure: null,
      phase: attempt.state === 'pending' ? 'pending' : 'terminal',
    });
  };
  const observe = async (kind: 'read' | 'cancel') => {
    const { selection, attempt, phase, busy } = state;
    if (busy || phase !== 'pending' || selection === null || attempt === null) return;
    publish({ busy: true, failure: null });
    try {
      const next = await api[kind](attempt.attemptId);
      if (!matches(next, selection, attempt.attemptId)) throw new Error('mismatched acquisition');
      accept(next);
    } catch {
      publish({
        busy: false,
        failure:
          kind === 'cancel'
            ? 'Could not confirm cancellation. Check import status before trying again.'
            : 'Import status is unavailable. Check again or cancel the original import.',
      });
    }
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin: async (selected: CredentialSelection): Promise<void> => {
      if (state.busy || ['starting', 'pending', 'unknown'].includes(state.phase)) return;
      const selection: CredentialSelection = {
        connectionId: selected.connectionId,
        login: selected.login,
        revision: selected.revision,
        revocationGeneration: selected.revocationGeneration,
      };
      publish({ selection, attempt: null, phase: 'starting', busy: true, failure: null });
      try {
        const attempt = await api.begin(
          selection.connectionId,
          'github.com',
          selection.login,
          selection.revision,
        );
        if (!matches(attempt, selection)) throw new Error('mismatched acquisition');
        accept(attempt);
      } catch (error) {
        const refusal = credentialImportRefusal(error);
        publish({
          busy: false,
          phase: refusal === null ? 'unknown' : 'terminal',
          failure:
            refusal ??
            'Could not confirm whether the import started. Refresh account status, then disable that account to stop any pending import before trying again.',
        });
      }
    },
    refresh: () => observe('read'),
    cancel: () => observe('cancel'),
    reconcile: (status: ConnectionStatus): void => {
      const original = state.selection;
      // A later disable atomically cancels that account's active acquisition.
      // An ordinary fresh/ready read cannot prove an unacknowledged worker stopped.
      if (
        state.phase === 'unknown' &&
        original !== null &&
        status.connectionId === original.connectionId &&
        status.login === original.login &&
        status.health === 'disabled' &&
        status.revision > original.revision
      ) {
        publish({ selection: null, attempt: null, phase: 'idle', busy: false, failure: null });
      }
    },
  };
}

/** Finite copy only: native exception text never reaches the view or session. */
export function credentialImportRefusal(error: unknown): string | null {
  switch (error) {
    case 'stale_revision':
      return 'The account changed. Refresh account status before importing.';
    case 'unsupported':
      return 'Credential import is unsupported for this account or platform.';
    case 'sign_in_required':
      return 'Sign in to the selected account in GitHub CLI, then refresh account status.';
    case 'identity_mismatch':
      return 'GitHub returned a different account. Check the selected GitHub CLI login.';
    case 'cancelled':
      return 'The credential import was cancelled.';
    case 'source_changed':
      return 'The account source changed. Refresh before importing again.';
    case 'not_found':
      return 'The selected account was not found. Refresh managed accounts.';
    case 'invalid_selection':
      return 'The selected GitHub account is invalid. Refresh managed accounts.';
    case 'unsafe_path':
    case 'invalid_config':
      return 'Credential import was refused because local configuration is unavailable.';
    default:
      return null;
  }
}

export const credentialImportSession = createCredentialImportSession({
  begin: beginGhImport,
  read: credentialAcquisition,
  cancel: cancelCredentialAcquisition,
});
