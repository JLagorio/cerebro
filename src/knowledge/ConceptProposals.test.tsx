// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listConcepts, reviewQueue as conceptQueue } from '@/engine/okf';
import type { Entry } from '@/engine/types';
import type { ReviewCard, RevertableApplication } from '@/lib/ipc';
import { todayIso } from '@/lib/templates';
import { NeedsYouSection } from '@/status/NeedsYouSection';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { ConceptReviewBar } from './ConceptReviewBar';
import { ConceptTable, ReviewQueueList } from './ConceptTable';
import { proposalsByPath } from './usePendingCards';

/**
 * A proposal shown on the concept it would change (M52.2).
 *
 * The cards lived only in Review, so the page an agent wanted to retire said
 * nothing of it. What is held here: the page shows the cards that target it
 * and decides them with the SAME arguments Review sends; a failed read says
 * nothing on a page; a decision in either place refreshes both; and a queue
 * row says when its concept also has a card waiting.
 */

const reviewQueue = vi.fn<(vault: string) => Promise<ReviewCard[]>>();
const revertableApplications = vi.fn<(vault: string) => Promise<RevertableApplication[]>>();
const decideProposal =
  vi.fn<
    (
      vault: string,
      id: string,
      approve: boolean,
      reviewer: string,
      reason: string | null,
    ) => Promise<string | null>
  >();

vi.mock('@/lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ipc')>();
  return {
    ...actual,
    reviewQueue: (vault: string) => reviewQueue(vault),
    revertableApplications: (vault: string) => revertableApplications(vault),
    decideProposal: (
      vault: string,
      id: string,
      approve: boolean,
      reviewer: string,
      reason: string | null,
    ) => decideProposal(vault, id, approve, reviewer, reason),
    beliefChips: vi.fn(async () => []),
  };
});

const VAULT = '/vault';
const HERE = 'knowledge/systems/offline-guarantee.md';
const ELSEWHERE = 'knowledge/metrics/webinar-attendance.md';

function concept(path: string, title: string): Entry {
  return {
    path,
    filename: path.split('/').pop() ?? '',
    folder: path.slice(0, path.lastIndexOf('/')),
    project: null,
    title,
    type: 'Concept',
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-01T00:00:00Z',
    parseError: null,
  };
}

function card(id: string, path: string | null, op = 'tombstone_belief'): ReviewCard {
  return {
    proposal_id: id,
    commit_set_id: `c-${id}`,
    run_id: 'run-1',
    actor: 'claude-code',
    op,
    effective_risk: 'HIGH',
    review: null,
    queued_for: [],
    intended_use_kind: 'ReversibleWork',
    intended_use_stakes: 'LOW',
    transition_cause: 'new_evidence',
    evidence_refs: ['e1'],
    coverage_refs: [],
    authority_refs: [],
    targets: [
      {
        target_class: 'belief',
        target_id: `b-${id}`,
        expected_version: 1,
        current_version: 1,
        stale: false,
        path,
      },
    ],
    reason: 'replaced in the Q3 rewrite',
    set_members: [id],
    set_ready: true,
  };
}

const today = todayIso();
const conceptAt = (path: string) =>
  listConcepts(useVaultStore.getState().entries, today).find((c) => c.entry.path === path)!;

function Bar() {
  return <ConceptReviewBar concept={conceptAt(HERE)} viewedBody="# Body" verifyBlocked={null} />;
}

beforeEach(() => {
  reviewQueue.mockReset();
  revertableApplications.mockReset().mockResolvedValue([]);
  decideProposal.mockReset().mockResolvedValue('apply');
  useVaultStore.setState({
    vaultPath: VAULT,
    entries: [concept(HERE, 'The offline guarantee'), concept(ELSEWHERE, 'Webinar attendance')],
  });
});

afterEach(cleanup);

