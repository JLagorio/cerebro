// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitRun, FileCommit, ModifiedFile } from '@/engine/git';

vi.mock('@/lib/gitIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitIpc')>();
  return {
    ...actual,
    getFileHistory: vi.fn(async () => [] as FileCommit[]),
    commitRuns: vi.fn(async () => [] as CommitRun[]),
    isGitRepo: vi.fn(async () => true),
    getModifiedFiles: vi.fn(async () => [] as ModifiedFile[]),
    getConflictFiles: vi.fn(async () => [] as string[]),
    getConflictMode: vi.fn(async () => 'none' as const),
    gitRemoteStatus: vi.fn(async () => ({ hasRemote: false })),
  };
});

import { CommitRow, GitHistoryPanel, UncommittedRow } from '@/git/GitHistoryPanel';
import { resetGitState } from '@/git/useGit';
import { commitRuns, getFileHistory, isGitRepo } from '@/lib/gitIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const commit = (char: string, patch: Partial<FileCommit> = {}): FileCommit => ({
  hash: char.repeat(40),
  shortHash: char.repeat(7),
  message: `commit ${char}`,
  author: 'Ana Rios',
  date: 1_753_700_000,
  parent: null,
  previousAt: null,
  pathAt: 'notes/plan.md',
  previousPath: null,
  change: 'modified',
  ...patch,
});

const AGENT = makeEntry({
  path: 'records/agents/release-scout.md',
  title: 'Release scout',
  type: 'Agent',
  properties: { slug: 'release-scout' },
});

