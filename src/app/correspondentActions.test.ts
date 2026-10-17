import { beforeEach, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import {
  createCorrespondent,
  dismissCorrespondent,
  restoreCorrespondent,
} from './correspondentActions';
const io = vi.hoisted(() => ({ read: vi.fn(), dismiss: vi.fn(), restore: vi.fn() }));
vi.mock('@/lib/ipc', () => ({
  mailDismissalsRead: io.read,
  mailDismiss: io.dismiss,
  mailUndismiss: io.restore,
}));
const person = makeEntry({
  path: 'types/contact.md',
  title: 'Contact',
  type: 'Type',
  properties: {
    folder: 'people',
    fields: { email: 'email', company: { kind: 'relation', target: 'Business' } },
  },
});
const company = makeEntry({
  path: 'types/business.md',
  title: 'Business',
  type: 'Type',
  properties: { folder: 'companies', email_domain: 'domain', fields: { domain: 'text' } },
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
const create = vi.fn();
beforeEach(() => {
  io.read.mockReset().mockResolvedValue([]);
  io.dismiss.mockReset().mockResolvedValue(undefined);
  io.restore.mockReset().mockResolvedValue(undefined);
  create.mockReset().mockResolvedValue('created.md');
  useVaultStore.setState({
    vaultPath: '/vault',
    entriesVault: '/vault',
    entries: [person, company, thread],
    status: 'ready',
    createItem: create,
  });
  useUiStore.setState({ toasts: [] });
});
it('creates a page with its declared email and uniquely resolved company relation', async () => {
  const business = makeEntry({
    path: 'companies/initech.md',
    filename: 'initech.md',
    title: 'Initech',
    type: 'Business',
    properties: { domain: 'initech.example' },
  });
  useVaultStore.setState({ entries: [person, company, thread, business] });
  expect(await createCorrespondent('Contact', 'newperson@initech.example')).toBe('created.md');
  expect(create).toHaveBeenCalledWith({
    folder: 'people',
    slug: 'newperson',
    frontmatter: { type: 'Contact', email: 'newperson@initech.example', company: '[[initech]]' },
    body: '# newperson\n',
  });
});
it('creates a company only for an unfiled business domain with one capable Type', async () => {
  expect(await createCorrespondent('Contact', 'newperson@initech.example', true)).toBe(
    'created.md',
  );
  expect(create).toHaveBeenCalledWith({
    folder: 'companies',
    slug: 'initech',
    frontmatter: { type: 'Business', domain: 'initech.example' },
    body: '# Initech\n',
  });
  create.mockClear();
  expect(await createCorrespondent('Contact', 'friend@gmail.com', true)).toBeNull();
  expect(create).not.toHaveBeenCalled();
  useVaultStore.setState({
    entries: [person, company, { ...company, path: 'types/other.md', title: 'Other' }, thread],
  });
  expect(await createCorrespondent('Contact', 'newperson@initech.example', true)).toBeNull();
});
it('retires across a vault round trip and contains operational errors', async () => {
  io.read.mockImplementationOnce(async () => {
    useVaultStore.setState({ vaultPath: '/other' });
    useVaultStore.setState({ vaultPath: '/vault' });
    return [];
  });
  expect(await createCorrespondent('Contact', 'newperson@initech.example')).toBeNull();
  expect(create).not.toHaveBeenCalled();
  io.dismiss.mockRejectedValueOnce(new Error('disk'));
  await expect(dismissCorrespondent('address', 'friend@gmail.com')).resolves.toBe(false);
  expect(useUiStore.getState().toasts.at(-1)?.message).toBe('disk');
  expect(await restoreCorrespondent('address', 'friend@gmail.com')).toBe(true);
  expect(io.restore).toHaveBeenCalledWith('/vault', 'address', 'friend@gmail.com');
});
it('rechecks filing after reading dismissals and never duplicates an already filed person', async () => {
  useVaultStore.setState({
    entries: [
      person,
      company,
      thread,
      makeEntry({
        path: 'people/newperson.md',
        type: 'Contact',
        properties: { email: 'newperson@initech.example' },
      }),
    ],
  });
  expect(await createCorrespondent('Contact', 'newperson@initech.example')).toBeNull();
  expect(create).not.toHaveBeenCalled();
});

it('never claims success when the create door returns no path', async () => {
  create.mockResolvedValueOnce(null);
  expect(await createCorrespondent('Contact', 'newperson@initech.example')).toBeNull();
  expect(useUiStore.getState().toasts.some((row) => row.message.startsWith('Created'))).toBe(false);
});
