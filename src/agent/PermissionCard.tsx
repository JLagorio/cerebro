import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { WaitingCard } from '@/agent/useAgentChat';
import type { PersonAnswer } from '@/agent/types';
import { familyCard } from '@/lib/policy/toolApproval';
import { TOOLS } from '@/lib/policy/tools';

/**
 * A command or file change the shell ceiling asks about (M57.2), drawn in
 * the slot M57.1's card holds (`AiPanel`): a card whose call names its
 * tool-approval family. It names the exact subject, verbatim, and answers
 * Allow once, This conversation (the same family and exact subject, for the
 * rest of this conversation, in memory only) or Deny. Rust's book holds the
 * call; this card is only a view of it, and its buttons are the one place an
 * answer starts. What the agent put in the call shows as text, never markup.
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
  const { card, answering, stale } = interaction;
  const disabled = answering || stale !== null;
  const title =
    (card.family != null ? familyCard(card.family)?.title : null) ?? PERMISSION_COPY.fallbackTitle;
  const subject = card.subject ?? card.summary;
  return (
    <div
      data-testid="permission-card"
      data-family={card.family ?? ''}
      data-tool={card.tool_name}
      data-state={stale !== null ? 'stale' : answering ? 'answering' : 'waiting'}
      className="flex flex-col gap-1.5 rounded-lg border border-cortex-200 bg-cortex-50 px-2.5 py-2 text-xs"
    >
      <div className="flex items-center gap-1.5 font-semibold text-n-800">
        <Icon name="shield-question-mark" size={12} color="var(--cortex-600)" />
        {title}
      </div>
      <div className="text-2xs text-n-600">{PERMISSION_COPY.lead}</div>
      <pre
        data-testid="permission-subject"
        className="m-0 max-h-[160px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-n-200 bg-n-0 px-1.5 py-1 [font-family:var(--font-mono)] text-2xs leading-[15px] text-n-800"
      >
        {subject}
      </pre>
      {outsideVault(card.tool_name, subject, vaultPath) && (
        <div data-testid="permission-outside" className="text-2xs font-medium text-n-700">
          {PERMISSION_COPY.outside}
        </div>
      )}
      {stale !== null && (
        <div data-testid="interaction-stale" className="text-2xs text-n-600">
          {stale}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button
          variant="primary"
          size="sm"
          testId="permission-allow-once"
          disabled={disabled}
          onClick={() => onAnswer({ kind: 'allow', remember: 'once' })}
        >
          {PERMISSION_COPY.once}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          testId="permission-allow-conversation"
          disabled={disabled}
          onClick={() => onAnswer({ kind: 'allow', remember: 'conversation' })}
        >
          {PERMISSION_COPY.conversation}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          testId="permission-deny"
          disabled={disabled}
          onClick={() => onAnswer({ kind: 'deny' })}
        >
          {PERMISSION_COPY.deny}
        </Button>
      </div>
    </div>
  );
}