// M53.15: a failed read used to come back as [] and the block rendered
// nothing, which is exactly what a note with no history renders. M58.4: each
// row names who made it from the commit record alone. M64.2b: the page's
// History panel is history/PageHistory, which reuses CommitRow; this is the
// record peek's foot list.
describe('GitHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGitState();
    useVaultStore.setState({
      vaultPath: '/demo-vault',
      entries: [AGENT],
    });
    useUiStore.setState({ diffView: null });
  });
  afterEach(cleanup);

  it('says a failed read under its heading', async () => {
    vi.mocked(getFileHistory).mockRejectedValueOnce(new Error('git log exited 128'));
    render(<GitHistoryPanel path="notes/plan.md" />);
    const block = await screen.findByTestId('git-history');
    expect(within(block).getByText('History')).toBeTruthy();
    expect(within(block).getByTestId('section-unavailable').textContent).toBe(
      "This page's history could not be read.",
    );
    expect(within(block).queryByTestId('git-commit')).toBeNull();
  });

  it('renders nothing at the foot for a page with no commits, once the read has landed', async () => {
    const read = deferred<FileCommit[]>();
    vi.mocked(getFileHistory).mockReturnValueOnce(read.promise);
    const { container } = render(<GitHistoryPanel path="notes/plan.md" />);
    await act(async () => read.resolve([]));
    expect(getFileHistory).toHaveBeenCalledWith('/demo-vault', 'notes/plan.md');
    expect(container.innerHTML).toBe('');
  });

  it('keeps compact versions behind a keyboard disclosure without losing the version action', async () => {
    vi.mocked(getFileHistory).mockResolvedValueOnce([commit('a')]);
    render(<GitHistoryPanel path="notes/plan.md" compact />);
    const toggle = await screen.findByTestId('peek-history-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'commit a' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'commit a' }));
    expect(useUiStore.getState().diffView).toEqual({
      path: 'notes/plan.md',
      commit: 'a'.repeat(40),
    });
  });

  it('keeps a compact history read failure visible without requiring expansion', async () => {
    vi.mocked(getFileHistory).mockRejectedValueOnce(new Error('git log exited 128'));
    render(<GitHistoryPanel path="notes/plan.md" compact />);
    expect(await screen.findByTestId('section-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('peek-history-toggle')).toBeNull();
  });

  it('names a recorded run, says unattributed otherwise, and words each change', async () => {
    vi.mocked(getFileHistory).mockResolvedValueOnce([
      commit('a', { previousAt: '2026-10-13T09:00:00.000Z' }),
      commit('b', { previousPath: 'notes/old-plan.md', change: 'renamed' }),
      commit('c', { change: 'added' }),
    ]);
    vi.mocked(commitRuns).mockResolvedValueOnce([
      {
        hash: 'a'.repeat(40),
        run_id: 'run-scout-1',
        actor: 'process:release-scout',
        with_person: true,
        also_by: [],
      },
      {
        hash: 'c'.repeat(40),
        run_id: 'run-chat',
        actor: 'claude-code',
        with_person: false,
        also_by: [],
      },
    ]);
    render(<GitHistoryPanel path="notes/plan.md" />);
    await waitFor(() =>
      expect(screen.getAllByTestId('commit-author')[0].dataset.attributed).toBe('run'),
    );
    const authors = screen.getAllByTestId('commit-author');
    expect(authors.map((a) => a.textContent)).toEqual([
      'Release scout with your edits',
      'unattributed',
      'Assistant',
    ]);
    expect(authors[1].getAttribute('title')).toBe('Ana Rios');
    expect(screen.getAllByTestId('git-commit-change').map((c) => c.textContent)).toEqual([
      'renamed from old-plan.md',
      'created it',
    ]);
    expect(commitRuns).toHaveBeenCalledWith('/demo-vault', [
      { hash: 'a'.repeat(40), path: 'notes/plan.md', since: '2026-10-13T09:00:00.000Z' },
      { hash: 'b'.repeat(40), path: 'notes/plan.md', since: null },
      { hash: 'c'.repeat(40), path: 'notes/plan.md', since: null },
    ]);
  });

  it('says attribution unknown when the record could not be read', async () => {
    vi.mocked(getFileHistory).mockResolvedValueOnce([commit('a')]);
    vi.mocked(commitRuns).mockRejectedValueOnce(new Error('no runtime db'));
    render(<GitHistoryPanel path="notes/plan.md" />);
    await waitFor(() =>
      expect(screen.getByTestId('commit-author').dataset.attributed).toBe('unknown'),
    );
    expect(screen.getByTestId('commit-author').textContent).toBe('attribution unknown');
  });

  it('opens the version lens from a row', async () => {
    vi.mocked(getFileHistory).mockResolvedValueOnce([commit('a')]);
    render(<GitHistoryPanel path="notes/plan.md" />);
    const row = await screen.findByTestId('git-commit');
    fireEvent.click(within(row).getByRole('button', { name: 'commit a' }));
    expect(useUiStore.getState().diffView).toEqual({
      path: 'notes/plan.md',
      commit: 'a'.repeat(40),
    });
  });

  // M64.2b: the page's History panel is PageHistory now; it reuses these rows.
  describe('the rows it exports', () => {
    it('renders a CommitRow alone, with its author, its change and the lens', () => {
      render(
        <CommitRow
          commit={commit('d', { change: 'added' })}
          path="notes/plan.md"
          runs={{ kind: 'ready', data: [] }}
        />,
      );
      const row = screen.getByTestId('git-commit');
      expect(within(row).getByTestId('commit-author').textContent).toBe('unattributed');
      expect(within(row).getByTestId('git-commit-change').textContent).toBe('created it');
      fireEvent.click(within(row).getByRole('button', { name: 'commit d' }));
      expect(useUiStore.getState().diffView).toEqual({
        path: 'notes/plan.md',
        commit: 'd'.repeat(40),
      });
      expect(getFileHistory).not.toHaveBeenCalled();
    });

    it('opens the lens on uncommitted changes from the Not in history yet row', () => {
      render(<UncommittedRow path="notes/plan.md" />);
      const row = screen.getByTestId('git-uncommitted');
      expect(row.textContent).toContain('Not in history yet');
      fireEvent.click(within(row).getByRole('button'));
      expect(useUiStore.getState().diffView).toEqual({ path: 'notes/plan.md', commit: null });
    });

    it('leaves the foot list unchanged in a vault that keeps no history', async () => {
      vi.mocked(isGitRepo).mockResolvedValue(false);
      const read = deferred<FileCommit[]>();
      vi.mocked(getFileHistory).mockReturnValueOnce(read.promise);
      const { container } = render(<GitHistoryPanel path="notes/plan.md" />);
      await act(async () => read.resolve([]));
      expect(container.innerHTML).toBe('');
      vi.mocked(isGitRepo).mockResolvedValue(true);
    });
  });
});
