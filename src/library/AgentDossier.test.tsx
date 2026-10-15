import { useFollowupStore } from '@/stores/followupStore';
import { agentRef } from '@/engine/agents';
import { stampActivation } from '@/agent/activation';
vi.mock('@/agent/activation', async (original) => ({
  ...(await original<typeof import('@/agent/activation')>()),
  stampActivation: vi.fn(async () => true),
}));
import { runAgentNow } from '@/agent/runNow';
import { useUiStore } from '@/stores/uiStore';
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
 * summary read comes from SQLite. Run now uses the shared job action.
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

vi.mock('@/agent/runNow', () => ({
  runAgentNow: vi.fn(async () => false),
  useRunNowStarting: () => false,
}));

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
    vi.mocked(stampActivation).mockResolvedValue(true);
    useUiStore.setState({ runs: [] });
    fleetActorSummary.mockResolvedValue(summary());
    fleetRuns.mockResolvedValue([]);
    useVaultStore.setState({ vaultPath: '/vault', patchFrontmatter: patchFrontmatter as never });
  });

  it('Resume stamps first, keeps resuming on stamp failure, and Pause stamps nothing', async () => {
    const entry = agent({ paused: true });
    const view = render(<AgentDossier entry={entry} now={NOW} />);
    vi.mocked(stampActivation).mockImplementationOnce(async () => {
      expect(patchFrontmatter).not.toHaveBeenCalled();
      return false;
    });
    const toast = vi.spyOn(useUiStore.getState(), 'toast');
    fireEvent.click(screen.getByTestId('agent-duty-toggle'));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalled());
    expect(stampActivation).toHaveBeenCalledWith(
      '/vault',
      'slug:weekly-digest',
      ['daily 09:00'],
      NOW,
    );
    expect(toast).toHaveBeenCalledWith(
      "Resumed. Cerebro couldn't record when, so a run its schedule missed may start now.",
    );
    vi.mocked(stampActivation).mockClear();
    view.rerender(<AgentDossier entry={agent()} now={NOW} />);
    await waitFor(() =>
      expect(screen.getByTestId('agent-duty-toggle')).toHaveProperty('disabled', false),
    );
    fireEvent.click(screen.getByTestId('agent-duty-toggle'));
    await waitFor(() => expect(patchFrontmatter).toHaveBeenCalledTimes(2));
    expect(stampActivation).not.toHaveBeenCalled();
    toast.mockRestore();
  });
  it('Resume uses the click time when an open page has aged past another fire', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 6, 28, 8));
      render(<AgentDossier entry={agent({ paused: true })} />);
      vi.setSystemTime(new Date(2026, 6, 28, 14));
      fireEvent.click(screen.getByTestId('agent-duty-toggle'));
      await waitFor(() => expect(stampActivation).toHaveBeenCalled());
      expect(vi.mocked(stampActivation).mock.lastCall?.[3]).toEqual(new Date(2026, 6, 28, 14));
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists show the soonest future time and a passed once reads passed and off duty', () => {
    const view = render(
      <AgentDossier
        entry={agent({ schedule: ['monthly last 18:00', 'weekdays 08:30'] })}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('dossier-next-fire').textContent).toContain('2026-07-29 08:30');
    expect(screen.getByTestId('dossier-next-fire').title).toContain("This computer's clock (");
    view.rerender(<AgentDossier entry={agent({ schedule: 'once 2026-07-27 09:00' })} now={NOW} />);
    expect(screen.getByTestId('dossier-next-fire').textContent).toContain(
      'its one time has passed',
    );
    expect(screen.getByTestId('dossier-duty').dataset.onDuty).toBe('false');
  });

  it('Run now invokes the shared action and a registry job shows Running', () => {
    const entry = agent();
    const view = render(<AgentDossier entry={entry} now={NOW} />);
    fireEvent.click(screen.getByTestId('agent-run-now'));
    expect(runAgentNow).toHaveBeenCalledWith(entry.path);
    useUiStore.setState({
      runs: [
        {
          id: 'job',
          owner: 'job',
          path: entry.path,
          label: entry.title,
          place: null,
          conversationId: null,
          run: 1,
          startedAt: 0,
        },
      ],
    });
    view.rerender(<AgentDossier entry={entry} now={NOW} />);
    const button = screen.getByTestId('agent-run-now') as HTMLButtonElement;
    expect(button.textContent).toBe('Running…');
    expect(button.disabled).toBe(true);
    expect(button.parentElement?.title).toBe('Weekly digest is already running');
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

it('a waiting follow-up keeps off-duty words honest and a paused record stays paused', async () => {
  const entry = agent({ schedule: null });
  useFollowupStore.setState({
    vault: useVaultStore.getState().vaultPath,
    read: {
      state: 'ready',
      rows: [
        {
          followupId: 'id',
          actor: agentRef(entry).actor,
          note: 'check',
          dueAt: NOW.toISOString(),
          requestedAt: NOW.toISOString(),
          requestedByRun: 'run',
          state: 'pending',
          claimedAt: null,
          runId: null,
          endedAt: null,
          cancelReason: null,
        },
      ],
    },
  });
  const { rerender } = render(<AgentDossier entry={entry} now={NOW} />);
  expect(screen.getByTestId('dossier-duty').textContent).toContain(
    'Off duty — only a follow-up it booked will run it, while Learn on its own is on',
  );
  rerender(
    <AgentDossier
      entry={{ ...entry, properties: { ...entry.properties, paused: true } }}
      now={NOW}
    />,
  );
  expect(screen.getByTestId('dossier-duty').textContent).toContain('Paused');
  useFollowupStore.getState().reset(null);
});
