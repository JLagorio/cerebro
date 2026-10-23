import { useId } from 'react';
import { proposalAnswers, proposalState } from '@/agent/elements/decisions';
import { Confirmation } from '@/components/ai/Confirmation';
import { Icon } from '@/components/ui/Icon';
import { actorLabel, isAssistantActor } from '@/engine/authors';
import { parseActor } from '@/engine/okf';
import { kindMeta } from '@/engine/properties';
import type { ReviewCard } from '@/lib/ipc';
import { FRESH_PROPOSAL_LABEL, askedAbout, freshProposalPrompt } from '@/lib/prompts';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import {
  basisText,
  conceptTargets,
  heldForText,
  linkOf,
  linkVerb,
  movedText,
  opVerb,
  purposeText,
  reasonSentence,
  relationVerb,
  riskLabel,
  riskTitle,
  targetName,
} from './proposalText';
import './review.css';

/**
 * One proposal an agent queued for a person (M52.2), wherever it is shown:
 * Review's "Waiting on you" and the concept page it would change. It is a
 * Confirmation (M91.14), the anatomy every card that asks shares.
 *
 * It reads top to bottom as the decision does — what would change, who asks,
 * why, why it waits for you, what it rests on, what moved underneath it —
 * and then the two answers. What it is meant for and why now, and the
 * ledger's own record (op, codes, intended use, targets and versions), are
 * one click down under Details: the words above are this build's copy, and
 * the codes are what was recorded.
 *
 * Every testid is the one `NeedsYouSection` carried since M24.9, so
 * `review.spec.ts` still proves the moves dropped nothing. `card-op` shows
 * the headline now; the op itself is its `data-op`, and the headline alone
 * names the card.
 */

const RISK_COLOR: Record<string, string> = {
  LOW: 'var(--text-meta)',
  // The chip named `--info-600`, a token the DS never defined, so MEDIUM
  // painted in whatever colour it inherited.
  MEDIUM: 'var(--cortex-600)',
  HIGH: 'var(--warn-700)',
  CRITICAL: 'var(--danger-700)',
};

/**
 * Who proposed this, in the app's own nouns — `actorLabel`, the one reading
 * the fleet, a run's header and the roster share (M52.3), so a worker has one
 * name wherever it is met: an agent is its record's title and opens it, the
 * attended assistant is the Assistant, a construct is "Background
 * maintenance". The raw stamp stays in the tooltip — it is what the ledger
 * recorded. Review's queued page writes name who asked by it too (M57.4c).
 */
export function CardAuthor({ actor }: { actor: string }) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const label = actorLabel(actor, entries);
  const agent = label.actor;
  if (agent !== undefined) {
    return (
      <button
        type="button"
        data-testid="card-author"
        title={actor}
        onClick={() => navigate({ kind: 'agents', actor: agent })}
        className="inline-flex items-center gap-1 border-0 bg-transparent p-0 text-xs font-medium text-n-700 hover:text-cortex-600"
      >
        <Icon name="bot" size={12} color="var(--synapse-500)" />
        {label.text}
      </button>
    );
  }
  // Anyone who is not an agent gets a glyph too, in neutral ink (M52.5): a
  // bot beside one name and bare text beside the next read as two kinds of
  // byline. A person is a person; the Assistant is its sparkle; a construct
  // or a stamp nobody recognises is background work.
  // Read through `parseActor`, which takes whatever the wire sent: a card
  // with no actor recorded is "unattributed", not a crash.
  const parsed = parseActor(actor);
  const icon =
    parsed?.kind === 'human'
      ? kindMeta('person').icon
      : parsed !== null && isAssistantActor(parsed.raw)
        ? 'sparkles'
        : 'cog';
  return (
    <span
      data-testid="card-author"
      title={actor}
      className="inline-flex items-center gap-1 text-xs font-medium text-n-700"
    >
      <Icon name={icon} size={12} color="var(--n-500)" />
      {label.text}
    </span>
  );
}

