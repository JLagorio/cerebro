// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from './Item';
import './trace-results.css';

/**
 * A question before something runs or changes (M91.9, shadcn's
 * Confirmation): an Item that says what is asked, who asks and what it would
 * touch, and offers the answers. A pending approval is a question, not
 * activity, so it sits outside the trace; once answered, the trace's own line
 * says how it went.
 *
 * One anatomy for every card that asks (§3.5): the assistant's permission,
 * interaction, ask-first write and question cards, and Review's queued writes
 * and proposals. Each keeps its own words and test hooks — `data-testid` and
 * its `data-*` on the card, a `testId` on each answer and part. Approve is one
 * answer or several ("Allow once", "This conversation"); Deny may carry a
 * reason, optional or required, asked for at once or once Deny is pressed. A
 * card whose body answers for itself — the question card's Questionnaire —
 * offers neither.
 *
 * Its state says what the answers can do: `pending` waits for the person;
 * `answering`, while an answer is on its way, offers nothing to press;
 * `answered` shows the outcome in place of the answers; `stale` can no longer
 * be answered, and its notice says why; `refused` waits still, under the
 * refusal that came back. The card only asks: the book behind it holds the
 * call, and its answers are the caller's (CV-28). What an agent wrote — the
 * subject, a draft — is drawn as text, never markup.
 */

/** The card's states. */
export type ConfirmationState = 'pending' | 'answering' | 'answered' | 'stale' | 'refused';

/** The card's own words, unless the caller says better. */
export const CONFIRMATION_WORDS = {
  deny: 'Deny',
  send: 'Send',
} as const;

/** The most a reason may hold. */
const REASON_CHARS = 2000;

/** One way to say yes. */
export interface ConfirmationChoice {
  label: string;
  onClick: () => void;
  /** Left out, the first answer is the primary one and the rest secondary. */
  variant?: 'primary' | 'secondary';
  /** A leading icon, by name. */
  icon?: string;
  /** This answer alone waits: an edit that does not parse, a target that
   *  moved. */
  disabled?: boolean;
  testId?: string;
}

/** The words a Deny may carry. */
export interface ConfirmationReason {
  /** Its placeholder and its name: "Why not? (optional)". */
  label: string;
  /** Deny waits for words. */
  required?: boolean;
  /** `always`: the field sits above the answers. `on_deny`: it opens beside
   *  them when Deny is pressed, with Send in Deny's place. */
  when?: 'always' | 'on_deny';
  maxLength?: number;
  testId?: string;
  sendLabel?: string;
  sendTestId?: string;
}

/** The way to say no. */
export interface ConfirmationDeny {
  /** Left out, "Deny". */
  label?: string;
  /** Hears the reason, trimmed, or null when none was given. */
  onDeny: (reason: string | null) => void;
  testId?: string;
  reason?: ConfirmationReason;
}

/** Test hooks for the parts a card's specs read. */
export interface ConfirmationTestIds {
  title?: string;
  summary?: string;
  notice?: string;
  refusal?: string;
  outcome?: string;
}

export type ConfirmationProps = Omit<ComponentProps<'div'>, 'title' | 'children'> & {
  state: ConfirmationState;
  /** What is asked: "Run this command?", "Change this file?". */
  title: ReactNode;
  /** An icon name before the title. */
  icon?: string;
  /** A line under the title: who asks, or that the agent waits. */
  summary?: ReactNode;
  /** At the end of the title's row: who proposed it, and when. */
  meta?: ReactNode;
  /** What it would run or change: a `ConfirmationSubject`, a draft form. */
  children?: ReactNode;
  /** A quiet line: why it can no longer be answered, what changed since. */
  notice?: ReactNode;
  /** Why the last answer was refused, said at once (`role="alert"`). */
  refusal?: ReactNode;
  /** How it was answered, shown in place of the answers once it was. */
  outcome?: ReactNode;
  /** Left out, with no `deny`, the card draws no answers of its own: its
   *  body answers (a Questionnaire). */
  approve?: readonly ConfirmationChoice[];
  deny?: ConfirmationDeny;
  /** `default`, the asking card's tint; `outline`, a hairline card. */
  variant?: 'default' | 'outline';
  testIds?: ConfirmationTestIds;
};

const shown = (node: ReactNode) => node !== undefined && node !== null && node !== false;

/** What would run or change — a command, a path — as the agent wrote it:
 *  verbatim, in the mono face, scrolled rather than cut. */
export function ConfirmationSubject({ className, ...props }: ComponentProps<'pre'>) {
  return (
    <pre
      data-slot="confirmation-subject"
      {...props}
      className={['cb-ai-confirmation-subject', className].filter(Boolean).join(' ')}
    />
  );
}

