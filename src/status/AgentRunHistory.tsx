import { useEffect, useState } from 'react';
import { hopCount, runDuration, runStatus, runTree, type RunNode } from '@/agent/elements/runs';
import { StepIcon } from '@/components/ai/StepLine';
import { TraceDescription, TraceLine, TraceTitle } from '@/components/ai/Trace';
import { actorLabel } from '@/engine/authors';
import type { Entry } from '@/engine/types';
import { instantText } from '@/engine/whenText';
import * as ipc from '@/lib/ipc';
import type { FleetRunDetail } from '@/lib/ipc';
import type { FleetRun } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { RunDetailPanel } from './RunDetailPanel';
import { RunWhy } from './RunWhy';
import './runs.css';

type Read<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'unavailable' };

/** The open run, by the row it opened from: a run listed twice — its own
 * row, and a hop under another of this agent's runs — opens at the row that
 * was clicked, and only there. */
type Open = { key: string; detail: FleetRunDetail };

/**
 * The actor's run history with its chains rendered (M41.4 — the trace
 * M34.3's `parent_run_id` has waited for). A hop names the run it hopped
 * from; a root with hops shows them under it on the trace's rule, and the
 * nesting IS the billing statement: hops bill to the root's ceiling.
 *
 * Each run is a trace line (M91.14): its state's icon, ink and, for a screen
 * reader, word, the working light on a run still going, and how long it
 * took only when both its ends were recorded (CV-05). A hop's own hops nest
 * under it, as deep as a chain goes (CV-48), and every row opens its run
 * where it is listed.
 *
 * Two hosts since M55.12: an agent page's Runs tab, and a construct's page on
 * the Agents surface. Neither owns it, so it lives with the other status reads.
 */
