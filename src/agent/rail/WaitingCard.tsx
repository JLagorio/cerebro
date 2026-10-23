import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import type { MessageScrollerCommands } from '@/components/ai/MessageScroller';
import { RailSection, type RailSectionState } from '@/components/ai/Rail';
import { StepHead, type StepState } from '@/components/ai/StepLine';
import { Trace } from '@/components/ai/Trace';
import { StateMessage } from '@/components/ui/StateMessage';
import { listInteractions } from '@/agent/agentIpc';
import { waitingRowId, type RailWaiting } from '@/agent/elements/railWaiting';
import { focusRevealed } from '@/agent/stepReveal';
import { toolIconName } from '@/engine/tools';
import './rail-jump.css';

/**
 * Waiting on you (M92.4, §2): the call the conversation's turn waits on,
 * first in the rail (Q5), and only while one waits. It says what the call
 * asks, and which subagent asked when the call is a subagent's own. Its
 * press stays in the canvas (§1): the rail's `jump`, and the transcript
 * brings the card into view and focuses its first answer. The card is
 * answered there, never here (Q6).
 *
 * The card it draws is the thread's own (`chat.interaction`): live as it is
 * raised, and after a reload as `waitOnCard`'s read of Rust's book brings it
 * back. With none, it checks the book itself, once each time it is shown
 * and never while the rail is folded: nothing waiting is no card at all
 * (Q7), and a check that failed says it could not tell, never that nothing
 * waits (CV-05). A card answered too late stays, saying it no longer waits.
 */

/** The card's words. */
export const WAITING_WORDS = {
  title: 'Waiting on you',
  show: ' (show it in the conversation)',
  answering: 'Sending your answer',
  stale: 'No longer waiting',
  unavailable: "Couldn't check what's waiting",
  notRecorded: 'Asked by a subagent whose task was not recorded',
} as const;

/** Which subagent asked, in words, or null when the turn asked itself. */
export function askerWords(asker: RailWaiting['asker']): string | null {
  if (asker === null) return null;
  const type = asker.type.trim();
  const task = asker.description.trim();
  if (type === '' && task === '') return WAITING_WORDS.notRecorded;
  if (type === '') return `Asked by a subagent: ${task}`;
  return task === '' ? `Asked by the ${type} subagent` : `Asked by the ${type} subagent: ${task}`;
}

/** The card's state while one waits: one answered too late is only part of
 *  what it was; one whose asking subagent recorded nothing of itself was not
 *  recorded; else ready. */
export function waitingState(waiting: RailWaiting): RailSectionState {
  if (waiting.stale !== null) return 'partial';
  const asker = waiting.asker;
  return asker !== null && asker.type.trim() === '' && asker.description.trim() === ''
    ? 'not-recorded'
    : 'ready';
}

/** The line's state, and its words where the card's heading does not say
 *  them: an answer on its way, or a card that no longer waits. */
function lineState(waiting: RailWaiting): { status: StepState; statusText: string | null } {
  if (waiting.stale !== null) return { status: 'cancelled', statusText: WAITING_WORDS.stale };
  if (waiting.answering) return { status: 'running', statusText: WAITING_WORDS.answering };
  return { status: 'waiting', statusText: null };
}

/** Where a card's answers are, in order: its answer buttons, or a question
 *  card's first answer and then its own buttons. */
const ANSWERS = [
  '[data-slot="confirmation-actions"] button',
  '[data-slot="questionnaire-item"] input',
  '[data-slot="questionnaire-actions"] button',
];

/** A card's first answer the person can press now, or null. */
export function firstAnswer(card: HTMLElement): HTMLElement | null {
  for (const selector of ANSWERS) {
    for (const found of card.querySelectorAll<HTMLButtonElement | HTMLInputElement>(selector)) {
      if (!found.disabled) return found;
    }
  }
  return null;
}

/** The transcript row drawn under `messageId` (MessageScrollerItem) in
 *  `scope`: the rail is the aside's third area (M92.1), and the transcript
 *  it jumps in is the aside's own. */
function transcriptRow(scope: ParentNode, messageId: string): HTMLElement | null {
  for (const row of scope.querySelectorAll<HTMLElement>('[data-message-id]')) {
    if (row.dataset.messageId === messageId) return row;
  }
  return null;
}

