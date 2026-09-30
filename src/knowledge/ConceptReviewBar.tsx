import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { resolveAuthor } from '@/engine/authors';
import {
  humanReviewed,
  localDayOf,
  recheckDue,
  recheckLine,
  sourceCount,
  verifyPatch,
  type Concept,
} from '@/engine/okf';
import { relativeDay } from '@/knowledge/KnowledgePanel';
import { FlagChip, ReviewChip } from '@/knowledge/ReviewChip';
import { useConcepts } from '@/knowledge/useConcepts';
import { useDecisions, usePendingCards } from '@/knowledge/usePendingCards';
import { verifyConcept } from '@/lib/ipc';
import { askedAbout, conceptAsk } from '@/lib/prompts';
import { refusalText } from '@/lib/refusal';
import { sha256Hex } from '@/lib/sha256';
import { todayIso } from '@/lib/templates';
import { ProposalCard } from '@/status/ProposalCard';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * A concept's review, as one bar under its title (M51.3): where it stands,
 * who wrote it, what it rests on — and the two acts that follow, Verify and
 * asking an agent to revise it (or, once it is due, to recheck it).
 *
 * A replaced concept offers neither (M52.3). Verifying a claim something
 * newer already overrode is busywork, and asking to revise it edits the
 * loser — so the bar says Replaced, and its one act opens what replaced it.
 *
 * It was the first tab of a side panel (M50.1), which made a concept page a
 * page, a review column and the assistant: four columns across, with the
 * decision in the narrowest of them. The evidence is still a click away —
 * the source count opens the panel's Details — but the verdict and the acts
 * sit where the page is read.
 *
 * `viewedBody` is the body exactly as the disk last gave it to the editor
 * (M49.3): Verify attests THAT text, and a file that changed underneath since
 * is refused as a stale view rather than signed unseen. `verifyBlocked` is
 * why Verify has to wait — an edit of the person's own still saving.
 *
 * **A change an agent proposed to this concept is decided here too
 * (M52.2).** The cards lived only in Review, so the page an agent wanted to
 * retire said nothing of it. The bar shows every queued card that targets
 * this file, as the same `ProposalCard` Review shows, with the same
 * handlers. A queue that could not be read shows nothing here: silence on a
 * page is not a claim that nothing is waiting — Review says it could not
 * tell.
 */
