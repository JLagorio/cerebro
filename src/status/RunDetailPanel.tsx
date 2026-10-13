import { useEffect, useState } from 'react';
import { actorLabel } from '@/engine/authors';
import { instantText } from '@/engine/whenText';
import { runKnowledgeWrites, type FleetRunDetail, type RunWrite } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * One run, opened (M33.5).
 *
 * **Why this is not `DetailPanel`.** The plan suggested reusing the record
 * detail chrome. That chrome is bound to a vault ENTRY — `detailPath`,
 * `useEntry`, a title you can rename and a BlockNote body — and a run has
 * none of those. Fitting one through it would mean inventing an entry-shaped
 * object for something that is not a record, which is the type special-casing
 * AGENTS.md forbids, arrived at from the other direction. A run is
 * operational; it gets an operational panel.
 *
 * **Every absent join says it is absent.** `cost_components: null` means no
 * rows were recorded for this run — pre-M31.6, or a path M31.6 does not cover
 * — and renders "not recorded". It never renders as $0, and an individual
 * component with no `observed_cost_micros` never renders as free either.
 * The proposal counters follow the same rule (M49.9): `null` is a run nothing
 * ever booked, and it reads "not recorded" — never "0 applied", and never a
 * "still waiting" count computed from zeros nobody measured.
 */

/** Micros to a readable amount. Only ever called with a recorded value —
 * the absent case is handled before this, by saying so in words. */
function micros(value: number): string {
  return `$${(value / 1_000_000).toFixed(4)}`;
}

/**
 * What the run changed in Knowledge (M50.3) — the concepts its proposals
 * named, each one a page, with what became of the proposal. The counters
 * above said "2 applied" and named nothing. `null` (a vault that keeps no
 * ledger, or a read that failed) is said as not recorded; `[]` is a run
 * measured to have changed nothing here.
 */
