import { useMemo, useState } from 'react';
import { Confirmation } from '@/components/ai/Confirmation';
import {
  answerable,
  cardStatus,
  denyAnswer,
  familyTitle,
  writeAllow,
  writeAllowWaits,
} from '@/agent/elements/cards';
import type { WaitingCard } from '@/agent/useAgentChat';
import type { PersonAnswer } from '@/agent/types';
import { UnfoldDetails } from '@/agent/Unfold';
import { WriteDraftForm, type DraftChange } from '@/agent/WriteDraftForm';
import { actorLabel } from '@/engine/authors';
import { parseDraft } from '@/engine/writeDraft';
import { toolFacts, toolSchema } from '@/lib/policy/tools';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * An ask-first agent's page write (M57.4), drawn in the slot M57.1's card
 * holds (`AiPanel`) as a Confirmation (M91.12b): a card whose table row
 * names the `write` kind. It names the write by the tool manifest's title,
 * the agent that asks, and the page or folder it aims at. The draft is a
 * form the person may edit before Allow (M57.4b, `WriteDraftForm`, projected
 * from the manifest's input schema); Allow sends the edit as `updatedInput`
 * only when there is one, and waits while the edit is invalid. Rust re-checks
 * an edit at the answer and refuses what the run's grant would refuse: the
 * refusal shows under the form, and the card stays with the edits. A draft
 * that is no JSON object (cut at the card's size limit) shows read-only. It
 * answers Allow or Deny with an optional reason, and never This
 * conversation: the table's write card offers Allow once only, so every
 * ask-first write asks. Rust's book holds the call and dispatch holds the
 * write to the Allow; this card is only a view, and its buttons are the one
 * place an answer starts. What the agent put in the call shows as text,
 * never markup.
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
  const [change, setChange] = useState<DraftChange | null>(null);
  const { card, stale } = interaction;
  const status = cardStatus(interaction);
  const title = card.title ?? toolFacts(card.tool_name)?.title ?? WRITE_COPY.fallbackTitle;
  const schema = toolSchema(card.tool_name);
  const asked = useMemo(() => parseDraft(card.input), [card.input]);
  const agent = card.actor == null ? WRITE_COPY.assistant : actorLabel(card.actor, entries).text;
  const target = card.target ?? null;
  return (
    <Confirmation
      data-testid="write-approval"
      data-tool={card.tool_name}
      data-target={target ?? ''}
      {...status}
      // The family card's question names the group; the manifest's title
      // heads it ("Allow this page write?" over "Create a note").
      aria-label={card.family != null ? familyTitle(card.family, title) : undefined}
      icon="hand"
      title={title}
      summary={WRITE_COPY.byline(agent)}
      refusal={interaction.refused}
      notice={stale}
      testIds={{
        title: 'write-approval-title',
        summary: 'write-approval-byline',
        refusal: 'write-approval-refused',
        notice: 'interaction-stale',
      }}
      approve={[
        {
          label: WRITE_COPY.allow,
          testId: 'write-approval-allow',
          disabled: writeAllowWaits(change),
          onClick: () => onAnswer(writeAllow(change)),
        },
      ]}
      deny={{
        label: WRITE_COPY.deny,
        testId: 'write-approval-deny',
        onDeny: (reason) => onAnswer(denyAnswer(reason)),
        reason: { label: WRITE_COPY.reason, testId: 'write-approval-reason' },
      }}
    >
      {target !== null && (
        <div
          data-testid="write-approval-target"
          className="min-w-0 break-words [font-family:var(--font-mono)] text-metadata text-cortex-700"
        >
          {target}
        </div>
      )}
      {asked !== null && schema !== null ? (
        <WriteDraftForm
          title={title}
          schema={schema}
          draft={asked}
          disabled={!answerable(status.state)}
          onChange={setChange}
        />
      ) : (
        <UnfoldDetails
          summary={
            <summary className="cursor-pointer text-metadata text-(--text-meta)">
              {WRITE_COPY.draft}
            </summary>
          }
        >
          <pre
            data-testid="write-approval-draft"
            className="cb-chat-reveal m-0 mt-1 max-h-[200px] overflow-auto whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-metadata leading-[18px] text-n-600"
          >
            {card.input}
          </pre>
        </UnfoldDetails>
      )}
    </Confirmation>
  );
}
