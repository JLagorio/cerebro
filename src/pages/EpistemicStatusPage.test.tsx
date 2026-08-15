// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChangesView,
  LanesView,
  PipelineOverview,
  ReviewCard,
  RevertableApplication,
  TriggerEntryStatus,
  TriggerRunReport,
  VerificationScope,
} from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';
import { EpistemicStatusPage } from './EpistemicStatusPage';

/**
 * The Epistemic Status surface (M27.8c).
 *
 * These specs are about ONE thing: that a section which could not read its
 * feed never renders as a section with nothing in it. Everything else on this
 * page is layout over sentences Rust composed, and asserting the wording here
 * would only pin a copy of it.
 */

const converge = vi.fn<(vault: string) => Promise<ChangesView>>();
const attentionLanes = vi.fn<(vault: string) => Promise<LanesView>>();
const reviewQueue = vi.fn<(vault: string) => Promise<ReviewCard[]>>();
// M33.3: the needs section reads BOTH halves of the queue itself, so the
// revertables need a stub too — without one the section's own read throws and
// it renders `unavailable`, which would quietly mask what these specs assert.
const revertableApplications = vi.fn<(vault: string) => Promise<RevertableApplication[]>>();
const pipelineOverview = vi.fn<(vault: string) => Promise<PipelineOverview>>();
const triggerStatus = vi.fn<(vault: string) => Promise<TriggerEntryStatus[]>>();
const triggerRun = vi.fn<(vault: string) => Promise<TriggerRunReport>>();
const triggerR7Scope = vi.fn<(vault: string) => Promise<VerificationScope | null>>();
const triggerDeclareR7Scope = vi.fn<(vault: string, scopeJson: string) => Promise<string>>();

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return {
    ...actual,
    converge: (vault: string) => converge(vault),
    attentionLanes: (vault: string) => attentionLanes(vault),
    reviewQueue: (vault: string) => reviewQueue(vault),
    revertableApplications: (vault: string) => revertableApplications(vault),
    pipelineOverview: (vault: string) => pipelineOverview(vault),
    triggerStatus: (vault: string) => triggerStatus(vault),
    triggerRun: (vault: string) => triggerRun(vault),
    triggerR7Scope: (vault: string) => triggerR7Scope(vault),
    triggerDeclareR7Scope: (vault: string, scopeJson: string) =>
      triggerDeclareR7Scope(vault, scopeJson),
  };
});

afterEach(cleanup);

const QUIET_CHANGES: ChangesView = {
  schema_version: 'convergence-v1',
  window: { from_seq: 0, to_seq: 0 },
  quiet: true,
  sections: [],
};

function lane(partial: Partial<LanesView['lanes'][number]> & { id: string }) {
  return {
    label: partial.id,
    blurb: 'what belongs here',
    empty_text: `Nothing in ${partial.id}.`,
    protected: false,
    items: [],
    withheld: 0,
    ...partial,
  };
}

const EMPTY_LANES: LanesView = {
  rule_version: 'lanes-v1',
  lanes: [lane({ id: 'contradiction', protected: true }), lane({ id: 'staleness' })],
  withheld: 0,
  incomplete: [],
};

const HEALTH: PipelineOverview = {
  global_pause: false,
  runtime_status: 'ready',
  meter: {
    window_start_utc: '2026-08-12T00:00:00.000Z',
    window_end_utc: '2026-08-13T00:00:00.000Z',
    timezone_id: 'UTC',
    ceiling_state: 'under_budget',
    ceiling_reasons: [],
    accounting_state: 'exact',
    runs_started: 0,
    max_daily_runs: 20,
    tokens_used: 0,
    max_daily_tokens: 200000,
    output_tokens_used: 0,
    max_daily_output_tokens: 40000,
    reserved_total_tokens: 0,
    reserved_output_tokens: 0,
  } as PipelineOverview['meter'],
  lanes: [],
  activity: [],
  banners: [],
  held: { baseline_held: 0, recovery_held: 0, pending_review: 0, pending: 0 },
};

