import { ManagedAccountCredential } from '@/app/ManagedAccountCredential';
import { createCredentialImportSession } from '@/app/managedCredentialSession';
import type { ConnectionStatus, CredentialAcquisitionView } from '@/lib/generated/actions';
import { faulted } from '@/lib/mockFaults';
import type { LabSection, LabState } from '../presets';

const account: ConnectionStatus = {
  connectionId: 'lab-account',
  login: 'lab-reader',
  revision: 1,
  revocationGeneration: 0,
  account: null,
  health: 'sign_in_required',
  cleanupPending: false,
  secretRevision: 0,
  remoteRevocation: 'not_attempted',
  observedAt: '2026-10-26T12:00:00Z',
};
const attempt: CredentialAcquisitionView = {
  attemptId: 'lab-import',
  connectionId: account.connectionId,
  host: 'github.com',
  login: account.login,
  expectedRevision: 2,
  revocationGeneration: 0,
  state: 'pending',
  error: null,
  observedAt: account.observedAt,
};
function preview(state: LabState) {
  // Disposable display fixtures only. No IPC, process, Keychain or provider.
  return createCredentialImportSession({
    begin: async () => ({ ...attempt, state: state === 'ready' ? 'installed' : 'pending' }),
    read: () => faulted('credential_acquisition', async () => attempt),
    cancel: async () => ({ ...attempt, state: 'cancelled', error: 'cancelled' }),
  });
}
let selected: ConnectionStatus | null = account;
let session = preview('empty');
const seed = (state: LabState) => () => {
  selected = state === 'empty' ? null : account;
  session = preview(state);
  if (state === 'ready' || state === 'partial' || state === 'unavailable') {
    void session.begin(account);
  }
};
function Stage() {
  const current = session;
  // The real controller receives the mock read only after applyPreset arms its
  // command fault; the original pending attempt remains visible on failure.
  useEffect(() => {
    void current.refresh();
  }, [current]);
  return (
    <ManagedAccountCredential
      active
      selected={selected}
      blocked={false}
      session={current}
      onSettled={() => {}}
    />
  );
}
export const section: LabSection = {
  id: 'managed-credential',
  title: 'Managed credential import',
  surface: 'Settings › Assistant › Managed accounts',
  render: () => <Stage />,
  states: {
    ready: {
      note: 'Fixture reports confirmed storage. No real credential was accessed; action permission stays separate.',
      seed: seed('ready'),
      expect: { present: ['[role="status"]'], text: 'Credential stored for lab-reader.' },
    },
    empty: {
      note: 'No account is selected; the view cannot choose an identity or start an import.',
      seed: seed('empty'),
      expect: { present: [], absent: ['[role="alert"]'], text: 'Select an account above' },
    },
    'not-recorded': {
      note: 'The selected account has no recorded credential and no import has started.',
      seed: seed('not-recorded'),
      expect: {
        present: [],
        absent: ['[role="status"]'],
        text: 'No credential recorded for lab-reader.',
      },
    },
    partial: {
      note: 'The original import is pending; changing views does not create another attempt.',
      seed: seed('partial'),
      expect: { present: ['[role="status"]'], text: 'Importing credential for lab-reader' },
    },
    unavailable: {
      note: 'The status read failed; the original attempt remains visible and cancellable.',
      seed: seed('unavailable'),
      failNext: ['credential_acquisition'],
      expect: {
        present: ['[role="alert"]', '[role="status"]', '[data-testid="section-unavailable"]'],
        text: 'Import status is unavailable.',
      },
    },
  },
};
import { useEffect } from 'react';
