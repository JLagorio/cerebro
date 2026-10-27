import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ConnectionStatus, CredentialAcquisitionView } from '@/lib/generated/actions';
import { hasNativeCredentialImport } from '@/lib/ipc';
import {
  createCredentialImportSession,
  type CredentialImportApi,
} from './managedCredentialSession';
import { ManagedAccountCredential } from './ManagedAccountCredential';

vi.mock('@/lib/ipc', async (original) => ({
  ...(await original<typeof import('@/lib/ipc')>()),
  hasNativeCredentialImport: vi.fn(() => true),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.mocked(hasNativeCredentialImport).mockReturnValue(true);
});
const selected: ConnectionStatus = {
  connectionId: 'account-a',
  login: 'alice',
  revision: 1,
  revocationGeneration: 0,
  account: null,
  health: 'sign_in_required',
  cleanupPending: false,
  secretRevision: 0,
  remoteRevocation: 'not_attempted',
  observedAt: '2026-10-26T12:00:00Z',
};
const pending: CredentialAcquisitionView = {
  attemptId: 'original-attempt',
  connectionId: 'account-a',
  host: 'github.com',
  login: 'alice',
  expectedRevision: 2,
  revocationGeneration: 0,
  state: 'pending',
  error: null,
  observedAt: selected.observedAt,
};
function setup() {
  const api = {
    begin: vi.fn<CredentialImportApi['begin']>().mockResolvedValue(pending),
    read: vi.fn<CredentialImportApi['read']>().mockResolvedValue(pending),
    cancel: vi
      .fn<CredentialImportApi['cancel']>()
      .mockResolvedValue({ ...pending, state: 'cancelled', error: 'cancelled' }),
  };
  const session = createCredentialImportSession(api);
  const onSettled = vi.fn();
  return {
    api,
    session,
    onSettled,
    props: { session, onSettled, active: true, selected, blocked: false },
  };
}
it('requires an explicit selected-account action and never offers a secret text field', async () => {
  const { api, props } = setup();
  render(<ManagedAccountCredential {...props} />);
  expect(api.begin).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByText(/macOS Keychain/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Import credential for alice' }));
  await waitFor(() =>
    expect(api.begin).toHaveBeenCalledExactlyOnceWith('account-a', 'github.com', 'alice', 1),
  );
  expect(await screen.findByText(/Importing credential for alice/)).toBeTruthy();
});
it('remounts the original in-progress import while another account is selected and cancels only that attempt', async () => {
  const { api, props } = setup();
  const first = render(<ManagedAccountCredential {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Import credential for alice' }));
  await screen.findByText(/Importing credential for alice/);
  first.unmount();
  render(
    <ManagedAccountCredential
      {...props}
      selected={{ ...selected, connectionId: 'account-b', login: 'bob' }}
    />,
  );
  expect(screen.getByText(/Importing credential for alice/)).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Import credential for bob' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel import for alice' }));
  await waitFor(() => expect(api.cancel).toHaveBeenCalledExactlyOnceWith('original-attempt'));
  expect(await screen.findByText(/Import cancelled for alice/)).toBeTruthy();
  expect(api.begin).toHaveBeenCalledTimes(1);
});
it('shows confirmed installation and refreshes only the original account without granting actions', async () => {
  const { api, session, onSettled, props } = setup();
  await session.begin(selected);
  api.read.mockResolvedValue({ ...pending, state: 'installed' });
  render(<ManagedAccountCredential {...props} />);
  await act(async () => {
    await session.refresh();
  });
  expect(screen.getByText(/Credential stored for alice/)).toBeTruthy();
  expect(screen.getByText(/Actions require separate permission/)).toBeTruthy();
  expect(onSettled).toHaveBeenCalledExactlyOnceWith('account-a');
});
it('browser preview and an unavailable account cannot initiate credential access', () => {
  const { api, props } = setup();
  vi.mocked(hasNativeCredentialImport).mockReturnValue(false);
  const view = render(<ManagedAccountCredential {...props} />);
  expect(screen.getByText(/macOS desktop app/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Import credential for alice' })).toBeNull();
  view.rerender(<ManagedAccountCredential {...props} selected={null} />);
  expect(api.begin).not.toHaveBeenCalled();
});
