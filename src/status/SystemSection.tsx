import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import * as ipc from '@/lib/ipc';
import type { PipelineOverview } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';

/**
 * The background's controls, as a section of the Status hub (M33.4) — and,
 * since M33a.2 folded that hub into Knowledge, as its "Background" tab.
 *
 * This is `PipelinePage`'s body — the meter, the banners, the lane toggles
 * and the held piles — moved rather than rewritten, with every testid
 * unchanged so `pipeline-surface.spec.ts` can prove the move dropped nothing.
 *
 * **The activity table did NOT come with it.** `PipelinePage` ended in a
 * 50-row `runs` table that was not clickable and had no detail view. M33.5's
 * fleet section replaces it with one that filters, attributes, and opens —
 * so carrying the old table across would have shipped two run lists.
 *
 * **The meter is global and the lanes are not.** One personal CLI
 * subscription is metered once, however many vaults debit it; which KINDS of
 * background work run is a per-vault choice, because somebody may want
 * scheduled agents at work and nothing at all in their journal.
 *
 * **The pause here is the WIDER of two (M33b.5).** This one stops every
 * background run on the subscription. Stopping ONE agent is a button on that
 * agent's row in the fleet, not a control here — this section is about the
 * background as a whole, and a list of colleagues on it would be a second,
 * worse roster. Neither pause overrides the other: both are collected at the
 * gate and either is enough to refuse.
 *
 * **The concurrency ceiling (M33b.2) joined the pause, and is global for the
 * same reason.** How MUCH background work may run at once is a fact about one
 * subscription, not about a folder. It ships at 1 — the number the retired
 * `ambient_dispatch` singleton row used to enforce — so the surface arrives
 * saying exactly what the app already did, and raising it is a human act in
 * the same way writing a `schedule:` is.
 *
 * **Three faces of failure stay three banners.** A quota death means wait; a
 * dead source means reality may be moving unobserved; a broken file means fix
 * one file. One merged "something went wrong" would tell a person none of
 * those, and they need different actions.
 *
 * **What DID change is the failure state.** `PipelinePage.tsx:92` caught a
 * failed read and rendered "Nothing to report yet" — the same empty state a
 * genuinely quiet vault gets. A workspace whose runtime database could not be
 * opened now says so, per the `Feed<T>` contract in
 * `knowledge/BaseItself.tsx`.
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

/** The ready state carries the vault it read, so the actions below cannot be
 * called with a null path — the overview belongs to a vault, and pairing them
 * removes the only place a cast would otherwise be needed. */
type State =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; vault: string; data: PipelineOverview };

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
        <h3 className="text-sm font-semibold">Today, across every vault</h3>
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

export function SystemSection({ vaultPath }: { vaultPath: string | null }) {
  const toast = useUiStore((s) => s.toast);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (vaultPath === null) {
      setState({ kind: 'unavailable' });
      return;
    }
    try {
      setState({ kind: 'ready', vault: vaultPath, data: await ipc.pipelineOverview(vaultPath) });
    } catch {
      // NOT the empty state. A workspace whose runtime database could not be
      // opened has an unknown pause, an unknown budget and unknown held work;
      // "nothing to report" would be this surface inventing calm.
      setState({ kind: 'unavailable' });
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

  if (state.kind === 'loading') return <p className="text-xs text-n-400">Reading…</p>;
  if (state.kind === 'unavailable') {
    return (
      <p data-testid="section-unavailable" className="text-xs text-n-500">
        Background health could not be read, so nothing here is a statement about this vault.
      </p>
    );
  }

  const { vault, data: overview } = state;
  const { held } = overview;
  return (
    <div className="flex flex-col gap-3" data-testid="pipeline-page">
      <div className="flex items-center justify-between gap-3">
        <p
          className="text-xs text-n-600"
          data-testid="pause-state"
          data-paused={overview.global_pause}
        >
          {overview.global_pause ? 'The background is paused.' : 'The background is running.'}
        </p>
        <Button
          variant={overview.global_pause ? 'primary' : 'secondary'}
          size="sm"
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
      </div>

      {/* The concurrency ceiling (M33b.2), beside the pause because they are
          the same control at two settings: this says how much background at
          once, and the pause says none. It ships at 1 — the number the old
          singleton lease row enforced — so arriving here changes nothing until
          somebody moves it, which is the point.

          The options come from `ambient_concurrency_max`, which Rust sends,
          so this control cannot offer a number the backend would refuse and
          the cap is never written down twice. */}
      <div className="flex items-center justify-between gap-3">
        <label
          className="text-xs text-n-600"
          htmlFor="ambient-concurrency"
          data-testid="concurrency-state"
          data-ceiling={overview.ambient_concurrency}
        >
          {overview.ambient_concurrency === 1
            ? 'Background work runs one job at a time.'
            : `Background work runs up to ${overview.ambient_concurrency} jobs at a time, so it can spend that much of your subscription at once.`}
        </label>
        <select
          id="ambient-concurrency"
          data-testid="ambient-concurrency"
          className="rounded border border-n-200 px-2 py-1 text-sm"
          value={overview.ambient_concurrency}
          disabled={busy}
          onChange={(e) => {
            const ceiling = Number(e.target.value);
            void act(
              () => ipc.setAmbientConcurrency(ceiling),
              ceiling === 1
                ? 'Background work will run one job at a time'
                : `Background work may now run ${ceiling} jobs at once`,
            );
          }}
        >
          {Array.from({ length: overview.ambient_concurrency_max }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n === 1 ? '1 at a time' : `${n} at a time`}
            </option>
          ))}
        </select>
      </div>

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
          <h3 className="text-sm font-semibold">Waiting for you to decide</h3>
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
                      () => ipc.resolveHeldItems(vault, which, 'baseline'),
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
                      () => ipc.resolveHeldItems(vault, which, 'process'),
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
        <h3 className="text-sm font-semibold">What may run in this vault</h3>
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
                      () => ipc.setLaneEnabled(vault, lane.lane, !lane.enabled),
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
    </div>
  );
}
