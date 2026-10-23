import { Confirmation, ConfirmationSubject } from '@/components/ai/Confirmation';
import { cardStatus, denyAnswer, familyTitle } from '@/agent/elements/cards';
import type { WaitingCard } from '@/agent/useAgentChat';
import type { PersonAnswer } from '@/agent/types';
import { TOOLS } from '@/lib/policy/tools';

/**
 * A command or file change the shell ceiling asks about (M57.2), drawn in
 * the slot M57.1's card holds (`AiPanel`) as a Confirmation (M91.12b): a
 * card whose call names its tool-approval family. It names the exact
 * subject, verbatim, and answers Allow once, This conversation (the same
 * family and exact subject, for the rest of this conversation, in memory
 * only) or Deny. Rust's book holds the call; this card is only a view of it,
 * and its buttons are the one place an answer starts. What the agent put in
 * the call shows as text, never markup.
 */

/** The card's words (Appendix C, M57.2). */
export const PERMISSION_COPY = {
  fallbackTitle: 'Waiting for your OK',
  lead: 'The assistant is waiting for your answer.',
  outside: 'This is outside the vault.',
  once: 'Allow once',
  conversation: 'This conversation',
  deny: 'Deny',
} as const;

/** Is `subject` a path the card's tool names by, outside `vault`? An absolute
 * or home path outside the vault folder, or a relative one that climbs out of
 * it. Only a tool whose manifest subject is a path field is read this way. */
export function outsideVault(tool: string, subject: string, vault: string | null): boolean {
  const field = TOOLS.cli_tools.find((row) => row.name === tool)?.subject ?? null;
  if (field === null || !field.endsWith('path')) return false;
  if (subject.startsWith('~')) return true;
  if (subject.startsWith('/')) {
    if (vault === null) return true;
    const root = vault.replace(/\/+$/, '');
    return subject !== root && !subject.startsWith(`${root}/`);
  }
  return subject.split('/').includes('..');
}

interface Props {
  interaction: WaitingCard;
  onAnswer: (answer: PersonAnswer) => void;
  vaultPath: string | null;
}

export function PermissionCard({ interaction, onAnswer, vaultPath }: Props) {
  const { card, stale } = interaction;
  const subject = card.subject ?? card.summary;
  return (
    <Confirmation
      data-testid="permission-card"
      data-family={card.family ?? ''}
      data-tool={card.tool_name}
      {...cardStatus(interaction)}
      icon="shield-question-mark"
      title={familyTitle(card.family, PERMISSION_COPY.fallbackTitle)}
      summary={PERMISSION_COPY.lead}
      notice={stale}
      testIds={{ notice: 'interaction-stale' }}
      approve={[
        {
          label: PERMISSION_COPY.once,
          testId: 'permission-allow-once',
          onClick: () => onAnswer({ kind: 'allow', remember: 'once' }),
        },
        {
          label: PERMISSION_COPY.conversation,
          testId: 'permission-allow-conversation',
          onClick: () => onAnswer({ kind: 'allow', remember: 'conversation' }),
        },
      ]}
      deny={{
        label: PERMISSION_COPY.deny,
        testId: 'permission-deny',
        onDeny: (reason) => onAnswer(denyAnswer(reason)),
      }}
    >
      <ConfirmationSubject data-testid="permission-subject">{subject}</ConfirmationSubject>
      {outsideVault(card.tool_name, subject, vaultPath) && (
        <div data-testid="permission-outside" className="text-metadata font-medium text-n-700">
          {PERMISSION_COPY.outside}
        </div>
      )}
    </Confirmation>
  );
}
