import { useCallback, useEffect, useMemo, useState } from 'react';
import { onAgentEvent } from '@/agent/agentIpc';
import { agentRef, isAgentEntry } from '@/engine/agents';
import { pagesFiledUnder } from '@/engine/filing';
import type { Entry, Schema } from '@/engine/types';
import { localStamp, relativeWhen } from '@/engine/whenText';
import { useFeed } from '@/hooks/useFeed';
import { fleetRunDetail, fleetSubjectRuns, type FleetRun } from '@/lib/ipc';
import { RunDetailPanel } from '@/status/RunDetailPanel';
import { RunWhy } from '@/status/RunWhy';
import { useVaultStore } from '@/stores/vaultStore';

/** Keep a hop directly below its listed parent; an unlisted parent leaves a
 * root row. The seen set bounds malformed historical cycles as well. */
function runRows(runs: FleetRun[]): { run: FleetRun; depth: number }[] {
  const byId = new Set(runs.map((run) => run.run_id));
  const seen = new Set<string>();
  const rows: { run: FleetRun; depth: number }[] = [];
  const add = (run: FleetRun, depth: number) => {
    if (seen.has(run.run_id)) return;
    seen.add(run.run_id);
    rows.push({ run, depth });
    for (const child of runs)
      if (child.parent_run_id === run.run_id) add(child, Math.min(depth + 1, 2));
  };
  for (const run of runs)
    if (run.parent_run_id === null || !byId.has(run.parent_run_id)) add(run, 0);
  for (const run of runs) add(run, 0);
  return rows;
}

function OpenRun({ vault, id, close }: { vault: string | null; id: string; close: () => void }) {
  const read = useCallback(() => fleetRunDetail(id), [id]);
  const detail = useFeed(vault, read);
  if (detail.kind === 'ready') return <RunDetailPanel detail={detail.data} onClose={close} />;
  return (
    <p role="status" className="m-0 text-xs text-n-500">
      {detail.kind === 'loading' ? 'Reading run…' : "Couldn't read this run."}
    </p>
  );
}

/** A page is a place for recorded subjects, never a guess about older runs. */
export function PageRunsTab({
  entry,
  entries,
  schema,
}: {
  entry: Entry;
  entries: Entry[];
  schema: Schema;
}) {
  const vault = useVaultStore((state) => state.vaultPath);
  const views = useVaultStore((state) => state.views);
  const subjects = useMemo(
    () => pagesFiledUnder(entry, entries, schema, views),
    [entry, entries, schema, views],
  );
  const subjectKey = JSON.stringify(subjects.slice(0, 500));
  const read = useCallback(
    (vault: string) => fleetSubjectRuns(vault, JSON.parse(subjectKey) as string[], 100),
    [subjectKey],
  );
  const [pulse, setPulse] = useState(0);
  useEffect(
    () =>
      onAgentEvent((event) => {
        if (event.kind === 'Init' || event.kind === 'Done' || event.kind === 'Error')
          setPulse((value) => value + 1);
      }),
    [],
  );
  const state = useFeed(vault, read, pulse);
  const [open, setOpen] = useState<{ vault: string | null; path: string; id: string } | null>(null);
  const rows = state.kind === 'ready' ? runRows(state.data) : [];
  return (
    <div data-testid="page-runs" className="space-y-3 px-6 py-4">
      {state.kind === 'loading' && (
        <p role="status" className="m-0 text-sm text-n-500">
          Reading runs…
        </p>
      )}
      {state.kind === 'unavailable' && (
        <p data-testid="section-unavailable" className="m-0 text-sm text-n-500">
          Couldn't read this page's runs.
        </p>
      )}
      {state.kind === 'ready' && rows.length === 0 && (
        <p data-testid="page-runs-empty" className="m-0 text-sm text-n-500">
          No runs about this page or the pages filed under it yet.
        </p>
      )}
      {rows.map(({ run, depth }) => {
        const agent = entries.find(
          (entry) => isAgentEntry(entry) && agentRef(entry).actor === run.actor,
        );
        const subject = run.cause?.subject;
        const title =
          subject == null
            ? null
            : (entries.find((entry) => entry.path === subject)?.title ?? subject);
        return (
          <button
            type="button"
            key={run.run_id}
            data-testid="page-run-row"
            data-run={run.run_id}
            data-depth={depth}
            onClick={() => setOpen({ vault, path: entry.path, id: run.run_id })}
            className="block w-full rounded-md border-0 bg-transparent px-2 py-2 text-left hover:bg-n-50"
            style={{ paddingLeft: `${8 + depth * 20}px` }}
          >
            <span className="flex items-baseline gap-3 text-xs">
              <span className="min-w-0 flex-1 truncate text-n-700">
                {agent?.title ?? run.actor ?? 'unattributed'}
              </span>
              <span className="text-n-500">{run.outcome}</span>
              <time
                dateTime={run.started_at}
                title={localStamp(new Date(run.started_at))}
                className="text-n-400"
              >
                {relativeWhen(run.started_at, new Date())}
              </time>
            </span>
            {title !== null && (
              <span className="mt-0.5 block truncate text-xs text-n-600">{title}</span>
            )}
            <span className="mt-0.5 flex">
              <RunWhy cause={run.cause} startedAt={run.started_at} />
            </span>
          </button>
        );
      })}
      <p
        data-testid="page-runs-footnote"
        className="m-0 border-t border-n-100 pt-3 text-xs text-n-500"
      >
        Runs from before Cerebro recorded why a run started can't be placed on a page.
      </p>
      {subjects.length > 500 && (
        <p data-testid="page-runs-limit" className="m-0 text-xs text-n-500">
          Searched the first 500 of {subjects.length} pages filed here.
        </p>
      )}
      {open !== null && open.vault === vault && open.path === entry.path && (
        <OpenRun
          key={`${vault}:${open.id}`}
          vault={vault}
          id={open.id}
          close={() => setOpen(null)}
        />
      )}
    </div>
  );
}
