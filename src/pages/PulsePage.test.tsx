// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/gitIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitIpc')>();
  return {
    ...actual,
    getVaultPulse: vi.fn(async () => [
      {
        hash: 'aaaaaaaaaaaa',
        shortHash: 'aaaaaaa',
        message: 'Update 2 notes in knowledge',
        author: 'assistant',
        date: '2026-08-01T09:00:00Z',
        added: 1,
        modified: 2,
        deleted: 0,
        files: [],
      },
    ]),
    getCommitDiff: vi.fn(async () => 'diff --git a b'),
  };
});

import { PulsePage } from '@/pages/PulsePage';
import { useVaultStore } from '@/stores/vaultStore';

afterEach(cleanup);

describe('PulsePage', () => {
  beforeEach(() => {
    useVaultStore.setState({ vaultPath: '/demo-vault', entries: [] });
  });

  const card = async () => (await screen.findAllByTestId('pulse-commit'))[0];

  // M15: the rail button says History and the status bar said History; a page
  // titled "Pulse" was a third name for the same destination.
  it('is titled History, in line with the rail that opens it', async () => {
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
});
