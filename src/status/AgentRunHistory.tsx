import { useEffect, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { actorLabel } from '@/engine/authors';
import { instantText } from '@/engine/whenText';
import * as ipc from '@/lib/ipc';
import type { FleetRunDetail } from '@/lib/ipc';
import type { FleetRun } from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { RunDetailPanel } from './RunDetailPanel';
import { RunWhy } from './RunWhy';

type Read<T> = { kind: 'loading' } | { kind: 'ready'; data: T } | { kind: 'unavailable' };

/**
 * The actor's run history with its chains rendered (M41.4 — the trace
 * M34.3's `parent_run_id` has waited for). A hop names the run it hopped
 * from; a root with hops shows them indented, and the indent IS the billing
 * statement: hops bill to the root's ceiling.
 *
 * Two hosts since M55.12: an agent page's Runs tab, and a construct's page on
 * the Agents surface. Neither owns it, so it lives with the other status reads.
 */
export function AgentRunHistory({ actor }: { actor: string }) {
  const entries = useVaultStore((s) => s.entries);
  const [runs, setRuns] = useState<Read<FleetRun[]>>({ kind: 'loading' });
  // M50.3: a run opens where it is listed. These rows were inert, so the one
  // page about an agent could not show what any of its runs did.
  const [open, setOpen] = useState<FleetRunDetail | null>(null);
  const openRun = (runId: string) => {
    if (open?.run.run_id === runId) {
      setOpen(null);
      return;
    }
    ipc.fleetRunDetail(runId).then(setOpen, () => setOpen(null));
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
      <p data-testid="agent-runs-unavailable" className="m-0 text-sm text-n-500">
        Couldn't read the run history — it can't say what this agent has done.
      </p>
    );
  }

  const all = runs.data;
  const byId = new Map(all.map((r) => [r.run_id, r]));
  const childrenOf = new Map<string, FleetRun[]>();
  for (const run of all) {
    if (run.parent_run_id === null) continue;
    const siblings = childrenOf.get(run.parent_run_id) ?? [];
    siblings.push(run);
    childrenOf.set(run.parent_run_id, siblings);
  }
  const mine = all.filter((r) => r.actor === actor);

  if (mine.length === 0) {
    return (
      <p data-testid="agent-runs-empty" className="m-0 text-sm text-n-500">
        No runs recorded for this agent.
      </p>
    );
  }

  const tokens = (run: FleetRun) =>
    run.usage_state === 'exact'
      ? `${(run.input_tokens + run.output_tokens).toLocaleString()} tokens`
      : // The zeros a lost run leaves behind are not a measurement.
        'usage unknown';

  // A hop is another worker's run, named as the app names it (M52.3); the
  // stamp the runtime recorded stays in the tooltip.
  const who = (raw: string | null) => actorLabel(raw, entries);

  const row = (run: FleetRun, hop: boolean) => (
    <button
      type="button"
      key={run.run_id}
      data-testid={hop ? 'agent-run-hop' : 'agent-run'}
      data-run={run.run_id}
      aria-expanded={open?.run.run_id === run.run_id}
      onClick={() => openRun(run.run_id)}
      className={`flex w-full items-center gap-2 rounded-md bg-transparent px-2 py-1 text-left text-sm hover:bg-n-50 ${hop ? 'ml-6 border-0 border-l-2 border-solid border-n-200' : 'border-0'}`}
    >
      {hop && <Icon name="corner-down-right" size={13} color="var(--n-400)" />}
      <span
        data-testid="agent-run-label"
        className="min-w-0 flex-1 truncate text-n-800"
        title={hop ? (run.actor ?? undefined) : run.started_at}
      >
        {hop ? who(run.actor).text : instantText(run.started_at)}
      </span>
      {/* Why it started (M56.7), and how late a schedule's fire ran. */}
      <RunWhy cause={run.cause} startedAt={run.started_at} />
      <span className="flex-none text-xs text-n-500">
        {run.lane} · {run.mode}
      </span>
      <span className="flex-none text-xs text-n-500">{tokens(run)}</span>
      <span
        className={`flex-none text-xs ${run.outcome === 'succeeded' ? 'text-n-500' : 'font-medium text-danger-600'}`}
      >
        {run.outcome}
      </span>
    </button>
  );

  return (
    <div data-testid="agent-runs" className="flex flex-col gap-0.5">
      {mine.map((run) => {
        const hops = childrenOf.get(run.run_id) ?? [];
        const parent = run.parent_run_id === null ? null : (byId.get(run.parent_run_id) ?? null);
        return (
          <div key={run.run_id}>
            {run.parent_run_id !== null && (
              <p
                data-testid="agent-run-parent"
                className="m-0 ml-2 text-xs leading-[17px] text-n-500"
              >
                ↳ a hop from{' '}
                <span title={parent?.actor ?? undefined}>
                  {parent === null ? `run ${run.parent_run_id}` : who(parent.actor).text}
                </span>{' '}
                — billed to that run's ceiling
              </p>
            )}
            {row(run, false)}
            {open?.run.run_id === run.run_id && (
              <div className="my-1">
                <RunDetailPanel detail={open} onClose={() => setOpen(null)} />
              </div>
            )}
            {hops.length > 0 && (
              <>
                {hops.map((hopRun) => row(hopRun, true))}
                <p className="m-0 ml-8 text-xs leading-[17px] text-n-400">
                  {hops.length === 1 ? 'one hop, billed' : `${hops.length} hops, billed`} to this
                  run's ceiling
                </p>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
