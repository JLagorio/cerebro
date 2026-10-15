import { useFeed } from '@/hooks/useFeed';
import { vaultActivity } from '@/lib/ipc';
import { editsData } from '@/engine/homeLanes';
import { backSection, sectionize } from '@/engine/homeSections';
import type { BandContext } from '@/engine/dateBuckets';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { Lane } from './Lane';

/** Read when opened, never from the clock that regroups Home's rows. */
async function recentEdits(vault: string) {
  const until = new Date();
  const from = new Date(until);
  from.setDate(from.getDate() - 7);
  const since = from.toISOString();
  // The read is half-open; include a write stamped at this exact millisecond.
  return {
    activity: await vaultActivity(vault, since, new Date(until.getTime() + 1).toISOString()),
    since,
  };
}

export function EditsLane({ now, ctx }: { now: Date; ctx: BandContext }) {
  const vault = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const status = useVaultStore((s) => s.status);
  const feed = useFeed(vault, recentEdits);
  const read =
    feed.kind === 'ready'
      ? editsData(feed.data.activity, entries, feed.data.since)
      : { state: feed.kind, data: { rows: [], line: '', notes: [] } };
  return (
    <Lane
      id="edits"
      state={status === 'error' ? 'unavailable' : status !== 'ready' ? 'loading' : read.state}
      data={read.data}
      sections={sectionize(
        read.data.rows,
        (row) => backSection(row.at, now, ctx),
        (a, b) => (b.at ?? '').localeCompare(a.at ?? ''),
      )}
      door="Open History"
      onDoor={() => useNavStore.getState().navigate({ kind: 'pulse' })}
    />
  );
}
