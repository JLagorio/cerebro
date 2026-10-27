import { useEffect, useRef, useState } from 'react';
import { hopCount, runDuration, runStatus, runTree, type RunNode } from '@/agent/elements/runs';
import { StepIcon } from '@/components/ai/StepLine';
import { TraceDescription, TraceLine, TraceTitle } from '@/components/ai/Trace';
import { actorLabel } from '@/engine/authors';
import type { Entry } from '@/engine/types';
import { instantText } from '@/engine/whenText';
import * as ipc from '@/lib/ipc';
import type { FleetRunDetail, RunCursor, RunHistoryScope, RunLineage } from '@/lib/ipc';
import type { FleetRun } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { RunDetailPanel } from './RunDetailPanel';
import { RunWhy } from './RunWhy';
import './runs.css';

type Read<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'unavailable' };

/** The open run, by the row it opened from: a run listed twice — its own
 * row, and a hop under another of this agent's runs — opens at the row that
 * was clicked, and only there. */
type Open = {
  key: string;
  runId: string;
  originVaultId: string | null;
  requestGeneration: number;
  read: Read<FleetRunDetail>;
};

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
export function AgentRunHistory({
  actor,
  scope,
}: {
  actor: string;
  scope?: RunHistoryScope | null;
}) {
  // A scope is a presentation identity: pending list/detail/lineage replies
  // from its previous incarnation cannot populate the next history.
  return <HistoryView key={JSON.stringify([actor, scope])} actor={actor} scope={scope} />;
}

type HistoryRows = {
  anchors: FleetRun[];
  context: FleetRun[];
  nextCursor: RunCursor | null;
  /** Undefined preserves the gated legacy construct presentation. Scoped
   * rows may use page titles only from their authoritative listing vault. */
  labelVaultId: string | null | undefined;
};