export function ConceptReviewBar({
  concept,
  viewedBody,
  verifyBlocked,
}: {
  concept: Concept;
  viewedBody: string | null;
  verifyBlocked: string | null;
}) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const actorId = useUiStore((s) => s.actorId);
  const askAgent = useUiStore((s) => s.askAgent);
  const setAiPanelOpen = useUiStore((s) => s.setAiPanelOpen);
  const setPanelOpen = useUiStore((s) => s.setConceptPanelOpen);
  const setPanelTab = useUiStore((s) => s.setConceptPanelTab);
  const navigate = useNavStore((s) => s.navigate);
  const all = useConcepts();
  const [verifying, setVerifying] = useState(false);
  const pending = usePendingCards(vaultPath);
  const { busy, decide, isSettled } = useDecisions(vaultPath);
  const today = todayIso();
  const proposals =
    pending.kind === 'ready'
      ? pending.data.filter((card) => card.targets.some((t) => t.path === concept.entry.path))
      : [];

  // M15: one sign-off per actor per day. "Verify again" used to append an
  // identical `{by, at}` row on every click, which is how the ledger filled
  // with four copies of the same stamp. The stamp's day is the reader's
  // (M52.4): `at` is a UTC instant, and its first ten characters are
  // yesterday for a morning Verify east of Greenwich.
  const verifiedToday = concept.verified.some(
    (stamp) =>
      stamp.by.kind === 'human' &&
      stamp.by.label === actorId &&
      localDayOf(stamp.at ?? '') === today,
  );
  // Loading disables Verify without a sentence — it lasts a frame, and a line
  // that flashes on every open reads as a warning.
  const blocked = viewedBody === null ? 'Loading the page…' : verifyBlocked;

  const verify = () => {
    if (vaultPath === null || verifiedToday || viewedBody === null) return;
    setVerifying(true);
    void (async () => {
      try {
        const patch = verifyPatch(concept.entry, `human:${actorId}`, new Date().toISOString());
        await verifyConcept(vaultPath, concept.entry.path, patch, sha256Hex(viewedBody));
        await rescan();
        // Said plainly, because verifying does not move the recheck date:
        // `stale_after` is the agent's (verify_concept writes `verified` and
        // nothing else), so the concept is still due one. It leaves Review
        // all the same — a person has looked since the date passed, and the
        // queue has nothing left to ask them — so the toast names what is
        // still owed and who owes it, not where the concept is filed.
        toast(
          concept.stale
            ? `Verified "${concept.title}" — it stays due a recheck until an agent rechecks it`
            : `Verified "${concept.title}"`,
        );
      } catch (err) {
        toast(`Couldn't verify: ${refusalText(err)}`);
      } finally {
        setVerifying(false);
      }
    })();
  };
  const act = conceptAsk({ path: concept.entry.path, title: concept.title, stale: concept.stale });
  const ask = () => askAgent(act.text, concept.entry.path, askedAbout(act.label, concept.title));
  // A replaced concept carries no back-pointer of its own (M8.7: the
  // replacement holds `supersedes`), so what replaced it is looked up.
  const replacedBy = concept.supersededBy;
  const replacement =
    replacedBy === null ? null : (all.find((c) => c.entry.path === replacedBy) ?? null);

  const author = concept.generated === null ? null : resolveAuthor(concept.generated.by, entries);
  const written = concept.generated === null ? null : relativeDay(concept.generated.at, today);
  // Measured, or not recorded (M52.5): a file with no `sources` key said
  // "Cites no source" here while the table said "not recorded" — an empty
  // list is the first sentence, a missing key the second.
  const sources = sourceCount(concept.entry);
  const openDetails = () => {
    setPanelTab('details');
    setPanelOpen(true);
  };

  const reviewChip =
    replacedBy !== null ? (
      <FlagChip icon="archive" label="Replaced" tone="muted" />
    ) : (
      <ReviewChip
        status={concept.review}
        by={concept.reviewedBy}
        detail={relativeDay(concept.lastVerified, today)}
      />
    );
  // A replaced concept is due nothing: the queue has dropped it. How late,
  // as the table says it; the date itself is the hover.
  const recheckChip =
    concept.stale && replacedBy === null ? (
      <FlagChip
        icon="clock-alert"
        label={recheckLine(concept, today)}
        tone="warn"
        title={recheckDue(concept) === null ? undefined : `Recheck date ${recheckDue(concept)}`}
      />
    ) : null;
  const deprecatedChip =
    concept.lifecycle === 'deprecated' ? (
      <FlagChip icon="archive" label="Deprecated" tone="muted" />
    ) : null;
  // The chip that leads is the word the concept's row wears (`statusOf` in
  // `ConceptTable`), so the table and the page it opens name one state
  // first: what is wrong with its review, else a recheck it is due, else its
  // retirement, else its review. A reviewed concept past its date led with
  // "Reviewed" here beside a row that said "Due a recheck".
  const lead =
    replacedBy !== null || concept.review !== 'current'
      ? 'review'
      : recheckChip !== null
        ? 'recheck'
        : deprecatedChip !== null
          ? 'deprecated'
          : 'review';
  // A change an agent proposed to this concept is the decision the page is
  // waiting on (M52.5): its card's Approve leads, and Verify and the ask
  // step back to secondary rather than competing with it.
  const proposalWaits = proposals.length > 0;

  return (
    <div
      data-testid="concept-review-bar"
      className="mb-4 ml-[54px] flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-n-200 bg-n-25 px-3 py-2"
    >
      {/* A 320px basis, not `flex-1`'s zero (M52.3): at zero the standing
          never claimed a width, so a narrow column squeezed it to a sliver
          beside the buttons — the chip broke over three lines — instead of
          letting the buttons wrap below it. */}
      <div className="flex min-w-0 flex-[1_1_320px] flex-wrap items-center gap-x-2 gap-y-1 text-xs text-n-600">
        {lead === 'recheck' && recheckChip}
        {lead === 'deprecated' && deprecatedChip}
        {reviewChip}
        {lead !== 'recheck' && recheckChip}
        {lead !== 'deprecated' && deprecatedChip}
        {concept.lifecycle === 'draft' && (
          <FlagChip icon="pencil-line" label="Draft" tone="muted" />
        )}
        {/* Who wrote it and what it rests on, as one unit (M52.3): it wraps
            below the chips whole, so a line never ends — or starts — on the
            separator. */}
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1">
            Written by
            {author === null ? (
              // Absent is never zero: nobody recorded who wrote it.
              <span className="text-n-500">— not recorded</span>
            ) : author.kind === 'agent' || author.kind === 'assistant' ? (
              <button
                type="button"
                data-testid="review-bar-author"
                data-author={author.kind}
                title={concept.generated?.by.raw}
                onClick={() =>
                  author.kind === 'agent'
                    ? navigate({ kind: 'agents', actor: author.actor })
                    : setAiPanelOpen(true)
                }
                className="inline-flex items-center gap-1 border-0 bg-transparent p-0 text-xs font-medium text-n-800 hover:text-cortex-600"
              >
                <Icon
                  name={author.kind === 'agent' ? 'bot' : 'sparkles'}
                  size={12}
                  color="var(--synapse-500)"
                />
                {author.kind === 'agent' ? author.title : 'Assistant'}
              </button>
            ) : (
              <span className="font-medium text-n-800" title={concept.generated?.by.raw}>
                {author.label}
              </span>
            )}
            {written !== null && <span className="text-n-500">{written}</span>}
          </span>
          {/* And the separator travels with the count, for the column too
            narrow to hold the unit on one line. */}
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="text-n-400">
              ·
            </span>
            <button
              type="button"
              data-testid="review-bar-sources"
              onClick={openDetails}
              className={`border-0 bg-transparent p-0 text-xs hover:text-cortex-600 ${
                sources === 0 ? 'text-warn-700' : sources === null ? 'text-n-500' : 'text-n-600'
              }`}
            >
              {sources === null
                ? 'Sources not recorded'
                : sources === 0
                  ? 'Cites no source'
                  : `${sources} ${sources === 1 ? 'source' : 'sources'}`}
            </button>
          </span>
        </span>
      </div>
      <div className="flex flex-none items-center gap-1.5">
        {replacedBy !== null ? (
          <Button
            variant="primary"
            size="sm"
            icon="arrow-right"
            testId="open-replacement"
            onClick={() => navigate({ kind: 'doc', path: replacedBy })}
          >
            {replacement === null ? 'Open the newer concept' : `Open ${replacement.title}`}
          </Button>
        ) : (
          <>
            {/* M52.3 — on a stale concept the recheck leads. Verifying does
                not move `stale_after` (it is the agent's), so Verify alone
                leaves it due; elsewhere Verify leads and asking is the aside.
                Neither leads while a proposal waits on this concept. */}
            <Button
              variant={concept.stale && !proposalWaits ? 'primary' : 'secondary'}
              size="sm"
              icon="sparkles"
              testId={concept.stale ? 'recheck-concept' : 'revise-concept'}
              onClick={ask}
            >
              {act.label}
            </Button>
            <Button
              variant={concept.stale || proposalWaits ? 'secondary' : 'primary'}
              size="sm"
              icon="shield-check"
              disabled={verifying || verifiedToday || blocked !== null}
              onClick={verify}
            >
              {verifiedToday
                ? 'Verified by you today'
                : humanReviewed(concept)
                  ? 'Verify again'
                  : 'Verify'}
            </Button>
          </>
        )}
      </div>
      {replacedBy === null && viewedBody !== null && verifyBlocked !== null && (
        <p data-testid="verify-blocked" className="m-0 w-full text-2xs text-n-500">
          {verifyBlocked}
        </p>
      )}
      {proposals.length > 0 && (
        <section
          data-testid="concept-proposals"
          aria-label="Proposed changes"
          className="flex w-full flex-col gap-3 border-t border-n-200 pt-2.5"
        >
          {proposals.map((card) => (
            <ProposalCard
              key={card.proposal_id}
              card={card}
              here={concept.entry.path}
              busy={busy || isSettled(card.proposal_id)}
              onDecide={(c, approve, reason) => void decide(c, approve, reason)}
            />
          ))}
        </section>
      )}
    </div>
  );
}
