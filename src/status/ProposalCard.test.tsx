// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry, Scalar } from '@/engine/types';
import type { ReviewCard } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { ProposalCard } from './ProposalCard';

/**
 * A card a person can decide from (M52.2): the headline in the app's words,
 * the reason as the main sentence — and every code the ledger recorded still
 * on the card, because the words are this build's and the codes are history.
 */

const PATH = 'knowledge/systems/offline-guarantee.md';

function entry(
  path: string,
  title: string,
  properties: Record<string, Scalar | Scalar[]> = {},
): Entry {
  return {
    path,
    filename: path.split('/').pop() ?? '',
    folder: path.slice(0, path.lastIndexOf('/')),
    project: null,
    title,
    type: null,
    properties,
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-01T00:00:00Z',
    parseError: null,
  };
}

const CARD: ReviewCard = {
  proposal_id: 'p0000000000000000000000000000001',
  commit_set_id: 'c1',
  run_id: 'run-scout-1',
  actor: 'process:release-scout',
  op: 'update_belief',
  effective_risk: 'HIGH',
  review: null,
  queued_for: ['high_stakes_verification_required'],
  intended_use_kind: 'ReversibleWork',
  intended_use_stakes: 'HIGH',
  transition_cause: 'new_evidence',
  evidence_refs: ['e1', 'e2', 'e3'],
  coverage_refs: ['c1'],
  authority_refs: [],
  targets: [
    {
      target_class: 'belief',
      target_id: 'b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1',
      expected_version: 3,
      current_version: 4,
      stale: true,
      path: PATH,
    },
  ],
  reason: 'the sync error rate has been above its threshold for six days, not two',
  set_members: ['p0000000000000000000000000000001'],
  set_ready: true,
};

beforeEach(() => {
  useVaultStore.setState({
    vaultPath: '/vault',
    entries: [
      entry(PATH, 'The offline guarantee'),
      {
        ...entry('records/agents/release-scout.md', 'Release scout', { slug: 'release-scout' }),
        type: 'Agent',
      },
    ],
  });
});

afterEach(cleanup);

