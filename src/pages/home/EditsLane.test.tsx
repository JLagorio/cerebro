import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { __seedActivity, resetMockFs } from '@/lib/mockIpc';
import { failNext } from '@/lib/mockFaults';
import { useVaultStore } from '@/stores/vaultStore';
import { useNavStore } from '@/stores/navStore';
import { VAULT_TODAY } from '@/lib/vaultToday';
import { EditsLane } from './EditsLane';
import type { ActivityWrite } from '@/engine/activity';

const props = { now: new Date(VAULT_TODAY), ctx: { today: '2026-07-28', weekStart: 0 as const } };
const path = 'delivery/how-we-schedule.md';
const write = (at = '2026-07-28T11:58:00Z'): Omit<ActivityWrite, 'content'> => ({
  kind: 'vault.write',
  path,
  to: null,
  actor: 'human:me',
  run_id: null,
  approved_by: null,
  first_at: at,
  at,
});
beforeEach(async () => {
  vi.setSystemTime(VAULT_TODAY);
  resetMockFs();
  await useVaultStore.getState().openVault('/demo-vault');
});
it('opens a recently edited page and names both recording limits', async () => {
  __seedActivity({ writes: [write()] });
  render(<EditsLane {...props} />);
  await screen.findByText('edited 1 time');
  expect(screen.getByText("Edits made outside Cerebro aren't listed.")).toBeTruthy();
  expect(screen.getByText("Edits before Tue, Jul 28, 2026 weren't recorded.")).toBeTruthy();
  fireEvent.click(screen.getByTestId('home-row').querySelector('button')!);
  expect(useNavStore.getState().selection).toMatchObject({ kind: 'doc', path });
  fireEvent.click(screen.getByRole('button', { name: 'Open History' }));
  expect(useNavStore.getState().selection).toEqual({ kind: 'pulse' });
});
it('a failed activity read is unavailable, never an empty claim', async () => {
  failNext('vault_activity');
  render(<EditsLane {...props} />);
  expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
    'Your recent edits could not be read',
  );
  expect(screen.queryByTestId('home-row')).toBeNull();
});
it('a successful empty window leaves no lane behind', async () => {
  __seedActivity({ writes: [write('2026-01-01T12:00:00Z')] });
  await act(async () => {
    render(<EditsLane {...props} />);
  });
  expect(screen.queryByTestId('home-lane')).toBeNull();
});
it('a write at the moment Home opens is included', async () => {
  __seedActivity({ writes: [write(new Date(VAULT_TODAY).toISOString())] });
  render(<EditsLane {...props} />);
  await screen.findByText('edited 1 time');
  expect(screen.getByText('Last few minutes')).toBeTruthy();
});
