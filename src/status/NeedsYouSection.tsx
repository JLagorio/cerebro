import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useDecisions, usePendingVersion } from '@/knowledge/usePendingCards';
import * as ipc from '@/lib/ipc';
import type { ReviewCard, RevertableApplication } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { ProposalCard } from './ProposalCard';
import { opVerb, reasonSentence } from './proposalText';

/**
 * The proposal queue, as a section of the Status hub (M33.3) — and, since
 * M33a.2 folded that hub into Knowledge, as its "Waiting on you" tab. The
 * rename is not cosmetic: Knowledge already had a "Needs review" row for
 * CONCEPTS a human has not verified, and two unrelated queues under one
 * string is a nav that lies about where a click lands.
 *
 * This is `ReviewPage`'s body, moved rather than rewritten, and every testid
 * is unchanged so `review.spec.ts` can prove the move dropped nothing. M52.2
 * moved it once more: the card is `ProposalCard` and the approve, reject and
 * revert handlers are `useDecisions`, because a concept page shows the same
 * cards now and two copies of a decision handler are two chances to send
 * different arguments.
 *
 * **What DID change is the failure state.** `ReviewPage` collapsed a failed
 * read into an empty one — `catch` set the cards to `[]` and the surface said
 * "Nothing is waiting". That told a person with an unreadable ledger that
 * their base had no pending decisions, which is the exact sentence the
 * `Feed<T>` contract (`knowledge/BaseItself.tsx`) exists to prevent. A read
 * that did not come back now says so.
 *
 * Every card is still rebuilt from the ledger on each load — nothing here is
 * cached, so this list cannot drift from what the vault actually holds. A
 * decision made anywhere (here, or on the concept it targets) bumps the
 * queue's version and this section re-reads.
 */

/** Columns of a reading width that fill the tab: three across at 2000px,
 * two at 1440, one where one fits. */
const GRID = 'grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(min(100%,480px),1fr))]';

/** The concept an application changed, by name, opening it — or "a concept"
 * when no file projects it: never a guess. */
function ConceptOpener({
  path,
  title,
  onOpen,
}: {
  path: string | null;
  title: (path: string) => string;
  onOpen: (path: string) => void;
}) {
  if (path === null) return <>a concept</>;
  return (
    <button
      type="button"
      data-testid="revertable-open"
      data-path={path}
      onClick={() => onOpen(path)}
      className="border-0 bg-transparent p-0 text-sm font-semibold text-cortex-600 hover:underline"
    >
      {title(path)}
    </button>
  );
}

/** The section's three states, matching the `Feed<T>` contract in
 * `knowledge/BaseItself.tsx`. */
type Queue = { cards: ReviewCard[]; applications: RevertableApplication[] };
type State = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; data: Queue };

export function NeedsYouSection({ vaultPath }: { vaultPath: string | null }) {
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const version = usePendingVersion();
  const { busy, decide, undo, isSettled, isReverted } = useDecisions(vaultPath);
  const [state, setState] = useState<State>({ kind: 'loading' });

  // `version` is the one deliberate re-read: a decision anywhere bumps it.
  // `live` (M52.4) drops an answer that lands after a newer read started or
  // the section unmounted: two reads in flight could land out of order, and
  // the older one would put a decided card back on screen.
  useEffect(() => {
    if (vaultPath === null) {
      setState({ kind: 'unavailable' });
      return;
    }
    let live = true;
    void (async () => {
      try {
        const [cards, applications] = await Promise.all([
          ipc.reviewQueue(vaultPath),
          ipc.revertableApplications(vaultPath),
        ]);
        if (live) setState({ kind: 'ready', data: { cards, applications } });
      } catch {
        // NOT an empty state. See the module note: a vault whose ledger could
        // not be read has an unknown number of pending decisions, and "nothing
        // is waiting" would be this surface inventing good news.
        if (live) setState({ kind: 'unavailable' });
      }
    })();
    return () => {
      live = false;
    };
  }, [vaultPath, version]);

  if (state.kind === 'loading') return <p className="text-xs text-n-400">Reading…</p>;
  if (state.kind === 'unavailable') {
    return (
      <p data-testid="section-unavailable" className="text-xs text-n-500">
        The review queue could not be read, so nothing here is a statement about this vault.
      </p>
    );
  }

  const { cards, applications } = state.data;
  if (cards.length === 0 && applications.length === 0) {
    return (
      <p data-testid="section-empty" className="text-xs text-n-500">
        Nothing is waiting on a decision.
      </p>
    );
  }

  return (
    <>
      {/* The cards fill the tab's width in columns of a reading width
          (M52.5), rather than one 880px column beside 800px of nothing:
          three across at 2000px, two at 1440, one where there is room for
          one. A row's cards share a height, so their answers line up. */}
      {cards.length > 0 && (
        <div data-testid="review-cards" className={GRID}>
          {cards.map((card) => (
            <ProposalCard
              key={card.proposal_id}
              card={card}
              busy={busy || isSettled(card.proposal_id)}
              onDecide={(c, approve, reason) => void decide(c, approve, reason)}
            />
          ))}
        </div>
      )}

      {applications.length > 0 ? (
        <>
          <h3 className="mb-1 mt-3 text-xs font-medium text-n-600">Applied — still undoable</h3>
          {/* The cards' columns (M52.5), so Revert sits by its line. */}
          <div className={GRID}>
            {applications.map((application) => (
              <article
                key={application.proposal_id}
                data-testid="revertable"
                data-proposal={application.proposal_id}
                className="flex items-center gap-3 rounded-lg border border-n-200 p-3"
              >
                <Icon name="undo-2" size={14} className="flex-none" />
                {/* What changed, by name, as a card's headline says it
                    (M52.5): "Revise" alone named no concept. */}
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span
                    className="text-sm font-medium text-n-900"
                    data-op={application.op}
                    title={application.op}
                  >
                    {opVerb(application.op).verb}{' '}
                    <ConceptOpener
                      path={application.path ?? null}
                      title={(path) => entries.find((e) => e.path === path)?.title ?? path}
                      onOpen={(path) => navigate({ kind: 'doc', path })}
                    />
                  </span>
                  <span className="text-xs text-n-500">{reasonSentence(application.reason)}</span>
                </span>
                <Button
                  className="ml-auto"
                  disabled={busy || isReverted(application.proposal_id)}
                  testId="revert"
                  onClick={() => void undo(application)}
                >
                  Revert
                </Button>
              </article>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