export function AgentRunHistory({ actor }: { actor: string }) {
  const entries = useVaultStore((s) => s.entries);
  const [runs, setRuns] = useState<Read<FleetRun[]>>({ kind: 'loading' });
  // M50.3: a run opens where it is listed. These rows were inert, so the one
  // page about an agent could not show what any of its runs did.
  const [open, setOpen] = useState<Open | null>(null);
  const openRun = (key: string, runId: string) => {
    if (open?.key === key) {
      setOpen(null);
      return;
    }
    ipc.fleetRunDetail(runId).then(
      (detail) => setOpen({ key, detail }),
      () => setOpen(null),
    );
  };

  useEffect(() => {
    let live = true;
    setRuns({ kind: 'loading' });
    void ipc.fleetRuns({ limit: 200 }).then(
      (data) => live && setRuns({ kind: 'ready', data }),
      () => live && setRuns({ kind: 'unavailable' }),
    );
    return () => {
      live = false;
    };
  }, [actor]);

  if (runs.kind === 'loading') return null;
  if (runs.kind === 'unavailable') {
    // NOT the empty state: "has not run" and "could not read the runs" are
    // opposite sentences.
    return (
      <p data-testid="agent-runs-unavailable" className="m-0 text-sm text-(--text-meta)">
        Couldn't read the run history — it can't say what this agent has done.
      </p>
    );
  }

  const all = runs.data;
  const byId = new Map(all.map((r) => [r.run_id, r]));
  const mine = all.filter((r) => r.actor === actor);

  if (mine.length === 0) {
    return (
      <p data-testid="agent-runs-empty" className="m-0 text-sm text-(--text-meta)">
        No runs recorded for this agent.
      </p>
    );
  }

  // A hop is another worker's run, named as the app names it (M52.3); the
  // stamp the runtime recorded stays in the tooltip.
  const who = (raw: string | null) => actorLabel(raw, entries);

  return (
    <div data-testid="agent-runs" className="flex flex-col gap-0.5">
      {mine.map((run) => {
        const tree = runTree(run, all);
        const hops = hopCount(tree);
        const parent = run.parent_run_id === null ? null : (byId.get(run.parent_run_id) ?? null);
        return (
          <div key={run.run_id}>
            {run.parent_run_id !== null && (
              <p
                data-testid="agent-run-parent"
                className="m-0 ml-2 text-xs leading-[17px] text-(--text-meta)"
              >
                ↳ a hop from{' '}
                <span title={parent?.actor ?? undefined}>
                  {parent === null
                    ? `run ${run.parent_run_id}`
                    : parent.actor === null
                      ? 'an assistant turn'
                      : who(parent.actor).text}
                </span>{' '}
                — billed to that run's ceiling
              </p>
            )}
            <RunChain
              node={tree}
              path={run.run_id}
              entries={entries}
              open={open}
              onOpen={openRun}
              onClose={() => setOpen(null)}
            />
            {hops > 0 && (
              <p className="m-0 ml-8 text-metadata text-(--text-meta)">
                {hops === 1 ? 'one hop, billed' : `${hops} hops, billed`} to this run's ceiling
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A run's row, its detail when it is the open one, and the hops it caused
 * under it on the trace's rule. `path` names the row: the run ids from the
 * root of this list's chain to this run.
 */
function RunChain({
  node,
  path,
  entries,
  open,
  onOpen,
  onClose,
}: {
  node: RunNode<FleetRun>;
  path: string;
  entries: Entry[];
  open: Open | null;
  onOpen: (key: string, runId: string) => void;
  onClose: () => void;
}) {
  const detail = open !== null && open.key === path ? open.detail : null;
  return (
    <>
      <RunRow
        run={node.run}
        hop={node.depth > 0}
        entries={entries}
        expanded={detail !== null}
        onClick={() => onOpen(path, node.run.run_id)}
      />
      {detail !== null && (
        <div className="my-1">
          <RunDetailPanel detail={detail} onClose={onClose} />
        </div>
      )}
      {node.hops.length > 0 && (
        <div className="cb-run-hops" data-hops={node.run.run_id}>
          {node.hops.map((hop) => (
            <RunChain
              key={hop.run.run_id}
              node={hop}
              path={`${path}>${hop.run.run_id}`}
              entries={entries}
              open={open}
              onOpen={onOpen}
              onClose={onClose}
            />
          ))}
        </div>
      )}
    </>
  );
}

function RunRow({
  run,
  hop,
  entries,
  expanded,
  onClick,
}: {
  run: FleetRun;
  hop: boolean;
  entries: Entry[];
  expanded: boolean;
  onClick: () => void;
}) {
  const status = runStatus(run.outcome);
  const took = runDuration(run);
  const tokens =
    run.usage_state === 'exact'
      ? `${(run.input_tokens + run.output_tokens).toLocaleString()} tokens`
      : // The zeros a lost run leaves behind are not a measurement.
        'usage unknown';
  return (
    <button
      type="button"
      data-testid={hop ? 'agent-run-hop' : 'agent-run'}
      data-run={run.run_id}
      aria-expanded={expanded}
      onClick={onClick}
      className="flex w-full rounded-md border-0 bg-transparent px-2 py-1 text-left hover:bg-n-50"
    >
      <TraceLine status={status.trace} statusText={status.statusText} className="cb-run-line">
        <StepIcon state={status.state} icon={status.icon} />
        <TraceTitle
          data-testid="agent-run-label"
          className="flex-1 text-n-800"
          title={hop ? (run.actor ?? undefined) : run.started_at}
        >
          {hop ? actorLabel(run.actor, entries).text : instantText(run.started_at)}
        </TraceTitle>
        {/* Why it started (M56.7), and how late a schedule's fire ran. */}
        <RunWhy cause={run.cause} startedAt={run.started_at} />
        <span className="flex-none text-metadata text-(--text-meta)">
          {run.lane} · {run.mode}
        </span>
        {took !== undefined && (
          <TraceDescription data-testid="agent-run-took" className="text-metadata">
            {took}
          </TraceDescription>
        )}
        <span className="flex-none text-metadata text-(--text-meta)">{tokens}</span>
        <span
          className={`flex-none text-xs ${status.state === 'failed' ? 'font-medium text-danger-600' : 'text-(--text-meta)'}`}
        >
          {status.words}
        </span>
      </TraceLine>
    </button>
  );
}