const BOARD: TriggerEntryStatus[] = [
  {
    registry_id: 'R8',
    capability: 'Curiosity as a construct',
    scope: 'vault_store',
    note: null,
    gates: [
      {
        gate: 'R8:root',
        variant: 'discretionary',
        note: 'awaiting a dated owner evidence pack',
        latest: null,
      },
    ],
  },
  {
    registry_id: 'R13',
    capability: 'Discovery execution',
    scope: 'vault_store',
    note: null,
    gates: [{ gate: 'R13:root', variant: 'measurable', note: null, latest: null }],
  },
  {
    registry_id: 'R14',
    capability: 'Live connectors',
    scope: 'vault_store',
    note: 'no connector is registered yet — connector:<id> gates appear as connectors register',
    gates: [],
  },
];

const RUN_REPORT: TriggerRunReport = {
  evaluated_at: '2026-08-14T09:00:00Z',
  timezone: 'UTC',
  gates: [
    {
      gate: 'R13:root',
      outcome: {
        kind: 'recorded',
        result: 'not_ready',
        evaluation_id: 'e'.repeat(64),
        replayed: false,
      },
    },
    {
      gate: 'R7:root',
      outcome: {
        kind: 'not_evaluated',
        reason: 'no verification scope is declared for this vault',
      },
    },
    {
      gate: 'R1:root',
      outcome: { kind: 'error', message: 'the projection artifact is unreadable' },
    },
  ],
};

