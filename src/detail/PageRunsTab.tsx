import { useCallback, useEffect, useMemo, useState } from 'react';
import { onAgentEvent } from '@/agent/agentIpc';
import { runDuration, runForest, runStatus, type RunNode } from '@/agent/elements/runs';
import { StepIcon } from '@/components/ai/StepLine';
import { TraceDescription, TraceLine, TraceTitle } from '@/components/ai/Trace';
import { agentRef, isAgentEntry } from '@/engine/agents';
import { pagesFiledUnder } from '@/engine/filing';
import type { Entry, Schema } from '@/engine/types';
import { localStamp, relativeWhen } from '@/engine/whenText';
import { useFeed } from '@/hooks/useFeed';
import { fleetRunDetail, fleetSubjectRuns, type FleetRun } from '@/lib/ipc';
import { RunDetailPanel } from '@/status/RunDetailPanel';
import { RunWhy } from '@/status/RunWhy';
import { useVaultStore } from '@/stores/vaultStore';
import '@/status/runs.css';

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

/**
 * One run about the page, as a trace line (M91.14): who ran it in its
 * state's icon, ink and word, how it ended, how long it took when both its
 * ends were recorded, and when; then the page it was about and why it
 * started, under its name. The hops it caused hang under it on the trace's
 * rule (`runForest`: a hop stays below its listed parent, an unlisted parent
 * leaves a root, and a cycle ends where it closes).
 */
function RunChain({
  node,
  entries,
  onOpen,
}: {
  node: RunNode<FleetRun>;
  entries: Entry[];
  onOpen: (id: string) => void;
}) {
  const { run, depth } = node;
  const agent = entries.find((entry) => isAgentEntry(entry) && agentRef(entry).actor === run.actor);
  const subject = run.cause?.subject;
  const title =
    subject == null ? null : (entries.find((entry) => entry.path === subject)?.title ?? subject);
  const status = runStatus(run.outcome);
  const took = runDuration(run);
  return (
    <>
      <button
        type="button"
        data-testid="page-run-row"
        data-run={run.run_id}
        data-depth={depth}
        onClick={() => onOpen(run.run_id)}
        className="block w-full rounded-md border-0 bg-transparent px-2 py-2 text-left hover:bg-n-50"
      >
        <TraceLine
          status={status.trace}
          statusText={status.statusText}
          className="cb-run-line cb-run-line-xs"
        >
          <StepIcon state={status.state} icon={status.icon} />
          <TraceTitle className="flex-1 text-n-700">
            {agent?.title ?? run.actor ?? 'unattributed'}
          </TraceTitle>
          <span className="text-n-500">{status.words}</span>
          {took !== undefined && <TraceDescription>{took}</TraceDescription>}
          <time
            dateTime={run.started_at}
            title={localStamp(new Date(run.started_at))}
            className="text-n-400"
          >
            {relativeWhen(run.started_at, new Date())}
          </time>
        </TraceLine>
        {title !== null && (
          <span className="cb-run-extra mt-0.5 block truncate text-xs text-n-600">{title}</span>
        )}
        <span className="cb-run-extra mt-0.5 flex">
          <RunWhy cause={run.cause} startedAt={run.started_at} />
        </span>
      </button>
      {node.hops.length > 0 && (
        <div className="cb-run-hops" data-hops={run.run_id}>
          {node.hops.map((hop) => (
            <RunChain key={hop.run.run_id} node={hop} entries={entries} onOpen={onOpen} />
          ))}
        </div>
      )}
    </>
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
  const chains = state.kind === 'ready' ? runForest(state.data) : [];
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
      {state.kind === 'ready' && chains.length === 0 && (
        <p data-testid="page-runs-empty" className="m-0 text-sm text-n-500">
          No runs about this page or the pages filed under it yet.
        </p>
      )}
      {chains.map((node) => (
        <div key={node.run.run_id}>
          <RunChain
            node={node}
            entries={entries}
            onOpen={(id) => setOpen({ vault, path: entry.path, id })}
          />
        </div>
      ))}
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
