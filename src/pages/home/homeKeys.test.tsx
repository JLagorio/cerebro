import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as ipc from '@/lib/ipc';
import { resetMockFs } from '@/lib/mockIpc';
import { VAULT_TODAY } from '@/lib/vaultToday';
import { useDoneMarksStore } from '@/stores/doneMarksStore';
import { useReminderStore } from '@/stores/reminderStore';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { useNavStore } from '@/stores/navStore';
import { HomeLanes } from './HomeLanes';

const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
const rows = () => screen.getAllByTestId('home-row');
const runs = () => rows().filter((row) => row.closest('[data-lane="runs"]'));
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.setSystemTime(VAULT_TODAY);
  resetMockFs();
  useDoneMarksStore.getState().reset(null);
  useReminderStore.getState().reset(null);
  await useVaultStore.getState().openVault('/demo-vault');
  useUiStore.setState({ inboxEnabled: true, inboxPeriod: 'all', homeTaskAssignee: '', toasts: [] });
  useNavStore.setState({ selection: { kind: 'home' } });
});
async function ready() {
  render(
    <>
      <HomeLanes />
      <input aria-label="Draft" />
    </>,
  );
  await waitFor(() => expect(runs().length).toBeGreaterThan(1));
  await waitFor(() =>
    expect(screen.getAllByTestId('home-row-done')[0].hasAttribute('disabled')).toBe(false),
  );
}
it('j/k cross lanes in DOM order, e on state rows passes, and Enter opens the page', async () => {
  await ready();
  const shown = rows();
  press('j');
  expect(document.activeElement).toBe(shown[0]);
  expect(press('e')).toBe(true);
  expect(useUiStore.getState().toasts).toHaveLength(0);
  const nextLane = shown.findIndex(
    (row) => row.closest('[data-lane]') !== shown[0].closest('[data-lane]'),
  );
  for (let i = 0; i < nextLane; i++) press('j');
  expect(document.activeElement).toBe(shown[nextLane]);
  press('k');
  expect(document.activeElement).toBe(shown[nextLane - 1]);
  act(() => shown[0].focus());
  press('Enter');
  expect(useUiStore.getState().detailPath).toBe(shown[0].dataset.subject);
});
it('e sends the rendered run revision, hides it, and moves focus to its successor', async () => {
  const data = await ipc.homeRuns('/demo-vault');
  const write = vi.spyOn(ipc, 'doneMark');
  await ready();
  const row = runs()[0];
  const subject = row.dataset.subject!;
  const next = rows()[rows().indexOf(row) + 1];
  const latest = data.runs
    .filter((run) => (run.actor ?? 'unattributed') === subject)
    .map((run) => run.ended_at!)
    .sort()
    .at(-1);
  act(() => row.focus());
  press('e');
  await waitFor(() => expect(row.isConnected).toBe(false));
  expect(write).toHaveBeenCalledWith('/demo-vault', {
    lane: 'run',
    subject,
    until: 'revision',
    revision: latest,
  });
  await waitFor(() => expect(document.activeElement).toBe(next));
  expect(useUiStore.getState().toasts.at(-1)?.message).toBe('Marked done');
});
it('selecting two runs and a state row marks only events with one toast', async () => {
  await ready();
  for (const row of [rows()[0], ...runs().slice(0, 2)]) {
    act(() => row.focus());
    press('x');
  }
  expect(screen.getByTestId('list-selection').textContent).toContain('3 selected · e marks done');
  press('e');
  await waitFor(() => expect(useUiStore.getState().toasts).toHaveLength(1));
  expect(useUiStore.getState().toasts[0].message).toBe('Marked 2 done');
  expect(screen.getByTestId('list-selection').textContent).toContain('1 selected');
});
it('unreadable marks keep e inert, and a focused field types it', async () => {
  await ready();
  const row = runs()[0];
  act(() => useDoneMarksStore.setState({ status: 'error' }));
  act(() => row.focus());
  const write = vi.spyOn(ipc, 'doneMark');
  expect(press('e')).toBe(true);
  expect(write).not.toHaveBeenCalled();
  const field = screen.getByRole('textbox', { name: 'Draft' });
  act(() => field.focus());
  expect(press('e')).toBe(true);
});
it('Show all rows join the cursor in their lane before the next lane', async () => {
  await ready();
  const lane = screen.getAllByTestId('home-lane').find((item) => item.dataset.lane === 'mywork')!;
  const initial = lane.querySelectorAll<HTMLElement>('[data-cursor-key]');
  expect(initial).toHaveLength(10);
  act(() => initial[9].focus());
  fireEvent.click(
    [...lane.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Show all '),
    )!,
  );
  const expanded = lane.querySelectorAll<HTMLElement>('[data-cursor-key]');
  expect(expanded.length).toBeGreaterThan(10);
  press('j');
  expect(document.activeElement).toBe(expanded[10]);
});
