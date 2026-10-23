// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { useId, type ComponentProps } from 'react';
import { Icon } from '@/components/ui/Icon';
import './trace-results.css';

/**
 * A point in the conversation to branch from (M91.9, shadcn's Checkpoint,
 * Q8). shadcn's marker restores the thread to a turn; here it starts a new
 * conversation holding the thread up to that turn, and nothing is rolled
 * back — the files the later turns changed keep their changes, listed with
 * their diffs and restore — so it reads "Branch from here", never "Restore",
 * and says "Files stay as they are" beside the button, which the button is
 * also described by.
 *
 * A labelled divider: the rules either side are drawn, and it has no
 * `role="separator"`, whose name would hide its words (§3.3). It draws
 * whenever it is given; the caller decides when a turn may be branched from —
 * an anchor, a thread that is not blocked, a readable transcript, a later
 * message.
 */

/** The checkpoint's words. */
export const CHECKPOINT_WORDS = {
  branch: 'Branch from here',
  note: 'Files stay as they are',
  /** The button's name: its visible words first (WCAG 2.5.3), then the turn
   *  it branches from. */
  name: (turn: string) => `Branch from here, after ${turn}`,
} as const;

/** The marker's icon, hidden: the words carry its meaning. */
export function CheckpointIcon({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="checkpoint-icon"
      {...props}
      aria-hidden="true"
      className={['cb-ai-checkpoint-icon', className].filter(Boolean).join(' ')}
    />
  );
}

/** The marker's button. Name it with the turn it branches from. */
export function CheckpointTrigger({
  className,
  type = 'button',
  ...props
}: ComponentProps<'button'>) {
  return (
    <button
      data-slot="checkpoint-trigger"
      {...props}
      type={type}
      className={['cb-ai-checkpoint-trigger', className].filter(Boolean).join(' ')}
    />
  );
}

export type CheckpointProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** The turn it branches from, as the button's name ends:
   *  "your message “Plan the launch”". */
  turn: string;
  onBranch: () => void;
  /** It cannot branch now: a turn is starting. */
  disabled?: boolean;
  /** The button's test hook. */
  triggerTestId?: string;
};

/** The marker after a turn: a rule, the button and its note, a rule. */
export function Checkpoint({
  turn,
  onBranch,
  disabled = false,
  triggerTestId,
  className,
  ...props
}: CheckpointProps) {
  const note = useId();
  return (
    <div
      data-slot="checkpoint"
      {...props}
      className={['cb-ai-checkpoint', className].filter(Boolean).join(' ')}
    >
      <span data-slot="checkpoint-content" className="cb-ai-checkpoint-content">
        <CheckpointIcon>
          <Icon name="git-branch" size={12} />
        </CheckpointIcon>
        <CheckpointTrigger
          data-testid={triggerTestId}
          aria-label={CHECKPOINT_WORDS.name(turn)}
          aria-describedby={note}
          disabled={disabled}
          onClick={onBranch}
        >
          {CHECKPOINT_WORDS.branch}
        </CheckpointTrigger>
        <span id={note} data-slot="checkpoint-note" className="cb-ai-checkpoint-note">
          {CHECKPOINT_WORDS.note}
        </span>
      </span>
    </div>
  );
}
