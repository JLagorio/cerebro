// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PulseCommit, VaultPulse } from '@/engine/git';

const { pulseCommit } = vi.hoisted(() => ({
  pulseCommit: (over: Partial<PulseCommit> = {}): PulseCommit => ({
    hash: 'aaaaaaaaaaaa',
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
  };
});

import { getCommitDiff, getVaultPulse } from '@/lib/gitIpc';
import { PulsePage } from '@/pages/PulsePage';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

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
    fireEvent.click(within(commit).getByText('assistant'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('labels the change counters instead of leaving +1 / ~2 to be decoded', async () => {
    render(<PulsePage />);
    const commit = await card();
    expect(within(commit).getByLabelText('1 file added')).toBeTruthy();
    expect(within(commit).getByLabelText('2 files changed')).toBeTruthy();
  });

  // M53.15: a failed `git log` used to land as [] and read "No history yet" —
  // a statement about the vault that nobody had been able to make.
  it('says a failed read could not be read, never "No history yet", and tries again', async () => {
    vi.mocked(getVaultPulse).mockRejectedValueOnce(new Error('git log exited 128'));
    render(<PulsePage />);
    expect(await screen.findByTestId('section-unavailable')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'History', level: 1 })).toBeTruthy();
    expect(screen.queryByText('No history yet')).toBeNull();

    fireEvent.click(screen.getByTestId('history-retry'));
    expect(await screen.findAllByTestId('pulse-commit')).toHaveLength(1);
    expect(getVaultPulse).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });

  it('says History is off for a vault that is not tracked, and offers no button', async () => {
    vi.mocked(getVaultPulse).mockResolvedValueOnce({ tracked: false, commits: [] });
    render(<PulsePage />);
    expect(await screen.findByText('History is off')).toBeTruthy();
    expect(screen.queryByText('No history yet')).toBeNull();
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says No history yet for a tracked vault with nothing committed', async () => {
    vi.mocked(getVaultPulse).mockResolvedValueOnce({ tracked: true, commits: [] });
    render(<PulsePage />);
    expect(await screen.findByText('No history yet')).toBeTruthy();
    expect(screen.getByText('Nothing has been committed in this vault yet.')).toBeTruthy();
    expect(screen.queryByText('History is off')).toBeNull();
  });

  it('says nothing at all before the read lands', async () => {
    const read = deferred<VaultPulse>();
    vi.mocked(getVaultPulse).mockReturnValueOnce(read.promise);
    const { container } = render(<PulsePage />);
    expect(container.textContent).toBe('');
    expect(screen.queryByText('No history yet')).toBeNull();

    await act(async () => read.resolve({ tracked: true, commits: [] }));
    expect(screen.getByText('No history yet')).toBeTruthy();
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
    fireEvent.click(within(await card()).getByText('assistant'));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByTestId('section-unavailable')).toBeTruthy();
    expect(within(dialog).queryByText('No changes.')).toBeNull();
  });

  it('shows nothing in the dialog while the diff is out', async () => {
    const read = deferred<string>();
    vi.mocked(getCommitDiff).mockReturnValueOnce(read.promise);
    render(<PulsePage />);
    fireEvent.click(within(await card()).getByText('assistant'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText('No changes.')).toBeNull();
    expect(within(dialog).queryByTestId('diff-view')).toBeNull();

    await act(async () => read.resolve('diff --git a/x b/x\n+added line'));
    expect(within(dialog).getByTestId('diff-view')).toBeTruthy();
  });
});
