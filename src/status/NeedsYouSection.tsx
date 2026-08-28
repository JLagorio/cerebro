import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import * as ipc from '@/lib/ipc';
import type { ReviewCard, RevertableApplication } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';

/**
 * The proposal queue, as a section of the Status hub (M33.3) — and, since
 * M33a.2 folded that hub into Knowledge, as its "Waiting on you" tab. The
 * rename is not cosmetic: Knowledge already had a "Needs review" row for
 * CONCEPTS a human has not verified, and two unrelated queues under one
 * string is a nav that lies about where a click lands.
 *
 * This is `ReviewPage`'s body, moved rather than rewritten: the card layout,
 * the approve/reject handlers, the reason guard and the revert list are the
 * same code, and every testid is unchanged so `review.spec.ts` can prove the
 * move dropped nothing.
 *
 * **What DID change is the failure state.** `ReviewPage` collapsed a failed
 * read into an empty one — `catch` set the cards to `[]` and the surface said
 * "Nothing is waiting". That told a person with an unreadable ledger that
 * their base had no pending decisions, which is the exact sentence the
 * `Feed<T>` contract (`knowledge/BaseItself.tsx`) exists to prevent. A read
 * that did not come back now says so.
 *
 * Every card is still rebuilt from the ledger on each load — nothing here is
 * cached, so this list cannot drift from what the vault actually holds. The
 * card leads with what a reviewer needs to DECIDE with: the operation, the
 * risk, why it is waiting, and which targets moved underneath it.
 *
 * Rejection asks for a reason before it will send. That is not politeness —
 * the server refuses a reasonless rejection, and a refusal nobody can learn
 * from later is the shape this milestone exists to avoid.
 */

const RISK_COLOR: Record<string, string> = {
  LOW: 'var(--n-500)',
  MEDIUM: 'var(--info-600)',
  HIGH: 'var(--warn-600)',
  CRITICAL: 'var(--danger-500)',
};

/** Who a decision is recorded as. The ledger keeps the reviewer, so this is
 * a name in the permanent record and not a UI label. */
const REVIEWER = 'human:me';

function riskChip(risk: string) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide"
      style={{ color: RISK_COLOR[risk] ?? 'var(--n-500)', border: '1px solid currentColor' }}
      data-testid="card-risk"
    >
      {risk}
    </span>
  );
}

/** The section's three states, matching the `Feed<T>` contract in
 * `knowledge/BaseItself.tsx`. */
type Queue = { cards: ReviewCard[]; applications: RevertableApplication[] };
type State = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; data: Queue };

