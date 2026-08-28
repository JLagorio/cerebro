// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineOverview } from '@/lib/ipc';
import { SystemSection } from './SystemSection';

/**
 * The Background section's concurrency ceiling (M33b.2).
 *
 * These specs are about the two claims the phase makes to a person: that the
 * app arrives saying it runs one background job at a time — the number the
 * retired `ambient_dispatch` singleton row used to enforce — and that the
 * control cannot offer a number the backend would refuse, because its range
 * comes from Rust rather than from a second copy of `MAX_CONCURRENT_RUNS`
 * written here.
 *
 * The RULE itself (the floor, the cap, what an unreadable value means) is
 * proved in `runtime::settings` and mirrored in `mockIpc.test.ts`. A third
 * copy here would be the twin-implementation defect.
 */

const pipelineOverview = vi.fn<(vault: string) => Promise<PipelineOverview>>();
const setAmbientConcurrency = vi.fn<(ceiling: number) => Promise<void>>();
const setGlobalPause = vi.fn<(paused: boolean) => Promise<void>>();

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return {
    ...actual,
    pipelineOverview: (vault: string) => pipelineOverview(vault),
    setAmbientConcurrency: (ceiling: number) => setAmbientConcurrency(ceiling),
    setGlobalPause: (paused: boolean) => setGlobalPause(paused),
  };
});

afterEach(cleanup);

const VAULT = '/demo-vault';

function overview(over: Partial<PipelineOverview> = {}): PipelineOverview {
  return {
    global_pause: false,
    ambient_concurrency: 1,
    ambient_concurrency_max: 4,
    runtime_status: 'ready',
    meter: {
      window_start_utc: '2026-08-16T00:00:00.000Z',
      window_end_utc: '2026-08-17T00:00:00.000Z',
      timezone_id: 'UTC',
      ceiling_state: 'under_budget',
      ceiling_reasons: [],
      accounting_state: 'exact',
      runs_started: 0,
      max_daily_runs: 20,
      tokens_used: 0,
      max_daily_tokens: 200000,
      output_tokens_used: 0,
      max_daily_output_tokens: 40000,
      reserved_total_tokens: 0,
      reserved_output_tokens: 0,
    },
    lanes: [],
    activity: [],
    banners: [],
    held: { baseline_held: 0, recovery_held: 0, pending_review: 0, pending: 0 },
    ...over,
  };
}

describe('the background concurrency ceiling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pipelineOverview.mockResolvedValue(overview());
    setAmbientConcurrency.mockResolvedValue(undefined);
  });

  it('arrives at one, and says so in words rather than only in a number', async () => {
    render(<SystemSection vaultPath={VAULT} />);
    const state = await screen.findByTestId('concurrency-state');
    expect(state.getAttribute('data-ceiling')).toBe('1');
    expect(state.textContent).toContain('one job at a time');
    const select = screen.getByTestId('ambient-concurrency') as HTMLSelectElement;
    expect(select.value).toBe('1');
  });

  it('offers exactly the range Rust sent, never a number the backend would refuse', async () => {
    pipelineOverview.mockResolvedValue(overview({ ambient_concurrency_max: 2 }));
    render(<SystemSection vaultPath={VAULT} />);
    const select = (await screen.findByTestId('ambient-concurrency')) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['1', '2']);
  });

  it('raising it asks the backend, and the sentence changes with the answer', async () => {
    render(<SystemSection vaultPath={VAULT} />);
    const select = await screen.findByTestId('ambient-concurrency');
    pipelineOverview.mockResolvedValue(overview({ ambient_concurrency: 3 }));
    fireEvent.change(select, { target: { value: '3' } });

    await waitFor(() => expect(setAmbientConcurrency).toHaveBeenCalledWith(3));
    await waitFor(() =>
      expect(screen.getByTestId('concurrency-state').getAttribute('data-ceiling')).toBe('3'),
    );
    expect(screen.getByTestId('concurrency-state').textContent).toContain('up to 3 jobs');
  });

  it('a refused ceiling is toasted, not thrown, and the surface reloads the truth', async () => {
    // The store-layer rule: a human UI action never throws. The backend's
    // refusal is a sentence, and what the control then shows is what the
    // backend says it is — not what was clicked.
    setAmbientConcurrency.mockRejectedValue(new Error('that ceiling is not allowed'));
    render(<SystemSection vaultPath={VAULT} />);
    const select = await screen.findByTestId('ambient-concurrency');
    fireEvent.change(select, { target: { value: '4' } });

    await waitFor(() => expect(setAmbientConcurrency).toHaveBeenCalledWith(4));
    await waitFor(() =>
      expect(screen.getByTestId('concurrency-state').getAttribute('data-ceiling')).toBe('1'),
    );
  });

  it('a read that failed says so, and never renders a ceiling it does not know', async () => {
    pipelineOverview.mockRejectedValue(new Error('the runtime database could not be opened'));
    render(<SystemSection vaultPath={VAULT} />);
    expect(await screen.findByTestId('section-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('ambient-concurrency')).toBeNull();
  });
});
