import type { BandContext } from '@/engine/dateBuckets';
import { comingUpRows } from '@/engine/homeLanes';
import { forwardSection, sectionize } from '@/engine/homeSections';
import { useNavStore } from '@/stores/navStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { Lane } from './Lane';

export function ComingUpLane({ now, ctx }: { now: Date; ctx: BandContext }) {
  const entries = useVaultStore((s) => s.entries),
    status = useVaultStore((s) => s.status);
  const schema = useSchema();
  const data = comingUpRows(entries, schema, now, ctx);
  const state =
    status === 'error'
      ? 'unavailable'
      : status !== 'ready'
        ? 'loading'
        : data.notes.length > 0
          ? 'partial'
          : 'ready';
  return (
    <Lane
      id="comingup"
      state={state}
      data={data}
      sections={sectionize(
        data.rows,
        (row) => forwardSection(row.date, now, ctx),
        (a, b) => (a.at ?? '').localeCompare(b.at ?? ''),
      )}
      door="Open My work"
      onDoor={() => useNavStore.getState().navigate({ kind: 'mywork' })}
    />
  );
}
