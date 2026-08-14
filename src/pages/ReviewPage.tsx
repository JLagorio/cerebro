import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import * as ipc from '@/lib/ipc';
import type { ReviewCard, RevertableApplication } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

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

/**
 * Needs review (M24.9): what the base wants to change, and what it is
 * waiting for you to say about it.
 *
 * Every card is rebuilt from the ledger on each load — nothing here is
 * cached, so this list cannot drift from what the vault actually holds. The
 * card leads with what a reviewer needs to DECIDE with: the operation, the
 * risk, why it is waiting, and which targets moved underneath it.
 *
 * Rejection asks for a reason before it will send. That is not politeness —
 * the server refuses a reasonless rejection, and a refusal nobody can learn
 * from later is the shape this milestone exists to avoid.
 */
export function ReviewPage() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);
  const [cards, setCards] = useState<ReviewCard[]>([]);
  const [applications, setApplications] = useState<RevertableApplication[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (vaultPath === null) return;
    try {
      const [queue, undoable] = await Promise.all([
        ipc.reviewQueue(vaultPath),
        ipc.revertableApplications(vaultPath),
      ]);
      setCards(queue);
      setApplications(undoable);
    } catch {
      // A vault with no ledger has nothing to review. Not an error state —
      // an empty one.
      setCards([]);
      setApplications([]);
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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="review-page">
      <div className="border-b border-[var(--n-200)] px-6 py-4">
        <h1 className="text-lg font-semibold">Needs review</h1>
        <p className="mt-0.5 text-sm text-[var(--n-500)]">
          Changes the base is holding until a person decides.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        {cards.length === 0 && applications.length === 0 ? (
          <EmptyState
            icon="check"
            title="Nothing is waiting"
            description="Changes that need a person land here."
          />
        ) : null}

        {cards.map((card) => {
          const stale = card.targets.some((t) => t.stale);
          return (
            <article
              key={card.proposal_id}
              data-testid="review-card"
              data-proposal={card.proposal_id}
              className="mb-3 rounded-lg border border-[var(--n-200)] p-4"
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
                  data-testid="approve"
                  onClick={() => void decide(card, true)}
                >
                  Approve
                </Button>
                <Input
                  value={reasons[card.proposal_id] ?? ''}
                  placeholder="Why not?"
                  data-testid="reject-reason"
                  onChange={(e) =>
                    setReasons((r) => ({ ...r, [card.proposal_id]: e.target.value }))
                  }
                />
                <Button
                  disabled={busy || (reasons[card.proposal_id] ?? '').trim() === ''}
                  data-testid="reject"
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
            <h2 className="mb-2 mt-6 text-sm font-medium text-[var(--n-600)]">
              Applied — still undoable
            </h2>
            {applications.map((application) => (
              <article
                key={application.proposal_id}
                data-testid="revertable"
                data-proposal={application.proposal_id}
                className="mb-2 flex items-center gap-3 rounded-lg border border-[var(--n-200)] p-3"
              >
                <Icon name="undo-2" size={14} />
                <span className="text-sm font-medium">{application.op}</span>
                <span className="text-xs text-[var(--n-500)]">{application.reason}</span>
                <Button
                  className="ml-auto"
                  disabled={busy}
                  data-testid="revert"
                  onClick={() => void undo(application)}
                >
                  Revert
                </Button>
              </article>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}
