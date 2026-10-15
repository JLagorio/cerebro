import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeLanes, HOME_COMPONENTS } from './HomeLanes';
import { HOME_LANES } from '@/engine/homeLanes';
import { useDoneMarksStore } from '@/stores/doneMarksStore';
import { useReminderStore } from '@/stores/reminderStore';
import { Lane } from './Lane';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { resetMockFs, __seedReview } from '@/lib/mockIpc';
import { failNext } from '@/lib/mockFaults';
import { VAULT_TODAY } from '@/lib/vaultToday';
import { makeEntry } from '@/test/factories';
import { useNavStore } from '@/stores/navStore';
import { readFileSync } from 'node:fs';

beforeEach(async () => {
  vi.setSystemTime(VAULT_TODAY);
  resetMockFs();
  useDoneMarksStore.getState().reset(null);
  useReminderStore.getState().reset(null);
  await useVaultStore.getState().openVault('/demo-vault');
  useUiStore.setState({ inboxEnabled: true, inboxPeriod: 'all', homeTaskAssignee: '' });
});
describe('Home lanes', () => {
  it('registers every declared lane', () => {
    expect(Object.keys(HOME_COMPONENTS).sort()).toEqual(HOME_LANES.map((lane) => lane.id).sort());
  });
  it('keeps the ordered lanes, opens a proposal page, and never decides on Home', async () => {
    render(<HomeLanes />);
    await waitFor(() =>
      expect(screen.getAllByTestId('home-lane').map((lane) => lane.dataset.lane)).toEqual([
        'mywork',
        'proposals',
        'runs',
        'captures',
        'changes',
        'edits',
        'comingup',
      ]),
    );
    const proposals = screen
      .getAllByTestId('home-lane')
      .find((lane) => lane.dataset.lane === 'proposals')!;
    fireEvent.click(proposals.querySelector('[data-testid="home-row"] button')!);
    expect(useNavStore.getState().selection.kind).toBe('doc');
    expect(proposals.querySelector('[data-testid="home-row-done"]')).toBeNull();
    for (const text of ['Approve', 'Reject', 'Allow'])
      expect(screen.queryByRole('button', { name: text })).toBeNull();
  });
  it('holds a failed queue apart from the work and captures that read successfully', async () => {
    failNext('review_queue');
    failNext('pending_writes');
    render(<HomeLanes />);
    await waitFor(() =>
      expect(screen.getByTestId('section-unavailable').textContent).toContain(
        'Waiting on you could not be read',
      ),
    );
    expect(screen.getAllByTestId('home-lane').map((lane) => lane.dataset.lane)).toContain(
      'captures',
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('home-lane').map((lane) => lane.dataset.lane)).toContain(
        'mywork',
      ),
    );
  });
  it('keeps an empty queue silent and honors Inbox being off', async () => {
    __seedReview({ cards: [] });
    useUiStore.setState({ inboxEnabled: false });
    render(<HomeLanes />);
    await waitFor(() =>
      expect(
        screen.queryAllByTestId('home-lane').some((lane) => lane.dataset.lane === 'mywork'),
      ).toBe(true),
    );
    expect(
      screen
        .queryAllByTestId('home-lane')
        .some((lane) => ['proposals', 'captures'].includes(lane.dataset.lane!)),
    ).toBe(false);
  });
  it('caps across sections, then reveals the remaining rows', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      subject: `p${index}`,
      path: `p${index}.md`,
      title: `Page ${index}`,
    }));
    render(
      <Lane
        id="captures"
        state="ready"
        data={{ rows, line: '12 captures to organize', notes: [] }}
        sections={[
          { key: 'a', label: 'First', order: 0, rows: rows.slice(0, 6) },
          { key: 'b', label: 'Second', order: 1, rows: rows.slice(6) },
        ]}
        door="Open Inbox"
        onDoor={() => {}}
      />,
    );
    expect(screen.getAllByTestId('home-row')).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 12' }));
    expect(screen.getAllByTestId('home-row')).toHaveLength(12);
  });
  it('names unknown capture times and keeps partially readable dates visible', async () => {
    useVaultStore.setState({ entries: [makeEntry({ path: 'untimed.md', createdAt: '' })] });
    render(<HomeLanes only="captures" />);
    expect(screen.getByText('When not recorded')).toBeTruthy();
  });
  it('never posts or requests an OS notification from a lane', () => {
    for (const name of [
      'HomeLanes',
      'Lane',
      'MyWorkLane',
      'ProposalsLane',
      'CapturesLane',
      'ComingUpLane',
      'EditsLane',
      'RunsLane',
      'RemindersLane',
      'ChangesLane',
    ])
      expect(readFileSync(`src/pages/home/${name}.tsx`, 'utf8')).not.toMatch(
        /\bNotification\b|requestPermission|sendNotification/,
      );
  });
});
