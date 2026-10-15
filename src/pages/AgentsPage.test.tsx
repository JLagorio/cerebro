import { navSeed } from '@/test/navSeed';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __seedFleet, __seedWakes, resetMockFs, type FleetRun } from '@/lib/mockIpc';
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
    cause: null,
    cli_session_id: null,
    ...over,
  };
}

describe('AgentsPage', () => {
  beforeEach(async () => {
    resetMockFs();
    await useVaultStore.getState().openVault('/demo-vault');
    useNavStore.setState({
      selection: { kind: 'agents' },
      history: [navSeed({ kind: 'agents' })],
      historyIndex: 0,
    });
  });
  afterEach(cleanup);

  it('the lobby composes the roster over the run feed, and a row opens the agent’s Runs', async () => {
    render(<AgentsPage selection={{ kind: 'agents' }} />);
    const knowledgeRow = (await screen.findAllByTestId('agent-row')).find((r) =>
      r.textContent?.includes('Knowledge'),
    );
    if (knowledgeRow === undefined) throw new Error('knowledge agent missing from roster');
    // The run feed is here too — one surface for who and what ran.
    expect(await screen.findByTestId('fleet-section')).toBeTruthy();

    // On this surface an agent is a DESTINATION, not a filter: its page,
    // on the tab that says what it has done (M55.12).
    fireEvent.click(knowledgeRow);
    expect(useNavStore.getState().selection).toEqual({
      kind: 'doc',
      path: 'records/agents/knowledge.md',
      tab: 'runs',
    });
  });

  it('the lobby names what is waiting to wake its agents, between the roster and the feed (M63.1b)', async () => {
    __seedWakes([
      {
        vault: '/demo-vault',
        agent: 'process:release-scout',
        admittedAt: new Date(Date.now() - 60_000).toISOString(),
        cause: { kind: 'event', subject: 'records/risks/gone.md' },
      },
    ]);
    const { container } = render(<AgentsPage selection={{ kind: 'agents' }} />);
    const row = await screen.findByTestId('agent-wake');
    expect(row.getAttribute('data-state')).toBe('pending');
    const section = container.querySelector('[data-section="wakes"]');
    expect(section?.contains(row)).toBe(true);
    // Nested in the fleet section, after the roster and before the feed.
    const fleet = container.querySelector('[data-section="fleet"]');
    expect(fleet?.contains(section ?? null)).toBe(true);
    const order = [...(fleet?.querySelectorAll('[data-testid]') ?? [])]
      .map((el) => el.getAttribute('data-testid'))
      .filter((id) => id === 'agent-row' || id === 'agent-wakes' || id === 'fleet-section');
    expect(order.indexOf('agent-wakes')).toBeGreaterThan(order.lastIndexOf('agent-row'));
    expect(order.indexOf('agent-wakes')).toBeLessThan(order.indexOf('fleet-section'));
  });

  it('an actor with a record forwards to its page, and Back returns to the lobby', async () => {
    const actor = { kind: 'agents' as const, actor: 'process:release-scout' };
    useNavStore.getState().navigate(actor);
    expect(useNavStore.getState().history).toHaveLength(2);
    const { container } = render(<AgentsPage selection={actor} />);
    await waitFor(() =>
      expect(useNavStore.getState().selection).toEqual({
        kind: 'doc',
        path: 'records/agents/release-scout.md',
      }),
    );
    // Replaced, not pushed: the forwarder is never a step Back lands on.
    expect(useNavStore.getState().history).toHaveLength(2);
    expect(container.textContent).toBe('');
    useNavStore.getState().back();
    expect(useNavStore.getState().selection).toEqual({ kind: 'agents' });
  });

  it('a construct page says it is internal, in plain words, and keeps its runs', async () => {
    __seedFleet([run({ run_id: 'ingest-1', actor: 'agent:m26-ingest' })]);
    render(<AgentsPage selection={{ kind: 'agents', actor: 'agent:m26-ingest' }} />);
    const page = await screen.findByTestId('agent-construct');
    // Nothing to edit: no property rows, no page to forward to.
    expect(screen.queryByTestId('agent-properties')).toBeNull();
    expect(useNavStore.getState().selection).toEqual({ kind: 'agents' });
    // M52.3: its name, not its stamp, and no milestone jargon.
    expect(page.textContent).toContain('Ingest is work Cerebro runs itself');
    expect(page.textContent).not.toContain('agent:m26-ingest');
    expect(page.textContent).not.toContain('M35');
    expect(await screen.findByTestId('agent-run')).toBeTruthy();
    // A construct is never woken, so its page lists no wakes.
    expect(screen.queryByTestId('agent-wakes')).toBeNull();
  });

  it('a dangling actor is absent, said as absent', async () => {
    render(<AgentsPage selection={{ kind: 'agents', actor: 'process:gone' }} />);
    expect(await screen.findByText('No agent answers to this name')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'All agents' }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'agents' });
  });
});
