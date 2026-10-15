import { useCallback, useState } from 'react';
import type { BandContext } from '@/engine/dateBuckets';
import { changeRows } from '@/engine/homeLanes';
import { markId } from '@/engine/reminderState';
import { backSection, sectionize } from '@/engine/homeSections';
import { useFeed } from '@/hooks/useFeed';
import { ChangeLines } from '@/knowledge/BaseItself';
import { homeChanges } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';
import { EventRow } from './EventRow';
import { Lane } from './Lane';
import { useHomeDone } from './useHomeDone';

export function ChangesLane({ now, ctx }: { now: Date; ctx: BandContext }) {
  const vault = useVaultStore((s) => s.vaultPath);
  const done = useHomeDone();
  const mark = done.marks?.[markId({ lane: 'change', subject: 'knowledge' })];
  const after = mark?.until === 'revision' ? Number(mark.revision) : undefined;
  const read = useCallback((path: string) => homeChanges(path, after), [after]);
  const feed = useFeed(done.loading ? null : vault, read);
  const [expanded, setExpanded] = useState(false);
  const view = feed.kind === 'ready' ? feed.data : null;
  const data = changeRows(view, done.marks);
  const state = done.loading
    ? 'loading'
    : feed.kind === 'unavailable'
      ? 'unavailable'
      : feed.kind === 'loading'
        ? 'loading'
        : data.notes.length > 0
          ? 'partial'
          : 'ready';
  return (
    <Lane
      id="changes"
      state={state}
      data={data}
      sections={sectionize(data.rows, (row) => backSection(row.at, now, ctx))}
      door="Open Activity"
      onDoor={() =>
        useNavStore.getState().navigate({ kind: 'knowledge', nav: { tab: 'activity' } })
      }
      onOpenRow={() => setExpanded((value) => !value)}
      renderRow={(row) => (
        <>
          <EventRow
            row={row}
            ready={done.ready}
            done={done.done}
            onOpen={() => setExpanded((value) => !value)}
          />
          {expanded && view !== null && (
            <div className="px-1.5 pb-2">
              <ChangeLines view={view} />
            </div>
          )}
        </>
      )}
    />
  );
}