export function NeedsYouSection({ vaultPath }: { vaultPath: string | null }) {
  const toast = useUiStore((s) => s.toast);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (vaultPath === null) {
      setState({ kind: 'unavailable' });
      return;
    }
    try {
      const [cards, applications] = await Promise.all([
        ipc.reviewQueue(vaultPath),
        ipc.revertableApplications(vaultPath),
      ]);
      setState({ kind: 'ready', data: { cards, applications } });
    } catch {
      // NOT an empty state. See the module note: a vault whose ledger could
      // not be read has an unknown number of pending decisions, and "nothing
      // is waiting" would be this surface inventing good news.
      setState({ kind: 'unavailable' });
    }
  }, [vaultPath]);

  useEffect(() => {
    void load();
  }, [load]);

  // Proposal channels are the AGENTS.md carve-out: the result is READ, not
  // toasted away. A queued set that did not resolve, and a rejection the
  // server refused, are different answers and the reviewer sees both.
  async function decide(card: ReviewCard, approve: boolean) {
    if (vaultPath === null) return;
    setBusy(true);
    try {
      const transition = await ipc.decideProposal(
        vaultPath,
        card.proposal_id,
        approve,
        REVIEWER,
        reasons[card.proposal_id] ?? null,
      );
      if (transition === null) {
        toast('Recorded — the rest of this set is still waiting');
      } else if (transition === 'apply') {
        toast('Applied');
      } else if (transition === 'stale_reject') {
        toast('Refused: the world moved while this waited');
      } else {
        toast('Rejected');
      }
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'the decision was refused');
    } finally {
      setBusy(false);
    }
  }

  async function undo(application: RevertableApplication) {
    if (vaultPath === null) return;
    setBusy(true);
    try {
      await ipc.revertApplication(
        vaultPath,
        application.proposal_id,
        [application.applied_event_id],
        REVIEWER,
      );
      toast('Reverted — the original change is still in the record');
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'the revert was refused');
    } finally {
      setBusy(false);
    }
  }

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
      {cards.map((card) => {
        const stale = card.targets.some((t) => t.stale);
        return (
          <article
            key={card.proposal_id}
            data-testid="review-card"
            data-proposal={card.proposal_id}
            className="rounded-lg border border-[var(--n-200)] p-4"
          >
            <header className="flex items-center gap-2">
              <span className="font-medium" data-testid="card-op">
                {card.op}
              </span>
              {riskChip(card.effective_risk)}
              {card.review === 'diff' ? (
                <span className="text-[11px] text-[var(--danger-500)]" data-testid="card-diff">
                  diff review
                </span>
              ) : null}
              <span className="ml-auto text-xs text-[var(--n-500)]">{card.actor}</span>
            </header>

            <p className="mt-1 text-sm text-[var(--n-600)]">{card.reason}</p>

            {/* WHY IT IS WAITING. The table's own words, not a paraphrase. */}
            {card.queued_for.length > 0 ? (
              <p className="mt-2 text-xs text-[var(--warn-600)]" data-testid="card-queued-for">
                {card.queued_for.join(', ')}
              </p>
            ) : null}

            {stale ? (
              <p className="mt-2 text-xs text-[var(--danger-500)]" data-testid="card-stale">
                The world moved while this waited — approving it will be refused.
              </p>
            ) : null}

            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-[var(--n-500)]">
              <div>
                <dt className="inline">Intended use </dt>
                <dd className="inline text-[var(--n-700)]">
                  {card.intended_use_kind} · {card.intended_use_stakes}
                </dd>
              </div>
              <div>
                <dt className="inline">Because </dt>
                <dd className="inline text-[var(--n-700)]">{card.transition_cause}</dd>
              </div>
              <div>
                <dt className="inline">Evidence </dt>
                <dd className="inline text-[var(--n-700)]">{card.evidence_refs.length}</dd>
              </div>
              <div>
                <dt className="inline">Coverage </dt>
                <dd className="inline text-[var(--n-700)]">{card.coverage_refs.length}</dd>
              </div>
            </dl>

            <ul className="mt-3 space-y-1 text-xs" data-testid="card-targets">
              {card.targets.map((target) => (
                <li key={`${target.target_class}/${target.target_id}`} className="font-mono">
                  <span className="text-[var(--n-500)]">{target.target_class}</span>{' '}
                  {target.target_id.slice(0, 8)}{' '}
                  <span className={target.stale ? 'text-[var(--danger-500)]' : ''}>
                    @{target.expected_version ?? 'new'} → {target.current_version ?? 'absent'}
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-3 flex items-center gap-2">
              <Button
                variant="primary"
                disabled={busy}
                testId="approve"
                onClick={() => void decide(card, true)}
              >
                Approve
              </Button>
              <Input
                value={reasons[card.proposal_id] ?? ''}
                placeholder="Why not?"
                testId="reject-reason"
                onChange={(e) => setReasons((r) => ({ ...r, [card.proposal_id]: e.target.value }))}
              />
              <Button
                disabled={busy || (reasons[card.proposal_id] ?? '').trim() === ''}
                testId="reject"
                onClick={() => void decide(card, false)}
              >
                Reject
              </Button>
            </div>
          </article>
        );
      })}

      {applications.length > 0 ? (
        <>
          <h3 className="mb-1 mt-3 text-xs font-medium text-[var(--n-600)]">
            Applied — still undoable
          </h3>
          {applications.map((application) => (
            <article
              key={application.proposal_id}
              data-testid="revertable"
              data-proposal={application.proposal_id}
              className="flex items-center gap-3 rounded-lg border border-[var(--n-200)] p-3"
            >
              <Icon name="undo-2" size={14} />
              <span className="text-sm font-medium">{application.op}</span>
              <span className="text-xs text-[var(--n-500)]">{application.reason}</span>
              <Button
                className="ml-auto"
                disabled={busy}
                testId="revert"
                onClick={() => void undo(application)}
              >
                Revert
              </Button>
            </article>
          ))}
        </>
      ) : null}
    </>
  );
}
