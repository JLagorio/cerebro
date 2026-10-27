import type { ReactElement } from 'react';
import { Confirmation } from '@/components/ai/Confirmation';
import { Icon } from '@/components/ui/Icon';
import { toolIcon, toolLabel } from '@/agent/AiActionCard';
import { cardStatus, denyAnswer } from '@/agent/elements/cards';
import { QuestionCard } from '@/agent/QuestionCard';
import { ManagedActionCard } from '@/agent/ManagedActionCard';
import { ManagedAccessCard } from '@/agent/ManagedAccessCard';
import { UnfoldDetails } from '@/agent/Unfold';
import type { WaitingCard } from '@/agent/useAgentChat';
import type { PersonAnswer } from '@/agent/types';

/**
 * A call that waits for the person (M57.1), drawn after the last assistant
 * message as a Confirmation (M91.12b). Rust's book holds it
 * (`agent::interaction`); the card is only a view of it, and its buttons are
 * the one place an answer starts.
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
  onChooseAccess?: (run: number, requestId: string) => void;
  interaction: WaitingCard;
  onAnswer: (answer: PersonAnswer) => void;
}

/** Allow once, or Deny with an optional reason the agent reads. */
function PermissionCard({ interaction, onAnswer }: CardProps) {
  const { card, stale } = interaction;
  return (
    <Confirmation
      data-testid="interaction-card"
      data-kind={card.kind}
      data-tool={card.tool_name}
      {...cardStatus(interaction)}
      icon="clock"
      title={CARD_COPY.title}
      notice={stale}
      testIds={{ notice: 'interaction-stale' }}
      approve={[
        {
          label: CARD_COPY.allow,
          testId: 'interaction-allow',
          onClick: () => onAnswer({ kind: 'allow' }),
        },
      ]}
      deny={{
        label: CARD_COPY.deny,
        testId: 'interaction-deny',
        onDeny: (reason) => onAnswer(denyAnswer(reason)),
        reason: { label: CARD_COPY.denyPlaceholder, testId: 'interaction-deny-message' },
      }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon name={toolIcon(card.tool_name)} size={11} color="var(--n-500)" />
        <span data-testid="interaction-tool" className="flex-none font-medium text-n-700">
          {toolLabel(card.tool_name)}
        </span>
        <span
          data-testid="interaction-summary"
          className="min-w-0 break-words [font-family:var(--font-mono)] text-metadata text-cortex-700"
        >
          {card.summary}
        </span>
      </div>
      <UnfoldDetails
        summary={
          <summary className="cursor-pointer text-metadata text-(--text-meta)">
            {CARD_COPY.input}
          </summary>
        }
      >
        <pre
          data-testid="interaction-input"
          className="cb-chat-reveal m-0 mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-metadata leading-[18px] text-n-600"
        >
          {card.input}
        </pre>
      </UnfoldDetails>
    </Confirmation>
  );
}

/** One renderer per card kind Rust's book draws. */
export const CARD_RENDERERS: Record<string, (props: CardProps) => ReactElement> = {
  permission: PermissionCard,
  question: QuestionCard,
  managed_action: ManagedActionCard,
  managed_access: ManagedAccessCard,
};

/** A waiting call's card, by its kind; a kind this build does not know is
 * drawn as a permission, which asks the same question. */
export function InteractionCard(props: CardProps) {
  const Render = CARD_RENDERERS[props.interaction.card.kind] ?? PermissionCard;
  return <Render {...props} />;
}
