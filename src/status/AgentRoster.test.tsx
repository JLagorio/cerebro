// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeEntry } from '@/engine/testHelpers';
import type { FleetActorSummary, PipelineOverview, ReviewCard } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import { AgentRoster, liveState } from './AgentRoster';

/**
 * Who works here (M33b.3), and what each of them is doing (M33b.4).
 *
 * Two claims under test and nothing else. **Absent is never zero**: an agent
 * that has never run, a total nobody metered and a queue that could not be
 * read each get a sentence, and none of those sentences is a number. And
 * **the state chip never asserts calm it cannot support**: "idle" says three
 * things at once — nothing running, nothing queued, nothing stopped — so a
 * failed read of any of the three has to cost it that word.
 *
 * The precedence itself is a pure function and is tested as one; the
 * component specs are about what reaches the screen.
 */

const fleetActorSummaries = vi.fn<() => Promise<FleetActorSummary[]>>();
const fleetRuns = vi.fn<() => Promise<unknown[]>>();
const reviewQueue = vi.fn<(vault: string) => Promise<ReviewCard[]>>();
const pipelineOverview = vi.fn<(vault: string) => Promise<PipelineOverview>>();

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return {
    ...actual,
    fleetActorSummaries: () => fleetActorSummaries(),
    fleetRuns: () => fleetRuns(),
    reviewQueue: (vault: string) => reviewQueue(vault),
    pipelineOverview: (vault: string) => pipelineOverview(vault),
  };
});

afterEach(cleanup);

const VAULT = '/demo-vault';
/** The clock every relative time in here is measured against. */
const NOW = new Date('2026-07-28T12:00:00Z');

const agentEntry = (title: string, properties: Record<string, unknown> = {}) =>
  makeEntry({
    path: `records/agents/${title.toLowerCase().replace(/\s+/g, '-')}.md`,
    filename: 'agent.md',
    folder: 'records/agents',
    title,
    type: 'Agent',
    properties: properties as never,
  });

function summary(over: Partial<FleetActorSummary> = {}): FleetActorSummary {
  return {
    actor: 'process:release-scout',
    run_count: 2,
    input_tokens: 1_000,
    output_tokens: 200,
    unknown_runs: 0,
    running_runs: 0,
    last_outcome: 'succeeded',
    last_started_at: '2026-07-28T09:00:00Z',
    ...over,
  };
}

function card(over: Partial<ReviewCard> = {}): ReviewCard {
  return {
    proposal_id: 'p1',
    commit_set_id: 'c1',
    run_id: 'r1',
    actor: 'process:release-scout',
    op: 'update_belief',
    effective_risk: 'HIGH',
    review: null,
    queued_for: [],
    intended_use_kind: 'ReversibleWork',
    intended_use_stakes: 'HIGH',
    transition_cause: 'new_evidence',
    evidence_refs: [],
    coverage_refs: [],
    authority_refs: [],
    targets: [],
    reason: 'because',
    set_members: ['p1'],
    set_ready: true,
    ...over,
  };
}

const roster = () => <AgentRoster vaultPath={VAULT} focus={null} onFocus={() => {}} now={NOW} />;

describe('liveState (M33b.4)', () => {
  const facts = {
    running: 0,
    waiting: 0,
    onDuty: true,
    paused: false,
  };

  it('lets a run in flight beat everything else', () => {
    expect(liveState({ ...facts, running: 1, waiting: 3, paused: true })).toBe('working');
  });

  it('puts a queued decision above the pause, which does not un-queue it', () => {
    expect(liveState({ ...facts, waiting: 2, paused: true })).toBe('waiting');
  });

  it('calls an agent nothing can fire not-activated rather than paused', () => {
    // A description is not a stopped daemon, and calling it paused would
    // imply a resume button exists for it.
    expect(liveState({ ...facts, onDuty: false, paused: true })).toBe('inactive');
  });

  it('refuses to say idle when a fact the idle claim rests on was not read', () => {
    expect(liveState({ ...facts, waiting: null })).toBe('unknown');
    expect(liveState({ ...facts, paused: null })).toBe('unknown');
    expect(liveState({ ...facts, running: null })).toBe('unknown');
    // And with all three known and quiet, it is allowed to say it.
    expect(liveState(facts)).toBe('idle');
  });
});

