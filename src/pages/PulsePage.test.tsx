// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitRun, PulseCommit, VaultPulse } from '@/engine/git';

const { pulseCommit } = vi.hoisted(() => ({
  pulseCommit: (over: Partial<PulseCommit> = {}): PulseCommit => ({
    hash: 'a'.repeat(40),
    shortHash: 'aaaaaaa',
    message: 'Update 2 notes in knowledge',
    author: 'assistant',
    // 2026-08-01T09:00:00Z, in the Unix seconds Rust sends.
    date: 1_785_574_800,
    changes: { files: [], added: 1, modified: 2, deleted: 0 },
    ...over,
  }),
}));

vi.mock('@/lib/gitIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitIpc')>();
  return {
    ...actual,
    getVaultPulse: vi.fn(async (): Promise<VaultPulse> => ({
      tracked: true,
      commits: [pulseCommit()],
    })),
    getCommitDiff: vi.fn(async () => 'diff --git a b'),
    commitRuns: vi.fn(async () => [] as CommitRun[]),
  };
});

import { resetVaultActivity } from '@/history/vaultActivityStore';
import { commitRuns, getCommitDiff, getVaultPulse } from '@/lib/gitIpc';
import { failNext, resetFaults } from '@/lib/mockFaults';
import { resetMockFs } from '@/lib/mockIpc';
import { PulsePage } from '@/pages/PulsePage';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';

