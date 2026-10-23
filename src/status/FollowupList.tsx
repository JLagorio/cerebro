import { StateMessage } from '@/components/ui/StateMessage';
import { useEffect, useState } from 'react';
import { followupState } from '@/agent/elements/runsQueue';
import { Queue, QueueItem, QueueItemAction, QueueList, QueueSection } from '@/components/ai/Queue';
import { agentRef, isAgentEntry } from '@/engine/agents';
import type { Followup } from '@/engine/followups';
import { localStamp } from '@/engine/whenText';
import { useFollowupStore } from '@/stores/followupStore';
import { useVaultStore } from '@/stores/vaultStore';

export function followupWords(row: Followup, now: Date): string {
  if (row.state === 'cancelled')
    return row.cancelReason === 'agent_gone'
      ? 'its agent is gone'
      : row.cancelReason === 'paused'
        ? 'its agent was paused when it came due'
        : 'cancelled by you';
  if (row.state === 'claimed') return 'starting';
  return Date.parse(row.dueAt) <= now.getTime()
    ? 'due now, waiting its turn'
    : localStamp(new Date(row.dueAt));
}

/**
 * The follow-ups agents booked for themselves (M63.8), as a queue (M91.14):
 * each its agent, its state in its icon and in a word read before the
 * agent's name, when it is due, and its note. Operational follow-ups are
 * quoted data, never markdown or an empty failed read.
 */
export function FollowupList({ actor, now: injectedNow }: { actor?: string; now?: Date }) {
  const vault = useVaultStore((state) => state.vaultPath);
  const entries = useVaultStore((state) => state.entries);
  const storeVault = useFollowupStore((state) => state.vault);
  const read = useFollowupStore((state) => state.read);
  const cancel = useFollowupStore((state) => state.cancel);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (vault !== null) void useFollowupStore.getState().load(vault);
  }, [vault]);
  if (vault === null) return null;
  if (storeVault !== vault || read.state === 'loading')
    return <StateMessage state="loading" title="Reading follow-ups…" compact />;
  if (read.state === 'unavailable')
    return (
      <p data-testid="followups-unavailable" className="text-metadata text-(--text-meta)">
        Couldn't read follow-ups, so this can't say what is waiting.
      </p>
    );
  const rows = read.rows
    .filter((row) => actor === undefined || row.actor === actor)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.followupId.localeCompare(b.followupId));
  if (rows.length === 0) return null;
  const now = injectedNow ?? new Date();
  return (
    <Queue data-testid="followups">
      <QueueSection collapsible={false} headingLevel={3} label="Follow-ups" icon="calendar-clock">
        <QueueList>
          {rows.map((row) => {
            const owners = entries.filter(
              (entry) => isAgentEntry(entry) && agentRef(entry).actor === row.actor,
            );
            const state = followupState(row.state);
            return (
              <QueueItem
                key={row.followupId}
                data-testid="followup-row"
                data-followup={row.followupId}
                className={row.state === 'cancelled' ? 'text-(--text-meta)' : 'text-n-700'}
                statusText={state.statusText}
                icon={state.icon}
                title={
                  // Its own ink: the trace line sets one, which the item's
                  // muting would not reach.
                  <span
                    data-testid="followup-agent"
                    className={`font-medium ${row.state === 'cancelled' ? 'text-(--text-meta)' : 'text-n-700'}`}
                  >
                    {owners.length === 1 ? owners[0].title : 'its agent is gone'}
                  </span>
                }
                description={<span title={row.dueAt}>{followupWords(row, now)}</span>}
                actions={
                  row.state === 'pending' && (
                    <QueueItemAction
                      disabled={busy !== null}
                      onClick={() => {
                        setBusy(row.followupId);
                        void cancel(row.followupId).finally(() => setBusy(null));
                      }}
                    >
                      Cancel
                    </QueueItemAction>
                  )
                }
              >
                <p
                  className={`m-0 whitespace-pre-wrap break-words text-ui ${row.state === 'cancelled' ? '' : 'text-n-700'}`}
                >
                  {JSON.stringify(row.note)}
                </p>
              </QueueItem>
            );
          })}
        </QueueList>
      </QueueSection>
    </Queue>
  );
}
