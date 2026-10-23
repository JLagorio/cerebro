// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localStamp } from '@/engine/whenText';
import { __seedFleet, resetMockFs, type FleetRun } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { AgentRunHistory } from './AgentRunHistory';

/*
 * An actor's runs with their chains (M41.4), moved out of AgentsPage in
 * M55.12: an agent page's Runs tab and a construct's page both show it.
 */
function run(over: Partial<FleetRun> & { run_id: string }): FleetRun {
  return {
    actor: null,
    vault_id: 'demo',
    mode: 'ambient',
    lane: 'filed',
    started_at: '2026-07-28T10:00:00Z',
    ended_at: '2026-07-28T10:01:00Z',
    outcome: 'succeeded',
    usage_state: 'exact',
    input_tokens: 100,
    output_tokens: 10,
    proposals_submitted: 0,
    applied: 0,
    rejected: 0,
    parent_run_id: null,
    cause: null,
    cli_session_id: null,
    ...over,
  };
}

describe('AgentRunHistory', () => {
  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
  });
  afterEach(cleanup);

  it('names a parent with a NULL actor as an assistant turn', async () => {
    __seedFleet([
      run({ run_id: 'chat', actor: null }),
      run({ run_id: 'hop', actor: 'process:release-scout', parent_run_id: 'chat' }),
    ]);
    render(<AgentRunHistory actor="process:release-scout" />);
    expect((await screen.findByTestId('agent-run-parent')).textContent).toContain(
      'a hop from an assistant turn',
    );
  });

  it('renders a chain: hops indent under their root, and a hop names its parent', async () => {
    __seedFleet([
      run({ run_id: 'root-1', actor: 'process:release-scout', started_at: '2026-07-28T11:00:00Z' }),
      run({
        run_id: 'hop-1',
        actor: 'process:knowledge',
        parent_run_id: 'root-1',
        started_at: '2026-07-28T11:01:00Z',
      }),
    ]);
    render(<AgentRunHistory actor="process:release-scout" />);
    await waitFor(() => expect(screen.getByTestId('agent-run')).toBeTruthy());
    // Named as its record names it (M52.3), the stamp a hover away.
    const hop = screen.getByTestId('agent-run-hop');
    expect(hop.textContent).toContain('Knowledge agent');
    expect(hop.textContent).not.toContain('process:knowledge');
    expect(hop.querySelector('[title="process:knowledge"]')).toBeTruthy();
    expect(screen.getByText(/billed to this run's ceiling/)).toBeTruthy();
    cleanup();

    // From the hop's side: its history says which run it hopped from.
    render(<AgentRunHistory actor="process:knowledge" />);
    await waitFor(() => expect(screen.getByTestId('agent-run-parent')).toBeTruthy());
    const parent = screen.getByTestId('agent-run-parent');
    expect(parent.textContent).toContain('a hop from Release scout');
    expect(parent.textContent).not.toContain('process:release-scout');
  });

  it('a run row shows its start on the reader clock, as its detail does (M52.4)', async () => {
    const started = '2026-07-28T09:00:00Z';
    __seedFleet([run({ run_id: 'root-1', actor: 'process:release-scout', started_at: started })]);
    render(<AgentRunHistory actor="process:release-scout" />);
    const row = await screen.findByTestId('agent-run');
    expect(within(row).getByTitle(started).textContent).toBe(localStamp(new Date(started)));
  });

  it('each row says why its run started, and a legacy row says why not recorded (M56.7)', async () => {
    __seedFleet([
      run({
        run_id: 'fired',
        actor: 'process:release-scout',
        started_at: '2026-07-28T09:15:00Z',
        cause: {
          kind: 'schedule',
          why: 'its schedule came due',
          subject: null,
          detail: 'weekdays 08:30',
          due_at: '2026-07-28T08:30:00.000Z',
        },
      }),
      run({ run_id: 'legacy', actor: 'process:release-scout', started_at: '2026-07-28T04:20:00Z' }),
    ]);
    render(<AgentRunHistory actor="process:release-scout" />);
    const rows = await screen.findAllByTestId('agent-run');
    expect(rows.map((row) => within(row).getByTestId('run-why').textContent)).toEqual([
      'its schedule came due (weekdays 08:30) · ran 45m late',
      'why not recorded',
    ]);
  });

  it('a failed runs read says could-not-read, never an empty history', async () => {
    __seedFleet(null); // the missing runtime DB: every fleet command refuses
    render(<AgentRunHistory actor="process:release-scout" />);
    await waitFor(() => expect(screen.getByTestId('agent-runs-unavailable')).toBeTruthy());
    expect(screen.queryByTestId('agent-runs-empty')).toBeNull();
  });

  it('an actor with no runs says so', async () => {
    __seedFleet([run({ run_id: 'other', actor: 'process:knowledge' })]);
    render(<AgentRunHistory actor="process:release-scout" />);
    expect(await screen.findByTestId('agent-runs-empty')).toBeTruthy();
    expect(screen.queryByTestId('agent-run')).toBeNull();
  });

  // --- Runs as trace lines (M91.14) -----------------------------------------

  it("nests a hop's own hop under it, and counts every hop the chain bills", async () => {
    __seedFleet([
      run({ run_id: 'root-1', actor: 'process:release-scout' }),
      run({ run_id: 'hop-1', actor: 'process:knowledge', parent_run_id: 'root-1' }),
      run({ run_id: 'hop-2', actor: 'process:weekly-review', parent_run_id: 'hop-1' }),
    ]);
    render(<AgentRunHistory actor="process:release-scout" />);
    await screen.findByTestId('agent-run');
    const hops = screen.getAllByTestId('agent-run-hop');
    expect(hops.map((hop) => hop.getAttribute('data-run'))).toEqual(['hop-1', 'hop-2']);
    expect(hops[0].closest('[data-hops]')?.getAttribute('data-hops')).toBe('root-1');
    expect(hops[1].closest('[data-hops]')?.getAttribute('data-hops')).toBe('hop-1');
    expect(screen.getByText("2 hops, billed to this run's ceiling")).toBeTruthy();
  });

  it('a hop opens its own run under its row, and only that row says it is open', async () => {
    const root = run({ run_id: 'root-1', actor: 'process:release-scout' });
    const hop = run({ run_id: 'hop-1', actor: 'process:knowledge', parent_run_id: 'root-1' });
    __seedFleet([root, hop], {
      'hop-1': {
        run: hop,
        cost_components: null,
        assembly: null,
        model_id: null,
        refusals: [],
        refusals_total: 0,
        wrote: { state: 'not_recorded' },
      },
    });
    render(<AgentRunHistory actor="process:release-scout" />);
    fireEvent.click(await screen.findByTestId('agent-run-hop'));
    expect((await screen.findByTestId('run-detail')).getAttribute('data-run')).toBe('hop-1');
    expect(screen.getByTestId('agent-run-hop').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('agent-run').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByTestId('agent-run-hop'));
    await waitFor(() => expect(screen.queryByTestId('run-detail')).toBeNull());
  });

  it('says how each run ended in a word before it, and how long only as recorded', async () => {
    __seedFleet([
      run({
        run_id: 'failed',
        actor: 'process:release-scout',
        outcome: 'failed',
        started_at: '2026-07-28T10:00:00Z',
        ended_at: '2026-07-28T10:00:42Z',
      }),
      run({
        run_id: 'live',
        actor: 'process:release-scout',
        outcome: 'running',
        ended_at: null,
      }),
    ]);
    render(<AgentRunHistory actor="process:release-scout" />);
    await screen.findAllByTestId('agent-run');
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-run="${id}"]`)!;
    expect(row('failed').textContent).toMatch(/^Failed: /);
    expect(within(row('failed')).getByTestId('agent-run-took').textContent).toBe('42s');
    expect(row('live').textContent).toMatch(/^Running: /);
    expect(within(row('live')).queryByTestId('agent-run-took')).toBeNull();
    expect(within(row('live')).getByTestId('agent-run-label').className).toContain('cb-ai-shimmer');
  });

  it('a row opens its run where it is listed (M50.3)', async () => {
    // The corpus's own run, which carries a recorded detail.
    render(<AgentRunHistory actor="process:knowledge" />);
    fireEvent.click(await screen.findByTestId('agent-run'));
    expect(await screen.findByTestId('run-detail')).toBeTruthy();
    expect(screen.getByTestId('agent-run').getAttribute('aria-expanded')).toBe('true');
  });

  it("release-scout's run opens with its model and what it was refused (M56.9)", async () => {
    render(<AgentRunHistory actor="process:release-scout" />);
    fireEvent.click(await screen.findByTestId('agent-run'));
    const refused = await screen.findByTestId('run-detail-refused');
    expect(
      within(refused)
        .getAllByTestId('run-detail-refusal')
        .map((row) => row.getAttribute('data-code')),
    ).toEqual(['write_outside_scope', 'capability_unavailable']);
    expect(screen.getByTestId('run-detail-model').textContent).toBe('claude-opus-5');
    // And the one page it wrote (M58.1b).
    expect(
      within(screen.getByTestId('run-detail-pages'))
        .getAllByTestId('run-detail-page')
        .map((row) => row.getAttribute('data-path')),
    ).toEqual(['records/risks/risk-scanner-delivery.md']);
  });
});
