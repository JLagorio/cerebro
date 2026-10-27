// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SettingsPage } from './SettingsPage';
import * as ipc from '@/lib/ipc';
import * as accountBackend from '@/lib/mockManagedAccounts';
import * as agentIpc from '@/agent/agentIpc';
import { resetMockFs } from '@/lib/mockIpc';
import { __resetCliReadiness } from '@/agent/useCliReadiness';
import { freshManagedAccountApp } from '@/app/managedAccountSession.testUtils';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { ConnectionStatus, ManagedConnectionPage } from '@/lib/generated/actions';

// Keep the actual Settings and IPC adapters. Only the browser transport leaf
// is controlled; no component, store action, owner or native authority is faked.
vi.mock('@/lib/mockManagedAccounts', () => ({
  managedConnections: vi.fn(),
  managedConnectionStatus: vi.fn(),
  managedConnectionAdd: vi.fn(),
  managedConnectionDisable: vi.fn(),
}));

const aliceId = 'a'.repeat(32);
const bobId = 'b'.repeat(32);
const budget = { timeout: 1500 };
function status(login = 'alice', connectionId = aliceId, revision = 1): ConnectionStatus {
  return {
    connectionId,
    revision,
    login,
    health: 'sign_in_required',
    account: null,
    secretRevision: 0,
    revocationGeneration: 0,
    observedAt: '2026-10-24T12:00:00.000Z',
    cleanupPending: false,
    remoteRevocation: 'not_attempted',
  };
}
function page(
  items: ConnectionStatus[] = [],
  nextCursor: string | null = null,
): ManagedConnectionPage {
  return { items, nextCursor };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function section(name: 'Assistant' | 'General') {
  fireEvent.click(
    within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', {
      name,
    }),
  );
}
function managed() {
  return screen.getByRole('region', { name: 'Managed accounts' });
}
function openAccounts() {
  section('Assistant');
  // The section owns its loading state immediately; only rows/status await IPC.
  return screen.getByRole('region', { name: 'Managed accounts' });
}
async function selectAccount(login = 'alice') {
  fireEvent.click(await within(managed()).findByRole('button', { name: login }, budget));
  return within(managed()).findByRole('group', { name: `Managed account ${login}` }, budget);
}
function noMutations() {
  expect(accountBackend.managedConnectionAdd).not.toHaveBeenCalled();
  expect(accountBackend.managedConnectionDisable).not.toHaveBeenCalled();
}
function draft(value: string) {
  fireEvent.change(within(managed()).getByRole('textbox', { name: 'GitHub login' }), {
    target: { value },
  });
}
function add() {
  fireEvent.click(within(managed()).getByRole('button', { name: 'Add account selection' }));
}
function unknownFeedback() {
  return within(managed()).findByText(
    /could not (?:be )?confirm|couldn.t confirm|outcome (?:is )?unknown/i,
    {},
    budget,
  );
}

beforeEach(() => {
  freshManagedAccountApp();
  vi.restoreAllMocks();
  resetMockFs();
  useVaultStore.setState({ vaultPath: '/demo-vault', status: 'ready', error: null, entries: [] });
  useUiStore.setState({
    settingsFocus: null,
    toasts: [],
    agentConnectors: true,
    stdioApprovals: {},
  });
  vi.spyOn(agentIpc, 'readCliReadiness').mockResolvedValue({
    state: 'available',
    backend: 'native',
    version: '2.1.250 (Claude Code)',
    path: '/opt/claude/bin/claude',
  });
  vi.spyOn(agentIpc, 'claudeUserSettings').mockResolvedValue({ state: 'browser' });
  // The readiness owner captures its reader at construction. Bind this test's
  // fresh spy before making that owner, rather than retaining the prior reader.
  __resetCliReadiness();
  vi.mocked(accountBackend.managedConnections).mockReset().mockResolvedValue(page());
  vi.mocked(accountBackend.managedConnectionStatus)
    .mockReset()
    .mockImplementation(async (id) => status(id === bobId ? 'bob' : 'alice', id));
  vi.mocked(accountBackend.managedConnectionAdd)
    .mockReset()
    .mockImplementation(async (_host, login) => status(login));
  vi.mocked(accountBackend.managedConnectionDisable)
    .mockReset()
    .mockImplementation(async (id, revision) => ({
      ...status(id === bobId ? 'bob' : 'alice', id, revision + 1),
      health: 'disabled',
      revocationGeneration: 1,
    }));
});
afterEach(() => {
  cleanup();
  freshManagedAccountApp();
  __resetCliReadiness();
  vi.restoreAllMocks();
});

it('managed_settings_inactive_general_never_reads_or_mutates_accounts', async () => {
  render(<SettingsPage />);
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(screen.getByTestId('settings-heading').textContent).toBe('General');
  expect(screen.queryByRole('region', { name: 'Managed accounts' })).toBeNull();
  expect(accountBackend.managedConnections).not.toHaveBeenCalled();
  expect(accountBackend.managedConnectionStatus).not.toHaveBeenCalled();
  noMutations();
});

