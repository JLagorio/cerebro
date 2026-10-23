import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { __seedFleet, __seedChanges, __seedReminderFires, resetMockFs } from '@/lib/mockIpc';
import { demoFleetRuns, demoChanges } from '@/lib/demoOperational';
import { failNext } from '@/lib/mockFaults';
import { VAULT_TODAY } from '@/lib/vaultToday';
import { useDoneMarksStore } from '@/stores/doneMarksStore';
import { useReminderStore } from '@/stores/reminderStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { useNavStore } from '@/stores/navStore';
import { RunsLane } from './RunsLane';
import { ChangesLane } from './ChangesLane';
import { RemindersLane } from './RemindersLane';
const props = { now: new Date(VAULT_TODAY), ctx: { today: '2026-07-28', weekStart: 0 as const } };
const run = () => ({
  ...demoFleetRuns().find((run) => run.actor === 'process:release-scout')!,
  ended_at: '2026-07-28T11:30:00Z',
});
beforeEach(async () => {
  vi.setSystemTime(VAULT_TODAY);
  resetMockFs();
  useDoneMarksStore.getState().reset(null);
  useReminderStore.getState().reset(null);
  useUiStore.setState({ toast: vi.fn() });
  await useVaultStore.getState().openVault('/demo-vault');
});
it('shows why, opens the agent Runs tab, and restores the exact row with Undo', async () => {
  __seedFleet([run()]);
  render(<RunsLane {...props} />);
  await screen.findByText('1 run ended');
  expect(screen.getByTestId('run-why').textContent).toContain('its schedule came due');
  fireEvent.click(screen.getByTestId('home-row').querySelector('button')!);
  expect(useNavStore.getState().selection).toMatchObject({ kind: 'doc', tab: 'runs' });
  fireEvent.click(screen.getByTestId('home-row-done'));
  await waitFor(() => expect(screen.queryByTestId('home-row')).toBeNull());
  const action = vi.mocked(useUiStore.getState().toast).mock.calls.at(-1)![1]!.action!;
  await act(async () => action.run());
  await screen.findByTestId('home-row');
});
it("draws an agent's latest run as a trace line in its outcome's state (M91.14)", async () => {
  __seedFleet([{ ...run(), outcome: 'quota_failed' }]);
  render(<RunsLane {...props} />);
  await screen.findByText("1 run ended · 1 didn't succeed");
  const open = screen.getByTestId('home-row').querySelector('button')!;
  const line = open.querySelector('[data-slot="trace-line"]')!;
  expect(line.getAttribute('data-status')).toBe('error');
  // Its state before its name, its outcome after, and why under it.
  expect(open.textContent).toMatch(/^Quota failed: Release scoutquota failed/);
  expect(screen.getByTestId('run-why').closest('.cb-run-extra')).toBeTruthy();
  expect(screen.getByTestId('home-row-done').textContent).toBe('Done');
});
it('holds readable rows with disabled Done when marks cannot be read', async () => {
  __seedFleet([{ ...run(), cause: null }]);
  failNext('done_marks_read');
  render(<RunsLane {...props} />);
  await screen.findByText('why not recorded');
  expect((screen.getByTestId('home-row-done') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Done history could not be read/)).toBeTruthy();
  expect(screen.getByTestId('home-lane-line').textContent).not.toContain('since you looked');
});
it('a failed runs read leaves Knowledge changes standing', async () => {
  failNext('home_runs');
  render(
    <>
      <RunsLane {...props} />
      <ChangesLane {...props} />
    </>,
  );
  await screen.findByTestId('section-unavailable');
  await screen.findByText(/Knowledge changed since the last convergence run/);
  expect(screen.getAllByTestId('home-lane')).toHaveLength(2);
});
it('Knowledge expands its existing change lines, clears on Done, and returns on Undo', async () => {
  __seedChanges(demoChanges());
  render(<ChangesLane {...props} />);
  await screen.findByTestId('home-row');
  fireEvent.click(screen.getByTestId('home-row').querySelector('button')!);
  expect(screen.getAllByTestId('change-line').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByTestId('home-row-done'));
  await waitFor(() => expect(screen.queryByTestId('home-row')).toBeNull());
  const action = vi.mocked(useUiStore.getState().toast).mock.calls.at(-1)![1]!.action!;
  await act(async () => action.run());
  await screen.findByTestId('home-row');
});
it('no Knowledge ledger renders nothing', async () => {
  __seedChanges(null);
  await act(async () => {
    render(<ChangesLane {...props} />);
  });
  expect(screen.queryByTestId('home-lane')).toBeNull();
});
it('a missed reminder names the closure and its removed chip honestly', async () => {
  __seedReminderFires('/demo-vault', [
    {
      path: 'delivery/how-we-schedule.md',
      chip: '0123456789abcdef',
      ordinal: 0,
      fireAt: '2026-07-27T18:00',
      outcome: 'missed',
      claimedAt: '2026-07-28T11:58:00Z',
    },
  ]);
  render(<RemindersLane {...props} />);
  await screen.findByText('Passed while Cerebro was closed');
  expect(screen.getByText('A reminder in How we schedule (since removed)')).toBeTruthy();
  expect(screen.getByTestId('home-lane-line').textContent).toBe(
    '1 reminder · 1 passed while Cerebro was closed',
  );
});
