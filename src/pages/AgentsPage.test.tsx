// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
    expect(screen.getByTestId('agent-run-hop').textContent).toContain('process:knowledge');
    expect(screen.getByText(/billed to this run's ceiling/)).toBeTruthy();
    cleanup();

    // From the hop's side: its page says which run it hopped from.
    render(<AgentsPage selection={{ kind: 'agents', actor: 'process:knowledge' }} />);
    await waitFor(() => expect(screen.getByTestId('agent-run-parent')).toBeTruthy());
    expect(screen.getByTestId('agent-run-parent').textContent).toContain('process:release-scout');
  });

  it('a construct page says it is permanently internal instead of offering an editor', async () => {
    render(<AgentsPage selection={{ kind: 'agents', actor: 'agent:m26-ingest' }} />);
    expect(await screen.findByTestId('agent-construct')).toBeTruthy();
    expect(screen.queryByTestId('agent-edit')).toBeNull();
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