describe('ProposalCard (M52.2)', () => {
  it('leads with what would change, in the app words, and keeps the op on the element', () => {
    render(<ProposalCard card={CARD} busy={false} onDecide={() => undefined} />);
    const headline = screen.getByTestId('card-op');
    expect(headline.textContent).toBe('Revise The offline guarantee');
    expect(headline.dataset.op).toBe('update_belief');
    // The proposer's reason, as a sentence (M52.5).
    expect(screen.getByTestId('card-reason').textContent).toBe(
      'The sync error rate has been above its threshold for six days, not two',
    );
    // Its risk, named and in sentence case; the rung itself on the element.
    const risk = screen.getByTestId('card-risk');
    expect(risk.textContent).toBe('High risk');
    expect(risk.dataset.risk).toBe('HIGH');
    // Who asks, as the agent it is; the stamp stays in the tooltip.
    const author = screen.getByTestId('card-author');
    expect(author.textContent).toBe('Release scout');
    expect(author.getAttribute('title')).toBe('process:release-scout');
  });

  it('names a construct the way the fleet does, not by its stamp (M52.4)', () => {
    render(
      <ProposalCard
        card={{ ...CARD, actor: 'agent:m26-maintenance' }}
        busy={false}
        onDecide={() => undefined}
      />,
    );
    const author = screen.getByTestId('card-author');
    expect(author.textContent).toBe('Background maintenance');
    expect(author.getAttribute('title')).toBe('agent:m26-maintenance');
    // No record answers to a construct, so there is nothing to open.
    expect(author.tagName).toBe('SPAN');
    // M52.5 — a glyph like an agent's byline has, in neutral ink rather than
    // an agent's: a bot beside one name and bare text beside the next read as
    // two kinds of byline.
    const glyph = author.querySelector('svg');
    expect(glyph).not.toBeNull();
    expect((glyph as SVGElement | null)?.style.color).toBe('var(--n-500)');
  });

  it('says why it waits and what moved in sentences, with the codes still recorded', () => {
    render(<ProposalCard card={CARD} busy={false} onDecide={() => undefined} />);
    const held = screen.getByTestId('card-queued-for');
    // What it lacks, off its own refs: a coverage check is cited below, a
    // sign-off is not (M52.5).
    expect(held.textContent).toBe(
      'Needs a person: it backs a high-stakes decision and nobody has signed off on it yet.',
    );
    expect(held.dataset.codes).toBe('high_stakes_verification_required');
    // M52.5 — what happened, not what Approve would do: it is disabled.
    expect(screen.getByTestId('card-stale').textContent).toBe(
      'The offline guarantee changed after this was proposed.',
    );
    expect(screen.getByTestId('card-basis').textContent).toBe(
      'Based on 3 sources and 1 coverage check',
    );
    // Stakes and why-now are Details' words, not the card's face.
    const face = screen.getByTestId('review-card');
    const details = screen.getByTestId('card-details');
    expect(face.textContent?.replace(details.textContent ?? '', '')).not.toMatch(
      /reversible|Why now|at high stakes/,
    );
    expect(screen.getByTestId('card-purpose').textContent).toBe(
      'Proposed because of new evidence, for reversible work at high stakes.',
    );

    // Details holds the ledger's record verbatim — nothing is lost to the copy.
    for (const code of [
      'update_belief',
      'high_stakes_verification_required',
      'ReversibleWork · HIGH',
      'new_evidence',
      'evidence 3 · coverage 1 · authority 0',
      'process:release-scout',
    ]) {
      expect(details.textContent).toContain(code);
    }
    expect(within(details).getByTestId('card-targets').textContent).toContain('@3 → 4');
  });

  it('opens the concept it would change', () => {
    render(<ProposalCard card={CARD} busy={false} onDecide={() => undefined} />);
    fireEvent.click(screen.getByTestId('card-target-open'));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: PATH });
  });

  it('on its own concept page, calls the target "this concept" and links nowhere', () => {
    render(<ProposalCard card={CARD} here={PATH} busy={false} onDecide={() => undefined} />);
    expect(screen.getByTestId('card-op').textContent).toBe('Revise this concept');
    expect(screen.queryByTestId('card-target-open')).toBeNull();
    expect(screen.getByTestId('card-stale').textContent).toContain('This concept changed');
  });

  it('names an op it has no verb for by its code, read aloud', () => {
    render(
      <ProposalCard
        card={{
          ...CARD,
          op: 'add_relation',
          targets: [{ ...CARD.targets[0], target_class: 'relation', path: null, stale: false }],
        }}
        busy={false}
        onDecide={() => undefined}
      />,
    );
    expect(screen.getByTestId('card-op').textContent).toBe('Add relation — a link');
  });

  it('approves, and rejects only with a reason', () => {
    const onDecide = vi.fn();
    const current = {
      ...CARD,
      targets: [{ ...CARD.targets[0], current_version: 3, stale: false }],
    };
    render(<ProposalCard card={current} busy={false} onDecide={onDecide} />);
    const reject = screen.getByTestId('reject') as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('reject-reason'), { target: { value: 'not yet' } });
    expect(reject.disabled).toBe(false);
    fireEvent.click(reject);
    expect(onDecide).toHaveBeenLastCalledWith(current, false, 'not yet');
    fireEvent.click(screen.getByTestId('approve'));
    expect(onDecide).toHaveBeenLastCalledWith(current, true, 'not yet');
    expect(screen.queryByTestId('ask-fresh')).toBeNull();
  });

  // M52.5 — "approving it will be refused" sat above an enabled, primary
  // Approve. The act a stale card offers is to ask for it again.
  it('offers a fresh proposal in place of an Approve the ledger would refuse', () => {
    const onDecide = vi.fn();
    useUiStore.setState({ aiPanelOpen: false, agentPendingPrompt: null });
    render(<ProposalCard card={CARD} busy={false} onDecide={onDecide} />);
    expect((screen.getByTestId('approve') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('ask-fresh'));
    const asked = useUiStore.getState().agentPendingPrompt;
    expect(asked?.subject).toBe(PATH);
    expect(asked?.label).toBe('Ask for a fresh proposal · The offline guarantee');
    expect(asked?.text).toContain(CARD.proposal_id);
    expect(asked?.text).toContain('changed after this was proposed');
    expect(asked?.text).toContain(CARD.reason);
    expect(onDecide).not.toHaveBeenCalled();
    // Rejecting the stale card itself stays possible.
    fireEvent.change(screen.getByTestId('reject-reason'), { target: { value: 'stale' } });
    fireEvent.click(screen.getByTestId('reject'));
    expect(onDecide).toHaveBeenLastCalledWith(CARD, false, 'stale');
  });

  it('names both ends of a link and what one is to the other (M52.5)', () => {
    const other = 'knowledge/playbooks/warehouse-cutover.md';
    useVaultStore.setState({
      entries: [
        ...useVaultStore.getState().entries,
        entry(other, 'Warehouse cutover: go-live and rollback'),
      ],
    });
    render(
      <ProposalCard
        card={{
          ...CARD,
          op: 'edit_relation',
          targets: [
            {
              target_class: 'relation',
              target_id: 'r'.repeat(32),
              expected_version: null,
              current_version: null,
              stale: false,
              link: { action: 'add', relation: 'refines', from_path: PATH, to_path: other },
            },
          ],
        }}
        busy={false}
        onDecide={() => undefined}
      />,
    );
    expect(screen.getByTestId('card-op').textContent).toBe(
      'Add a link: The offline guarantee refines Warehouse cutover: go-live and rollback',
    );
    const ends = screen.getAllByTestId('card-link-end');
    expect(ends.map((e) => e.dataset.path)).toEqual([PATH, other]);
    fireEvent.click(ends[1]);
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: other });
  });

  it('says "a concept" for an end no file answers to, and "this concept" on its page', () => {
    render(
      <ProposalCard
        card={{
          ...CARD,
          op: 'edit_relation',
          targets: [
            {
              target_class: 'relation',
              target_id: 'r'.repeat(32),
              expected_version: null,
              current_version: null,
              stale: false,
              link: { action: 'remove', relation: 'supersedes', from_path: PATH, to_path: null },
            },
          ],
        }}
        here={PATH}
        busy={false}
        onDecide={() => undefined}
      />,
    );
    expect(screen.getByTestId('card-op').textContent).toBe(
      'Remove the link: this concept replaces a concept',
    );
  });

  // M52.5 — Review lays the cards in a grid of reading-width columns, so a
  // card fills its cell to the row's height instead of capping itself; on
  // its concept's page it sits flush inside the review bar.
  it('fills its cell in Review, and sits flush in the page bar', () => {
    const { container, rerender } = render(
      <ProposalCard card={CARD} busy={false} onDecide={() => undefined} />,
    );
    const card = () => container.querySelector('article')?.className ?? '';
    expect(card()).toContain('h-full');
    expect(card()).toContain('border');
    expect(card()).not.toContain('max-w-');
    rerender(<ProposalCard card={CARD} here={PATH} busy={false} onDecide={() => undefined} />);
    expect(card()).not.toContain('max-w-');
    expect(card()).not.toContain('border');
  });
});