type Check = 'unread' | 'read' | 'unavailable';

/**
 * Whether the book could be read, checked for `thread` while `wanted`: as it
 * comes to be wanted, and each time again. A thread's check never answers
 * for another's, and until a new check lands the last one stands.
 */
function useBookCheck(vault: string | null, thread: string, wanted: boolean): Check {
  const key = `${vault ?? ''}\n${thread}`;
  const [held, setHeld] = useState<{ key: string; check: Check }>({ key, check: 'unread' });
  useEffect(() => {
    if (!wanted || vault === null) return;
    let live = true;
    listInteractions(vault).then(
      () => {
        if (live) setHeld({ key, check: 'read' });
      },
      () => {
        if (live) setHeld({ key, check: 'unavailable' });
      },
    );
    return () => {
      live = false;
    };
  }, [vault, key, wanted]);
  return held.key === key ? held.check : 'unread';
}

export interface WaitingCardProps {
  /** The thread's waiting card (`railWaiting`), or null with none. */
  waiting: RailWaiting | null;
  /** The open vault, whose book the card checks while none waits here. */
  vault: string | null;
  /** The conversation the rail is open on: another one checks again. */
  thread: string;
  /** Folded away with the rail (ConversationRail), hidden and inert: the
   *  card reads nothing and draws nothing new until the rail unfolds. */
  folded: boolean;
  /** The rail's primary action (ConversationRail's `jump`). */
  jump: (go: () => void) => void;
  /** The transcript's scroll commands (Chat's `scrollerRef`). */
  scroller: RefObject<MessageScrollerCommands | null>;
}

/** A folded card keeps what it drew; an unfolding one draws the latest. */
function stillWhileFolded(before: WaitingCardProps, after: WaitingCardProps): boolean {
  if (before.folded && after.folded) return true;
  return (
    before.waiting === after.waiting &&
    before.vault === after.vault &&
    before.thread === after.thread &&
    before.folded === after.folded &&
    before.jump === after.jump &&
    before.scroller === after.scroller
  );
}

export const WaitingCard = memo(function WaitingCard({
  waiting,
  vault,
  thread,
  folded,
  jump,
  scroller,
}: WaitingCardProps) {
  const own = useRef<HTMLElement | null>(null);
  const check = useBookCheck(vault, thread, !folded && waiting === null);
  if (waiting === null) {
    if (check !== 'unavailable') return null;
    return (
      <RailSection
        data-testid="rail-waiting"
        title={WAITING_WORDS.title}
        icon="clock"
        state="unavailable"
      >
        <StateMessage compact state="unavailable" title={WAITING_WORDS.unavailable} />
      </RailSection>
    );
  }
  const line = lineState(waiting);
  // Lands on the card in the transcript and on its first answer there; a
  // card whose answers wait takes focus itself.
  const go = () => {
    const target = waitingRowId(waiting.id);
    const placed = scroller.current?.scrollToMessage(target) === true;
    const row = transcriptRow(own.current?.closest('aside') ?? document, target);
    if (row === null) return;
    const card = row.querySelector<HTMLElement>('[data-slot="confirmation"]') ?? row;
    focusRevealed(firstAnswer(card) ?? card, placed);
  };
  return (
    <RailSection
      ref={own}
      data-testid="rail-waiting"
      title={WAITING_WORDS.title}
      icon="clock"
      state={waitingState(waiting)}
    >
      <Trace>
        <button
          type="button"
          // WebKit leaves a native button without one out of the Tab order.
          tabIndex={0}
          data-testid="rail-waiting-card"
          data-card-id={waiting.id}
          className="cb-ai-step-link cb-rail-jump"
          onClick={() => jump(go)}
        >
          <StepHead
            status={line.status}
            statusText={line.statusText}
            icon={toolIconName(waiting.toolName)}
            title={waiting.summary}
            progress={askerWords(waiting.asker)}
          />
          <span className="sr-only">{WAITING_WORDS.show}</span>
        </button>
      </Trace>
    </RailSection>
  );
}, stillWhileFolded);
