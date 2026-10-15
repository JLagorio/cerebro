import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import CASES from '../../src-tauri/fixtures/followup-cases.json';
import { makeEntry } from '@/engine/testHelpers';
import type { Followup } from '@/engine/followups';
import { useVaultStore } from '@/stores/vaultStore';
import { useFollowupStore } from '@/stores/followupStore';
import { FollowupList, followupWords } from './FollowupList';
const now = new Date(CASES.defaults.now);
const row = (patch: Partial<Followup> = {}): Followup => ({
  followupId: 'id',
  actor: 'process:scout',
  note: '[[link]] and <b>plain</b>',
  dueAt: now.toISOString(),
  requestedAt: now.toISOString(),
  requestedByRun: 'run',
  state: 'pending',
  claimedAt: null,
  runId: null,
  endedAt: null,
  cancelReason: null,
  ...patch,
});
beforeEach(() => {
  useVaultStore.setState({
    vaultPath: '/vault',
    entries: [
      makeEntry({
        type: 'Agent',
        title: 'Scout',
        path: 'agents/scout.md',
        properties: { slug: 'scout' },
      }),
    ],
  });
  useFollowupStore.getState().reset('/vault');
  useFollowupStore.setState({ read: { state: 'ready', rows: [] } });
});
it('a failed read is never the empty state', () => {
  useFollowupStore.setState({ read: { state: 'unavailable' } });
  render(<FollowupList />);
  expect(screen.getByTestId('followups-unavailable').textContent).toBe(
    "Couldn't read follow-ups, so this can't say what is waiting.",
  );
  expect(screen.queryByTestId('followup-row')).toBeNull();
});
it('empty and loading render nothing', () => {
  const { container, rerender } = render(<FollowupList />);
  expect(container.textContent).toBe('');
  act(() => useFollowupStore.setState({ read: { state: 'loading' } }));
  rerender(<FollowupList />);
  expect(container.textContent).toBe('');
});
it('sorts due rows and quotes notes literally, showing claimed and missing agents honestly', () => {
  useFollowupStore.setState({
    read: {
      state: 'ready',
      rows: [
        row({ followupId: 'later', dueAt: '2026-10-15T13:00:00Z' }),
        row({ followupId: 'first', state: 'claimed', actor: 'process:gone' }),
      ],
    },
  });
  const { container } = render(<FollowupList now={now} />);
  const rows = screen.getAllByTestId('followup-row');
  expect(rows[0].getAttribute('data-followup')).toBe('first');
  expect(rows[0].textContent).toContain('its agent is gone');
  expect(rows[0].textContent).toContain('starting');
  expect(within(rows[0]).queryByRole('button', { name: 'Cancel' })).toBeNull();
  expect(rows[1].textContent).toContain('"[[link]] and <b>plain</b>"');
  expect(container.querySelector('b,a')).toBeNull();
  expect(within(rows[1]).getByRole('button', { name: 'Cancel' })).toBeTruthy();
});
it('filters an agent page and cancels only its pending row', async () => {
  const cancel = vi.spyOn(useFollowupStore.getState(), 'cancel').mockResolvedValue(true);
  useFollowupStore.setState({
    read: { state: 'ready', rows: [row(), row({ followupId: 'other', actor: 'process:other' })] },
  });
  render(<FollowupList actor="process:scout" now={now} />);
  expect(screen.getAllByTestId('followup-row')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(cancel).toHaveBeenCalledWith('id'));
  cancel.mockRestore();
});
it('Cerebro cancellations are muted and keep the shared reasons', () => {
  for (const [cancelReason, words] of Object.entries(CASES.cancelWords))
    expect(
      followupWords(
        row({ state: 'cancelled', cancelReason: cancelReason as Followup['cancelReason'] }),
        now,
      ),
    ).toBe(words);
  useFollowupStore.setState({
    read: { state: 'ready', rows: [row({ state: 'cancelled', cancelReason: 'paused' })] },
  });
  render(<FollowupList now={now} />);
  expect(screen.getByTestId('followup-row').className).toContain('text-n-400');
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
});