describe('AgentRoster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVaultStore.setState({
      vaultPath: VAULT,
      entries: [agentEntry('Release scout', { slug: 'release-scout' })],
    });
    fleetActorSummaries.mockResolvedValue([summary()]);
    fleetRuns.mockResolvedValue([]);
    reviewQueue.mockResolvedValue([]);
    pipelineOverview.mockResolvedValue({ global_pause: false } as PipelineOverview);
  });

  it('lists an agent that has never run, rather than only ones that are busy', async () => {
    // D6: a fleet that only showed working agents would answer "what is
    // happening" and not "who works here".
    fleetActorSummaries.mockResolvedValue([]);
    render(roster());

    const row = await screen.findByTestId('agent-row');
    expect(row.getAttribute('data-actor')).toBe('process:release-scout');
    expect(screen.getByTestId('agent-last-run').textContent).toBe('has never run');
    // Never an epoch, a dash, or a zero.
    expect(screen.getByTestId('agent-spend').textContent).toContain('no runs yet');
    expect(row.textContent).not.toContain('$0');
  });

  it('says a record with no schedule is a description, not a daemon', async () => {
    render(roster());
    await screen.findByTestId('agent-row');
    expect(screen.getByTestId('agent-state').getAttribute('data-state')).toBe('inactive');
    expect(screen.getByTestId('agent-duty').textContent).toContain('description, not a daemon');
  });

  it('says when an activated agent last ran, and when it fires next', async () => {
    // The carried M33.1–.10 defect, on the surface that inherited it: these
    // rows named who and what and never once said WHEN.
    useVaultStore.setState({
      entries: [agentEntry('Release scout', { slug: 'release-scout', schedule: 'daily 09:00' })],
    });
    render(roster());

    await screen.findByTestId('agent-row');
    expect(screen.getByTestId('agent-last-run').textContent).toBe('3 hours ago');
    expect(screen.getByTestId('agent-duty').textContent).toContain('next ');
    expect(screen.getByTestId('agent-state').getAttribute('data-state')).toBe('idle');
  });

  it('names the unmetered runs a lifetime total could not include', async () => {
    fleetActorSummaries.mockResolvedValue([summary({ run_count: 3, unknown_runs: 1 })]);
    render(roster());

    const spend = await screen.findByTestId('agent-spend');
    expect(spend.textContent).toContain('1,200 tokens');
    expect(spend.textContent).toContain('1 run unmetered');
  });

  it('says not recorded, never $0, when nothing metered any of its runs', async () => {
    fleetActorSummaries.mockResolvedValue([summary({ run_count: 2, unknown_runs: 2 })]);
    render(roster());

    const spend = await screen.findByTestId('agent-spend');
    expect(spend.textContent).toContain('not recorded');
    expect(spend.textContent).toContain('2 runs unmetered');
    expect(spend.textContent).not.toContain('0 tokens');
  });

  it('reads working off a run still going, not off a recent timestamp', async () => {
    fleetActorSummaries.mockResolvedValue([summary({ running_runs: 1 })]);
    render(roster());

    await waitFor(() =>
      expect(screen.getByTestId('agent-state').getAttribute('data-state')).toBe('working'),
    );
  });

  it('counts what is queued against this agent and says a measured zero out loud', async () => {
    reviewQueue.mockResolvedValue([card(), card({ proposal_id: 'p2' }), card({ actor: 'other' })]);
    render(roster());

    await waitFor(() =>
      expect(screen.getByTestId('agent-waiting').textContent).toBe('2 waiting on you'),
    );
    expect(screen.getByTestId('agent-state').getAttribute('data-state')).toBe('waiting');

    cleanup();
    reviewQueue.mockResolvedValue([]);
    render(roster());
    await waitFor(() =>
      expect(screen.getByTestId('agent-waiting').textContent).toBe('nothing waiting on you'),
    );
  });

  it('says which read failed, and costs the row its claim to be idle', async () => {
    // "Nothing is waiting" and "we could not tell you what is waiting" are
    // opposite sentences.
    useVaultStore.setState({
      entries: [agentEntry('Release scout', { slug: 'release-scout', schedule: 'daily 09:00' })],
    });
    reviewQueue.mockRejectedValue(new Error('no ledger'));
    render(roster());

    await waitFor(() =>
      expect(
        screen
          .getAllByTestId('section-unavailable')
          .some((n) => n.textContent?.includes('proposal queue')),
      ).toBe(true),
    );
    expect(screen.getByTestId('agent-waiting').textContent).toBe('queue not read');
    expect(screen.getByTestId('agent-state').getAttribute('data-state')).toBe('unknown');
    // The other two reads stand. The row still knows when it last ran.
    expect(screen.getByTestId('agent-last-run').textContent).toBe('3 hours ago');
  });

  it('keeps the team on screen when the run history is what failed', async () => {
    fleetActorSummaries.mockRejectedValue(new Error('no runtime database'));
    render(roster());

    // Who works here came off the vault, not off the read that failed, so
    // hiding the roster would answer a question we can still answer.
    const row = await screen.findByTestId('agent-row');
    expect(row.getAttribute('data-actor')).toBe('process:release-scout');
    expect(screen.getByTestId('agent-last-run').textContent).toBe('last run not read');
    expect(screen.getByTestId('agent-spend').textContent).toBe('spend not read');
    expect(
      screen
        .getAllByTestId('section-unavailable')
        .some((n) => n.textContent?.includes('run history')),
    ).toBe(true);
  });

  it('names actors that ran here with no record, without giving them a row', async () => {
    // The internal constructs. A row implies a persona, and a batched run has
    // no memory and no judgment (M26's name-discipline trap).
    fleetActorSummaries.mockResolvedValue([
      summary(),
      summary({ actor: 'agent:m26-ingest' }),
      summary({ actor: 'agent:m26-maintenance' }),
    ]);
    render(roster());

    expect(await screen.findAllByTestId('agent-row')).toHaveLength(1);
    const note = screen.getByTestId('roster-unowned');
    expect(note.textContent).toContain('agent:m26-ingest');
    expect(note.textContent).toContain('agent:m26-maintenance');
    expect(note.textContent).not.toContain('process:release-scout');
  });

  it('hands the clicked agent up so the history below can narrow to it', async () => {
    const onFocus = vi.fn();
    render(<AgentRoster vaultPath={VAULT} focus={null} onFocus={onFocus} now={NOW} />);
    fireEvent.click(await screen.findByTestId('agent-row'));
    expect(onFocus).toHaveBeenCalledWith('process:release-scout');

    // And clicking the selected one lets go of it — a filter you cannot clear
    // is a trap.
    cleanup();
    onFocus.mockClear();
    render(
      <AgentRoster vaultPath={VAULT} focus="process:release-scout" onFocus={onFocus} now={NOW} />,
    );
    fireEvent.click(await screen.findByTestId('agent-row'));
    expect(onFocus).toHaveBeenCalledWith(null);
  });

  it('says there are no agent records rather than rendering an empty list', async () => {
    useVaultStore.setState({ entries: [] });
    render(roster());
    expect((await screen.findByTestId('roster-empty')).textContent).toContain('No agent records');
  });
});
