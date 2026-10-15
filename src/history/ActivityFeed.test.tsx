// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PulseCommit } from '@/engine/git';
import { LAB_NOW } from '@/lab/clock';
import { applyPreset, LAB_STATES, unmetExpectations } from '@/lab/presets';
import { section } from '@/lab/sections/historyFeed';
import { resetFaults } from '@/lib/mockFaults';
import { resetMockGit } from '@/lib/mockGit';
import { __seedActivity, __seedFleet, resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { DAYS_PER_REVEAL, HistoryFeedSection } from './ActivityFeed';
import { resetVaultActivity } from './vaultActivityStore';

/** The feed over the mock (M64.2), at the lab's clock and in UTC. */

const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'UTC';
  vi.setSystemTime(LAB_NOW);
});
afterAll(() => {
  vi.useRealTimers();
  process.env.TZ = originalTz;
});
afterEach(() => {
  cleanup();
  resetFaults();
  resetVaultActivity();
});

async function open(seed?: () => void): Promise<HTMLElement> {
  resetMockFs();
  resetMockGit();
  seed?.();
  await useVaultStore.getState().openVault('/demo-vault');
  render(<HistoryFeedSection />);
  return screen.findByTestId('history-feed');
}

const day = (key: string) =>
  document.querySelector<HTMLElement>(`[data-testid="history-day"][data-day="${key}"]`);

describe('ActivityFeed', () => {
  it.each(LAB_STATES)('renders its %s preset', async (state) => {
    await applyPreset(section, state);
    const { container } = render(<div>{section.render()}</div>);
    await waitFor(() =>
      expect(unmetExpectations(container, section.states[state].expect)).toEqual([]),
    );
  });

  it("tells the demo's days: your sessions, the runs with why and what they wrote", async () => {
    const feed = await open();
    const today = day('2026-07-28')!;
    const scout = within(today)
      .getAllByTestId('history-run')
      .find((r) => r.dataset.run === 'run-scout-1')!;
    expect(scout.textContent).toContain('Release scout ran');
    expect(scout.textContent).toContain('its schedule came due');
    expect(scout.textContent).toContain('wrote Scanner hardware delivery is slipping');
    // The run that applied nothing wrote no pages, measured.
    const assembly = within(today)
      .getAllByTestId('history-run')
      .find((r) => r.dataset.run === 'run-assembly-1')!;
    expect(assembly.textContent).toContain('wrote no pages');
    // A run from before writes were booked: not recorded, never none.
    const legacy = within(today)
      .getAllByTestId('history-run')
      .find((r) => r.dataset.run === 'run-legacy-1')!;
    expect(legacy.textContent).toContain('pages written: not recorded');
    const yours = within(day('2026-07-27')!).getAllByTestId('history-session');
    expect(yours.map((s) => s.textContent)).toEqual([
      'You edited Delivery',
      'You edited Warehouse rollback has never been rehearsed',
    ]);
    expect(within(day('2026-07-21')!).getByTestId('history-session').textContent).toBe(
      'Edited How we schedule · who was not recorded',
    );
    const gaps = within(feed).getAllByTestId('history-gap');
    expect(gaps.map((g) => [g.dataset.state, g.textContent])).toEqual(
      expect.arrayContaining([
        ['not-recorded', "Not recorded · Jul 25 – Jul 26 — Cerebro wasn't open"],
        ['empty', 'No edits or runs · Jul 22 – Jul 24'],
      ]),
    );
    expect(screen.getByTestId('history-outside').textContent).toBe(
      "Edits made outside Cerebro aren't recorded here; they show up only as checkpoints.",
    );
  });

  it('fails each lane alone, and says no gap while any lane is down', async () => {
    for (const [seed, lanes] of [
      [() => __seedFleet(null), ['runs']],
      [() => __seedActivity({ sessions: null }), ['app_sessions']],
      [() => __seedActivity({ writes: null }), ['writes', 'recording_since']],
    ] as const) {
      const feed = await open(seed);
      await waitFor(() =>
        expect(
          within(feed)
            .getAllByTestId('section-unavailable')
            .map((l) => l.dataset.lane),
        ).toEqual(lanes),
      );
      expect(within(feed).queryByTestId('history-gap')).toBeNull();
      expect(within(feed).getAllByTestId('pulse-commit').length).toBeGreaterThan(0);
      cleanup();
      resetVaultActivity();
    }
  });

  it('reveals the next days that hold something on Show earlier', async () => {
    const commits: PulseCommit[] = Array.from({ length: DAYS_PER_REVEAL + 3 }, (_, i) => ({
      hash: String(i % 10).repeat(39) + String.fromCharCode(97 + i),
      shortHash: `c${i}`,
      message: `Checkpoint ${i}`,
      author: 'Cerebro',
      date: Date.UTC(2026, 5, 30 - i, 12) / 1000,
      changes: { files: [], added: 0, modified: 1, deleted: 0 },
    }));
    const feed = await open(() => {
      __seedActivity({ writes: null });
      __seedFleet([]);
      resetMockGit({ commits });
    });
    await waitFor(() => expect(within(feed).getAllByTestId('pulse-commit')).toHaveLength(14));
    fireEvent.click(screen.getByTestId('history-earlier'));
    expect(within(feed).getAllByTestId('pulse-commit')).toHaveLength(DAYS_PER_REVEAL + 3);
    expect(screen.queryByTestId('history-earlier')).toBeNull();
  });

  it('says a vault with no checkpoints kept in a line, and the activity still reads', async () => {
    const feed = await open(() => resetMockGit({ isRepo: false }));
    expect(await within(feed).findByTestId('history-untracked')).toBeTruthy();
    expect(within(feed).getAllByTestId('history-session').length).toBeGreaterThan(0);
  });
});