function KnowledgeChanged({ runId }: { runId: string }) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const navigate = useNavStore((s) => s.navigate);
  const [writes, setWrites] = useState<RunWrite[] | null | 'loading'>('loading');
  useEffect(() => {
    if (vaultPath === null) {
      setWrites(null);
      return;
    }
    let live = true;
    setWrites('loading');
    runKnowledgeWrites(vaultPath, runId).then(
      (found) => live && setWrites(found),
      () => live && setWrites(null),
    );
    return () => {
      live = false;
    };
  }, [vaultPath, runId]);

  return (
    <section className="flex flex-col gap-1" data-testid="run-detail-knowledge">
      <h5 className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">Knowledge</h5>
      {writes === 'loading' ? null : writes === null ? (
        <Absent what="What it changed in Knowledge" />
      ) : writes.length === 0 ? (
        <p className="text-2xs text-n-500">Changed nothing in Knowledge.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-px p-0">
          {writes.map((w) => (
            <li key={w.path}>
              <button
                type="button"
                data-testid="run-detail-knowledge-write"
                data-path={w.path}
                onClick={() => navigate({ kind: 'doc', path: w.path })}
                className="flex w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1 py-0.5 text-left text-2xs hover:bg-n-100"
              >
                <span className="min-w-0 truncate text-cortex-600">
                  {entries.find((e) => e.path === w.path)?.title ?? w.path}
                </span>
                <span className="flex-none text-n-500">{w.state}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * A recorded instant, as the reader's wall clock (M52.3) — Started and Ended
 * said `2026-07-28T09:02:00Z` and made a person convert it. The runtime writes UTC
 * with a `Z`, so the parse is exact; the ISO stays in the `title`. A stamp
 * that will not parse comes back verbatim rather than as a confident wrong
 * time, the same rule `relativeWhen` keeps.
 */
function Stamp({ iso }: { iso: string }) {
  return (
    <dd className="inline" title={iso}>
      {instantText(iso)}
    </dd>
  );
}

function Absent({ what }: { what: string }) {
  return (
    <p className="text-2xs text-n-500" data-testid="detail-absent">
      {what} — not recorded for this run.
    </p>
  );
}

export function RunDetailPanel({
  detail,
  onClose,
}: {
  detail: FleetRunDetail;
  onClose: () => void;
}) {
  const navigate = useNavStore((s) => s.navigate);
  const entries = useVaultStore((s) => s.entries);
  const { run, cost_components: components, assembly } = detail;
  // Who ran it, in the app's nouns (M52.3); an agent's name opens its page.
  const who = actorLabel(run.actor, entries);
  const agent = who.actor;
  const metered = run.usage_state === 'exact';
  const { proposals_submitted: submitted, applied, rejected } = run;
  const booked = submitted !== null && applied !== null && rejected !== null;
  // Only a booked row can say what is still undecided.
  const waiting = booked ? submitted - applied - rejected : 0;

  return (
    <div
      data-testid="run-detail"
      data-run={run.run_id}
      className="flex flex-col gap-2 rounded-lg border border-n-300 bg-n-50 p-3"
    >
      <div className="flex items-baseline gap-2">
        <h4 className="text-xs font-semibold text-n-800" title={who.raw ?? undefined}>
          {agent === undefined ? (
            who.text
          ) : (
            <button
              type="button"
              data-testid="run-detail-agent"
              onClick={() => navigate({ kind: 'agents', actor: agent })}
              className="border-0 bg-transparent p-0 text-xs font-semibold text-n-800 hover:text-cortex-600"
            >
              {who.text}
            </button>
          )}
        </h4>
        <span className="text-2xs text-n-500">
          {run.lane} · {run.mode}
        </span>
        <button
          type="button"
          className="ml-auto text-2xs text-n-500 hover:text-n-800"
          onClick={onClose}
          data-testid="run-detail-close"
        >
          Close
        </button>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-2xs text-n-600">
        <div>
          <dt className="inline text-n-500">Started </dt>
          <Stamp iso={run.started_at} />
        </div>
        <div>
          <dt className="inline text-n-500">Ended </dt>
          {/* A run still going has no end, and an em dash is the honest
              placeholder — "now" would be a claim nothing recorded. */}
          {run.ended_at === null ? <dd className="inline">—</dd> : <Stamp iso={run.ended_at} />}
        </div>
        <div>
          <dt className="inline text-n-500">Outcome </dt>
          <dd className="inline">{run.outcome.replace(/_/g, ' ')}</dd>
        </div>
        <div>
          <dt className="inline text-n-500">Tokens </dt>
          <dd className="inline">
            {metered
              ? `${run.input_tokens.toLocaleString()} in · ${run.output_tokens.toLocaleString()} out`
              : 'unknown'}
          </dd>
        </div>
        <div>
          <dt className="inline text-n-500">Proposals </dt>
          <dd className="inline" data-testid="run-detail-proposals">
            {booked
              ? `${submitted} submitted · ${applied} applied · ${rejected} rejected`
              : 'not recorded'}
          </dd>
        </div>
      </dl>

      <KnowledgeChanged runId={run.run_id} />

      <section className="flex flex-col gap-1">
        <h5 className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">Cost</h5>
        {components === null ? (
          <Absent what="Cost components" />
        ) : (
          <table className="w-full text-2xs">
            <thead className="text-left text-n-500">
              <tr>
                <th className="font-medium">Component</th>
                <th className="font-medium">Quantity</th>
                <th className="font-medium">Observed</th>
              </tr>
            </thead>
            <tbody>
              {components.map((component) => (
                <tr
                  key={component.component}
                  data-testid="cost-component"
                  data-component={component.component}
                  data-estimated={component.estimated}
                >
                  <td>
                    {component.component}
                    {component.estimated && <span className="text-warn-600"> (estimated)</span>}
                  </td>
                  <td className="tabular-nums">
                    {component.quantity.toLocaleString()} {component.unit}
                  </td>
                  <td className="tabular-nums">
                    {component.observed_cost_micros === null ? (
                      // Absent, not free. A dash here would read as zero.
                      <span className="text-n-500">not recorded</span>
                    ) : (
                      micros(component.observed_cost_micros)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h5 className="text-2xs font-semibold uppercase tracking-[0.06em] text-n-500">Assembly</h5>
        {assembly === null ? (
          <Absent what="Assembly metrics" />
        ) : (
          <dl
            className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-2xs text-n-600"
            data-testid="assembly-metrics"
          >
            <div>
              <dt className="inline text-n-500">Stakes </dt>
              <dd className="inline">{assembly.intended_stakes}</dd>
            </div>
            <div>
              <dt className="inline text-n-500">Sources </dt>
              <dd className="inline">{assembly.source_count}</dd>
            </div>
            <div>
              <dt className="inline text-n-500">Evidence </dt>
              <dd className="inline">{assembly.evidence_item_count}</dd>
            </div>
            <div>
              <dt className="inline text-n-500">Latency </dt>
              <dd className="inline">
                {assembly.answer_latency_micros === null
                  ? 'not recorded'
                  : `${(assembly.answer_latency_micros / 1000).toFixed(0)} ms`}
              </dd>
            </div>
          </dl>
        )}
      </section>

      {/* A run that queued proposals has somewhere to send you. A run that
          queued none does not, and a dead link would be worse than none. */}
      {waiting > 0 && (
        <button
          type="button"
          data-testid="run-detail-to-review"
          className="self-start rounded-xs border border-n-300 px-2 py-1 text-2xs text-n-700 hover:bg-n-100"
          onClick={() => navigate({ kind: 'knowledge', nav: { tab: 'review' } })}
        >
          {waiting} still waiting on a decision
        </button>
      )}
    </div>
  );
}