describe('the concept page (M52.2)', () => {
  it('shows the cards that target this concept, and only those', async () => {
    reviewQueue.mockResolvedValue([card('p1', HERE), card('p2', ELSEWHERE), card('p3', null)]);
    render(<Bar />);

    const proposals = await screen.findByTestId('concept-proposals');
    const cards = within(proposals).getAllByTestId('review-card');
    expect(cards.map((c) => c.dataset.proposal)).toEqual(['p1']);
    expect(within(proposals).getByTestId('card-op').textContent).toBe('Retire this concept');
    // Verify is where it was — and steps back while the card waits (M52.5):
    // the decision the page is waiting on is the card's, so its Approve is
    // the one primary act.
    const verify = screen.getByRole('button', { name: 'Verify' });
    expect(verify.className).toContain('cb-btn-secondary');
    expect(within(proposals).getByTestId('approve').className).toContain('cb-btn-primary');
  });

  it('says nothing when no card targets it', async () => {
    reviewQueue.mockResolvedValue([card('p2', ELSEWHERE)]);
    render(<Bar />);
    await waitFor(() => expect(reviewQueue).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByTestId('concept-proposals')).toBeNull();
    // With nothing waiting on it, Verify leads again.
    expect(screen.getByRole('button', { name: 'Verify' }).className).toContain('cb-btn-primary');
  });

  it('says nothing — not "nothing is waiting" — when the queue could not be read', async () => {
    reviewQueue.mockRejectedValue(new Error('no active ledger writer for this vault'));
    render(<Bar />);
    await waitFor(() => expect(reviewQueue).toHaveBeenCalled());
    await act(async () => undefined);
    expect(screen.queryByTestId('concept-proposals')).toBeNull();
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
    expect(screen.queryByTestId('section-empty')).toBeNull();
  });

  it('decides with exactly the arguments Review sends', async () => {
    reviewQueue.mockResolvedValue([card('p1', HERE)]);

    const { unmount } = render(<NeedsYouSection vaultPath={VAULT} />);
    fireEvent.click(await screen.findByTestId('approve'));
    await waitFor(() => expect(decideProposal).toHaveBeenCalledTimes(1));
    const fromReview = decideProposal.mock.calls[0];
    unmount();

    const page = render(<Bar />);
    let proposals = await screen.findByTestId('concept-proposals');
    fireEvent.click(within(proposals).getByTestId('approve'));
    await waitFor(() => expect(decideProposal).toHaveBeenCalledTimes(2));
    expect(decideProposal.mock.calls[1]).toEqual(fromReview);
    expect(fromReview).toEqual([VAULT, 'p1', true, 'human:me', null]);
    // That page has decided p1 and holds it (M52.4), so a fresh one rejects.
    page.unmount();

    // And a rejection carries its reason, as it does in Review.
    render(<Bar />);
    proposals = await screen.findByTestId('concept-proposals');
    fireEvent.change(within(proposals).getByTestId('reject-reason'), {
      target: { value: 'the rewrite kept it' },
    });
    fireEvent.click(within(proposals).getByTestId('reject'));
    await waitFor(() => expect(decideProposal).toHaveBeenCalledTimes(3));
    expect(decideProposal.mock.calls[2]).toEqual([
      VAULT,
      'p1',
      false,
      'human:me',
      'the rewrite kept it',
    ]);
  });

  it('a decision in either place refreshes both', async () => {
    let queue = [card('p1', HERE)];
    reviewQueue.mockImplementation(async () => queue);
    decideProposal.mockImplementation(async () => {
      queue = [];
      return 'apply';
    });
    render(
      <>
        <Bar />
        <div data-testid="review-tab">
          <NeedsYouSection vaultPath={VAULT} />
        </div>
      </>,
    );
    const proposals = await screen.findByTestId('concept-proposals');
    const tab = screen.getByTestId('review-tab');
    await waitFor(() => expect(within(tab).getAllByTestId('review-card')).toHaveLength(1));

    fireEvent.click(within(proposals).getByTestId('approve'));
    await waitFor(() => expect(screen.queryByTestId('concept-proposals')).toBeNull());
    await waitFor(() =>
      expect(within(tab).getByTestId('section-empty').textContent).toContain('Nothing is waiting'),
    );
  });

  // M52.4 — `busy` cleared when the decision resolved, and the card stayed on
  // screen, live, until the re-read landed: a second click decided it again.
  it('holds a decided card until the re-read takes it away', async () => {
    reviewQueue.mockResolvedValueOnce([card('p1', HERE)]).mockResolvedValueOnce([card('p1', HERE)]);
    let answer: (cards: ReviewCard[]) => void = () => undefined;
    const reread = new Promise<ReviewCard[]>((resolve) => {
      answer = resolve;
    });
    render(
      <>
        <Bar />
        <div data-testid="review-tab">
          <NeedsYouSection vaultPath={VAULT} />
        </div>
      </>,
    );
    const proposals = await screen.findByTestId('concept-proposals');
    const tab = screen.getByTestId('review-tab');
    await waitFor(() => expect(within(tab).getAllByTestId('review-card')).toHaveLength(1));
    reviewQueue.mockReturnValue(reread);

    fireEvent.click(within(proposals).getByTestId('approve'));
    await waitFor(() => expect(decideProposal).toHaveBeenCalledTimes(1));
    await act(async () => undefined);
    // Decided, re-read still in flight: the card is on screen, its buttons held.
    expect((within(proposals).getByTestId('approve') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(proposals).getByTestId('approve'));
    expect(decideProposal).toHaveBeenCalledTimes(1);

    await act(async () => answer([]));
    await waitFor(() => expect(screen.queryByTestId('concept-proposals')).toBeNull());
  });

  // M52.4 — Rust refusals lead with their policy code; the toast says the
  // sentence, as every other refusal the app shows.
  it('says why a decision was refused, without the code', async () => {
    reviewQueue.mockResolvedValue([card('p1', HERE)]);
    decideProposal.mockRejectedValue('stale_target_version: the target moved');
    useUiStore.setState({ toasts: [] });
    render(<NeedsYouSection vaultPath={VAULT} />);
    fireEvent.click(await screen.findByTestId('approve'));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.map((t) => t.message)).toEqual([
        "Couldn't decide: the target moved",
      ]),
    );
    // Refused, so nothing was decided: the card stays live.
    expect((screen.getByTestId('approve') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('the review queue row (M52.2)', () => {
  it('says when its concept also has a card waiting', () => {
    const queue = conceptQueue(listConcepts(useVaultStore.getState().entries, today));
    expect(queue.map((q) => q.concept.entry.path).sort()).toEqual([ELSEWHERE, HERE].sort());
    render(
      <ReviewQueueList
        queue={queue}
        proposals={proposalsByPath([card('p1', HERE, 'update_belief'), card('p2', null)])}
      />,
    );
    const marked = screen.getAllByTestId('queue-proposal');
    expect(marked).toHaveLength(1);
    const row = marked[0].closest('[data-testid="queue-row"]') as HTMLElement;
    expect(row.getAttribute('data-path')).toBe(HERE);
    // M52.5 — a mark beside the reason, not in its place: the row still says
    // why it is queued, and the card's own sentence is the mark's hover.
    expect(marked[0].textContent).toBe('+1 change');
    const hover = marked[0].querySelector('[title]')?.getAttribute('title') ?? '';
    expect(hover.split('\n')[0]).toBe('A proposal to revise it is waiting on you');
    expect(row.querySelector('[data-testid="queue-reason"]')?.textContent).toBe('Unreviewed');
  });

  it('counts the cards when more than one waits', () => {
    const queue = conceptQueue(listConcepts(useVaultStore.getState().entries, today));
    render(
      <ReviewQueueList
        queue={queue}
        proposals={proposalsByPath([card('p1', HERE, 'update_belief'), card('p2', HERE)])}
      />,
    );
    const [marked] = screen.getAllByTestId('queue-proposal');
    expect(marked.dataset.count).toBe('2');
    expect(marked.textContent).toBe('+2 changes');
  });

  // M52.5 — a link card marks both concepts it connects, so four rows said
  // "+1 change" under a header counting three proposals. Each end says
  // "+1 link", and its hover names the other end.
  it('marks a link card as a link on both of its ends, naming the other', () => {
    const queue = conceptQueue(listConcepts(useVaultStore.getState().entries, today));
    const link = card('p1', HERE, 'edit_relation');
    link.targets = [
      ...link.targets,
      { ...link.targets[0], target_id: 'b-other', path: ELSEWHERE },
      {
        target_class: 'relation',
        target_id: 'r-1',
        expected_version: null,
        current_version: null,
        stale: false,
        path: null,
        link: { action: 'add', relation: 'refines', from_path: HERE, to_path: ELSEWHERE },
      },
    ];
    render(
      <ReviewQueueList
        queue={queue}
        proposals={proposalsByPath([link, card('p2', HERE, 'update_belief')])}
      />,
    );
    const marks = screen.getAllByTestId('queue-proposal');
    const at = (path: string) =>
      marks.find((m) => m.closest('[data-testid="queue-row"]')?.getAttribute('data-path') === path);
    // One change and one link on this end, counted apart…
    expect(at(HERE)?.textContent).toBe('+1 change, +1 link');
    expect(at(HERE)?.dataset.count).toBe('2');
    const here = at(HERE)?.querySelector('[title]')?.getAttribute('title')?.split('\n') ?? [];
    expect(here).toContain('Add a link: this concept refines Webinar attendance');
    // …and the same card on the other end, naming this one.
    expect(at(ELSEWHERE)?.textContent).toBe('+1 link');
    expect(at(ELSEWHERE)?.querySelector('[title]')?.getAttribute('title')?.split('\n')[0]).toBe(
      'Add a link: The offline guarantee refines this concept',
    );
  });

  it('marks nothing when there is no answer', () => {
    const queue = conceptQueue(listConcepts(useVaultStore.getState().entries, today));
    render(<ReviewQueueList queue={queue} />);
    expect(screen.queryByTestId('queue-proposal')).toBeNull();
  });

  // M52.5 — the Concepts table carries the same mark, so a card waiting on a
  // concept nobody has queued (a reviewed one) is not only under Review.
  it('marks a filed row too, and only that row', () => {
    const concepts = listConcepts(useVaultStore.getState().entries, today);
    render(
      <ConceptTable
        sections={[{ folder: '', label: 'Ungrouped', concepts }]}
        queue={conceptQueue(concepts)}
        proposals={proposalsByPath([card('p1', HERE, 'update_belief')])}
      />,
    );
    const marked = screen.getAllByTestId('concept-proposal');
    expect(marked).toHaveLength(1);
    expect(marked[0].closest('[data-testid="concept-row"]')?.getAttribute('data-path')).toBe(HERE);
    // M52.5 — one status per row, and it is still the queue's reason: the
    // card is a mark beside it. It used to replace the reason, which hid
    // that the concept was queued at all.
    expect(marked[0].textContent).toBe('+1 change');
    const row = marked[0].closest('[data-testid="concept-row"]') as HTMLElement;
    const status = row.querySelectorAll('[data-status-value]');
    expect(status).toHaveLength(1);
    expect(status[0].textContent).toBe('Unreviewed');
  });

  // M52.5 — a reviewed concept with a change waiting on it read as finished
  // (green "Reviewed · by a person" beside a 13px glyph), and then, with the
  // change in the status's place, as a second state its page never named.
  // It says what its page says, and marks the change beside it.
  it('marks a waiting card beside a finished review, and keeps the review', () => {
    useVaultStore.setState({
      entries: [
        ...useVaultStore.getState().entries.filter((e) => e.path !== HERE),
        {
          ...useVaultStore.getState().entries.find((e) => e.path === HERE)!,
          properties: {
            verified: [{ by: 'human:josef', at: '2026-07-01' }],
          } as unknown as Entry['properties'],
        },
      ],
    });
    const concepts = listConcepts(useVaultStore.getState().entries, today);
    render(
      <ConceptTable
        sections={[{ folder: '', label: 'Ungrouped', concepts }]}
        queue={conceptQueue(concepts)}
        proposals={proposalsByPath([card('p1', HERE, 'update_belief')])}
      />,
    );
    const row = screen
      .getAllByTestId('concept-row')
      .find((r) => r.dataset.path === HERE) as HTMLElement;
    // M52.5 — the status stays the page's own ("Reviewed"), and the change
    // is the mark beside it: in its place, "Change proposed" hid that the
    // concept was reviewed while its page said so.
    const proposal = row.querySelector('[data-testid="concept-proposal"]');
    expect(proposal?.textContent).toBe('+1 change');
    expect(proposal?.hasAttribute('data-status-value')).toBe(false);
    const status = row.querySelector('[data-testid="review-chip"]');
    expect(status?.textContent).toBe('Reviewed');
    expect(status?.hasAttribute('data-status-value')).toBe(true);
  });
});
