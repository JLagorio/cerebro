import type { BandContext } from '@/engine/dateBuckets';
import { runRows } from '@/engine/homeLanes';
import { backSection, sectionize } from '@/engine/homeSections';
import { useFeed } from '@/hooks/useFeed';
import { homeRuns } from '@/lib/ipc';
import { RunWhy } from '@/status/RunWhy';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { EventRow } from './EventRow';
import { Lane } from './Lane';
import { useHomeDone } from './useHomeDone';

export function RunsLane({ now, ctx }: { now: Date; ctx: BandContext }) {
  const vault = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const feed = useFeed(vault, homeRuns);
  const done = useHomeDone();
  const runs = feed.kind === 'ready' ? feed.data.runs : [];
  const data = runRows(
    runs,
    done.marks,
    entries,
    now,
    feed.kind === 'ready' && feed.data.truncated,
  );
  const state =
    feed.kind === 'unavailable'
      ? 'unavailable'
      : feed.kind === 'loading' || done.loading
        ? 'loading'
        : data.notes.length > 0
          ? 'partial'
          : 'ready';
  return (
    <Lane
      id="runs"
      state={state}
      data={data}
      sections={sectionize(
        data.rows,
        (row) => backSection(row.at, now, ctx),
        (a, b) => (b.at ?? '').localeCompare(a.at ?? ''),
      )}
      door="Open Agents"
      onDoor={() => useNavStore.getState().navigate({ kind: 'agents' })}
      onOpenRow={(row) =>
        useNavStore
          .getState()
          .navigate(
            row.path === null ? { kind: 'agents' } : { kind: 'doc', path: row.path, tab: 'runs' },
          )
      }
      renderRow={(row) => {
        const run = runs.find((run) => run.run_id === row.runId);
        return (
          <EventRow
            row={row}
            ready={done.ready}
            done={done.done}
            onOpen={() =>
              useNavStore
                .getState()
                .navigate(
                  row.path === null
                    ? { kind: 'agents' }
                    : { kind: 'doc', path: row.path, tab: 'runs' },
                )
            }
          >
            <RunWhy cause={run?.cause} startedAt={run?.started_at ?? ''} />
          </EventRow>
        );
      }}
    />
  );
}
