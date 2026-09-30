// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localStamp } from '@/engine/whenText';
import { __seedFleet, resetMockFs, type FleetRun } from '@/lib/mockIpc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { AgentsPage } from './AgentsPage';

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
    ...over,
  };
}

describe('AgentsPage', () => {
  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    useNavStore.setState({
      selection: { kind: 'agents' },
      history: [{ kind: 'agents' }],
      historyIndex: 0,
    });
  });
  afterEach(cleanup);

  it('the lobby composes the roster over the run feed, and a row opens the agent', async () => {
    render(<AgentsPage selection={{ kind: 'agents' }} />);
    const knowledgeRow = (await screen.findAllByTestId('agent-row')).find((r) =>
      r.textContent?.includes('Knowledge'),
    );
    if (knowledgeRow === undefined) throw new Error('knowledge agent missing from roster');
    // The run feed is here too — one surface for who and what ran.
    expect(await screen.findByTestId('fleet-section')).toBeTruthy();

    // On this surface an agent is a DESTINATION, not a filter.
    fireEvent.click(knowledgeRow);
    expect(useNavStore.getState().selection).toEqual({
      kind: 'agents',
      actor: 'process:knowledge',
    });
  });

  it('an agent page shows charter, grants, duty, and the way to the one editor', async () => {
    render(<AgentsPage selection={{ kind: 'agents', actor: 'process:release-scout' }} />);
    expect(await screen.findByTestId('agent-grants')).toBeTruthy();
    expect(screen.getByText('Writes in')).toBeTruthy();
    expect(screen.getByText('Reads')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('agent-charter')).toBeTruthy());

    // Editing stays the Library's — one editor, one save path.
    fireEvent.click(screen.getByTestId('agent-edit'));
    const selection = useNavStore.getState().selection;
    expect(selection.kind).toBe('library');
    if (selection.kind === 'library') expect(selection.tab).toBe('agent');
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
    render(<AgentsPage selection={{ kind: 'agents', actor: 'process:release-scout' }} />);
    // The root's row, with its hop indented beneath and the billing stated.
    await waitFor(() => expect(screen.getByTestId('agent-run')).toBeTruthy());
    // Named as its record names it (M52.3), the stamp a hover away.
    const hop = screen.getByTestId('agent-run-hop');
    expect(hop.textContent).toContain('Knowledge agent');
    expect(hop.textContent).not.toContain('process:knowledge');
    expect(hop.querySelector('[title="process:knowledge"]')).toBeTruthy();
    expect(screen.getByText(/billed to this run's ceiling/)).toBeTruthy();
    cleanup();

    // From the hop's side: its page says which run it hopped from.
    render(<AgentsPage selection={{ kind: 'agents', actor: 'process:knowledge' }} />);
    await waitFor(() => expect(screen.getByTestId('agent-run-parent')).toBeTruthy());
    const parent = screen.getByTestId('agent-run-parent');
    expect(parent.textContent).toContain('a hop from Release scout');
    expect(parent.textContent).not.toContain('process:release-scout');
  });

  it('a construct page says it is internal, in plain words, instead of offering an editor', async () => {
    render(<AgentsPage selection={{ kind: 'agents', actor: 'agent:m26-ingest' }} />);
    const page = await screen.findByTestId('agent-construct');
    expect(screen.queryByTestId('agent-edit')).toBeNull();
    // M52.3: its name, not its stamp, and no milestone jargon.
    expect(page.textContent).toContain('Ingest is work Cerebro runs itself');
    expect(page.textContent).not.toContain('agent:m26-ingest');
    expect(page.textContent).not.toContain('M35');
  });

  it('the Knowledge agent page tells the same story as its concepts and its run (M52.3)', async () => {
    // The corpus: two concepts stamped `process:knowledge`, one addressed run
    // that applied them. Its page, its run and each concept's byline agree.
    render(<AgentsPage selection={{ kind: 'agents', actor: 'process:knowledge' }} />);
    expect((await screen.findByRole('heading', { level: 2 })).textContent).toBe('Knowledge agent');
    const wrote = await screen.findAllByTestId('agent-wrote');
    expect(wrote.map((w) => w.getAttribute('data-path')).sort()).toEqual([
      'knowledge/playbooks/warehouse-cutover.md',
      'knowledge/systems/pick-queue-drain.md',
    ]);
    await waitFor(() => expect(screen.getAllByTestId('agent-run')).toHaveLength(1));
    expect(screen.getByTestId('agent-run').getAttribute('data-run')).toBe('run-ingest-2');
    expect(screen.getByTestId('agent-grants').textContent).toContain('off duty');
  });

  it('a run row shows its start on the reader clock, as its detail does (M52.4)', async () => {
    const started = '2026-07-28T09:00:00Z';
    __seedFleet([run({ run_id: 'root-1', actor: 'process:release-scout', started_at: started })]);
    render(<AgentsPage selection={{ kind: 'agents', actor: 'process:release-scout' }} />);
    const row = await screen.findByTestId('agent-run');
    // The run detail's Started reads `localStamp` too; the ISO a hover away.
    expect(within(row).getByTitle(started).textContent).toBe(localStamp(new Date(started)));
  });

  it('an agent with triggers and no schedule is not called off duty (M52.4)', async () => {
    const entries = useVaultStore
      .getState()
      .entries.map((e) =>
        e.path === 'records/agents/release-scout.md'
          ? { ...e, properties: { ...e.properties, when: ['created'] } }
          : e,
      );
    useVaultStore.setState({ entries });
    render(<AgentsPage selection={{ kind: 'agents', actor: 'process:release-scout' }} />);
    const grants = await screen.findByTestId('agent-grants');
    expect(grants.textContent).toContain('none — its triggers fire it');
    expect(grants.textContent).not.toContain('off duty');
    expect(grants.textContent).toContain('1 standing');
  });

  it('a dangling actor is absent, said as absent', async () => {
    render(<AgentsPage selection={{ kind: 'agents', actor: 'process:gone' }} />);
    expect(await screen.findByText('No agent answers to this name')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All agents' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'agents' });
  });

  it('a failed runs read says could-not-read, never an empty history', async () => {
    __seedFleet(null); // the missing runtime DB: every fleet command refuses
    render(<AgentsPage selection={{ kind: 'agents', actor: 'process:release-scout' }} />);
    await waitFor(() => expect(screen.getByTestId('agent-runs-unavailable')).toBeTruthy());
    expect(screen.queryByTestId('agent-runs-empty')).toBeNull();
  });
});
