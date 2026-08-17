import type { FleetRunDetail } from '@/lib/ipc';
import { useNavStore } from '@/stores/navStore';

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
 */

/** Micros to a readable amount. Only ever called with a recorded value —
 * the absent case is handled before this, by saying so in words. */
function micros(value: number): string {
  return `$${(value / 1_000_000).toFixed(4)}`;
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
  const { run, cost_components: components, assembly } = detail;
  const metered = run.usage_state === 'exact';

  return (
    <div
      data-testid="run-detail"
      data-run={run.run_id}
      className="flex flex-col gap-2 rounded-lg border border-n-300 bg-n-50 p-3"
    >
      <div className="flex items-baseline gap-2">
        <h4 className="text-xs font-semibold text-n-800">{run.actor ?? 'unattributed'}</h4>
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
          <dd className="inline">{run.started_at}</dd>
        </div>
        <div>
          <dt className="inline text-n-500">Ended </dt>
          {/* A run still going has no end, and an em dash is the honest
              placeholder — "now" would be a claim nothing recorded. */}
          <dd className="inline">{run.ended_at ?? '—'}</dd>
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
      </dl>

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
      {run.proposals_submitted > run.applied + run.rejected && (
        <button
          type="button"
          data-testid="run-detail-to-review"
          className="self-start rounded border border-n-300 px-2 py-1 text-2xs text-n-700 hover:bg-n-100"
          onClick={() => navigate({ kind: 'knowledge', nav: { tab: 'waiting' } })}
        >
          {run.proposals_submitted - run.applied - run.rejected} still waiting on a decision
        </button>
      )}
    </div>
  );
}
