// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangesView, LanesView, PipelineOverview, ReviewCard } from '@/lib/ipc';
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
const pipelineOverview = vi.fn<(vault: string) => Promise<PipelineOverview>>();

vi.mock('@/lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('@/lib/ipc')>('@/lib/ipc');
  return {
    ...actual,
    converge: (vault: string) => converge(vault),
    attentionLanes: (vault: string) => attentionLanes(vault),
    reviewQueue: (vault: string) => reviewQueue(vault),
    pipelineOverview: (vault: string) => pipelineOverview(vault),
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

describe('EpistemicStatusPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useVaultStore.setState({ vaultPath: '/demo-vault' });
    converge.mockResolvedValue(QUIET_CHANGES);
    attentionLanes.mockResolvedValue(EMPTY_LANES);
    reviewQueue.mockResolvedValue([]);
    pipelineOverview.mockResolvedValue(HEALTH);
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

  it('counts the queue and marks how much of it is HIGH or CRITICAL', async () => {
    const card = (risk: string): ReviewCard =>
      ({ proposal_id: risk, effective_risk: risk }) as ReviewCard;
    reviewQueue.mockResolvedValue([card('LOW'), card('HIGH'), card('CRITICAL')]);
    render(<EpistemicStatusPage />);

    const summary = await screen.findByTestId('review-summary');
    expect(summary.getAttribute('data-urgent')).toBe('2');
    expect(summary.textContent).toContain('3 cards are');
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

    await waitFor(() => expect(screen.getAllByTestId('section-unavailable').length).toBe(4));
    expect(converge).not.toHaveBeenCalled();
  });
});