it('managed_settings_active_list_uses_real_ipc_and_distinguishes_measured_empty', async () => {
  const read = vi.spyOn(ipc, 'managedConnections'); // forwards through actual adapter
  render(<SettingsPage />);
  const region = openAccounts();
  await within(region).findByText(/no managed accounts/i, {}, budget);
  expect(read).toHaveBeenCalledWith(null);
  expect(accountBackend.managedConnections).toHaveBeenCalledWith(null);
  expect(within(region).queryByTestId('section-unavailable')).toBeNull();
  expect(
    within(region).getByText(/credential import is available in the macOS desktop app/i),
  ).toBeTruthy();
  expect(within(region).queryByText(/^connected$|^ready$/i)).toBeNull();
  expect(within(region).queryByLabelText(/password|token|credential/i)).toBeNull();
  expect(
    within(region).queryByRole('button', { name: /^connect$|^sign in$|^import credentials$/i }),
  ).toBeNull();
  expect(accountBackend.managedConnectionStatus).not.toHaveBeenCalled();
  noMutations();
});

it('managed_settings_unavailable_is_not_empty_and_explicit_refresh_can_recover_without_a_vault', async () => {
  useVaultStore.setState({ vaultPath: null });
  vi.mocked(accountBackend.managedConnections).mockRejectedValueOnce('unavailable');
  render(<SettingsPage />);
  const region = openAccounts();
  expect(await within(region).findByTestId('section-unavailable', {}, budget)).toBeTruthy();
  expect(within(region).queryByText(/no managed accounts/i)).toBeNull();
  fireEvent.click(within(region).getByRole('button', { name: 'Refresh managed accounts' }));
  await within(region).findByText(/no managed accounts/i, {}, budget);
  expect(accountBackend.managedConnections).toHaveBeenCalledTimes(2);
  noMutations();
});

it('managed_settings_retains_login_draft_and_stops_focus_reads_while_section_is_hidden', async () => {
  render(<SettingsPage />);
  openAccounts();
  await within(managed()).findByText(/no managed accounts/i, {}, budget);
  const input = within(managed()).getByRole('textbox', { name: 'GitHub login' });
  draft('retained-login');
  section('General');
  const before = vi.mocked(accountBackend.managedConnections).mock.calls.length;
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(accountBackend.managedConnections).toHaveBeenCalledTimes(before);
  expect(screen.queryByRole('textbox', { name: 'GitHub login' })).toBeNull();
  openAccounts();
  expect(within(managed()).getByRole('textbox', { name: 'GitHub login' })).toBe(input);
  expect((input as HTMLInputElement).value).toBe('retained-login');
  await waitFor(() => expect(accountBackend.managedConnections).toHaveBeenCalledTimes(before + 1));
  noMutations();
});

