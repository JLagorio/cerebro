import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
vi.mock('@/lib/ipc', { spy: true });
import * as ipc from '@/lib/ipc';
import { __seedMailGate, resetMockFs } from '@/lib/mockIpc';
import { addDays, toIsoDate } from '@/engine/dates';
import { useVaultStore } from '@/stores/vaultStore';
import { chooseOption, optionLabels } from '@/test/chooseOption';
import { MailSettings } from './MailSettings';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
beforeEach(async () => {
  vi.clearAllMocks();
  resetMockFs();
  await useVaultStore.getState().openVault('/demo-vault');
});
afterEach(cleanup);
it('shows the closed gate and the measured empty cache', async () => {
  render(<MailSettings />);
  expect((await screen.findByTestId('mail-gate')).textContent).toContain(
    'No run can save mail digests until it is enabled.',
  );
  expect((await screen.findByTestId('mail-cached')).textContent).toBe('No mail cached.');
  expect(screen.getByText('Kept out of git: sources/mail/ and comments on it.')).toBeTruthy();
});
it.each(['open', 'other_vault'] as const)(
  'reads a %s gate from the native-shaped seam',
  async (state) => {
    __seedMailGate({ state, kinds: ['thread', 'thread_text'] });
    render(<MailSettings />);
    expect((await screen.findByTestId('mail-gate')).getAttribute('data-state')).toBe(state);
    expect(screen.getByTestId('mail-gate').textContent).toContain(
      state === 'open' ? 'Message text only when you ask' : 'enabled for a different vault',
    );
  },
);
it('counts readable digests, says missing fetch time, and lists legacy copies', async () => {
  fs().set('sources/mail/a.md', '---\ntype: Source\nsource_kind: thread\nsource_id: a\n---\n# A\n');
  fs().set('sources/mail/bad.md', '---\nbad: [\n---\n# Bad\n');
  fs().set(
    'sources/web/old.md',
    '---\nsource_kind: web\nsource_id: https://mail.google.com/mail/old\n---\n# Old mail copy\n',
  );
  render(<MailSettings />);
  expect((await screen.findByTestId('mail-cached')).textContent).toBe(
    '1 thread cached, fetch time not recorded. 1 could not be read.',
  );
  expect((await screen.findByTestId('mail-legacy')).textContent).toContain('Old mail copy');
});
it('a gate failure leaves the successful cache count visible', async () => {
  vi.mocked(ipc.mailGateRead).mockRejectedValueOnce(new Error('store unavailable'));
  render(<MailSettings />);
  expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
    'Mail gate could not be read',
  );
  expect((await screen.findByTestId('mail-cached')).textContent).toBe('No mail cached.');
});
it('a text page without its digest never reads as an empty mail cache', async () => {
  fs().set('sources/mail/a-text.md', '---\nsource_kind: thread_text\nsource_id: a\n---\n# Text\n');
  render(<MailSettings />);
  expect((await screen.findByTestId('mail-cached')).textContent).toBe(
    'No thread digests cached; other mail pages remain.',
  );
});
it('a failed cache read is unavailable, never an empty cache', async () => {
  vi.mocked(ipc.scanVault).mockRejectedValueOnce(new Error('permission denied'));
  render(<MailSettings />);
  expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
    'Cached mail could not be read',
  );
  expect(screen.queryByTestId('mail-cached')).toBeNull();
  expect(await screen.findByTestId('mail-gate')).toBeTruthy();
});
it.each(['closed', 'other_vault'] as const)(
  'keeps Add disabled for a %s gate and explains why',
  async (state) => {
    __seedMailGate({ state, kinds: ['thread'] });
    render(<MailSettings />);
    await screen.findByTestId('mail-gate');
    const add = screen.getByRole('button', { name: 'Add Mail sweep' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    expect(add.title).toBe(
      state === 'closed'
        ? 'Mail caching is not enabled in this build.'
        : 'Mail caching is not enabled for this vault.',
    );
  },
);
it('an open gate offers a scoped sweep, and connector failure is local to its row', async () => {
  __seedMailGate({ state: 'open', kinds: ['thread'] });
  vi.mocked(ipc.connectorStatus).mockResolvedValueOnce([
    {
      connector: 'gmail',
      cli_name: 'gmail',
      refused: null,
      state: 'needs_sign_in',
      signal: null,
      seen_at: null,
      run_id: null,
    },
  ]);
  render(<MailSettings />);
  await screen.findByText('Never swept · needs sign-in');
  expect(
    (screen.getByRole('button', { name: 'Add Mail sweep' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  cleanup();
  vi.mocked(ipc.connectorStatus).mockRejectedValueOnce(new Error('status unavailable'));
  render(<MailSettings />);
  expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
    'Mail connector status could not be read',
  );
  expect(await screen.findByTestId('mail-cached')).toBeTruthy();
});
it('choosing another connector reads that connector’s sweep status', async () => {
  const row = { cli_name: 'gmail', refused: null, signal: null, seen_at: null, run_id: null };
  vi.mocked(ipc.connectorStatus).mockResolvedValueOnce([
    { ...row, connector: 'gmail', state: 'needs_sign_in' },
    { ...row, connector: 'work-mail', cli_name: 'work-mail', state: 'working' },
  ]);
  render(<MailSettings />);
  await screen.findByText('Never swept · needs sign-in');
  const connector = screen.getByRole('button', { name: 'Gmail connector' });
  expect(optionLabels(connector)).toEqual(['gmail', 'work-mail']);
  chooseOption(connector, 'work-mail');
  expect(connector.getAttribute('data-value')).toBe('work-mail');
  expect(screen.getByText('Never swept · connector working')).toBeTruthy();
});
it('with no connectors the connector select says so and cannot open', async () => {
  vi.mocked(ipc.connectorStatus).mockResolvedValueOnce([]);
  render(<MailSettings />);
  const connector = await screen.findByRole('button', { name: 'Gmail connector' });
  expect((connector as HTMLButtonElement).disabled).toBe(true);
  expect(connector.textContent).toBe('No connectors configured');
});
it('the retention window re-plans what Remove takes', async () => {
  const sent = addDays(toIsoDate(new Date()), -60);
  fs().set(
    'sources/mail/recent.md',
    `---\nsource_kind: thread\nsource_id: recent\nlast_message_at: ${sent}T00:00:00Z\n---\n# Recent\n`,
  );
  render(<MailSettings />);
  await screen.findByText('Nothing older than 90 days.');
  const retention = screen.getByRole('button', { name: 'Mail retention window' });
  expect(retention.getAttribute('data-value')).toBe('90');
  expect(optionLabels(retention)).toEqual(['30 days', '90 days', '365 days']);
  chooseOption(retention, '30 days');
  expect(retention.getAttribute('data-value')).toBe('30');
  expect(screen.getByText('1 digest and 0 text pages go to Recently deleted.')).toBeTruthy();
});
it('previews retention as digest/text pairs and keeps unknown dates', async () => {
  fs().set(
    'sources/mail/a.md',
    '---\nsource_kind: thread\nsource_id: a\nlast_message_at: 2020-01-01T00:00:00Z\n---\n# A\n',
  );
  fs().set('sources/mail/a-text.md', '---\nsource_kind: thread_text\nsource_id: a\n---\n# Text\n');
  fs().set(
    'sources/mail/unknown.md',
    '---\nsource_kind: thread\nsource_id: unknown\n---\n# No date\n',
  );
  render(<MailSettings />);
  await screen.findByText('1 digest and 1 text page go to Recently deleted.');
  expect(screen.getByText('1 digest without a recorded message date stays.')).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Remove cached mail' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});
