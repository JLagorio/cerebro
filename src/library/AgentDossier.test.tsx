// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import type { FleetActorSummary, FleetRun } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { AgentDossier } from './AgentDossier';

/**
 * The agent page's duty bar (M33.6, M55.12).
 *
 * Two properties: **absent is never zero** (a lifetime total names the runs
 * it could not include, a failed read says so), and **nothing about the agent
 * is stored outside the vault** — on duty is derived from the record, and the
 * only thing read from SQLite is the actor's summary.
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

function agent(properties: Record<string, unknown> = {}): Entry {
  return makeEntry({
    path: 'records/agents/weekly-digest.md',
    folder: 'records/agents',
    title: 'Weekly digest',
    type: 'Agent',
    properties: { slug: 'weekly-digest', schedule: 'daily 09:00', ...properties } as never,
  });
}

function summary(over: Partial<FleetActorSummary> = {}): FleetActorSummary {
  return {
    actor: 'process:weekly-digest',
    run_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    unknown_runs: 0,
    running_runs: 0,
    last_outcome: null,
    last_started_at: null,
    ...over,
  };
}

describe('AgentDossier', () => {
  const patchFrontmatter = vi.fn(async (_path: string, _patch: Record<string, unknown>) => true);

  beforeEach(() => {
    vi.clearAllMocks();
    fleetActorSummary.mockResolvedValue(summary());
    fleetRuns.mockResolvedValue([]);
    useVaultStore.setState({ patchFrontmatter: patchFrontmatter as never });
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
    render(<AgentDossier entry={agent()} now={NOW} />);

    const tokens = await screen.findByTestId('dossier-tokens');
    expect(tokens.textContent).toContain('4,800');
    // Named, not absorbed: a total that swallowed them would read as a
    // smaller bill than the one actually paid.
    expect(tokens.textContent).toContain('3 runs unmetered');
    expect((await screen.findByTestId('dossier-last')).textContent).toContain('quota failed');
    expect((await screen.findByTestId('dossier-runs')).textContent).toContain('5');
  });

  it('an agent that never ran says so in its last outcome', async () => {
    render(<AgentDossier entry={agent()} now={NOW} />);
    expect((await screen.findByTestId('dossier-last')).textContent).toContain('never run');
  });

  it('computes the next fire against the injected clock, not the wall clock', async () => {
    // Pinned to noon local on 2026-07-28; a 09:00 daily has already gone
    // today, so the next one is tomorrow morning.
    render(<AgentDossier entry={agent()} now={NOW} />);

    const next = await screen.findByTestId('dossier-next-fire');
    expect(next.textContent).toContain('2026-07-29 09:00');
  });

  it('is on duty on a schedule alone', async () => {
    render(<AgentDossier entry={agent()} now={NOW} />);
    const duty = await screen.findByTestId('dossier-duty');
    expect(duty.getAttribute('data-on-duty')).toBe('true');
    expect(duty.textContent).toContain('On duty');
  });

  it('is on duty on a trigger alone, with no schedule at all', async () => {
    // The derivation is "something can fire it", not "it has a schedule".
    render(<AgentDossier entry={agent({ schedule: null, when: ['created'] })} now={NOW} />);
    const duty = await screen.findByTestId('dossier-duty');
    expect(duty.getAttribute('data-on-duty')).toBe('true');
    expect(duty.textContent).toContain('On duty');
  });

  it('says off duty when nothing can fire it', async () => {
    render(<AgentDossier entry={agent({ schedule: null })} now={NOW} />);
    const duty = await screen.findByTestId('dossier-duty');
    expect(duty.getAttribute('data-on-duty')).toBe('false');
    expect(duty.textContent).toContain('Off duty — nothing can fire it');
    expect((await screen.findByTestId('dossier-next-fire')).textContent).toContain('no schedule');
  });

  it('a paused agent is not on duty, whatever could fire it', async () => {
    render(<AgentDossier entry={agent({ paused: true })} now={NOW} />);
    const duty = await screen.findByTestId('dossier-duty');
    expect(duty.getAttribute('data-on-duty')).toBe('false');
    expect(duty.textContent).toContain('Paused');
  });

  it('Pause writes paused: true, and Resume removes it', async () => {
    render(<AgentDossier entry={agent()} now={NOW} />);
    fireEvent.click(screen.getByTestId('agent-duty-toggle'));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(1));
    expect(patchFrontmatter).toHaveBeenCalledWith('records/agents/weekly-digest.md', {
      paused: true,
    });
    cleanup();

    render(<AgentDossier entry={agent({ paused: true })} now={NOW} />);
    const toggle = screen.getByTestId('agent-duty-toggle');
    expect(toggle.textContent).toBe('Resume');
    fireEvent.click(toggle);
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(2));
    expect(patchFrontmatter).toHaveBeenLastCalledWith('records/agents/weekly-digest.md', {
      paused: null,
    });
  });

  it('says the history could not be read rather than claiming it never ran', async () => {
    fleetActorSummary.mockRejectedValue(new Error('no runtime database'));
    render(<AgentDossier entry={agent()} now={NOW} />);

    expect((await screen.findByTestId('section-unavailable')).textContent).toContain(
      'could not be read',
    );
    expect(screen.queryByTestId('dossier-last')).toBeNull();
  });

  it('reads only the actor summary: the runs are the Runs tab', async () => {
    render(<AgentDossier entry={agent()} now={NOW} />);
    await waitFor(() => expect(fleetActorSummary).toHaveBeenCalledWith('process:weekly-digest'));
    await screen.findByTestId('dossier-last');
    expect(fleetRuns).not.toHaveBeenCalled();
  });
});