it('managed_settings_add_is_explicit_single_flight_metadata_only_and_independent_of_cli_toggle', async () => {
  const write = vi.spyOn(ipc, 'managedConnectionAdd'); // actual IPC remains in the call chain
  const reply = deferred<ConnectionStatus>();
  vi.mocked(accountBackend.managedConnectionAdd).mockReturnValueOnce(reply.promise);
  useUiStore.setState({ agentConnectors: false });
  render(<SettingsPage />);
  try {
    openAccounts();
    draft('alice');
    noMutations();
    add();
    add();
    await waitFor(() => expect(accountBackend.managedConnectionAdd).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledExactlyOnceWith('github.com', 'alice');
    expect(accountBackend.managedConnectionAdd).toHaveBeenCalledExactlyOnceWith(
      'github.com',
      'alice',
    );
    expect(within(managed()).queryByText(/^connected$|^ready$/i)).toBeNull();
    await act(async () => reply.resolve(status()));
    const detail = await within(managed()).findByRole(
      'group',
      { name: 'Managed account alice' },
      budget,
    );
    expect(within(detail).getByText('Sign in required')).toBeTruthy();
    expect(accountBackend.managedConnectionDisable).not.toHaveBeenCalled();
    expect(useUiStore.getState().agentConnectors).toBe(false);
    expect(useUiStore.getState().stdioApprovals).toEqual({});
  } finally {
    await act(async () => reply.resolve(status()));
  }
});

it('managed_settings_definite_add_refusal_keeps_the_login_draft_without_claiming_an_account', async () => {
  vi.mocked(accountBackend.managedConnectionAdd).mockRejectedValueOnce('invalid_selection');
  render(<SettingsPage />);
  openAccounts();
  draft('invalid/login');
  add();
  expect(await within(managed()).findByRole('alert', {}, budget)).toBeTruthy();
  expect(
    (within(managed()).getByRole('textbox', { name: 'GitHub login' }) as HTMLInputElement).value,
  ).toBe('invalid/login');
  expect(accountBackend.managedConnectionAdd).toHaveBeenCalledExactlyOnceWith(
    'github.com',
    'invalid/login',
  );
  expect(within(managed()).queryByRole('group', { name: /Managed account / })).toBeNull();
  expect(accountBackend.managedConnectionDisable).not.toHaveBeenCalled();
});

it('managed_settings_unknown_add_keeps_draft_and_requires_explicit_read_instead_of_resending', async () => {
  vi.mocked(accountBackend.managedConnectionAdd).mockRejectedValueOnce(new Error('lost reply'));
  render(<SettingsPage />);
  openAccounts();
  draft('alice');
  add();
  await unknownFeedback();
  expect(
    (within(managed()).getByRole('textbox', { name: 'GitHub login' }) as HTMLInputElement).value,
  ).toBe('alice');
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  section('General');
  openAccounts();
  expect(accountBackend.managedConnectionAdd).toHaveBeenCalledTimes(1);
  vi.mocked(accountBackend.managedConnections).mockResolvedValue(page([status()]));
  fireEvent.click(within(managed()).getByRole('button', { name: 'Refresh managed accounts' }));
  expect(await within(managed()).findByRole('button', { name: 'alice' }, budget)).toBeTruthy();
  expect(accountBackend.managedConnectionAdd).toHaveBeenCalledTimes(1);
  expect(accountBackend.managedConnectionDisable).not.toHaveBeenCalled();
  expect(within(managed()).queryByText(/added successfully|connected successfully/i)).toBeNull();
});

it('managed_settings_cursor_is_explicit_and_all_loaded_rows_remain_selectable', async () => {
  vi.mocked(accountBackend.managedConnections)
    .mockResolvedValueOnce(page([status()], aliceId))
    .mockResolvedValueOnce(page([status('bob', bobId)], null));
  render(<SettingsPage />);
  const region = openAccounts();
  expect(await within(region).findByRole('button', { name: 'alice' }, budget)).toBeTruthy();
  expect(accountBackend.managedConnections).toHaveBeenCalledExactlyOnceWith(null);
  fireEvent.click(within(region).getByRole('button', { name: 'Load more accounts' }));
  expect(await within(region).findByRole('button', { name: 'bob' }, budget)).toBeTruthy();
  expect(within(region).getByRole('button', { name: 'alice' })).toBeTruthy();
  expect(accountBackend.managedConnections).toHaveBeenNthCalledWith(2, aliceId);
  expect(within(region).queryByRole('button', { name: 'Load more accounts' })).toBeNull();
  noMutations();
});

it('managed_settings_old_row_status_cannot_replace_the_current_selected_row', async () => {
  const old = deferred<ConnectionStatus>();
  vi.mocked(accountBackend.managedConnections).mockResolvedValue(
    page([status(), status('bob', bobId)]),
  );
  vi.mocked(accountBackend.managedConnectionStatus).mockImplementation((id) =>
    id === aliceId ? old.promise : Promise.resolve(status('bob', bobId, 7)),
  );
  render(<SettingsPage />);
  try {
    openAccounts();
    fireEvent.click(await within(managed()).findByRole('button', { name: 'alice' }, budget));
    await waitFor(() =>
      expect(accountBackend.managedConnectionStatus).toHaveBeenCalledWith(aliceId),
    );
    fireEvent.click(within(managed()).getByRole('button', { name: 'bob' }));
    const current = await within(managed()).findByRole(
      'group',
      { name: 'Managed account bob' },
      budget,
    );
    await within(current).findByText('Sign in required', {}, budget);
    await act(async () => old.resolve({ ...status(), health: 'disabled' }));
    const selected = within(managed()).getByRole('group', { name: 'Managed account bob' });
    expect(within(selected).getByText('Sign in required')).toBeTruthy();
    expect(within(selected).queryByText(/^disabled(?: in Cerebro)?$/i)).toBeNull();
    expect(accountBackend.managedConnectionStatus).toHaveBeenCalledWith(bobId);
    noMutations();
  } finally {
    await act(async () => old.resolve(status()));
  }
});

it('managed_settings_unavailable_row_status_is_not_sign_in_required_and_can_be_rechecked', async () => {
  vi.mocked(accountBackend.managedConnections).mockResolvedValue(page([status()]));
  vi.mocked(accountBackend.managedConnectionStatus).mockRejectedValueOnce('unavailable');
  render(<SettingsPage />);
  openAccounts();
  const detail = await selectAccount();
  expect(await within(detail).findByTestId('section-unavailable', {}, budget)).toBeTruthy();
  expect(within(detail).queryByText('Sign in required')).toBeNull();
  const disable = within(detail).queryByRole('button', { name: 'Disable in Cerebro' });
  expect(disable === null || (disable as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(detail).getByRole('button', { name: 'Refresh account status' }));
  await waitFor(() =>
    expect(
      within(within(managed()).getByRole('group', { name: 'Managed account alice' })).getByText(
        'Sign in required',
      ),
    ).toBeTruthy(),
  );
  expect(accountBackend.managedConnectionStatus).toHaveBeenNthCalledWith(2, aliceId);
  noMutations();
});

it('managed_settings_hidden_old_list_cannot_replace_a_fresh_reopened_list', async () => {
  const old = deferred<ManagedConnectionPage>();
  vi.mocked(accountBackend.managedConnections)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue(page([status('bob', bobId)]));
  render(<SettingsPage />);
  try {
    openAccounts();
    await waitFor(() => expect(accountBackend.managedConnections).toHaveBeenCalledTimes(1));
    section('General');
    openAccounts();
    expect(await within(managed()).findByRole('button', { name: 'bob' }, budget)).toBeTruthy();
    await act(async () => old.resolve(page([status()])));
    expect(within(managed()).getByRole('button', { name: 'bob' })).toBeTruthy();
    expect(within(managed()).queryByRole('button', { name: 'alice' })).toBeNull();
    noMutations();
  } finally {
    await act(async () => old.resolve(page()));
  }
});

it('managed_settings_disable_sends_current_exact_revision_once_and_reports_remaining_cleanup', async () => {
  const reply = deferred<ConnectionStatus>();
  const current = status('alice', aliceId, 7);
  // Distinguish the fresh row read from the older list row before clicking.
  vi.mocked(accountBackend.managedConnections).mockResolvedValue(
    page([{ ...status(), health: 'unavailable' }]),
  );
  vi.mocked(accountBackend.managedConnectionStatus).mockResolvedValue(current);
  vi.mocked(accountBackend.managedConnectionDisable).mockReturnValueOnce(reply.promise);
  const write = vi.spyOn(ipc, 'managedConnectionDisable');
  render(<SettingsPage />);
  try {
    openAccounts();
    const detail = await selectAccount();
    await within(detail).findByText('Sign in required', {}, budget);
    const disable = within(detail).getByRole('button', { name: 'Disable in Cerebro' });
    fireEvent.click(disable);
    fireEvent.click(disable);
    await waitFor(() => expect(accountBackend.managedConnectionDisable).toHaveBeenCalledTimes(1));
    expect(write).toHaveBeenCalledExactlyOnceWith(aliceId, 7);
    expect(accountBackend.managedConnectionDisable).toHaveBeenCalledExactlyOnceWith(aliceId, 7);
    expect(within(detail).queryByText(/^disabled(?: in Cerebro)?$/i)).toBeNull();
    await act(async () =>
      reply.resolve({
        ...current,
        revision: 8,
        health: 'disabled',
        cleanupPending: true,
        revocationGeneration: 1,
      }),
    );
    await within(detail).findByText(/^disabled(?: in Cerebro)?$/i, {}, budget);
    expect(
      within(detail).getByText(/credential.*(?:not.*removed|removal.*pending|cleanup.*pending)/i),
    ).toBeTruthy();
    expect(
      within(detail).getByText(
        /remote.*(?:not attempted|not revoked)|(?:does not|has not).*revok/i,
      ),
    ).toBeTruthy();
    expect(
      within(detail).queryByText(/credential deleted|credential removed|remotely revoked/i),
    ).toBeNull();
    expect(accountBackend.managedConnectionAdd).not.toHaveBeenCalled();
  } finally {
    await act(async () => reply.resolve(current));
  }
});

it('managed_settings_stale_disable_refusal_never_optimistically_disables_the_row', async () => {
  vi.mocked(accountBackend.managedConnections).mockResolvedValue(page([status()]));
  vi.mocked(accountBackend.managedConnectionDisable).mockRejectedValueOnce('stale_revision');
  render(<SettingsPage />);
  openAccounts();
  const detail = await selectAccount();
  fireEvent.click(
    await within(detail).findByRole('button', { name: 'Disable in Cerebro' }, budget),
  );
  expect(await within(managed()).findByRole('alert', {}, budget)).toBeTruthy();
  expect(within(detail).queryByText(/^disabled(?: in Cerebro)?$/i)).toBeNull();
  expect(accountBackend.managedConnectionDisable).toHaveBeenCalledExactlyOnceWith(aliceId, 1);
  expect(accountBackend.managedConnectionAdd).not.toHaveBeenCalled();
});

it('managed_settings_unknown_disable_is_not_retried_and_refresh_observes_the_actual_row', async () => {
  vi.mocked(accountBackend.managedConnections).mockResolvedValue(page([status()]));
  vi.mocked(accountBackend.managedConnectionDisable).mockRejectedValueOnce(new Error('lost reply'));
  render(<SettingsPage />);
  openAccounts();
  const detail = await selectAccount();
  fireEvent.click(
    await within(detail).findByRole('button', { name: 'Disable in Cerebro' }, budget),
  );
  await unknownFeedback();
  expect(accountBackend.managedConnectionDisable).toHaveBeenCalledTimes(1);
  expect(within(detail).queryByText(/^disabled(?: in Cerebro)?$/i)).toBeNull();
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(accountBackend.managedConnectionDisable).toHaveBeenCalledTimes(1);
  vi.mocked(accountBackend.managedConnectionStatus).mockResolvedValue({
    ...status(),
    revision: 2,
    health: 'disabled',
    revocationGeneration: 1,
  });
  fireEvent.click(within(managed()).getByRole('button', { name: 'Refresh account status' }));
  await waitFor(() =>
    expect(
      within(within(managed()).getByRole('group', { name: 'Managed account alice' })).getByText(
        /^disabled(?: in Cerebro)?$/i,
      ),
    ).toBeTruthy(),
  );
  expect(accountBackend.managedConnectionDisable).toHaveBeenCalledTimes(1);
  expect(accountBackend.managedConnectionAdd).not.toHaveBeenCalled();
});

it('managed_settings_late_disable_result_keeps_the_new_selected_row_and_does_not_retarget', async () => {
  const reply = deferred<ConnectionStatus>();
  vi.mocked(accountBackend.managedConnections).mockResolvedValue(
    page([status(), status('bob', bobId)]),
  );
  vi.mocked(accountBackend.managedConnectionDisable).mockReturnValueOnce(reply.promise);
  render(<SettingsPage />);
  try {
    openAccounts();
    const original = await selectAccount();
    fireEvent.click(
      await within(original).findByRole('button', { name: 'Disable in Cerebro' }, budget),
    );
    await waitFor(() => expect(accountBackend.managedConnectionDisable).toHaveBeenCalledTimes(1));
    const current = await selectAccount('bob');
    await within(current).findByText('Sign in required', {}, budget);
    await act(async () =>
      reply.resolve({ ...status(), revision: 2, health: 'disabled', revocationGeneration: 1 }),
    );
    const selected = within(managed()).getByRole('group', { name: 'Managed account bob' });
    expect(within(selected).getByText('Sign in required')).toBeTruthy();
    expect(accountBackend.managedConnectionDisable).toHaveBeenCalledExactlyOnceWith(aliceId, 1);
    expect(accountBackend.managedConnectionAdd).not.toHaveBeenCalled();
  } finally {
    await act(async () => reply.resolve(status()));
  }
});

it('managed_settings_unmounted_add_completion_cannot_publish_into_another_settings_visit', async () => {
  const reply = deferred<ConnectionStatus>();
  vi.mocked(accountBackend.managedConnectionAdd).mockReturnValueOnce(reply.promise);
  const first = render(<SettingsPage />);
  try {
    openAccounts();
    draft('alice');
    add();
    await waitFor(() => expect(accountBackend.managedConnectionAdd).toHaveBeenCalledTimes(1));
    first.unmount();
    vi.mocked(accountBackend.managedConnections).mockResolvedValue(page([status('bob', bobId)]));
    render(<SettingsPage />);
    openAccounts();
    expect(await within(managed()).findByRole('button', { name: 'bob' }, budget)).toBeTruthy();
    const beforeToasts = useUiStore.getState().toasts;
    await act(async () => reply.resolve(status()));
    expect(within(managed()).getByRole('button', { name: 'bob' })).toBeTruthy();
    expect(within(managed()).queryByRole('button', { name: 'alice' })).toBeNull();
    expect(useUiStore.getState().toasts).toEqual(beforeToasts);
    expect(accountBackend.managedConnectionAdd).toHaveBeenCalledTimes(1);
    expect(accountBackend.managedConnectionDisable).not.toHaveBeenCalled();
  } finally {
    await act(async () => reply.resolve(status()));
  }
});

it('managed_settings_keeps_existing_claude_and_cli_connector_controls_on_their_existing_paths', async () => {
  const write = vi.spyOn(ipc, 'saveConnectors'); // real existing browser writer
  render(<SettingsPage />);
  section('Assistant');
  expect(await screen.findByTestId('settings-claude-code-status')).toBeTruthy();
  expect(screen.getByTestId('settings-claude-code').textContent).toContain('/login');
  await waitFor(() => expect(agentIpc.readCliReadiness).toHaveBeenCalled());
  expect(screen.getByRole('switch', { name: 'Connectors' })).toBeTruthy();
  fireEvent.change(await screen.findByPlaceholderText('Name'), {
    target: { value: 'cli-review-fixture' },
  });
  fireEvent.change(screen.getByPlaceholderText('https://…/mcp'), {
    target: { value: 'https://example.test/mcp' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await waitFor(() => expect(write).toHaveBeenCalled());
  expect(write.mock.calls.at(-1)?.[0]).toBe('/demo-vault');
  expect(write.mock.calls.at(-1)?.[1]).toContain('cli-review-fixture');
  expect(useUiStore.getState().stdioApprovals['/demo-vault']).toHaveLength(1);
  noMutations();
});

it('managed_settings_pending_add_survives_full_consumer_teardown_and_blocks_a_second_dispatch', async () => {
  const reply = deferred<ConnectionStatus>();
  vi.mocked(accountBackend.managedConnectionAdd).mockReturnValueOnce(reply.promise);
  const first = render(<SettingsPage />);
  try {
    openAccounts();
    draft('alice');
    add();
    await waitFor(() => expect(accountBackend.managedConnectionAdd).toHaveBeenCalledTimes(1));
    first.unmount();
    // This is a second visit in the same app session, not a fixture reset.
    render(<SettingsPage />);
    openAccounts();
    const retainedDraft = (
      within(managed()).getByRole('textbox', { name: 'GitHub login' }) as HTMLInputElement
    ).value;
    draft('alice');
    await act(async () => add());
    expect(accountBackend.managedConnectionAdd).toHaveBeenCalledExactlyOnceWith(
      'github.com',
      'alice',
    );
    expect(retainedDraft).toBe('alice');
    expect(
      (
        within(managed()).getByRole('button', {
          name: 'Add account selection',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(accountBackend.managedConnectionDisable).not.toHaveBeenCalled();
  } finally {
    await act(async () => reply.resolve(status()));
  }
});

it.each([
  { label: 'native unavailable', error: 'unavailable' },
  { label: 'lost transport reply', error: new Error('lost reply') },
])(
  'managed_settings_unknown_add_survives_full_consumer_teardown_after_$label',
  async ({ error }) => {
    vi.mocked(accountBackend.managedConnectionAdd).mockRejectedValueOnce(error);
    const first = render(<SettingsPage />);
    openAccounts();
    draft('alice');
    add();
    await unknownFeedback();
    first.unmount();
    render(<SettingsPage />);
    openAccounts();
    const retainedDraft = (
      within(managed()).getByRole('textbox', { name: 'GitHub login' }) as HTMLInputElement
    ).value;
    draft('alice');
    await act(async () => add());
    expect(accountBackend.managedConnectionAdd).toHaveBeenCalledExactlyOnceWith(
      'github.com',
      'alice',
    );
    expect(retainedDraft).toBe('alice');
    await unknownFeedback();

    // A failed explicit read must preserve that same app-session barrier.
    vi.mocked(accountBackend.managedConnections).mockRejectedValueOnce('unavailable');
    fireEvent.click(within(managed()).getByRole('button', { name: 'Refresh managed accounts' }));
    expect(await within(managed()).findByTestId('section-unavailable', {}, budget)).toBeTruthy();
    add();
    expect(accountBackend.managedConnectionAdd).toHaveBeenCalledTimes(1);
    await unknownFeedback();

    vi.mocked(accountBackend.managedConnections).mockResolvedValue(page([status()]));
    fireEvent.click(within(managed()).getByRole('button', { name: 'Refresh managed accounts' }));
    expect(await within(managed()).findByRole('button', { name: 'alice' }, budget)).toBeTruthy();
    expect(accountBackend.managedConnectionAdd).toHaveBeenCalledTimes(1);
    expect(accountBackend.managedConnectionDisable).not.toHaveBeenCalled();
  },
);

it('managed_settings_unknown_disable_survives_full_consumer_teardown_until_original_account_refresh', async () => {
  vi.mocked(accountBackend.managedConnections).mockResolvedValue(page([status()]));
  vi.mocked(accountBackend.managedConnectionDisable).mockRejectedValueOnce('unavailable');
  const first = render(<SettingsPage />);
  openAccounts();
  const original = await selectAccount();
  fireEvent.click(
    await within(original).findByRole('button', { name: 'Disable in Cerebro' }, budget),
  );
  await unknownFeedback();
  first.unmount();
  render(<SettingsPage />);
  openAccounts();
  fireEvent.click(within(managed()).getByRole('button', { name: 'Refresh managed accounts' }));
  const current = await selectAccount();
  await within(current).findByText('Sign in required', {}, budget);
  // Selecting a row reads it, but does not replace explicit reconciliation.
  await act(async () => {
    fireEvent.click(within(current).getByRole('button', { name: 'Disable in Cerebro' }));
  });
  expect(accountBackend.managedConnectionDisable).toHaveBeenCalledExactlyOnceWith(aliceId, 1);
  await unknownFeedback();

  vi.mocked(accountBackend.managedConnectionStatus).mockRejectedValueOnce('unavailable');
  fireEvent.click(within(current).getByRole('button', { name: 'Refresh account status' }));
  expect(await within(current).findByTestId('section-unavailable', {}, budget)).toBeTruthy();
  draft('bob');
  add();
  expect(accountBackend.managedConnectionAdd).not.toHaveBeenCalled();
  await unknownFeedback();

  vi.mocked(accountBackend.managedConnectionStatus).mockResolvedValue({
    ...status(),
    revision: 2,
    health: 'disabled',
    revocationGeneration: 1,
  });
  fireEvent.click(within(current).getByRole('button', { name: 'Refresh account status' }));
  await within(current).findByText(/^disabled(?: in Cerebro)?$/i, {}, budget);
  expect(accountBackend.managedConnectionDisable).toHaveBeenCalledTimes(1);
  expect(accountBackend.managedConnectionAdd).not.toHaveBeenCalled();
});

it.each([
  { route: 'alice again', viaBob: false, arrival: 'before confirmation', staleFirst: true },
  { route: 'alice again', viaBob: false, arrival: 'after confirmation', staleFirst: false },
  { route: 'bob then alice', viaBob: true, arrival: 'before confirmation', staleFirst: true },
  { route: 'bob then alice', viaBob: true, arrival: 'after confirmation', staleFirst: false },
])(
  'managed_settings_confirmed_disable_wins_after_selecting [$route] with old status [$arrival]',
  async ({ viaBob, staleFirst }) => {
    const reply = deferred<ConnectionStatus>();
    const oldStatus = deferred<ConnectionStatus>();
    const confirmed: ConnectionStatus = {
      ...status(),
      revision: 2,
      health: 'disabled',
      revocationGeneration: 1,
    };
    let aliceReads = 0;
    vi.mocked(accountBackend.managedConnections).mockResolvedValue(
      page([status(), status('bob', bobId)]),
    );
    vi.mocked(accountBackend.managedConnectionStatus).mockImplementation((id) => {
      if (id === bobId) return Promise.resolve(status('bob', bobId));
      aliceReads += 1;
      if (aliceReads === 1) return Promise.resolve(status());
      if (aliceReads === 2) return oldStatus.promise;
      // A repair may choose a fresh read rather than publishing the confirmed row.
      return Promise.resolve(confirmed);
    });
    vi.mocked(accountBackend.managedConnectionDisable).mockReturnValueOnce(reply.promise);
    render(<SettingsPage />);
    try {
      openAccounts();
      const original = await selectAccount();
      fireEvent.click(
        await within(original).findByRole('button', { name: 'Disable in Cerebro' }, budget),
      );
      await waitFor(() => expect(accountBackend.managedConnectionDisable).toHaveBeenCalledTimes(1));
      if (viaBob) {
        const other = await selectAccount('bob');
        await within(other).findByText('Sign in required', {}, budget);
      }
      const selectedAgain = await selectAccount();
      await waitFor(() => expect(aliceReads).toBe(2));
      if (staleFirst) {
        await act(async () => oldStatus.resolve(status()));
        await within(selectedAgain).findByText('Sign in required', {}, budget);
      }
      await act(async () => reply.resolve(confirmed));
      await within(selectedAgain).findByText(/^disabled(?: in Cerebro)?$/i, {}, budget);
      if (!staleFirst) await act(async () => oldStatus.resolve(status()));
      const final = within(managed()).getByRole('group', { name: 'Managed account alice' });
      expect(within(final).getByText(/^disabled(?: in Cerebro)?$/i)).toBeTruthy();
      expect(within(final).queryByText('Sign in required')).toBeNull();
      expect(within(final).queryByRole('button', { name: 'Disable in Cerebro' })).toBeNull();
      expect(accountBackend.managedConnectionDisable).toHaveBeenCalledExactlyOnceWith(aliceId, 1);
      expect(accountBackend.managedConnectionAdd).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        oldStatus.resolve(status());
        reply.resolve(confirmed);
      });
    }
  },
);

it.each([
  { settlement: 'detached confirmation', unavailable: false },
  { settlement: 'unavailable acknowledgement', unavailable: true },
])(
  'managed_settings_precommit_catalog_head_cannot_reconcile_add_after [$settlement]',
  async ({ unavailable }) => {
    const reply = deferred<ConnectionStatus>();
    const carolId = 'c'.repeat(32);
    const mutationReply = unavailable
      ? reply.promise.then(() => Promise.reject('unavailable'))
      : reply.promise;
    vi.mocked(accountBackend.managedConnectionAdd).mockReturnValueOnce(mutationReply);
    vi.mocked(accountBackend.managedConnections)
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page([status('bob', bobId)], bobId))
      .mockResolvedValueOnce(page([status('carol', carolId)]))
      .mockRejectedValueOnce('unavailable')
      .mockResolvedValueOnce(page([status()], aliceId))
      .mockResolvedValueOnce(page([status('bob', bobId)], bobId))
      .mockResolvedValueOnce(page([status('carol', carolId)]));
    const first = render(<SettingsPage />);
    try {
      openAccounts();
      await within(managed()).findByText(/no managed accounts/i, {}, budget);
      draft('alice');
      add();
      await waitFor(() => expect(accountBackend.managedConnectionAdd).toHaveBeenCalledTimes(1));
      first.unmount();
      render(<SettingsPage />);
      openAccounts();
      // This automatic head lands before the Add settles. Its b… cursor skips
      // the new a… connection if reused after the commit.
      expect(await within(managed()).findByRole('button', { name: 'bob' }, budget)).toBeTruthy();
      expect(accountBackend.managedConnections).toHaveBeenNthCalledWith(2, null);
      await act(async () => reply.resolve(status()));
      await unknownFeedback();
      fireEvent.click(within(managed()).getByRole('button', { name: 'Load more accounts' }));
      expect(await within(managed()).findByRole('button', { name: 'carol' }, budget)).toBeTruthy();
      expect(accountBackend.managedConnections).toHaveBeenNthCalledWith(3, bobId);
      expect(within(managed()).queryByRole('button', { name: 'alice' })).toBeNull();
      await act(async () => add());
      expect(accountBackend.managedConnectionAdd).toHaveBeenCalledExactlyOnceWith(
        'github.com',
        'alice',
      );
      expect(
        (
          within(managed()).getByRole('button', {
            name: 'Add account selection',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      await unknownFeedback();

      // A failed replacement head cannot certify the old head or release the lock.
      fireEvent.click(within(managed()).getByRole('button', { name: 'Refresh managed accounts' }));
      expect(await within(managed()).findByTestId('section-unavailable', {}, budget)).toBeTruthy();
      add();
      expect(accountBackend.managedConnectionAdd).toHaveBeenCalledTimes(1);
      await unknownFeedback();

      // Only the complete new walk includes the newly committed ID before b… .
      fireEvent.click(within(managed()).getByRole('button', { name: 'Refresh managed accounts' }));
      expect(await within(managed()).findByRole('button', { name: 'alice' }, budget)).toBeTruthy();
      expect(
        (
          within(managed()).getByRole('button', {
            name: 'Add account selection',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      fireEvent.click(within(managed()).getByRole('button', { name: 'Load more accounts' }));
      expect(await within(managed()).findByRole('button', { name: 'bob' }, budget)).toBeTruthy();
      expect(
        (
          within(managed()).getByRole('button', {
            name: 'Add account selection',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      await unknownFeedback();
      fireEvent.click(within(managed()).getByRole('button', { name: 'Load more accounts' }));
      expect(await within(managed()).findByRole('button', { name: 'carol' }, budget)).toBeTruthy();
      expect(within(managed()).getByRole('button', { name: 'alice' })).toBeTruthy();
      expect(within(managed()).getByRole('button', { name: 'bob' })).toBeTruthy();
      expect(
        (
          within(managed()).getByRole('button', {
            name: 'Add account selection',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
      expect(
        vi.mocked(accountBackend.managedConnections).mock.calls.map(([cursor]) => cursor),
      ).toEqual([null, null, bobId, null, null, aliceId, bobId]);
      expect(accountBackend.managedConnectionAdd).toHaveBeenCalledTimes(1);
      expect(accountBackend.managedConnectionDisable).not.toHaveBeenCalled();
    } finally {
      await act(async () => reply.resolve(status()));
    }
  },
);

it.each([
  { settlement: 'detached confirmation', unavailable: false },
  { settlement: 'unavailable acknowledgement', unavailable: true },
])(
  'managed_settings_postsettlement_automatic_head_can_reconcile_add_after [$settlement]',
  async ({ unavailable }) => {
    const reply = deferred<ConnectionStatus>();
    const carolId = 'c'.repeat(32);
    const mutationReply = unavailable
      ? reply.promise.then(() => Promise.reject('unavailable'))
      : reply.promise;
    vi.mocked(accountBackend.managedConnectionAdd).mockReturnValueOnce(mutationReply);
    vi.mocked(accountBackend.managedConnections)
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(page([status()], aliceId))
      .mockResolvedValueOnce(page([status('bob', bobId), status('carol', carolId)]));
    const first = render(<SettingsPage />);
    try {
      openAccounts();
      await within(managed()).findByText(/no managed accounts/i, {}, budget);
      draft('alice');
      add();
      await waitFor(() => expect(accountBackend.managedConnectionAdd).toHaveBeenCalledTimes(1));
      first.unmount();
      // Same app session and same mutation, but this head starts after settlement.
      await act(async () => reply.resolve(status()));
      render(<SettingsPage />);
      openAccounts();
      expect(await within(managed()).findByRole('button', { name: 'alice' }, budget)).toBeTruthy();
      expect(
        (
          within(managed()).getByRole('button', {
            name: 'Add account selection',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      await unknownFeedback();
      fireEvent.click(within(managed()).getByRole('button', { name: 'Load more accounts' }));
      expect(await within(managed()).findByRole('button', { name: 'bob' }, budget)).toBeTruthy();
      expect(within(managed()).getByRole('button', { name: 'carol' })).toBeTruthy();
      expect(within(managed()).getByRole('button', { name: 'alice' })).toBeTruthy();
      expect(
        (
          within(managed()).getByRole('button', {
            name: 'Add account selection',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
      expect(
        vi.mocked(accountBackend.managedConnections).mock.calls.map(([cursor]) => cursor),
      ).toEqual([null, null, aliceId]);
      expect(accountBackend.managedConnectionAdd).toHaveBeenCalledExactlyOnceWith(
        'github.com',
        'alice',
      );
      expect(accountBackend.managedConnectionDisable).not.toHaveBeenCalled();
    } finally {
      await act(async () => reply.resolve(status()));
    }
  },
);