afterEach(() => {
  cleanup();
  resetFaults();
  resetVaultActivity();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('PulsePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockFs();
    useVaultStore.setState({ vaultPath: '/demo-vault', entries: [] });
  });

  const card = async () => (await screen.findAllByTestId('pulse-commit'))[0];

  // M15: the nav row says History and the status bar said History; a page
  // titled "Pulse" was a third name for the same destination.
  it('is titled History, in line with the nav row that opens it', async () => {
    render(<PulsePage />);
    expect(await screen.findByRole('heading', { name: 'History', level: 1 })).toBeTruthy();
  });

  // M15: the card is a bordered, padded, ~970px-wide target whose only live
  // pixel was the message string.
  it('opens the diff from anywhere on the card, not just the message', async () => {
    render(<PulsePage />);
    const commit = await card();
    fireEvent.click(await within(commit).findByText('unattributed'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('labels the change counters instead of leaving +1 / ~2 to be decoded', async () => {
    render(<PulsePage />);
    const commit = await card();
    expect(within(commit).getByLabelText('1 file added')).toBeTruthy();
    expect(within(commit).getByLabelText('2 files changed')).toBeTruthy();
  });

  // M64.2: the year and the feed, with checkpoints as their own rows.
  it('renders the heatmap and the feed, with the commit cards in it', async () => {
    render(<PulsePage />);
    expect(await screen.findByTestId('history-heatmap')).toBeTruthy();
    const feed = await screen.findByTestId('history-feed');
    expect(await within(feed).findAllByTestId('pulse-commit')).toHaveLength(1);
    expect(within(feed).getAllByTestId('history-session').length).toBeGreaterThan(0);
    expect(screen.getByTestId('pulse-page')).toBeTruthy();
  });

  // M53.15, M64.2: a failed `git log` is a line in the feed, never "No
  // history yet", and never a blank page: the activity still reads.
  it('says a failed checkpoint read in its line and tries again, while activity renders', async () => {
    vi.mocked(getVaultPulse).mockRejectedValueOnce(new Error('git log exited 128'));
    render(<PulsePage />);
    const feed = await screen.findByTestId('history-feed');
    const line = await within(feed).findByText('Checkpoints could not be read.');
    expect(line.dataset.lane).toBe('checkpoints');
    expect(within(feed).getAllByTestId('history-session').length).toBeGreaterThan(0);
    expect(
      screen.getByTestId('history-heatmap').querySelector('[data-testid="heatmap-day"]'),
    ).toBeTruthy();
    expect(screen.queryByText('No history yet')).toBeNull();

    fireEvent.click(screen.getByTestId('history-retry'));
    expect(await screen.findAllByTestId('pulse-commit')).toHaveLength(1);
    expect(getVaultPulse).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Checkpoints could not be read.')).toBeNull();
  });

  it('says a vault that keeps no checkpoints in a line, and the activity still reads', async () => {
    vi.mocked(getVaultPulse).mockResolvedValueOnce({ tracked: false, commits: [] });
    render(<PulsePage />);
    expect((await screen.findByTestId('history-untracked')).textContent).toBe(
      'This vault keeps no checkpoints. Turn history on in Settings to keep every version of every page.',
    );
    expect(screen.getAllByTestId('history-session').length).toBeGreaterThan(0);
    expect(screen.queryByText('History is off')).toBeNull();
  });

  it('offers Retry when activity fails, while the checkpoints still render', async () => {
    failNext('vault_activity');
    render(<PulsePage />);
    expect(await screen.findAllByTestId('pulse-commit')).toHaveLength(1);
    const lanes = screen.getAllByTestId('section-unavailable').map((l) => l.dataset.lane);
    expect(lanes).toEqual(['all', 'all']);
    expect(screen.queryByTestId('history-session')).toBeNull();

    fireEvent.click(screen.getByTestId('activity-retry'));
    expect(await screen.findAllByTestId('history-session')).not.toHaveLength(0);
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });

  it('says nothing in the feed before both reads land', async () => {
    const read = deferred<VaultPulse>();
    vi.mocked(getVaultPulse).mockReturnValueOnce(read.promise);
    render(<PulsePage />);
    await screen.findByTestId('history-heatmap');
    expect(screen.queryByTestId('history-feed')).toBeNull();

    await act(async () => read.resolve({ tracked: true, commits: [] }));
    expect(await screen.findByTestId('history-feed')).toBeTruthy();
  });

  it('says files unknown for a commit whose file list could not be read, never +0', async () => {
    vi.mocked(getVaultPulse).mockResolvedValueOnce({
      tracked: true,
      commits: [pulseCommit({ changes: null })],
    });
    render(<PulsePage />);
    const commit = await card();
    expect(within(commit).getByTestId('pulse-files-unknown').textContent).toBe('files unknown');
    expect(within(commit).queryByLabelText(/files? (added|changed|deleted)/)).toBeNull();
  });

  it('says a failed diff read could not be read, never "No changes."', async () => {
    vi.mocked(getCommitDiff).mockRejectedValueOnce(new Error('fatal: bad object'));
    render(<PulsePage />);
    fireEvent.click(await within(await card()).findByText('unattributed'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('section-unavailable')).toBeTruthy();
    expect(within(dialog).queryByText('No changes.')).toBeNull();
  });

  it('shows nothing in the dialog while the diff is out', async () => {
    const read = deferred<string>();
    vi.mocked(getCommitDiff).mockReturnValueOnce(read.promise);
    render(<PulsePage />);
    fireEvent.click(await within(await card()).findByText('unattributed'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('No changes.')).toBeNull();
    expect(within(dialog).queryByTestId('diff-view')).toBeNull();

    await act(async () => read.resolve('diff --git a/x b/x\n+added line'));
    expect(within(dialog).getByTestId('diff-view')).toBeTruthy();
  });

  // M58.4 (CV-35): the History page reads who made a commit as the page's
  // History tab does, from the commit record alone.
  describe('attribution', () => {
    const scout = makeEntry({
      path: 'records/agents/release-scout.md',
      title: 'Release scout',
      type: 'Agent',
      properties: { slug: 'release-scout' },
    });

    it('names the agent of a recorded commit, and unattributed otherwise', async () => {
      useVaultStore.setState({ vaultPath: '/demo-vault', entries: [scout] });
      vi.mocked(getVaultPulse).mockResolvedValueOnce({
        tracked: true,
        commits: [pulseCommit(), pulseCommit({ hash: 'b'.repeat(40), shortHash: 'bbbbbbb' })],
      });
      vi.mocked(commitRuns).mockResolvedValueOnce([
        {
          hash: 'a'.repeat(40),
          run_id: 'run-scout-1',
          actor: 'process:release-scout',
          with_person: null,
          also_by: [],
        },
      ]);
      render(<PulsePage />);
      const cards = await screen.findAllByTestId('pulse-commit');
      expect(await within(cards[0]).findByText('Release scout')).toBeTruthy();
      expect(within(cards[1]).getByTestId('commit-author').textContent).toBe('unattributed');
      expect(commitRuns).toHaveBeenCalledWith('/demo-vault', [
        { hash: 'a'.repeat(40), path: null, since: null },
        { hash: 'b'.repeat(40), path: null, since: null },
      ]);
    });

    it('says attribution unknown when the record could not be read', async () => {
      vi.mocked(commitRuns).mockRejectedValueOnce(new Error('no runtime db'));
      render(<PulsePage />);
      const commit = await card();
      expect((await within(commit).findByText('attribution unknown')).dataset.attributed).toBe(
        'unknown',
      );
    });
  });
});
