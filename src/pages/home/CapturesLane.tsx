import type { BandContext } from '@/engine/dateBuckets';
import { captureRows } from '@/engine/homeLanes';
import { backSection, sectionize } from '@/engine/homeSections';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { Lane } from './Lane';

export function CapturesLane({ now, ctx }: { now: Date; ctx: BandContext }) {
  const entries = useVaultStore((s) => s.entries),
    status = useVaultStore((s) => s.status);
  const enabled = useUiStore((s) => s.inboxEnabled);
  if (!enabled) return null;
  const data = captureRows(entries);
  const state = status === 'error' ? 'unavailable' : status === 'ready' ? 'ready' : 'loading';
  return (
    <Lane
      id="captures"
      state={state}
      data={data}
      sections={sectionize(
        data.rows,
        (row) => backSection(row.at, now, ctx),
        (a, b) => (b.at ?? '').localeCompare(a.at ?? ''),
      )}
      door="Open Inbox"
      onDoor={() => useNavStore.getState().navigate({ kind: 'inbox' })}
    />
  );
}
