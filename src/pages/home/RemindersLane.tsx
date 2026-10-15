import { useEffect } from 'react';
import { useOpenPath } from '@/app/useOpenPath';
import type { BandContext } from '@/engine/dateBuckets';
import { reminderRows } from '@/engine/homeLanes';
import { backSection, sectionize } from '@/engine/homeSections';
import { useNavStore } from '@/stores/navStore';
import { useReminderStore } from '@/stores/reminderStore';
import { useVaultStore } from '@/stores/vaultStore';
import { EventRow } from './EventRow';
import { Lane } from './Lane';
import { useHomeDone } from './useHomeDone';

export function RemindersLane({ now, ctx }: { now: Date; ctx: BandContext }) {
  const vault = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const stateVault = useReminderStore((s) => s.vault);
  const status = useReminderStore((s) => s.status);
  const reminders = useReminderStore((s) => s.reminders);
  const fires = useReminderStore((s) => s.fires);
  const done = useHomeDone();
  const open = useOpenPath();
  useEffect(() => {
    if (vault !== null) void useReminderStore.getState().hydrate(vault);
  }, [vault]);
  const data = reminderRows(
    stateVault === vault ? Object.values(fires) : [],
    reminders,
    done.marks,
    entries,
    now,
  );
  const state =
    status === 'error' && stateVault === vault
      ? 'unavailable'
      : stateVault !== vault || status !== 'ready' || done.loading
        ? 'loading'
        : data.notes.length > 0
          ? 'partial'
          : 'ready';
  return (
    <Lane
      id="reminders"
      state={state}
      data={data}
      sections={sectionize(
        data.rows,
        (row) => backSection(row.at, now, ctx),
        (a, b) => (b.at ?? '').localeCompare(a.at ?? ''),
      )}
      door="Open My work"
      onDoor={() => useNavStore.getState().navigate({ kind: 'mywork' })}
      renderRow={(row) => (
        <EventRow
          row={row}
          ready={done.ready}
          done={done.done}
          onOpen={row.path === null ? undefined : () => open(row.path!)}
        />
      )}
    />
  );
}
