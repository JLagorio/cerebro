// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import { localStamp } from '@/engine/whenText';
import type { FleetRun, FleetRunDetail } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
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
    parent_run_id: null,
    ...over,
  };
}

/** An agent record answering to `process:weekly-digest`. */
const digestAgent = makeEntry({
  path: 'records/agents/weekly-digest.md',
  filename: 'weekly-digest.md',
  folder: 'records/agents',
  title: 'Weekly digest',
  type: 'Agent',
  properties: { slug: 'weekly-digest' },
});

describe('FleetSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVaultStore.setState({ vaultPath: null, entries: [] });
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

  it('says an unbooked run\'s proposals are "not recorded", never "0 applied"', async () => {
    // M49.9: before booking existed nothing wrote these counters, so the
    // zeros a legacy row carries are not a measurement.
    const legacy = run({
      run_id: 'legacy',
      proposals_submitted: null,
      applied: null,
      rejected: null,
    });
    fleetRuns.mockResolvedValue([legacy]);
    fleetRunDetail.mockResolvedValue({ run: legacy, cost_components: null, assembly: null });
    render(<FleetSection />);

    const row = await screen.findByTestId('fleet-row');
    expect(row.textContent).toContain('proposals not recorded');
    expect(row.textContent).not.toMatch(/\bapplied\b/);

    fireEvent.click(row);
    expect((await screen.findByTestId('run-detail-proposals')).textContent).toBe('not recorded');
    // No "still waiting" arithmetic over numbers nobody measured.
    expect(screen.queryByTestId('run-detail-to-review')).toBeNull();
  });

  it('counts a booked run, and what is left over is still waiting', async () => {
    const booked = run({ proposals_submitted: 3, applied: 1, rejected: 1 });
    fleetRuns.mockResolvedValue([booked]);
    fleetRunDetail.mockResolvedValue({ run: booked, cost_components: null, assembly: null });
    render(<FleetSection />);

    const row = await screen.findByTestId('fleet-row');
    expect(row.textContent).toContain('1 applied · 1 rejected');

    fireEvent.click(row);
    expect((await screen.findByTestId('run-detail-proposals')).textContent).toBe(
      '3 submitted · 1 applied · 1 rejected',
    );
    expect(screen.getByTestId('run-detail-to-review').textContent).toContain('1 still waiting');
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

  // --- Carried from M33.1–.10 ------------------------------------------------

  it('says WHEN a run happened, keeping the exact stamp a hover away', async () => {
    // These rows said who, what lane, what outcome and what it cost, and
    // never once said when — so a run from this morning and one from March
    // read identically, and "newest first" was an ordering nobody could check.
    fleetRuns.mockResolvedValue([run({ started_at: '2026-07-28T09:00:00Z' })]);
    render(<FleetSection now={new Date('2026-07-28T12:00:00Z')} />);

    const when = await screen.findByTestId('fleet-when');
    expect(when.textContent).toBe('3 hours ago');
    expect(when.getAttribute('title')).toBe('2026-07-28T09:00:00Z');
  });

  it('narrows to the agent the roster selected, through the same one filter', async () => {
    // Not a second piece of state meaning "which actor". A list filtered by
    // one thing while the chip claims another is the defect that avoids.
    render(<FleetSection focusActor="process:weekly-digest" />);

    await waitFor(() =>
      expect(fleetRuns).toHaveBeenLastCalledWith(
        expect.objectContaining({ actor: 'process:weekly-digest' }),
      ),
    );
    expect((screen.getByTestId('fleet-filter-actor') as HTMLSelectElement).value).toBe(
      'process:weekly-digest',
    );
  });
  // --- One cast, one set of names (M52.3) -------------------------------------

  it("names each run's actor in the app's words, keeping the stamp a hover away", async () => {
    useVaultStore.setState({ entries: [digestAgent] });
    fleetRuns.mockResolvedValue([
      run(),
      run({ run_id: 'r2', actor: 'claude-code' }),
      run({ run_id: 'r3', actor: 'agent:m26-ingest' }),
      run({ run_id: 'r4', actor: 'process:retired' }),
    ]);
    render(<FleetSection />);

    await screen.findAllByTestId('fleet-row');
    const actors = screen.getAllByTestId('fleet-actor');
    expect(actors.map((a) => a.textContent)).toEqual([
      'Weekly digest',
      'Assistant',
      'Background ingest',
      // Nothing answers to it: shown as written, never guessed at.
      'process:retired',
    ]);
    expect(actors.map((a) => a.getAttribute('title'))).toEqual([
      'process:weekly-digest',
      'claude-code',
      'agent:m26-ingest',
      'process:retired',
    ]);
  });

  it('labels the actor filter in words while its values stay the stamps it matches', async () => {
    useVaultStore.setState({ entries: [digestAgent] });
    render(<FleetSection />);
    await screen.findByTestId('fleet-row');

    const options = [
      ...(screen.getByTestId('fleet-filter-actor') as HTMLSelectElement).options,
    ].map((o) => [o.value, o.textContent]);
    // Every construct is offered before it has run, so "has ingest run at
    // all?" is answered with a no rather than by a missing option.
    expect(options).toEqual([
      ['', 'any'],
      ['agent:m26-ingest', 'Background ingest'],
      ['agent:m26-maintenance', 'Background maintenance'],
      ['agent:m26-synthesis', 'Background synthesis'],
      ['process:weekly-digest', 'Weekly digest'],
    ]);
  });

  it("opens a run under its agent's name, which opens the agent", async () => {
    useVaultStore.setState({ entries: [digestAgent] });
    render(<FleetSection />);
    fireEvent.click(await screen.findByTestId('fleet-row'));

    const agent = await screen.findByTestId('run-detail-agent');
    expect(agent.textContent).toBe('Weekly digest');
    fireEvent.click(agent);
    expect(useNavStore.getState().selection).toEqual({
      kind: 'agents',
      actor: 'process:weekly-digest',
    });
  });

  it("says when a run started and ended on the reader's clock, the ISO a hover away", async () => {
    render(<FleetSection />);
    fireEvent.click(await screen.findByTestId('fleet-row'));

    const detail = await screen.findByTestId('run-detail');
    const started = detail.querySelector('[title="2026-07-28T10:00:00Z"]');
    expect(started?.textContent).toBe(localStamp(new Date('2026-07-28T10:00:00Z')));
    expect(detail.querySelector('[title="2026-07-28T10:01:00Z"]')?.textContent).toBe(
      localStamp(new Date('2026-07-28T10:01:00Z')),
    );
    expect(detail.textContent).not.toContain('T10:00:00Z');
    // An actor nothing answers to has no page to open — and no dead button.
    expect(screen.queryByTestId('run-detail-agent')).toBeNull();
  });
});
