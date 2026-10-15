// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LAB_NOW } from '@/lab/clock';
import { applyPreset, LAB_STATES, unmetExpectations } from '@/lab/presets';
import { section } from '@/lab/sections/historyHeatmap';
import { resetFaults } from '@/lib/mockFaults';
import { __seedActivity, resetMockFs } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { HistoryHeatmapSection } from './ActivityHeatmap';
import { resetVaultActivity } from './vaultActivityStore';

/** The heatmap over the mock (M64.2), at the lab's clock and in UTC, so the
 * demo's days are the days the corpus names. */

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

const cell = (day: string) =>
  document.querySelector<HTMLElement>(`[data-testid="heatmap-day"][data-day="${day}"]`);

async function demo(): Promise<void> {
  resetMockFs();
  await useVaultStore.getState().openVault('/demo-vault');
  render(<HistoryHeatmapSection />);
  await screen.findByTestId('heatmap-seam');
}

describe('ActivityHeatmap', () => {
  it.each(LAB_STATES)('renders its %s preset', async (state) => {
    await applyPreset(section, state);
    const { container } = render(<div>{section.render()}</div>);
    await waitFor(() =>
      expect(unmetExpectations(container, section.states[state].expect)).toEqual([]),
    );
  });

  it("reads the demo's days in words: sessions, no edits, not recorded, before recording", async () => {
    await demo();
    expect(cell('2026-07-27')?.dataset).toMatchObject({ state: 'recorded', sessions: '2' });
    expect(cell('2026-07-27')?.getAttribute('aria-label')).toBe(
      'Mon, Jul 27, 2026 — 2 editing sessions',
    );
    expect(cell('2026-07-28')?.dataset).toMatchObject({ state: 'recorded', sessions: '3' });
    expect(cell('2026-07-22')?.title).toBe('Wed, Jul 22, 2026 — no edits');
    expect(cell('2026-07-22')?.dataset.sessions).toBe('0');
    expect(cell('2026-07-25')?.title).toBe("Sat, Jul 25, 2026 — not recorded: Cerebro wasn't open");
    expect(cell('2026-07-25')?.dataset.sessions).toBe('');
    expect(cell('2026-07-20')?.dataset.state).toBe('not-recorded');
    expect(cell('2026-07-20')?.title).toBe(
      'Mon, Jul 20, 2026 — not recorded: before Cerebro began recording edits',
    );
    expect(screen.getByTestId('heatmap-seam').textContent).toBe(
      'Cerebro began recording edits here on Tue, Jul 21, 2026.',
    );
    expect(screen.getByTestId('heatmap-legend').textContent).toContain('Not recorded');
  });

  it('says which lane it needs failed, each alone', async () => {
    // The write table holds when recording began too, so both fail together.
    for (const [seed, lanes] of [
      [{ sessions: null }, ['app_sessions']],
      [{ writes: null }, ['writes', 'recording_since']],
    ] as const) {
      resetMockFs();
      __seedActivity(seed);
      await useVaultStore.getState().openVault('/demo-vault');
      render(<HistoryHeatmapSection />);
      const lines = await screen.findAllByTestId('section-unavailable');
      expect(lines.map((l) => l.dataset.lane)).toEqual(lanes);
      expect(screen.queryByTestId('heatmap-day')).toBeNull();
      expect(screen.getByTestId('activity-retry')).toBeTruthy();
      cleanup();
      resetVaultActivity();
    }
  });

  it('draws the grid with the runs lane down: runs are not a lane it needs', async () => {
    const { __seedFleet } = await import('@/lib/mockIpc');
    resetMockFs();
    __seedFleet(null);
    await useVaultStore.getState().openVault('/demo-vault');
    render(<HistoryHeatmapSection />);
    await screen.findByTestId('heatmap-seam');
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });
});
