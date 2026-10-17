import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import cases from '../../src-tauri/fixtures/pr-cases.json';
import type { PrRead } from '@/engine/pullRequest';
import * as git from '@/lib/gitIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { PullRequestChip, PullRequestChipView } from './PullRequestChip';
const url = 'https://github.com/acme/notes/pull/1';
const passing = cases.cases[0].expect as PrRead;
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => useVaultStore.setState({ vaultPath: '/demo-vault' }));
it('keeps failed reads unknown, with the reason and refresh', () => {
  const refresh = vi.fn();
  render(
    <PullRequestChipView
      url={url}
      read={{ state: 'not_signed_in', checkedAt: 'now' }}
      onRefresh={refresh}
    />,
  );
  const chip = screen.getByTestId('pr-chip');
  expect(chip.dataset.readiness).toBe('checks_unknown');
  expect(chip.textContent).toContain('checks unknown');
  expect(chip.title).toContain('gh auth login');
  expect(chip.title).toContain('as of now from gh');
  expect(screen.getByRole('link').getAttribute('href')).toBe(url);
  fireEvent.click(screen.getByTestId('pr-chip-refresh'));
  expect(refresh).toHaveBeenCalledOnce();
});
it('counts both shapes and keeps merged independent of readiness', () => {
  if (passing.state !== 'read') throw new Error('fixture');
  const { rerender } = render(
    <PullRequestChipView url={url} read={passing} onRefresh={() => {}} />,
  );
  expect(screen.getByTestId('pr-chip').dataset.readiness).toBe('ready');
  rerender(
    <PullRequestChipView
      url={url}
      read={{ ...passing, pr: { ...passing.pr, state: 'MERGED' } }}
      onRefresh={() => {}}
    />,
  );
  expect(screen.getByTestId('pr-chip').dataset.readiness).toBe('none');
  expect(screen.getByTestId('pr-chip').textContent).toContain('merged');
});
it('retires an older URL read and a vault round trip', async () => {
  let finish!: (read: PrRead) => void;
  const mock = vi
    .spyOn(git, 'pullRequestState')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ state: 'gh_missing', checkedAt: 'later' });
  const { rerender } = render(<PullRequestChip url={url} />);
  await waitFor(() => expect(mock).toHaveBeenCalledOnce());
  rerender(<PullRequestChip url={url.replace('/1', '/2')} />);
  await waitFor(() => expect(screen.getByTestId('pr-chip').dataset.state).toBe('gh_missing'));
  await act(async () => finish(passing));
  expect(screen.getByTestId('pr-chip').dataset.state).toBe('gh_missing');
  cleanup();
  mock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<PullRequestChip url={url} />);
  act(() => {
    useVaultStore.setState({ vaultPath: '/other' });
    useVaultStore.setState({ vaultPath: '/demo-vault' });
  });
  await act(async () => finish(passing));
  expect(screen.getByTestId('pr-chip').dataset.readiness).toBe('checks_unknown');
});
it('clears an earlier success while refresh is pending and catches a rejected read', async () => {
  const mock = vi
    .spyOn(git, 'pullRequestState')
    .mockResolvedValueOnce(passing)
    .mockRejectedValueOnce(new Error('transport'));
  render(<PullRequestChip url={url} />);
  await waitFor(() => expect(screen.getByTestId('pr-chip').dataset.readiness).toBe('ready'));
  fireEvent.click(screen.getByTestId('pr-chip-refresh'));
  await waitFor(() => expect(screen.getByTestId('pr-chip').dataset.state).toBe('failed'));
  expect(mock).toHaveBeenLastCalledWith(url, true);
});
