// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentDraft } from '@/engine/libraryDraft';
import type { FleetActorSummary, FleetRun } from '@/lib/ipc';
import { AgentDossier } from './AgentDossier';

/**
 * The agent dossier (M33.6).
 *
 * Two properties: **absent is never zero** (an agent with no runs says so, a
 * lifetime total names the runs it could not include), and **nothing about
 * the agent is stored outside the vault** — on duty is derived from the
 * draft, and the only thing read from SQLite is the run join.
 *
 * The clock is PINNED. Every date this component renders is relative to
 * `now`, and an unpinned test has a shelf life (M26's lesson, which cost
 * days).
 */

/**
 * Noon on VAULT_TODAY, constructed from LOCAL parts on purpose.
 *
 * `parseSchedule` reads `daily 09:00` as local time, so a `now` built from a
 * UTC instant would make this test's answer depend on the machine's zone —
 * and unlike Playwright (`timezoneId: 'UTC'`), vitest pins no timezone. Local
 * `now` against a local schedule is the same relationship everywhere.
 */
const NOW = new Date(2026, 6, 28, 12, 0, 0);

const fleetActorSummary = vi.fn<(actor: string) => Promise<FleetActorSummary>>();
const fleetRuns = vi.fn<(filter?: unknown) => Promise<FleetRun[]>>();

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return {
    ...actual,
    fleetActorSummary: (actor: string) => fleetActorSummary(actor),
    fleetRuns: (filter?: unknown) => fleetRuns(filter),
  };
});

afterEach(cleanup);

function draft(over: Partial<AgentDraft> = {}): AgentDraft {
  return {
    slug: 'weekly-digest',
    description: '',
    scope: null,
    allowedTools: null,
    connectors: null,
    shell: false,
    schedule: 'daily 09:00',
    triggers: [],
    preferences: '',
    recent: '',
    instructions: '',
    ...over,
  };
}

function summary(over: Partial<FleetActorSummary> = {}): FleetActorSummary {
  return {
    actor: 'process:weekly-digest',
    run_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    unknown_runs: 0,
    last_outcome: null,
    last_started_at: null,
    ...over,
  };
}

function run(over: Partial<FleetRun> = {}): FleetRun {
  return {
    run_id: 'r1',
    actor: 'process:weekly-digest',
    vault_id: 'v1',
    mode: 'attended',
    lane: 'agent',
    started_at: '2026-07-28T09:00:00Z',
    ended_at: '2026-07-28T09:01:00Z',
    outcome: 'succeeded',
    usage_state: 'exact',
    input_tokens: 900,
    output_tokens: 100,
    proposals_submitted: 0,
    applied: 0,
    rejected: 0,
    ...over,
  };
}

describe('AgentDossier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fleetActorSummary.mockResolvedValue(summary());
    fleetRuns.mockResolvedValue([]);
  });

  it('shows lifetime tokens with the unmetered runs called out separately', async () => {
    fleetActorSummary.mockResolvedValue(
      summary({
        run_count: 5,
        input_tokens: 4_000,
        output_tokens: 800,
        unknown_runs: 3,
        last_outcome: 'quota_failed',
        last_started_at: '2026-07-28T09:00:00Z',
      }),
    );
    fleetRuns.mockResolvedValue([run()]);
    render(<AgentDossier draft={draft()} actor="process:weekly-digest" now={NOW} />);

    const tokens = await screen.findByTestId('dossier-tokens');
    expect(tokens.textContent).toContain('4,800');
    // Named, not absorbed: a total that swallowed them would read as a
    // smaller bill than the one actually paid.
    expect(tokens.textContent).toContain('3 runs unmetered');
    expect((await screen.findByTestId('dossier-last')).textContent).toContain('quota failed');
    expect((await screen.findByTestId('dossier-runs')).textContent).toContain('5');
  });

  it('says "no runs yet" rather than rendering an empty table', async () => {
    render(<AgentDossier draft={draft()} actor="process:weekly-digest" now={NOW} />);

    expect(await screen.findByTestId('section-empty')).toBeTruthy();
    expect(screen.queryAllByTestId('fleet-row')).toHaveLength(0);
    // And the derived pill is still right for an agent that has never run.
    expect((await screen.findByTestId('dossier-last')).textContent).toContain('never run');
  });

  it('computes the next fire against the injected clock, not the wall clock', async () => {
    // Pinned to noon local on 2026-07-28; a 09:00 daily has already gone
    // today, so the next one is tomorrow morning.
    render(<AgentDossier draft={draft()} actor="process:weekly-digest" now={NOW} />);

    const next = await screen.findByTestId('dossier-next-fire');
    expect(next.textContent).toContain('2026-07-29 09:00');
  });

  it('derives on-duty from what can fire it, and says so when nothing can', async () => {
    render(
      <AgentDossier
        draft={draft({ schedule: '', triggers: [] })}
        actor="process:weekly-digest"
        now={NOW}
      />,
    );

    const duty = await screen.findByTestId('dossier-duty');
    expect(duty.getAttribute('data-on-duty')).toBe('false');
    expect(duty.textContent).toContain('nothing can fire it');
    expect((await screen.findByTestId('dossier-next-fire')).textContent).toContain('no schedule');
  });

  it('is on duty on a trigger alone, with no schedule at all', async () => {
    // The derivation is "something can fire it", not "it has a schedule".
    render(
      <AgentDossier
        draft={draft({ schedule: '', triggers: [{ event: 'created' }] })}
        actor="process:weekly-digest"
        now={NOW}
      />,
    );

    const duty = await screen.findByTestId('dossier-duty');
    expect(duty.getAttribute('data-on-duty')).toBe('true');
  });

  it('says the history could not be read rather than claiming it never ran', async () => {
    fleetActorSummary.mockRejectedValue(new Error('no runtime database'));
    render(<AgentDossier draft={draft()} actor="process:weekly-digest" now={NOW} />);

    expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
      'could not be read',
    );
    expect(screen.queryByTestId('section-empty')).toBeNull();
  });

  it('asks only for this actor, and for a bounded page', async () => {
    render(<AgentDossier draft={draft()} actor="process:weekly-digest" now={NOW} />);

    await waitFor(() => expect(fleetRuns).toHaveBeenCalled());
    expect(fleetRuns).toHaveBeenCalledWith(
      expect.objectContaining({ actor: 'process:weekly-digest' }),
    );
    const filter = fleetRuns.mock.calls[0][0] as { limit?: number };
    expect(filter.limit).toBeGreaterThan(0);
  });
});
