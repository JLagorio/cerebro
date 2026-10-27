import { Confirmation } from '@/components/ai/Confirmation';
import { managedRunSelector } from './managedInteraction';
import type { WaitingCard } from './useAgentChat';

export interface ManagedAccessCardProps {
  interaction: WaitingCard;
  onChooseAccess?: (run: number, requestId: string) => void;
}
/** Access selection belongs to the original held call, never a permission answer. */
export function ManagedAccessCard({ interaction, onChooseAccess }: ManagedAccessCardProps) {
  const { card } = interaction;
  const run = managedRunSelector(card);
  const notice =
    interaction.stale ??
    (run === null
      ? 'The original run was not recorded. Access cannot be changed from this card.'
      : onChooseAccess === undefined
        ? 'Access controls are unavailable in this view.'
        : null);
  return (
    <Confirmation
      data-testid="interaction-card"
      data-kind="managed_access"
      data-tool={card.tool_name}
      state={notice !== null ? 'stale' : interaction.answering ? 'answering' : 'pending'}
      title="Choose access for this run"
      icon="clock"
      notice={notice}
      testIds={{ notice: 'interaction-stale' }}
      approve={
        notice !== null
          ? []
          : [
              {
                label: 'Choose access',
                onClick: () => {
                  if (run !== null) onChooseAccess?.(run, card.id);
                },
              },
            ]
      }
    >
      <p className="m-0 text-ui text-(--text-meta)">
        Choose the accounts and actions this run can use. External changes still need your approval.
      </p>
    </Confirmation>
  );
}
