import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
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

/** Operational follow-ups are quoted data, never markdown or an empty failed read. */
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
  if (storeVault !== vault || read.state === 'loading') return null;
  if (read.state === 'unavailable')
    return (
      <p data-testid="followups-unavailable" className="text-xs text-n-500">
        Couldn't read follow-ups, so this can't say what is waiting.
      </p>
    );
  const rows = read.rows
    .filter((row) => actor === undefined || row.actor === actor)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.followupId.localeCompare(b.followupId));
  if (rows.length === 0) return null;
  const now = injectedNow ?? new Date();
  return (
    <div className="flex flex-col gap-2" data-testid="followups">
      <h3 className="m-0 text-xs font-medium text-n-600">Follow-ups</h3>
      {rows.map((row) => {
        const owners = entries.filter(
          (entry) => isAgentEntry(entry) && agentRef(entry).actor === row.actor,
        );
        return (
          <div
            key={row.followupId}
            data-testid="followup-row"
            data-followup={row.followupId}
            className={`flex items-start gap-3 py-1 ${row.state === 'cancelled' ? 'text-n-400' : 'text-n-700'}`}
          >
            <div className="min-w-0 flex-1 text-xs">
              <span className="font-medium">
                {owners.length === 1 ? owners[0].title : 'its agent is gone'}
              </span>
              <span className="ml-2 text-2xs" title={row.dueAt}>
                {followupWords(row, now)}
              </span>
              <p className="m-0 mt-1 whitespace-pre-wrap break-words">{JSON.stringify(row.note)}</p>
            </div>
            {row.state === 'pending' && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => {
                  setBusy(row.followupId);
                  void cancel(row.followupId).finally(() => setBusy(null));
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