function ConfirmationAnswers({
  approve,
  deny,
  disabled,
}: {
  approve: readonly ConfirmationChoice[];
  deny?: ConfirmationDeny;
  disabled: boolean;
}) {
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState(false);
  const ask = deny?.reason;
  const when = ask?.when ?? 'always';
  const said = reason.trim();
  const wordless = ask?.required === true && said === '';
  const send = () => deny?.onDeny(said === '' ? null : said);
  const field = ask !== undefined && (
    <input
      type="text"
      data-slot="confirmation-reason"
      data-testid={ask.testId}
      value={reason}
      disabled={disabled}
      maxLength={ask.maxLength ?? REASON_CHARS}
      placeholder={ask.label}
      aria-label={ask.label}
      // Pressing Deny asked for these words: the field is where they go.
      autoFocus={when === 'on_deny'}
      onChange={(event) => setReason(event.target.value)}
      className="cb-ai-confirmation-reason"
    />
  );
  return (
    <div data-slot="confirmation-answers" className="cb-ai-confirmation-answers">
      {when === 'always' && field}
      <div data-slot="confirmation-actions" className="cb-ai-confirmation-actions">
        {approve.map((choice, index) => (
          <Button
            key={`${index}:${choice.label}`}
            variant={choice.variant ?? (index === 0 ? 'primary' : 'secondary')}
            size="sm"
            icon={choice.icon}
            testId={choice.testId}
            tabIndex={0}
            disabled={disabled || choice.disabled === true}
            onClick={choice.onClick}
          >
            {choice.label}
          </Button>
        ))}
        {deny !== undefined &&
          (when === 'on_deny' && asking ? (
            <>
              {field}
              <Button
                variant="secondary"
                size="sm"
                testId={ask?.sendTestId}
                tabIndex={0}
                disabled={disabled || wordless}
                onClick={send}
              >
                {ask?.sendLabel ?? CONFIRMATION_WORDS.send}
              </Button>
            </>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              testId={deny.testId}
              tabIndex={0}
              disabled={disabled || (when === 'always' && wordless)}
              onClick={when === 'on_deny' && ask !== undefined ? () => setAsking(true) : send}
            >
              {deny.label ?? CONFIRMATION_WORDS.deny}
            </Button>
          ))}
      </div>
    </div>
  );
}

/**
 * The card: an Item named by its title, a group of what it asks and its
 * answers. A caller's `aria-label` names it instead; its `data-state` words,
 * where its specs read older ones, replace the state's.
 */
export function Confirmation({
  state,
  title,
  icon,
  summary,
  meta,
  children,
  notice,
  refusal,
  outcome,
  approve = [],
  deny,
  variant = 'default',
  testIds = {},
  className,
  ...props
}: ConfirmationProps) {
  const titleId = useId();
  const named = props['aria-label'] !== undefined || props['aria-labelledby'] !== undefined;
  return (
    <Item
      variant="outline"
      size="sm"
      role="group"
      aria-labelledby={named ? undefined : titleId}
      aria-busy={state === 'answering' ? true : undefined}
      data-slot="confirmation"
      data-state={state}
      {...props}
      className={[
        'cb-ai-confirmation',
        variant === 'default' && 'cb-ai-confirmation-ask',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {icon !== undefined && (
        <ItemMedia variant="icon" className="cb-ai-confirmation-icon">
          <Icon name={icon} size={16} />
        </ItemMedia>
      )}
      <ItemContent>
        <ItemTitle id={titleId} data-testid={testIds.title}>
          {title}
        </ItemTitle>
        {shown(summary) && (
          <ItemDescription data-testid={testIds.summary}>{summary}</ItemDescription>
        )}
      </ItemContent>
      {shown(meta) && (
        <div data-slot="confirmation-meta" className="cb-ai-confirmation-meta">
          {meta}
        </div>
      )}
      {shown(children) && (
        <div data-slot="confirmation-body" className="cb-ai-confirmation-body">
          {children}
        </div>
      )}
      {shown(refusal) && (
        <div
          data-slot="confirmation-refusal"
          data-testid={testIds.refusal}
          role="alert"
          className="cb-ai-confirmation-refusal"
        >
          {refusal}
        </div>
      )}
      {shown(notice) && (
        <div
          data-slot="confirmation-notice"
          data-testid={testIds.notice}
          className="cb-ai-confirmation-notice"
        >
          {notice}
        </div>
      )}
      {state === 'answered'
        ? shown(outcome) && (
            <div
              data-slot="confirmation-outcome"
              data-testid={testIds.outcome}
              role="status"
              className="cb-ai-confirmation-outcome"
            >
              {outcome}
            </div>
          )
        : (approve.length > 0 || deny !== undefined) && (
            <ConfirmationAnswers
              approve={approve}
              deny={deny}
              disabled={state !== 'pending' && state !== 'refused'}
            />
          )}
    </Item>
  );
}