export function ProposalCard({
  card,
  here,
  busy,
  onDecide,
}: {
  card: ReviewCard;
  /** The concept page this card is shown on, if any: its own target reads
   * "this concept" rather than a link to where the reader already is, and
   * the card sits flush inside the page's review bar. */
  here?: string;
  /** A decision on its way, or one made here that waits for the queue's
   *  re-read (`useDecisions`, M52.4): the card offers nothing to press. */
  busy: boolean;
  onDecide: (card: ReviewCard, approve: boolean, reason: string | null) => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const askAgent = useUiStore((s) => s.askAgent);
  const headlineId = useId();
  const titleOf = (path: string) => entries.find((e) => e.path === path)?.title ?? path;

  const { verb, known } = opVerb(card.op);
  const concepts = conceptTargets(card);
  const named = concepts[0] ?? card.targets[0] ?? null;
  const more = concepts.length > 1 ? concepts.length - 1 : 0;
  const stale = card.targets.filter((t) => t.stale);
  const flush = here !== undefined;
  const link = linkOf(card);

  // M50.3: a concept target is named and opens — the card showed eight hex
  // of an id nobody could follow. `testId` is the one target's opener; a
  // link's two ends are `card-link-end`.
  const conceptName = (path: string | null | undefined, testId = 'card-target-open') =>
    path == null ? (
      'a concept'
    ) : path === here ? (
      'this concept'
    ) : (
      <button
        type="button"
        data-testid={testId}
        data-path={path}
        onClick={() => navigate({ kind: 'doc', path })}
        className="border-0 bg-transparent p-0 text-sm font-semibold text-cortex-600 hover:underline"
      >
        {titleOf(path)}
      </button>
    );
  const object =
    named === null
      ? null
      : named.path != null
        ? conceptName(named.path)
        : targetName(named, titleOf, here);

  // The headline: what would change, by name. A link names both of its ends
  // and what one is to the other (M52.5) — "Change a link" named neither.
  const headline =
    link !== null ? (
      <>
        {linkVerb(link)}: {conceptName(link.from_path, 'card-link-end')}{' '}
        <span className="font-normal text-n-600">{relationVerb(link)}</span>{' '}
        {conceptName(link.to_path, 'card-link-end')}
      </>
    ) : (
      <>
        {verb}
        {object !== null && (known ? ' ' : ' — ')}
        {object}
        {more > 0 && <span className="font-normal text-(--text-meta)"> and {more} more</span>}
      </>
    );

  // A card whose target moved cannot be approved: the ledger refuses it
  // (`stale_target_version`). So Approve is not offered as the act — the
  // act is to ask for the proposal again against what the concept says now,
  // and Reject stays for the card itself (M52.5).
  const askFresh = () => {
    const target = stale[0];
    const name = targetName(target, titleOf);
    askAgent(
      freshProposalPrompt({
        proposalId: card.proposal_id,
        change: `${verb.charAt(0).toLowerCase()}${verb.slice(1)} ${name}`,
        reason: card.reason,
        moved: movedText(target, name),
      }),
      target.path ?? null,
      askedAbout(FRESH_PROPOSAL_LABEL, name),
    );
  };
  const answers = proposalAnswers({
    stale: stale.length > 0,
    onApprove: () => onDecide(card, true, null),
    onAskFresh: askFresh,
    onReject: (reason) => onDecide(card, false, reason),
  });

  const basis = basisText(card);
  return (
    <Confirmation
      data-testid="review-card"
      data-proposal={card.proposal_id}
      // In Review it is one cell of a grid of reading-width columns (M52.5),
      // as tall as its row, with its answers at the foot so a row's line up
      // (review.css); on its concept's page it sits flush in the review bar.
      data-flush={flush ? '' : undefined}
      aria-labelledby={headlineId}
      variant="outline"
      state={proposalState(busy)}
      title={
        <>
          <h3
            id={headlineId}
            data-testid="card-op"
            data-op={card.op}
            title={card.op}
            className="m-0 text-section-title font-semibold text-n-900"
          >
            {headline}
          </h3>
          <span
            data-testid="card-risk"
            data-risk={card.effective_risk}
            title={riskTitle(card.effective_risk)}
            className="whitespace-nowrap rounded-xs px-1.5 py-0.5 text-metadata font-medium"
            style={{
              color: RISK_COLOR[card.effective_risk] ?? 'var(--text-meta)',
              border: '1px solid currentColor',
            }}
          >
            {riskLabel(card.effective_risk)}
          </span>
          {card.review === 'diff' ? (
            // The CRITICAL rung's review mode (`risk_ladder.CRITICAL.review`).
            <span
              data-testid="card-diff"
              title="Review mode: diff"
              className="text-metadata font-medium text-danger-700"
            >
              Read it closely
            </span>
          ) : null}
        </>
      }
      meta={
        <>
          Proposed by <CardAuthor actor={card.actor} />
        </>
      }
      // What happened underneath it, said before anyone presses Approve.
      notice={
        stale.length > 0 ? (
          <span className="text-danger-600">
            {stale.map((t) => movedText(t, targetName(t, titleOf, here))).join(' ')}
          </span>
        ) : null
      }
      testIds={{ notice: 'card-stale' }}
      approve={answers.approve}
      deny={answers.deny}
      className="cb-review-card"
    >
      {/* The proposer's own reason is the main sentence: it is what the
          decision is about. Display text — no rule reads it. */}
      <p data-testid="card-reason" className="m-0 text-ui text-n-700">
        {reasonSentence(card.reason)}
      </p>

      {/* WHY IT WAITS beyond its risk. The table carries codes, not
          sentences, so these are this build's words keyed by the table's
          own slot (M52.2); the codes ride on the element and in Details,
          and a code with no words is shown as itself. */}
      {card.queued_for.length > 0 ? (
        <p
          data-testid="card-queued-for"
          data-codes={card.queued_for.join(',')}
          className="m-0 text-xs text-warn-700"
        >
          {card.queued_for.map((code) => heldForText(code, card)).join(' ')}
        </p>
      ) : null}

      {basis !== null && (
        <p data-testid="card-basis" className="m-0 text-ui text-(--text-meta)">
          {basis}
        </p>
      )}

      <details data-testid="card-details" className="group">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-metadata text-(--text-meta) hover:text-n-800">
          <Icon name="chevron-right" size={11} className="motion-move group-open:rotate-90" />
          Details
        </summary>
        {/* The why-now and the what-for in words, then the codes they read. */}
        <p data-testid="card-purpose" className="m-0 mt-1.5 text-xs text-n-600">
          {purposeText(card)}
        </p>
        <dl className="m-0 mt-1.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-metadata text-(--text-meta) [font-family:var(--font-mono)]">
          <dt>op</dt>
          <dd className="m-0 text-n-700">{card.op}</dd>
          <dt>risk</dt>
          <dd className="m-0 text-n-700">
            {card.effective_risk}
            {card.review != null && ` · review ${card.review}`}
          </dd>
          <dt>held for</dt>
          <dd className="m-0 text-n-700">
            {card.queued_for.length === 0 ? 'none' : card.queued_for.join(', ')}
          </dd>
          <dt>intended use</dt>
          <dd className="m-0 text-n-700">
            {card.intended_use_kind} · {card.intended_use_stakes}
          </dd>
          <dt>cause</dt>
          <dd className="m-0 text-n-700">{card.transition_cause}</dd>
          <dt>basis</dt>
          <dd className="m-0 text-n-700">
            evidence {card.evidence_refs?.length ?? '—'} · coverage{' '}
            {card.coverage_refs?.length ?? '—'} · authority {card.authority_refs?.length ?? '—'}
          </dd>
          <dt>proposal</dt>
          <dd className="m-0 break-all text-n-700">
            {card.proposal_id} · {card.actor}
          </dd>
        </dl>
        <ul
          data-testid="card-targets"
          className="m-0 mt-1.5 list-none space-y-0.5 p-0 text-metadata text-(--text-meta) [font-family:var(--font-mono)]"
        >
          {card.targets.map((target) => (
            <li key={`${target.target_class}/${target.target_id}`}>
              {target.target_class} {target.path ?? target.target_id.slice(0, 8)}{' '}
              <span className={target.stale ? 'text-danger-600' : 'text-n-700'}>
                @{target.expected_version ?? 'new'} → {target.current_version ?? 'absent'}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </Confirmation>
  );
}
