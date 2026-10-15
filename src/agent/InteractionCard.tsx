import { useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { toolIcon, toolLabel } from '@/agent/AiActionCard';
import { QuestionCard } from '@/agent/QuestionCard';
import type { WaitingCard } from '@/agent/useAgentChat';
import type { PersonAnswer } from '@/agent/types';

/**
 * A call that waits for the person (M57.1), drawn after the last assistant
 * message. Rust's book holds it (`agent::interaction`); the card is only a
 * view of it, and its buttons are the one place an answer starts.
 *
 * Cards are a registry keyed by kind: `permission`, and `question` for
 * AskUserQuestion (M57.3, `QuestionCard`); a later kind adds a renderer here,
 * never a second path. Whatever the agent put in the call shows as text,
 * never as markup.
 */

/** The card's words (Appendix C, M57.1). */
export const CARD_COPY = {
  title: 'Waiting for your OK',
  allow: 'Allow once',
  deny: 'Deny',
  denyPlaceholder: 'Tell the agent why (optional)',
  input: 'Input',
} as const;

interface CardProps {
  interaction: WaitingCard;
  onAnswer: (answer: PersonAnswer) => void;
}

/** Allow once, or Deny with an optional reason the agent reads. */
function PermissionCard({ interaction, onAnswer }: CardProps) {
  const [message, setMessage] = useState('');
  const { card, answering, stale } = interaction;
  const disabled = answering || stale !== null;
  const deny = () => {
    const said = message.trim();
    onAnswer(said === '' ? { kind: 'deny' } : { kind: 'deny', message: said });
  };
  return (
    <div
      data-testid="interaction-card"
      data-kind={card.kind}
      data-tool={card.tool_name}
      data-state={stale !== null ? 'stale' : answering ? 'answering' : 'waiting'}
      className="flex flex-col gap-1.5 rounded-lg border border-cortex-200 bg-cortex-50 px-2.5 py-2 text-xs"
    >
      <div className="flex items-center gap-1.5 font-semibold text-n-800">
        <Icon name="clock" size={12} color="var(--cortex-600)" />
        {CARD_COPY.title}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon name={toolIcon(card.tool_name)} size={11} color="var(--n-500)" />
        <span data-testid="interaction-tool" className="flex-none font-medium text-n-700">
          {toolLabel(card.tool_name)}
        </span>
        <span
          data-testid="interaction-summary"
          className="min-w-0 truncate [font-family:var(--font-mono)] text-2xs text-cortex-700"
        >
          {card.summary}
        </span>
      </div>
      <details>
        <summary className="cursor-pointer text-2xs text-n-500">{CARD_COPY.input}</summary>
        <pre
          data-testid="interaction-input"
          className="m-0 mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-2xs leading-[15px] text-n-600"
        >
          {card.input}
        </pre>
      </details>
      {stale !== null && (
        <div data-testid="interaction-stale" className="text-2xs text-n-600">
          {stale}
        </div>
      )}
      <input
        data-testid="interaction-deny-message"
        type="text"
        value={message}
        disabled={disabled}
        maxLength={2000}
        placeholder={CARD_COPY.denyPlaceholder}
        aria-label={CARD_COPY.denyPlaceholder}
        onChange={(e) => setMessage(e.target.value)}
        className="rounded-md border border-n-200 bg-n-0 px-1.5 py-1 text-xs text-n-800"
      />
      <div className="flex gap-1.5">
        <Button
          variant="primary"
          size="sm"
          testId="interaction-allow"
          disabled={disabled}
          onClick={() => onAnswer({ kind: 'allow' })}
        >
          {CARD_COPY.allow}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          testId="interaction-deny"
          disabled={disabled}
          onClick={deny}
        >
          {CARD_COPY.deny}
        </Button>
      </div>
    </div>
  );
}

/** One renderer per card kind Rust's book draws. */
export const CARD_RENDERERS: Record<string, (props: CardProps) => ReactElement> = {
  permission: PermissionCard,
  question: QuestionCard,
};

/** A waiting call's card, by its kind; a kind this build does not know is
 * drawn as a permission, which asks the same question. */
export function InteractionCard(props: CardProps) {
  const Render = CARD_RENDERERS[props.interaction.card.kind] ?? PermissionCard;
  return <Render {...props} />;
}
