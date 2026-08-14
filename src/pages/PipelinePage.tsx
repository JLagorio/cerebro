import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import * as ipc from '@/lib/ipc';
import type { PipelineOverview } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * What the background is doing, what it has spent, and what it is waiting on
 * (M25.7) — the first real surface of the overhaul.
 *
 * **The meter is global and the lanes are not.** One personal CLI
 * subscription is metered once, however many vaults debit it; which KINDS of
 * background work run is a per-vault choice, because somebody may want
 * scheduled agents at work and nothing at all in their journal.
 *
 * **Three faces of failure stay three banners.** A quota death means wait; a
 * dead source means reality may be moving unobserved; a broken file means fix
 * one file. One merged "something went wrong" would tell a person none of
 * those, and they need different actions.
 *
 * **"Activity log", never "ledger".** Ledger is reserved for the epistemic
 * record in the vault. Runs and token counts are operational.
 *
 * Every action here is a HUMAN UI action, so the store-layer never-throw rule
 * applies: they catch, toast, and reload rather than propagating.
 */

const BANNER_TITLE: Record<string, string> = {
  runtime_health: 'Claude Code is not answering',
  source_health: 'A source is not answering',
  ingestion: 'Some items could not be read',
  accounting_unknown: "Today's spend could not be counted",
};

