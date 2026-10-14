// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitCommit } from '@/engine/git';

vi.mock('@/lib/gitIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitIpc')>();
  return { ...actual, getFileHistory: vi.fn(async () => [] as GitCommit[]) };
});

import { GitHistoryPanel } from '@/git/GitHistoryPanel';
import { getFileHistory } from '@/lib/gitIpc';
import { useVaultStore } from '@/stores/vaultStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const commit = (hash: string): GitCommit => ({
  hash,
  shortHash: hash.slice(0, 7),
  message: `commit ${hash}`,
  author: 'Ana Rios',
  date: 1_753_700_000,
});

// M53.15: a failed read used to come back as [] and the block rendered
// nothing, which is exactly what a note with no history renders. The two
// are told apart now; a note with no commits still shows no chrome.
describe('GitHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVaultStore.setState({ vaultPath: '/demo-vault', entries: [] });
  });
  afterEach(cleanup);

  it('says a failed read under its heading', async () => {
    vi.mocked(getFileHistory).mockRejectedValueOnce(new Error('git log exited 128'));
    render(<GitHistoryPanel path="notes/plan.md" />);
    const block = await screen.findByTestId('git-history');
    expect(within(block).getByText('History')).toBeTruthy();
    expect(within(block).getByTestId('section-unavailable').textContent).toBe(
      "This note's history could not be read.",
    );
    expect(within(block).queryByTestId('git-commit')).toBeNull();
  });

  it('renders nothing for a note with no commits, once the read has landed', async () => {
    const read = deferred<GitCommit[]>();
    vi.mocked(getFileHistory).mockReturnValueOnce(read.promise);
    const { container } = render(<GitHistoryPanel path="notes/plan.md" />);
    await act(async () => read.resolve([]));
    expect(getFileHistory).toHaveBeenCalledWith('/demo-vault', 'notes/plan.md');
    expect(container.innerHTML).toBe('');
  });

  it('lists the commits it read', async () => {
    vi.mocked(getFileHistory).mockResolvedValueOnce([commit('aaaaaaaa'), commit('bbbbbbbb')]);
    render(<GitHistoryPanel path="notes/plan.md" />);
    const rows = await screen.findAllByTestId('git-commit');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('commit aaaaaaaa');
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });
});
