// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetRun, FleetRunDetail } from '@/lib/ipc';
import { FleetSection } from './FleetSection';

/**
 * The fleet section (M33.5).
 *
 * These specs are about ONE property, the one M31's measurement rule and this
 * milestone's four rules both turn on: **absent is never zero**. A run whose
 * cost was never recorded, a run whose usage was lost, and a run nobody
 * attributed each have a sentence of their own, and none of those sentences
 * is a number.
 *
 * Ordering, filtering and clamping are proved against the real SQL in
 * `runtime::fleet` and mirrored in `mockIpc.test.ts`. A third copy here would
 * be the twin-implementation defect.
 */

const fleetRuns = vi.fn<(filter?: unknown) => Promise<FleetRun[]>>();
const fleetRunDetail = vi.fn<(runId: string) => Promise<FleetRunDetail>>();

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return {
    ...actual,
    fleetRuns: (filter?: unknown) => fleetRuns(filter),
    fleetRunDetail: (runId: string) => fleetRunDetail(runId),
  };
});

afterEach(cleanup);

function run(over: Partial<FleetRun> = {}): FleetRun {
  return {
    run_id: 'r1',
    actor: 'process:weekly-digest',
    vault_id: 'v1',
    mode: 'ambient',
    lane: 'filed',
    started_at: '2026-07-28T10:00:00Z',
    ended_at: '2026-07-28T10:01:00Z',
    outcome: 'succeeded',
    usage_state: 'exact',
    input_tokens: 1200,
    output_tokens: 300,
    proposals_submitted: 0,
    applied: 0,
    rejected: 0,
    ...over,
  };
}

describe('FleetSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fleetRuns.mockResolvedValue([run()]);
    fleetRunDetail.mockResolvedValue({
      run: run(),
      cost_components: null,
      assembly: null,
    });
  });

  it('renders absent cost as "not recorded", never $0', async () => {
    render(<FleetSection />);

    fireEvent.click(await screen.findByTestId('fleet-row'));

    const detail = await screen.findByTestId('run-detail');
    expect(detail.textContent).toContain('not recorded');
    // The whole point: no invented zero anywhere in the panel.
    expect(detail.textContent).not.toMatch(/\$0\b/);
    expect(detail.textContent).not.toMatch(/\b0 tokens\b/);
  });

  it('says "unknown" for a run whose usage was lost, rather than showing its zeros', async () => {
    fleetRuns.mockResolvedValue([
      run({ run_id: 'lost', usage_state: 'unknown', input_tokens: 0, output_tokens: 0 }),
    ]);
    render(<FleetSection />);

    const row = await screen.findByTestId('fleet-row');
    expect(row.textContent).toContain('unknown');
    expect(row.textContent).not.toContain('0 tokens');
  });

  it('calls an unattributed run unattributed rather than blank', async () => {
    fleetRuns.mockResolvedValue([run({ run_id: 'old', actor: null })]);
    render(<FleetSection />);

    const row = await screen.findByTestId('fleet-row');
    expect(row.textContent).toContain('unattributed');
  });

  it('shows recorded cost components, and marks the estimated ones as estimates', async () => {
    fleetRunDetail.mockResolvedValue({
      run: run(),
      cost_components: [
        {
          component: 'output_tokens',
          unit: 'tokens',
          model_id: 'claude-opus-5',
          quantity: 300,
          observed_cost_micros: 4500,
          estimated: false,
          pricing_snapshot_id: 'snap-1',
          recorded_at: '2026-07-28T10:01:00Z',
        },
        {
          component: 'tool_calls',
          unit: 'calls',
          model_id: null,
          quantity: 7,
          observed_cost_micros: null,
          estimated: true,
          pricing_snapshot_id: null,
          recorded_at: '2026-07-28T10:01:00Z',
        },
      ],
      assembly: null,
    });
    render(<FleetSection />);
    fireEvent.click(await screen.findByTestId('fleet-row'));

    const rows = await screen.findAllByTestId('cost-component');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('output_tokens');
    // An estimate shown as a measurement is worse than showing nothing.
    expect(rows[1].getAttribute('data-estimated')).toBe('true');
    expect(rows[1].textContent).toContain('estimated');
    // A component with no observed cost says so rather than reading as free.
    expect(rows[1].textContent).toContain('not recorded');
  });

  it('narrows to one actor when its filter chip is chosen', async () => {
    render(<FleetSection />);
    await screen.findByTestId('fleet-row');

    fireEvent.change(screen.getByTestId('fleet-filter-actor'), {
      target: { value: 'process:weekly-digest' },
    });

    await waitFor(() =>
      expect(fleetRuns).toHaveBeenLastCalledWith(
        expect.objectContaining({ actor: 'process:weekly-digest' }),
      ),
    );
  });

  it('says the run history could not be read rather than saying nothing ran', async () => {
    // The distinction the old activity log could not express: it rendered
    // "Nothing has run yet" for both.
    fleetRuns.mockRejectedValue(new Error('no runtime database'));
    render(<FleetSection />);

    const note = await screen.findByTestId('section-unavailable');
    expect(note.textContent).toContain('run history');
    expect(screen.queryByText(/Nothing has run/)).toBeNull();
  });

  it('says nothing has run when the fleet is genuinely empty', async () => {
    fleetRuns.mockResolvedValue([]);
    render(<FleetSection />);

    expect(await screen.findByTestId('section-empty')).toBeTruthy();
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });
});