function Meter({ overview }: { overview: PipelineOverview }) {
  const { meter } = overview;
  const bars: [string, number, number][] = [
    ['Runs', meter.runs_started, meter.max_daily_runs],
    ['Tokens', meter.tokens_used, meter.max_daily_tokens],
    ['Output', meter.output_tokens_used, meter.max_daily_output_tokens],
  ];
  return (
    <section className="rounded-lg border border-n-200 p-4" data-testid="budget-meter">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Today, across every vault</h2>
        <span
          className="text-xs uppercase tracking-wide text-n-500"
          data-testid="ceiling-state"
          data-state={meter.ceiling_state}
        >
          {meter.ceiling_state.replace('_', ' ')}
        </span>
      </div>
      {meter.accounting_state !== 'exact' && (
        <p className="mt-1 text-xs text-warn-600" data-testid="accounting-unknown">
          Spend for this day is unknown — it is not zero.
        </p>
      )}
      <dl className="mt-3 grid grid-cols-3 gap-3">
        {bars.map(([label, used, ceiling]) => (
          <div key={label} data-testid={`meter-${label.toLowerCase()}`}>
            <dt className="text-xs text-n-500">{label}</dt>
            <dd className="text-sm tabular-nums">
              {used.toLocaleString()}{' '}
              <span className="text-n-400">/ {ceiling.toLocaleString()}</span>
            </dd>
            <div className="mt-1 h-1 rounded bg-n-100">
              <div
                className="h-1 rounded bg-synapse-500"
                style={{ width: `${ceiling === 0 ? 100 : Math.min(100, (used / ceiling) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function PipelinePage() {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const toast = useUiStore((s) => s.toast);
  const [overview, setOverview] = useState<PipelineOverview | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (vaultPath === null) return;
    try {
      setOverview(await ipc.pipelineOverview(vaultPath));
    } catch {
      // A vault with no runtime database has nothing to show. That is a
      // degraded workspace, not a broken one.
      setOverview(null);
    }
  }, [vaultPath]);

  useEffect(() => {
    void load();
  }, [load]);

  // Human UI actions: catch, toast, reload. Never throw (AGENTS.md).
  const act = async (run: () => Promise<unknown>, said: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await run();
      toast(said);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'That did not take');
    } finally {
      setBusy(false);
      await load();
    }
  };

  if (vaultPath === null || overview === null) {
    return (
      <div className="p-6" data-testid="pipeline-page">
        <EmptyState
          icon="activity"
          title="Nothing to report yet"
          description="The background pipeline records what it runs and what it spends. Once it has, this is where it says so."
        />
      </div>
    );
  }

  const { held } = overview;
  return (
    <div className="flex flex-col gap-4 overflow-auto p-6" data-testid="pipeline-page">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Background</h1>
          <p className="text-sm text-n-500">What ran, what it cost, and what it is waiting on.</p>
        </div>
        <Button
          variant={overview.global_pause ? 'primary' : 'secondary'}
          disabled={busy}
          onClick={() =>
            act(
              () => ipc.setGlobalPause(!overview.global_pause),
              overview.global_pause ? 'Background work resumed' : 'Background work paused',
            )
          }
        >
          {overview.global_pause ? 'Resume background work' : 'Pause background work'}
        </Button>
      </header>

      {overview.banners.map((banner) => (
        <div
          key={banner.kind}
          className="rounded-lg border border-warn-300 bg-warn-50 p-3 text-sm"
          data-testid="pipeline-banner"
          data-kind={banner.kind}
        >
          <strong className="font-medium">{BANNER_TITLE[banner.kind] ?? banner.kind}</strong>
          <p className="text-n-600">
            {banner.detail}
            {banner.count > 0 && (
              <span data-testid="banner-count">
                {' '}
                — {banner.count} {banner.count === 1 ? 'item' : 'items'}
              </span>
            )}
          </p>
        </div>
      ))}

      <Meter overview={overview} />

      {(held.baseline_held > 0 || held.recovery_held > 0) && (
        <section className="rounded-lg border border-n-200 p-4" data-testid="held-items">
          <h2 className="text-sm font-semibold">Waiting for you to decide</h2>
          {(
            [
              ['baseline_held', held.baseline_held, 'from the upgrade'],
              ['recovery_held', held.recovery_held, 'after the database was rebuilt'],
            ] as const
          )
            .filter(([, count]) => count > 0)
            .map(([which, count, why]) => (
              <div key={which} className="mt-2 flex items-center gap-2" data-testid={which}>
                <p className="flex-1 text-sm text-n-600">
                  {count} {count === 1 ? 'item' : 'items'} {why}. We could not prove whether they
                  were already processed, so nothing was assumed.
                </p>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => ipc.resolveHeldItems(vaultPath, which, 'baseline'),
                      'Accepted as the new baseline',
                    )
                  }
                >
                  Use current state as baseline
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    act(
                      () => ipc.resolveHeldItems(vaultPath, which, 'process'),
                      'Queued — the budget still governs when they run',
                    )
                  }
                >
                  Process these items
                </Button>
              </div>
            ))}
        </section>
      )}

      <section className="rounded-lg border border-n-200 p-4" data-testid="lane-toggles">
        <h2 className="text-sm font-semibold">What may run in this vault</h2>
        <ul className="mt-2 flex flex-col gap-1">
          {overview.lanes.map((lane) => (
            <li key={lane.lane} className="flex items-center gap-2" data-testid="lane">
              <label className="flex flex-1 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={lane.enabled}
                  disabled={busy}
                  data-testid={`lane-${lane.lane}`}
                  onChange={() =>
                    act(
                      () => ipc.setLaneEnabled(vaultPath, lane.lane, !lane.enabled),
                      lane.enabled ? `${lane.lane} paused` : `${lane.lane} resumed`,
                    )
                  }
                />
                {lane.lane}
              </label>
              <span className="text-xs text-n-400">priority {lane.priority}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-n-200 p-4" data-testid="activity-log">
        <h2 className="text-sm font-semibold">Activity log</h2>
        {overview.activity.length === 0 ? (
          <p className="mt-2 text-sm text-n-500">Nothing has run yet.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-n-500">
              <tr>
                <th className="font-medium">Lane</th>
                <th className="font-medium">Mode</th>
                <th className="font-medium">Outcome</th>
                <th className="text-right font-medium">Tokens</th>
                <th className="text-right font-medium">Proposals</th>
              </tr>
            </thead>
            <tbody>
              {overview.activity.map((run) => (
                <tr key={run.run_id} data-testid="activity-row" data-outcome={run.outcome}>
                  <td>{run.lane}</td>
                  <td>{run.mode}</td>
                  <td>{run.outcome.replace(/_/g, ' ')}</td>
                  <td className="text-right tabular-nums">
                    {run.usage_state === 'exact' ? (
                      run.total_tokens.toLocaleString()
                    ) : (
                      <span data-testid="usage-unknown">unknown</span>
                    )}
                  </td>
                  <td className="text-right tabular-nums">
                    {run.applied} applied · {run.rejected} rejected
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
