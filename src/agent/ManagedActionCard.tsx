import { useMemo, useState } from 'react';
import actionPolicy from '../../shared/policy/actions.v1.json';
import { Confirmation } from '@/components/ai/Confirmation';
import { Button } from '@/components/ui/Button';
import {
  answerable,
  cardStatus,
  denyAnswer,
  writeAllow,
  writeAllowWaits,
} from '@/agent/elements/cards';
import { managedRunSelector } from '@/agent/managedInteraction';
import { editableJsonNumbers, parseDraft } from '@/engine/writeDraft';
import { WriteDraftForm, type DraftChange } from '@/agent/WriteDraftForm';
import type { WaitingCard } from '@/agent/useAgentChat';
import type { PersonAnswer } from '@/agent/types';
export interface ManagedActionCardProps {
  interaction: WaitingCard;
  onAnswer: (answer: PersonAnswer) => void;
}
interface View {
  version: 1;
  accountLabel: string;
  preview: {
    summary: string;
    fields: { label: string; value: string }[];
    redactedFields: string[];
  };
  inputSchema: string;
  input: string;
}
const utf8 = new TextEncoder();
const previewLimits = actionPolicy.historyInspection;
const bounded = (value: unknown, bytes: number): value is string =>
  typeof value === 'string' && utf8.encode(value).byteLength <= bytes;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
function viewOf(text: string): { view: View; schema: Record<string, unknown> } | null {
  try {
    if (!bounded(text, previewLimits.maxStringBytes)) return null;
    const value: unknown = JSON.parse(text);
    if (
      !record(value) ||
      Object.keys(value).sort().join(',') !== 'accountLabel,input,inputSchema,preview,version' ||
      value.version !== 1 ||
      !bounded(value.accountLabel, previewLimits.maxAccountLabelBytes) ||
      value.accountLabel.trim() === '' ||
      !bounded(value.inputSchema, actionPolicy.limits.schemaBytes) ||
      !bounded(value.input, actionPolicy.limits.inputBytes) ||
      !record(value.preview)
    )
      return null;
    const preview = value.preview;
    if (
      Object.keys(preview).sort().join(',') !== 'fields,redactedFields,summary' ||
      !bounded(preview.summary, previewLimits.maxPreviewSummaryBytes) ||
      !Array.isArray(preview.fields) ||
      preview.fields.length > previewLimits.maxPreviewFields ||
      !preview.fields.every(
        (field) =>
          record(field) &&
          Object.keys(field).sort().join(',') === 'label,value' &&
          bounded(field.label, previewLimits.maxPreviewLabelBytes) &&
          bounded(field.value, previewLimits.maxPreviewValueBytes),
      ) ||
      !Array.isArray(preview.redactedFields) ||
      preview.redactedFields.length > previewLimits.maxRedactedFields ||
      !preview.redactedFields.every((field) => bounded(field, previewLimits.maxPreviewLabelBytes))
    )
      return null;
    const schema: unknown = JSON.parse(value.inputSchema);
    if (!record(schema) || schema.type !== 'object') return null;
    // Original canonical text remains untouched. Only the explicit edited-input
    // seam creates a JS object, and unsupported values never enter that editor.
    JSON.parse(value.input);
    return { view: value as unknown as View, schema };
  } catch {
    return null;
  }
}
function editableInput(text: string): boolean {
  return editableJsonNumbers(text) && parseDraft(text) !== null;
}

function Content({ interaction, onAnswer }: ManagedActionCardProps) {
  const { card, stale } = interaction;
  const status = cardStatus(interaction);
  const payload = useMemo(() => viewOf(card.input), [card.input]);
  const [editing, setEditing] = useState(false);
  const [change, setChange] = useState<DraftChange | null>(null);
  const draft = useMemo(
    () =>
      payload !== null &&
      payload.view.preview.redactedFields.length === 0 &&
      editableInput(payload.view.input)
        ? parseDraft(payload.view.input)
        : null,
    [payload],
  );
  const available = payload !== null && managedRunSelector(card) !== null;
  return (
    <Confirmation
      data-testid="managed-action-card"
      data-kind="managed_action"
      {...status}
      icon="hand"
      title={card.title ?? 'Review this action'}
      summary={payload?.view.preview.summary ?? card.summary}
      refusal={interaction.refused}
      notice={stale}
      testIds={{ notice: 'interaction-stale' }}
      approve={[
        {
          label: 'Allow once',
          disabled: !available || writeAllowWaits(change),
          onClick: () => onAnswer(writeAllow(change)),
        },
      ]}
      deny={{ label: 'Deny', onDeny: (reason) => onAnswer(denyAnswer(reason)) }}
    >
      {available && payload !== null ? (
        <>
          <div className="text-metadata text-(--text-meta)">{payload.view.accountLabel}</div>
          <dl className="m-0 flex min-w-0 flex-col gap-2">
            {payload.view.preview.fields.map((field, index) => (
              <div key={index}>
                <dt className="text-metadata text-(--text-meta)">{field.label}</dt>
                <dd className="m-0 whitespace-pre-wrap break-words text-ui text-n-800">
                  {field.value}
                </dd>
              </div>
            ))}
          </dl>
          {payload.view.preview.redactedFields.length > 0 && (
            <p className="m-0 text-metadata text-(--text-meta)">Some fields are hidden.</p>
          )}
          {draft !== null ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={!answerable(status.state)}
                onClick={() => setEditing((value) => !value)}
              >
                {editing ? 'Close editor' : 'Edit draft'}
              </Button>
              <div hidden={!editing}>
                <WriteDraftForm
                  title={card.title ?? 'Action draft'}
                  schema={payload.schema}
                  draft={draft}
                  exactNumbersOnly
                  disabled={!answerable(status.state)}
                  onChange={setChange}
                />
              </div>
            </>
          ) : (
            <p className="m-0 text-metadata text-(--text-meta)">
              This input cannot be edited here without changing its exact values.
            </p>
          )}
        </>
      ) : (
        <p className="m-0 text-metadata text-(--text-meta)">The action preview is unavailable.</p>
      )}
    </Confirmation>
  );
}
export function ManagedActionCard(props: ManagedActionCardProps) {
  return <Content key={props.interaction.card.id} {...props} />;
}
