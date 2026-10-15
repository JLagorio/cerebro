import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { WaitingCard } from '@/agent/useAgentChat';
import type { PersonAnswer } from '@/agent/types';
import { WriteDraftForm, type DraftChange } from '@/agent/WriteDraftForm';
import { actorLabel } from '@/engine/authors';
import { parseDraft } from '@/engine/writeDraft';
import { familyCard } from '@/lib/policy/toolApproval';
import { toolFacts, toolSchema } from '@/lib/policy/tools';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * An ask-first agent's page write (M57.4), drawn in the slot M57.1's card
 * holds (`AiPanel`): a card whose table row names the `write` kind. It names
 * the write by the tool manifest's title, the agent that asks, and the page
 * or folder it aims at. The draft is a form the person may edit before
 * Allow (M57.4b, `WriteDraftForm`, projected from the manifest's input
 * schema); Allow sends the edit as `updatedInput` only when there is one,
 * and waits while the edit is invalid. Rust re-checks an edit at the answer
 * and refuses what the run's grant would refuse: the refusal shows under the
 * form, and the card stays with the edits. A draft that is no JSON object
 * (cut at the card's size limit) shows read-only. It answers Allow or Deny
 * with an optional reason, and never This conversation: the table's write
 * card offers Allow once only, so every ask-first write asks. Rust's book
 * holds the call and dispatch holds the write to the Allow; this card is
 * only a view, and its buttons are the one place an answer starts. What the
 * agent put in the call shows as text, never markup.
 */

/** The card's words (Appendix C, M57.4). */
export const WRITE_COPY = {
  byline: (agent: string) => `${agent} asks before writing`,
  allow: 'Allow',
  deny: 'Deny',
  reason: 'Why not? (optional)',
  draft: 'Draft',
  fallbackTitle: 'Write a page',
  assistant: 'The assistant',
} as const;

interface Props {
  interaction: WaitingCard;
  onAnswer: (answer: PersonAnswer) => void;
}

export function WriteApprovalCard({ interaction, onAnswer }: Props) {
  const entries = useVaultStore((s) => s.entries);
  const [reason, setReason] = useState('');
  const [change, setChange] = useState<DraftChange | null>(null);
  const { card, answering, stale } = interaction;
  const refused = interaction.refused ?? null;
  const disabled = answering || stale !== null;
  const title = card.title ?? toolFacts(card.tool_name)?.title ?? WRITE_COPY.fallbackTitle;
  const schema = toolSchema(card.tool_name);
  const asked = useMemo(() => parseDraft(card.input), [card.input]);
  const edited = change?.edited === true;
  const allow = () =>
    onAnswer(
      edited && change !== null
        ? { kind: 'allow', remember: 'once', updatedInput: change.input }
        : { kind: 'allow', remember: 'once' },
    );
  const agent = card.actor == null ? WRITE_COPY.assistant : actorLabel(card.actor, entries).text;
  const target = card.target ?? null;
  const deny = () => {
    const said = reason.trim();
    onAnswer(said === '' ? { kind: 'deny' } : { kind: 'deny', message: said });
  };
  return (
    <div
      data-testid="write-approval"
      data-tool={card.tool_name}
      data-target={target ?? ''}
      data-state={stale !== null ? 'stale' : answering ? 'answering' : 'waiting'}
      role="group"
      aria-label={card.family != null ? (familyCard(card.family)?.title ?? title) : title}
      className="flex flex-col gap-1.5 rounded-lg border border-cortex-200 bg-cortex-50 px-2.5 py-2 text-xs"
    >
      <div className="flex items-center gap-1.5 font-semibold text-n-800">
        <Icon name="hand" size={12} color="var(--cortex-600)" />
        <span data-testid="write-approval-title">{title}</span>
      </div>
      <div data-testid="write-approval-byline" className="text-2xs text-n-600">
        {WRITE_COPY.byline(agent)}
      </div>
      {target !== null && (
        <div
          data-testid="write-approval-target"
          className="min-w-0 truncate [font-family:var(--font-mono)] text-2xs text-cortex-700"
        >
          {target}
        </div>
      )}
      {asked !== null && schema !== null ? (
        <WriteDraftForm
          title={title}
          schema={schema}
          draft={asked}
          disabled={disabled}
          onChange={setChange}
        />
      ) : (
        <details>
          <summary className="cursor-pointer text-2xs text-n-500">{WRITE_COPY.draft}</summary>
          <pre
            data-testid="write-approval-draft"
            className="m-0 mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-2xs leading-[15px] text-n-600"
          >
            {card.input}
          </pre>
        </details>
      )}
      {refused !== null && (
        <div data-testid="write-approval-refused" role="alert" className="text-2xs text-danger-600">
          {refused}
        </div>
      )}
      {stale !== null && (
        <div data-testid="interaction-stale" className="text-2xs text-n-600">
          {stale}
        </div>
      )}
      <input
        data-testid="write-approval-reason"
        type="text"
        value={reason}
        disabled={disabled}
        maxLength={2000}
        placeholder={WRITE_COPY.reason}
        aria-label={WRITE_COPY.reason}
        onChange={(e) => setReason(e.target.value)}
        className="rounded-md border border-n-200 bg-n-0 px-1.5 py-1 text-xs text-n-800"
      />
      <div className="flex gap-1.5">
        <Button
          variant="primary"
          size="sm"
          testId="write-approval-allow"
          disabled={disabled || (edited && change?.valid !== true)}
          onClick={allow}
        >
          {WRITE_COPY.allow}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          testId="write-approval-deny"
          disabled={disabled}
          onClick={deny}
        >
          {WRITE_COPY.deny}
        </Button>
      </div>
    </div>
  );
}