describe('EpistemicStatusPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVaultStore.setState({ vaultPath: '/demo-vault' });
    converge.mockResolvedValue(QUIET_CHANGES);
    attentionLanes.mockResolvedValue(EMPTY_LANES);
    reviewQueue.mockResolvedValue([]);
    revertableApplications.mockResolvedValue([]);
    pipelineOverview.mockResolvedValue(HEALTH);
    triggerStatus.mockResolvedValue(BOARD);
    triggerRun.mockResolvedValue(RUN_REPORT);
    triggerR7Scope.mockResolvedValue(null);
    triggerDeclareR7Scope.mockResolvedValue('a'.repeat(64));
  });

  it('renders every lane the feed declares, including the ones holding nothing', async () => {
    render(<EpistemicStatusPage />);
    await waitFor(() => expect(screen.getByTestId('status-page')).toBeTruthy());

    const sections = await screen.findAllByTestId('status-section');
    const ids = sections.map((s) => s.getAttribute('data-section'));
    expect(ids).toContain('contradiction');
    expect(ids).toContain('staleness');
    // Its own words, not a shared "nothing here" — the lane knows what it
    // means to be empty and this page does not.
    expect(screen.getByText('Nothing in contradiction.')).toBeTruthy();
  });

  it('shows the protected badge only where a preference could not have hidden it', async () => {
    render(<EpistemicStatusPage />);
    const badges = await screen.findAllByTestId('protected-badge');
    expect(badges).toHaveLength(1);
  });

  /** The failure this page exists to prevent: a read that did not come back
   * rendering as a base with nothing wrong with it. */
  it('says a feed could not be read instead of rendering its empty state', async () => {
    attentionLanes.mockRejectedValue(new Error('no ledger'));
    render(<EpistemicStatusPage />);

    const said = await screen.findByTestId('section-unavailable');
    expect(said.textContent).toContain('The attention lanes');
    // And no lane claimed to be empty on the strength of a failed read.
    expect(screen.queryByText('Nothing in contradiction.')).toBeNull();
  });

  it('keeps the other sections when one feed refuses', async () => {
    converge.mockRejectedValue(new Error('this vault has no ledger store'));
    render(<EpistemicStatusPage />);

    await screen.findByTestId('section-unavailable');
    // The lanes are a separate call and a separate answer.
    expect(await screen.findByText('Nothing in contradiction.')).toBeTruthy();
  });

  it('reports what a preference held back rather than showing fewer in silence', async () => {
    attentionLanes.mockResolvedValue({
      ...EMPTY_LANES,
      lanes: [
        lane({
          id: 'staleness',
          withheld: 3,
          items: [
            {
              lane: 'staleness',
              belief_id: 'b'.repeat(32),
              entity_id: 'entity',
              path: 'metrics/sync-error-rate.md',
              predicate: 'ci_status',
              state_stage: 'implemented',
              scope_text: 'ci_status at implemented',
              reasons: ['freshness_stale'],
              reason_text: 'past its freshness rule',
              reliance: ['qualified'],
              reliance_text: 'relied on: promoted past draft',
              edge_id: null,
              relation_id: null,
            },
          ],
        }),
      ],
      withheld: 3,
    });
    render(<EpistemicStatusPage />);

    const item = await screen.findByTestId('lane-item');
    expect(item.getAttribute('data-reasons')).toBe('freshness_stale');
    expect(item.textContent).toContain('metrics/sync-error-rate.md');
    expect((await screen.findByTestId('lane-withheld')).textContent).toContain('3 more');
  });

  it('names a feed the backend could not see rather than dropping it', async () => {
    attentionLanes.mockResolvedValue({
      ...EMPTY_LANES,
      incomplete: ['Parked promotions could not be read, so epistemic debt may be under-reported.'],
    });
    render(<EpistemicStatusPage />);

    const note = await screen.findByTestId('lanes-incomplete');
    expect(note.textContent).toContain('under-reported');
  });

  // M33.3 INVERTED this. It used to assert the section was a COUNT and a
  // door — "3 cards are waiting, 2 at HIGH or CRITICAL" — because the cards
  // themselves lived on a separate tab. The tab is gone, so the count is the
  // thing that must not be here: the section renders the cards.
  it('holds the cards themselves rather than a count and a door', async () => {
    const card = (risk: string): ReviewCard =>
      ({
        proposal_id: risk,
        effective_risk: risk,
        op: `op_${risk}`,
        queued_for: [],
        targets: [],
        evidence_refs: [],
        coverage_refs: [],
      }) as unknown as ReviewCard;
    reviewQueue.mockResolvedValue([card('LOW'), card('HIGH'), card('CRITICAL')]);
    render(<EpistemicStatusPage />);

    const cards = await screen.findAllByTestId('review-card');
    expect(cards).toHaveLength(3);
    expect(screen.getAllByTestId('card-risk').map((c) => c.textContent)).toEqual([
      'LOW',
      'HIGH',
      'CRITICAL',
    ]);
    expect(screen.getAllByTestId('approve')).toHaveLength(3);
    expect(screen.queryByTestId('review-summary')).toBeNull();
  });

  // The defect the merge retires: `ReviewPage` turned a failed read into an
  // empty one, telling a person with an unreadable ledger that nothing was
  // waiting on them.
  it('says the review queue could not be read rather than borrowing the empty state', async () => {
    reviewQueue.mockRejectedValue(new Error('no ledger store for this vault'));
    render(<EpistemicStatusPage />);

    await waitFor(() =>
      expect(
        screen
          .getAllByTestId('section-unavailable')
          .some((n) => n.textContent?.includes('The review queue')),
      ).toBe(true),
    );
    expect(screen.queryByText('Nothing is waiting on a decision.')).toBeNull();
  });

  /** A day whose spend was lost is not a day with budget left. */
  it('never reports a ceiling state over a meter that could not account for itself', async () => {
    pipelineOverview.mockResolvedValue({
      ...HEALTH,
      meter: { ...HEALTH.meter, accounting_state: 'unknown' },
    });
    render(<EpistemicStatusPage />);

    const summary = await screen.findByTestId('health-summary');
    expect(summary.textContent).toContain('not fully accounted for');
    expect(summary.textContent).not.toContain('under budget');
  });

  it('renders nothing about a vault that is not open', async () => {
    useVaultStore.setState({ vaultPath: null });
    render(<EpistemicStatusPage />);

    await waitFor(() => expect(screen.getAllByTestId('section-unavailable').length).toBe(6));
    expect(converge).not.toHaveBeenCalled();
  });

  it('renders every gate the board declares, and never-evaluated is said, not omitted', async () => {
    render(<EpistemicStatusPage />);

    const rows = await screen.findAllByTestId('gate-row');
    expect(rows.map((row) => row.getAttribute('data-gate'))).toEqual(['R8:root', 'R13:root']);
    expect(rows[0].textContent).toContain('Never evaluated here.');
    expect(rows[0].textContent).toContain('awaiting a dated owner evidence pack');
    // R14 holds no gates and the entry says why instead of leaving a hole.
    expect((await screen.findByTestId('gate-entry-note')).textContent).toContain(
      'no connector is registered',
    );
  });

  it('a fired gate is loud and names the one thing firing licenses', async () => {
    triggerStatus.mockResolvedValue([
      {
        ...BOARD[1],
        gates: [
          {
            gate: 'R13:root',
            variant: 'measurable',
            note: null,
            latest: {
              evaluation_id: 'e'.repeat(64),
              result: 'fired',
              evaluated_at: '2026-08-14T09:00:00Z',
              window_end: '2026-08-14T00:00:00+02:00',
            },
          },
        ],
      },
    ]);
    render(<EpistemicStatusPage />);

    const row = await screen.findByTestId('gate-row');
    expect(row.getAttribute('data-result')).toBe('fired');
    expect(row.textContent).toContain('A firing licenses a dated plan, never code.');
    expect(screen.getByText(/R13:root has fired/)).toBeTruthy();
  });

  it('evaluate runs once, says what each gate did, and re-reads the board', async () => {
    render(<EpistemicStatusPage />);
    await screen.findAllByTestId('gate-row');
    expect(triggerStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('gates-evaluate'));

    const outcome = await screen.findByTestId('gates-run-outcome');
    expect(outcome.textContent).toContain('Evaluated 1 gate');
    const skips = screen.getAllByTestId('gates-run-skip');
    expect(skips.map((skip) => skip.textContent)).toEqual([
      'R7:root: no verification scope is declared for this vault',
      'R1:root: failed — the projection artifact is unreadable',
    ]);
    // The board was re-read so the newest rows are the ones on screen.
    await waitFor(() => expect(triggerStatus).toHaveBeenCalledTimes(2));
  });

  it('a run that refuses becomes a sentence, never a throw', async () => {
    triggerRun.mockRejectedValue(
      new Error('an R7 verification scope is declared, but this vault has no active ledger writer'),
    );
    render(<EpistemicStatusPage />);
    await screen.findAllByTestId('gate-row');

    fireEvent.click(screen.getByTestId('gates-evaluate'));

    const error = await screen.findByTestId('gates-run-error');
    expect(error.textContent).toContain('no active ledger writer');
  });

  it('declaring an R7 scope canonicalizes the lists before anything is sent', async () => {
    render(<EpistemicStatusPage />);
    expect((await screen.findByTestId('r7-scope-none')).textContent).toContain(
      'No scope is declared',
    );

    fireEvent.click(screen.getByTestId('r7-scope-open'));
    // Unsorted, duplicated, and padded with blank lines — the form's job is
    // to canonicalize, not to make a human hand-sort entity ids.
    fireEvent.change(screen.getByTestId('r7-scope-subjects'), {
      target: { value: '\nbbb\naaa\n\nbbb\n' },
    });
    fireEvent.change(screen.getByTestId('r7-scope-classes'), {
      target: { value: 'operational_status' },
    });
    fireEvent.change(screen.getByTestId('r7-scope-stage'), { target: { value: '  ' } });
    fireEvent.click(screen.getByTestId('r7-scope-save'));

    await screen.findByTestId('r7-scope-digest');
    expect(triggerDeclareR7Scope).toHaveBeenCalledWith(
      '/demo-vault',
      JSON.stringify({
        subjects: ['aaa', 'bbb'],
        predicate_classes: ['operational_status'],
        stage: null,
        environment: null,
        geography: null,
      }),
    );
    // The declared feed is re-read so the block shows what is now stored.
    await waitFor(() => expect(triggerR7Scope).toHaveBeenCalledTimes(2));
  });

  it('a refused declaration is a sentence beside the form, which stays open', async () => {
    triggerDeclareR7Scope.mockRejectedValue(
      new Error('a verification scope with no subjects verifies nothing'),
    );
    render(<EpistemicStatusPage />);
    await screen.findByTestId('r7-scope-none');

    fireEvent.click(screen.getByTestId('r7-scope-open'));
    fireEvent.click(screen.getByTestId('r7-scope-save'));

    expect((await screen.findByTestId('r7-scope-error')).textContent).toContain('verifies nothing');
    expect(screen.getByTestId('r7-scope-save')).toBeTruthy();
  });

  it('a declared scope renders as the question R7 is counting', async () => {
    triggerR7Scope.mockResolvedValue({
      subjects: ['e0000000000000000000000000000001'],
      predicate_classes: ['operational_status'],
      stage: 'implemented',
      environment: null,
      geography: null,
    });
    render(<EpistemicStatusPage />);

    const declared = await screen.findByTestId('r7-scope-declared');
    expect(declared.textContent).toContain('e0000000000000000000000000000001');
    expect(declared.textContent).toContain('operational_status');
    expect(declared.textContent).toContain('stage implemented');
  });
});