function HistoryView({ actor, scope }: { actor: string; scope?: RunHistoryScope | null }) {
  const entries = useVaultStore((s) => s.entries);
  const [runs, setRuns] = useState<Read<HistoryRows>>({ kind: 'loading' });
  const [more, setMore] = useState<'idle' | 'loading' | 'unavailable'>('idle');
  const [lineages, setLineages] = useState<Record<string, Read<RunLineage>>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const live = useRef(true);
  const listRequest = useRef(0);
  // M50.3: a run opens where it is listed. These rows were inert, so the one
  // page about an agent could not show what any of its runs did.
  const [open, setOpen] = useState<Open | null>(null);
  const detailRequest = useRef(0);
  const closeRun = () => {
    detailRequest.current += 1;
    setOpen(null);
  };
  const readDetail = (key: string, runId: string, originVaultId: string | null) => {
    const requestGeneration = ++detailRequest.current;
    setOpen({ key, runId, originVaultId, requestGeneration, read: { kind: 'loading' } });
    const apply = (read: Read<FleetRunDetail>) => {
      if (!live.current || detailRequest.current !== requestGeneration) return;
      setOpen((current) =>
        current !== null &&
        current.key === key &&
        current.runId === runId &&
        current.originVaultId === originVaultId &&
        current.requestGeneration === requestGeneration
          ? { ...current, read }
          : current,
      );
    };
    void ipc.fleetRunDetail(runId).then(
      (detail) =>
        apply(
          detail.run.run_id === runId && detail.run.vault_id === originVaultId
            ? { kind: 'ready', data: detail }
            : { kind: 'unavailable' },
        ),
      () => apply({ kind: 'unavailable' }),
    );
  };
  const openRun = (key: string, run: FleetRun) => {
    if (open?.key === key) {
      closeRun();
      return;
    }
    readDetail(key, run.run_id, run.vault_id);
  };

  const load = async (cursor?: RunCursor) => {
    const request = ++listRequest.current;
    if (cursor) setMore('loading');
    else setRuns({ kind: 'loading' });
    try {
      if (scope === null) throw new Error('No registered vault selected.');
      const data: HistoryRows =
        scope === undefined
          ? await ipc.fleetRuns({ limit: 200 }).then((all) => ({
              anchors: all.filter((run) => run.actor === actor),
              context: all,
              nextCursor: null,
              labelVaultId: undefined,
            }))
          : await ipc.fleetRunsPage(scope, cursor).then((page) => ({
              anchors: page.runs,
              context: page.runs,
              nextCursor: page.nextCursor,
              labelVaultId: scope.kind === 'agent' ? page.effectiveVaultIds[0] : null,
            }));
      if (!live.current || listRequest.current !== request) return;
      setRuns((previous) => ({
        kind: 'ready',
        data:
          cursor && previous.kind === 'ready'
            ? {
                ...data,
                anchors: [...previous.data.anchors, ...data.anchors],
                context: [...previous.data.context, ...data.context],
              }
            : data,
      }));
      setMore('idle');
    } catch {
      if (!live.current || listRequest.current !== request) return;
      if (cursor) setMore('unavailable');
      else setRuns({ kind: 'unavailable' });
    }
  };
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    live.current = true;
    void loadRef.current();
    return () => {
      live.current = false;
      listRequest.current += 1;
    };
  }, []);

  const readLineage = (runId: string) => {
    setLineages((old) => ({ ...old, [runId]: { kind: 'loading' } }));
    void ipc.fleetRunLineage(runId).then(
      (data) =>
        live.current && setLineages((old) => ({ ...old, [runId]: { kind: 'ready', data } })),
      () => live.current && setLineages((old) => ({ ...old, [runId]: { kind: 'unavailable' } })),
    );
  };

  if (runs.kind === 'loading') return null;
  if (runs.kind === 'unavailable') {
    // NOT the empty state: "has not run" and "could not read the runs" are
    // opposite sentences.
    return (
      <div data-testid="agent-runs-unavailable" className="m-0 text-sm text-(--text-meta)">
        <p data-testid="section-unavailable">
          Couldn't read the run history — it can't say what this agent has done.
        </p>
        <button type="button" onClick={() => void load()}>
          Retry history
        </button>
      </div>
    );
  }

  const all = runs.data.context;
  const byId = new Map(all.map((r) => [r.run_id, r]));
  const mine = runs.data.anchors;

  if (mine.length === 0) {
    return (
      <p data-testid="agent-runs-empty" className="m-0 text-sm text-(--text-meta)">
        No runs recorded for this agent.
      </p>
    );
  }

  // A hop is another worker's run, named as the app names it (M52.3); the
  // stamp the runtime recorded stays in the tooltip.
  const who = (run: FleetRun) =>
    actorLabel(
      run.actor,
      runs.data.labelVaultId === undefined || run.vault_id === runs.data.labelVaultId
        ? entries
        : [],
    );

  return (
    <div data-testid="agent-runs" className="flex flex-col gap-0.5">
      {scope?.kind === 'construct' && (
        <p className="text-metadata text-(--text-meta)">All registered vaults</p>
      )}
      {mine.map((run) => {
        const lineage = lineages[run.run_id];
        const show = scope === undefined || expanded.has(run.run_id);
        const tree = runTree(
          run,
          scope === undefined ? all : show && lineage?.kind === 'ready' ? lineage.data.runs : [],
        );
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
                      : who(parent).text}
                </span>{' '}
                — billed to that run's ceiling
              </p>
            )}
            <RunChain
              node={tree}
              path={run.run_id}
              entries={entries}
              labelVaultId={runs.data.labelVaultId}
              open={open}
              onOpen={openRun}
              onClose={closeRun}
              onRetry={() => open && readDetail(open.key, open.runId, open.originVaultId)}
            />
            {scope !== undefined && (
              <>
                <button
                  type="button"
                  aria-expanded={show}
                  onClick={() => {
                    setExpanded((old) => {
                      const next = new Set(old);
                      if (show) next.delete(run.run_id);
                      else next.add(run.run_id);
                      return next;
                    });
                    if (!show && lineage === undefined) readLineage(run.run_id);
                  }}
                >
                  {show ? 'Hide hops' : 'Show hops'}
                </button>
                {show && lineage?.kind === 'loading' && <p role="status">Loading hops…</p>}
                {show && lineage?.kind === 'unavailable' && (
                  <p>
                    Couldn't read this run's hops.{' '}
                    <button type="button" onClick={() => readLineage(run.run_id)}>
                      Retry hops
                    </button>
                  </p>
                )}
                {show && lineage?.kind === 'ready' && lineage.data.truncated && (
                  <p>More hops exist; showing the first 200.</p>
                )}
                {show && lineage?.kind === 'ready' && lineage.data.runs.length === 0 && (
                  <p>No hops recorded.</p>
                )}
              </>
            )}
            {hops > 0 && (
              <p className="m-0 ml-8 text-metadata text-(--text-meta)">
                {hops === 1 ? 'one hop, billed' : `${hops} hops, billed`} to this run's ceiling
              </p>
            )}
          </div>
        );
      })}
      {more === 'unavailable' && (
        <p role="status">Couldn't read more runs. The loaded history is still available.</p>
      )}
      {runs.data.nextCursor !== null && (
        <button
          type="button"
          disabled={more === 'loading'}
          onClick={() => void load(runs.data.nextCursor!)}
        >
          {more === 'loading'
            ? 'Loading more runs…'
            : more === 'unavailable'
              ? 'Retry more runs'
              : 'Load more runs'}
        </button>
      )}
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
  labelVaultId,
  open,
  onOpen,
  onClose,
  onRetry,
}: {
  node: RunNode<FleetRun>;
  path: string;
  entries: Entry[];
  labelVaultId: string | null | undefined;
  open: Open | null;
  onOpen: (key: string, run: FleetRun) => void;
  onClose: () => void;
  onRetry: () => void;
}) {
  const selected = open !== null && open.key === path ? open : null;
  return (
    <>
      <RunRow
        run={node.run}
        hop={node.depth > 0}
        entries={labelVaultId === undefined || node.run.vault_id === labelVaultId ? entries : []}
        expanded={selected !== null}
        onClick={() => onOpen(path, node.run)}
      />
      {selected !== null && (
        <div className="my-1">
          {selected.read.kind === 'ready' ? (
            <RunDetailPanel detail={selected.read.data} onClose={onClose} />
          ) : (
            <div>
              <p role="status">
                {selected.read.kind === 'loading'
                  ? 'Loading run detail…'
                  : "Couldn't read this run's detail."}
              </p>
              {selected.read.kind === 'unavailable' && (
                <button type="button" onClick={onRetry}>
                  Retry run detail
                </button>
              )}
              <button type="button" onClick={onClose}>
                Close run detail
              </button>
            </div>
          )}
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
              labelVaultId={labelVaultId}
              open={open}
              onOpen={onOpen}
              onClose={onClose}
              onRetry={onRetry}
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
