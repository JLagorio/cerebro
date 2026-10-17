import cases from '../../src-tauri/fixtures/pr-cases.json';
import type { PrRead } from '@/engine/pullRequest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/engine/testHelpers';
import * as ipc from '@/lib/ipc';
import { seedPullRequests } from '@/lib/mockGit';
import { useVaultStore } from '@/stores/vaultStore';
import { PullRequestStrip } from './PullRequestStrip';
const url = 'https://github.com/acme/notes/pull/1';
const entry = makeEntry({ path: 'work/one.md' });
beforeEach(() => {
  useVaultStore.setState({ vaultPath: '/demo-vault' });
  seedPullRequests({});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('omits property duplicates, caps visible body chips and reports the rest', async () => {
  vi.spyOn(ipc, 'readNoteSource').mockResolvedValue({
    hash: 'a',
    content: Array.from({ length: 11 }, (_, i) => url.replace('/1', `/${i + 1}`)).join('\n'),
  });
  render(
    <PullRequestStrip entry={{ ...entry, properties: { pr: url } }} schema={buildSchema([])} />,
  );
  await waitFor(() => expect(screen.getAllByTestId('pr-chip')).toHaveLength(8));
  expect(screen.getByTestId('pr-strip').textContent).toContain('and 2 more');
  expect(screen.queryByText('acme/notes#1')).toBeNull();
  expect(screen.queryByRole('button', { name: /Mark/ })).toBeNull();
});
it('distinguishes a failed body read from no PRs', async () => {
  const read = vi.spyOn(ipc, 'readNoteSource').mockRejectedValue(new Error('disk'));
  render(<PullRequestStrip entry={entry} schema={buildSchema([])} />);
  expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
    'could not be read',
  );
  cleanup();
  read.mockResolvedValue({ hash: 'a', content: '# No links' });
  render(<PullRequestStrip entry={entry} schema={buildSchema([])} />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(screen.queryByTestId('pr-strip')).toBeNull();
  expect(screen.queryByTestId('section-unavailable')).toBeNull();
});
it('never reads Knowledge and drops a late result after the owner changes', async () => {
  let finish!: (value: { hash: string; content: string }) => void;
  const read = vi.spyOn(ipc, 'readNoteSource').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { rerender } = render(
    <PullRequestStrip entry={{ ...entry, path: 'knowledge/a.md' }} schema={buildSchema([])} />,
  );
  expect(read).not.toHaveBeenCalled();
  rerender(<PullRequestStrip entry={entry} schema={buildSchema([])} />);
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  rerender(
    <PullRequestStrip entry={{ ...entry, path: 'knowledge/a.md' }} schema={buildSchema([])} />,
  );
  await act(async () => finish({ hash: 'a', content: url }));
  expect(screen.queryByTestId('pr-chip')).toBeNull();
});

it('counts case-equivalent property and body links once for a merged suggestion', async () => {
  const type = makeEntry({
    path: 'types/work.md',
    title: 'Work',
    type: 'Type',
    properties: { fields: { status: 'status' } },
  });
  const item = {
    ...entry,
    type: 'Work',
    properties: { status: 'todo', pr: 'https://github.com/Acme/Notes/pull/42' },
  };
  seedPullRequests({
    'https://github.com/acme/notes/pull/42': cases.cases.find((row) => row.name === 'merged')!
      .expect as PrRead,
  });
  vi.spyOn(ipc, 'readNoteSource').mockResolvedValue({
    hash: 'a',
    content: 'https://github.com/acme/notes/pull/42',
  });
  render(<PullRequestStrip entry={item} schema={buildSchema([type, item])} />);
  expect(await screen.findByRole('button', { name: 'Mark “Done”' })).toBeTruthy();
  expect(screen.queryByTestId('pr-chip')).toBeNull();
});
