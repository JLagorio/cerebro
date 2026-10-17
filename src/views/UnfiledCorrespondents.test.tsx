import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';
import { UnfiledCorrespondents } from './UnfiledCorrespondents';
const io = vi.hoisted(() => ({
  read: vi.fn(),
  create: vi.fn(),
  dismiss: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('@/lib/ipc', () => ({ mailDismissalsRead: io.read }));
vi.mock('@/app/correspondentActions', () => ({
  createCorrespondent: io.create,
  dismissCorrespondent: io.dismiss,
  restoreCorrespondent: io.restore,
}));
const type = makeEntry({
  path: 'types/person.md',
  title: 'Contact',
  type: 'Type',
  properties: { fields: { email: 'email' } },
});
const business = makeEntry({
  path: 'types/business.md',
  title: 'Business',
  type: 'Type',
  properties: { email_domain: 'domain', fields: { domain: 'text' } },
});
const thread = makeEntry({
  path: 'sources/mail/one.md',
  properties: {
    source_kind: 'thread',
    participants: ['newperson@initech.example', 'friend@gmail.com'],
    sent_to: ['newperson@initech.example', 'friend@gmail.com'],
    owner_addresses: ['me@our.example'],
    last_from: 'me@our.example',
    first_message_at: '2026-07-27T09:00:00Z',
    last_message_at: '2026-07-27T09:00:00Z',
    last_sent_at: '2026-07-27T09:00:00Z',
    needs_reply: false,
    message_count: 1,
  },
});
beforeEach(() => {
  io.read.mockReset().mockResolvedValue([]);
  io.create.mockReset().mockResolvedValue('page.md');
  io.dismiss.mockReset().mockResolvedValue(true);
  io.restore.mockReset().mockResolvedValue(true);
  useVaultStore.setState({
    vaultPath: '/vault',
    entriesVault: '/vault',
    entries: [type, business, thread],
    status: 'ready',
  });
});
afterEach(cleanup);
it('reads only on mount and offers people actions but no company for a personal address', async () => {
  expect(io.read).not.toHaveBeenCalled();
  render(<UnfiledCorrespondents typeName="Contact" onClose={() => {}} />);
  expect(await screen.findByText('friend@gmail.com')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Create page' })).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: 'Create company' })).toHaveLength(1);
  expect(screen.getByText(/personal address/)).toBeTruthy();
  expect(screen.getAllByText(/wrote in 1 thread/)).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Create company' }));
  await waitFor(() =>
    expect(io.create).toHaveBeenCalledWith('Contact', 'newperson@initech.example', true),
  );
});
it('keeps unreadable and empty facts apart and restores a dismissed address', async () => {
  io.read.mockResolvedValue([
    { kind: 'address', value: 'friend@gmail.com', dismissedAt: '2026-07-27T10:00:00Z' },
  ]);
  render(<UnfiledCorrespondents typeName="Contact" onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Show 1 dismissed' }));
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  await waitFor(() => expect(io.restore).toHaveBeenCalledWith('address', 'friend@gmail.com'));
  cleanup();
  io.read.mockRejectedValueOnce(new Error('disk'));
  render(<UnfiledCorrespondents typeName="Contact" onClose={() => {}} />);
  expect(await screen.findByTestId('section-unavailable')).toBeTruthy();
  expect(screen.queryByText('No unfiled correspondents.')).toBeNull();
});
it('a failed scan is unavailable and absent mail says no cache', async () => {
  useVaultStore.setState({ status: 'error' });
  render(<UnfiledCorrespondents typeName="Contact" onClose={() => {}} />);
  expect(await screen.findByTestId('section-unavailable')).toBeTruthy();
  cleanup();
  useVaultStore.setState({ status: 'ready', entries: [type] });
  render(<UnfiledCorrespondents typeName="Contact" onClose={() => {}} />);
  expect(await screen.findByText('No mail cached.')).toBeTruthy();
});
it('waits for the current vault scan even after dismissals have loaded', async () => {
  useVaultStore.setState({ status: 'scanning', entriesVault: null, entries: [] });
  render(<UnfiledCorrespondents typeName="Contact" onClose={() => {}} />);
  await act(async () => {});
  expect(io.read).toHaveBeenCalledWith('/vault');
  expect(screen.getByTestId('unfiled-correspondents').getAttribute('data-state')).toBe('loading');
  expect(screen.queryByText('No mail cached.')).toBeNull();
  await act(async () => {
    useVaultStore.setState({ status: 'ready', entriesVault: '/vault', entries: [type, thread] });
  });
  expect(await screen.findByText('friend@gmail.com')).toBeTruthy();
});
it('retires a pending read across a batched vault round trip and loads fresh dismissals', async () => {
  let finish!: (rows: []) => void;
  io.read.mockImplementationOnce(() => new Promise<[]>((resolve) => (finish = resolve)));
  render(<UnfiledCorrespondents typeName="Contact" onClose={() => {}} />);
  await act(async () => {
    useVaultStore.setState({ vaultPath: '/other' });
    useVaultStore.setState({ vaultPath: '/vault' });
  });
  await waitFor(() => expect(io.read).toHaveBeenCalledTimes(2));
  await act(async () => finish([]));
  expect(await screen.findByText('friend@gmail.com')).toBeTruthy();
});

it('a vault round trip clears busy while an old action stays retired', async () => {
  let finish!: (result: boolean) => void;
  io.dismiss.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finish = resolve)));
  render(<UnfiledCorrespondents typeName="Contact" onClose={() => {}} />);
  await screen.findByText('friend@gmail.com');
  fireEvent.click(screen.getAllByRole('button', { name: 'Not a person' })[0]);
  expect(
    (screen.getAllByRole('button', { name: 'Create page' })[0] as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => {
    useVaultStore.setState({ vaultPath: '/other' });
    useVaultStore.setState({ vaultPath: '/vault' });
  });
  await screen.findByText('friend@gmail.com');
  expect(
    (screen.getAllByRole('button', { name: 'Create page' })[0] as HTMLButtonElement).disabled,
  ).toBe(false);
  const calls = io.read.mock.calls.length;
  await act(async () => finish(true));
  expect(io.read).toHaveBeenCalledTimes(calls);
});
