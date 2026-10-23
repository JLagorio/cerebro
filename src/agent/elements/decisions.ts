import type { DraftChange } from '@/agent/WriteDraftForm';
import { writeAllowWaits } from '@/agent/elements/cards';
import type {
  ConfirmationChoice,
  ConfirmationDeny,
  ConfirmationState,
} from '@/components/ai/Confirmation';
import type { Draft } from '@/engine/writeDraft';
import { FRESH_PROPOSAL_LABEL } from '@/lib/prompts';

/**
 * The decisions a person makes away from the conversation (M91.14), as the
 * Confirmation element draws them: a page write an ask-first agent queued
 * while nobody watched (M57.4c), a proposal an agent queued in the ledger
 * (M52.2) — in Review, or flush in its concept's review bar — and the filing
 * an agent suggested for an Inbox capture (M7).
 *
 * These say what each card's state is, which answers it offers and what each
 * answer sends, and nothing reaches a door from here. A queued write is
 * decided by `decidePendingWrite` alone, which Rust re-guards under the
 * queuing run's grant (CV-32); a proposal by `decideProposal`, whose typed
 * result its surface reads (CV-03's proposal-channel exemption); a filing by
 * the person's own store writes.
 */

/** The answers a card's Confirmation offers. */
export interface CardAnswers {
  approve: readonly ConfirmationChoice[];
  deny: ConfirmationDeny;
}

/* ---- A queued page write (PendingWriteCard) ---- */

/** The queued write card's words (Appendix C, M57.4c). */
export const PENDING_COPY = {
  queued: (when: string) => `Queued ${when} by`,
  changed: 'This page changed since it was queued.',
  allow: 'Allow',
  reject: 'Reject',
  send: 'Send',
  reason: 'Why not? The agent will read this.',
  applied: (path: string) => `Applied — ${path}`,
  refused: (reason: string) =>
    `Allowed, but Cerebro refused it: ${reason.replace(/\.$/, '')}. The agent will hear this.`,
  rejected: 'Rejected',
  decided: 'Already decided',
  failed: (why: string) => `Couldn't decide: ${why}`,
  draft: 'Draft',
} as const;

/** Where a queued write's decision stands. */
export interface PendingWriteProgress {
  /** A decision is on its way. */
  busy: boolean;
  /** Cerebro refused the person's edit: the write still waits, edits kept. */
  refused: string | null;
  /** What a decision that landed came to; the card waits only for the queue
   *  to read again, which takes it away. */
  outcome: string | null;
}

/**
 * The card's state: a decision that landed is its outcome, held until the
 * queue reads again (as `useDecisions` holds a decided proposal, M52.4), so a
 * second press never decides a write that no longer waits; then one on its
 * way; then a refused edit, which still waits for the person.
 */
export function pendingWriteState(progress: PendingWriteProgress): ConfirmationState {
  if (progress.outcome !== null) return 'answered';
  if (progress.busy) return 'answering';
  return progress.refused !== null ? 'refused' : 'pending';
}

/** Whether the page changed since the write was queued: both hashes known,
 *  and different. A new page, or a page not scanned yet, says nothing. */
export function changedSinceQueued(
  queuedHash: string | null,
  pageHash: string | null | undefined,
): boolean {
  return queuedHash !== null && pageHash != null && pageHash !== queuedHash;
}

/** Allow waits while the person's edit of the draft is not one the form can
 *  send, as on the ask-first write card (cards.ts); Reject never waits on it. */
export const editWaits = writeAllowWaits;

/** The edit Allow sends: the person's, only when there is one. */
export function editSent(change: DraftChange | null): Draft | null {
  return change !== null && change.edited ? change.input : null;
}

/**
 * Allow, held while the edit waits; Reject, which asks for words once it is
 * pressed and sends only with them: the agent's next run reads the reason.
 */
export function pendingWriteAnswers({
  allowWaits,
  onAllow,
  onReject,
}: {
  allowWaits: boolean;
  onAllow: () => void;
  onReject: (reason: string) => void;
}): CardAnswers {
  return {
    approve: [
      {
        label: PENDING_COPY.allow,
        testId: 'pending-write-allow',
        disabled: allowWaits,
        onClick: onAllow,
      },
    ],
    deny: {
      label: PENDING_COPY.reject,
      testId: 'pending-write-reject',
      // The reason is required, so Send hands over words.
      onDeny: (reason) => {
        if (reason !== null) onReject(reason);
      },
      reason: {
        label: PENDING_COPY.reason,
        required: true,
        when: 'on_deny',
        testId: 'pending-write-reason',
        sendLabel: PENDING_COPY.send,
        sendTestId: 'pending-write-send',
      },
    },
  };
}

/* ---- A queued proposal (status/ProposalCard) ---- */

/** A proposal card's answers' words. */
export const PROPOSAL_COPY = {
  approve: 'Approve',
  reject: 'Reject',
  reason: 'Why not?',
} as const;

/** A proposal card's state: a decision on its way, or one decided here and
 *  held until the queue reads again (`useDecisions`, M52.4), offers nothing. */
export function proposalState(busy: boolean): ConfirmationState {
  return busy ? 'answering' : 'pending';
}

/**
 * Approve, or — when a target moved since the proposal was made — the fresh
 * proposal the ledger would want instead (M52.5): an Approve it would refuse
 * (`stale_target_version`) stays, disabled, beside the act that can work.
 * Reject needs a reason, asked for beside the answers: the ledger refuses a
 * rejection without one. The reason belongs to Reject alone.
 */
export function proposalAnswers({
  stale,
  onApprove,
  onAskFresh,
  onReject,
}: {
  stale: boolean;
  onApprove: () => void;
  onAskFresh: () => void;
  onReject: (reason: string) => void;
}): CardAnswers {
  const approve: ConfirmationChoice = {
    label: PROPOSAL_COPY.approve,
    testId: 'approve',
    variant: stale ? 'secondary' : 'primary',
    disabled: stale,
    onClick: onApprove,
  };
  return {
    approve: stale
      ? [
          {
            label: FRESH_PROPOSAL_LABEL,
            testId: 'ask-fresh',
            variant: 'primary',
            icon: 'sparkles',
            onClick: onAskFresh,
          },
          approve,
        ]
      : [approve],
    deny: {
      label: PROPOSAL_COPY.reject,
      testId: 'reject',
      onDeny: (reason) => {
        if (reason !== null) onReject(reason);
      },
      reason: {
        label: PROPOSAL_COPY.reason,
        required: true,
        when: 'always',
        testId: 'reject-reason',
      },
    },
  };
}

/* ---- A suggested filing (agent/ProposalCard) ---- */

/** The filing card's words. */
export const FILING_COPY = {
  title: 'Suggested filing',
  apply: 'Apply',
  dismiss: 'Dismiss',
} as const;

/** A filing card's state: while Apply writes, it offers nothing more. */
export function filingState(applying: boolean): ConfirmationState {
  return applying ? 'answering' : 'pending';
}

/** Apply writes the planned filing; Dismiss lets the suggestion go, writing
 *  nothing, and asks for no reason: nobody reads one. */
export function filingAnswers({
  onApply,
  onDismiss,
}: {
  onApply: () => void;
  onDismiss: () => void;
}): CardAnswers {
  return {
    approve: [{ label: FILING_COPY.apply, icon: 'check', onClick: onApply }],
    deny: { label: FILING_COPY.dismiss, onDeny: () => onDismiss() },
  };
}
