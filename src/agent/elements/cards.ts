import type { ConfirmationState } from '@/components/ai/Confirmation';
import type { PersonAnswer } from '@/agent/types';
import type { WaitingCard } from '@/agent/useAgentChat';
import type { DraftChange } from '@/agent/WriteDraftForm';
import { familyCard } from '@/lib/policy/toolApproval';

/**
 * The waiting cards' view models (M91.12b): what the assistant's permission,
 * interaction, ask-first write and question cards hand their Confirmation and
 * Questionnaire. Rust's book holds each call and only the answer command
 * carries an answer (CV-28, CV-32); a card is a view of the call, and these
 * say only what the view shows and what its answers send.
 */

/** The `data-state` a card's specs read: the element's `pending` reads
 * `waiting` there, as every card read before it was a Confirmation. */
export type CardStateWord = Exclude<ConfirmationState, 'pending'> | 'waiting';

export interface CardStatus {
  state: ConfirmationState;
  'data-state': CardStateWord;
}

/**
 * A waiting card's state: too late outranks an answer on its way, which
 * outranks a write Rust refused (M57.4b), which still waits for the person.
 * A card leaves the conversation once answered, so none reads `answered`.
 */
export function cardStatus(waiting: WaitingCard): CardStatus {
  const state: ConfirmationState =
    waiting.stale !== null
      ? 'stale'
      : waiting.answering
        ? 'answering'
        : (waiting.refused ?? null) !== null
          ? 'refused'
          : 'pending';
  return { state, 'data-state': state === 'pending' ? 'waiting' : state };
}

/** Whether the person can answer in this state: a refused write waits still. */
export function answerable(state: ConfirmationState): boolean {
  return state === 'pending' || state === 'refused';
}

/** A card's title by its tool-approval family (M57.2), else `fallback`. */
export function familyTitle(family: string | null | undefined, fallback: string): string {
  return (family != null ? familyCard(family)?.title : null) ?? fallback;
}

/** Deny, carrying the person's words for the agent when they gave any. */
export function denyAnswer(reason: string | null): PersonAnswer {
  return reason === null ? { kind: 'deny' } : { kind: 'deny', message: reason };
}

/** A write card's Allow (M57.4b): once, never This conversation, carrying
 * the person's edit of the draft only when there is one. */
export function writeAllow(change: DraftChange | null): PersonAnswer {
  return change !== null && change.edited
    ? { kind: 'allow', remember: 'once', updatedInput: change.input }
    : { kind: 'allow', remember: 'once' };
}

/** Allow waits while the person's edit of the draft is not one the form
 * can send; Deny never waits on it. */
export function writeAllowWaits(change: DraftChange | null): boolean {
  return change !== null && change.edited && !change.valid;
}
