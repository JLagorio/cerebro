import { useEffect, useState } from 'react';
import { agentActive, type AgentDraft } from '@/engine/libraryDraft';
import { nextFire, parseSchedule } from '@/engine/skills';
// The local-time rationale that used to live beside a private copy of this
// went with it — see `engine/whenText`.
import { localStamp } from '@/engine/whenText';
import * as ipc from '@/lib/ipc';
import type { FleetActorSummary, FleetRun } from '@/lib/ipc';

/**
 * What this agent has actually done (M33.6).
 *
 * **Nothing about the agent is stored here.** Identity, mission, schedule and
 * tools live in the record's frontmatter; SQLite holds runs and joins them by
 * `actor`. This strip is a READ of that join — a `registry` table holding a
 * second copy of agent config would be the twin-inventory defect, and there
 * is deliberately nowhere in M33 that writes one.
 *
 * **On duty is DERIVED, never stored.** `agentActive` computes it from the
 * schedule and triggers, exactly as it always has: an agent is on duty
 * precisely when something can fire it, so there is no `enabled:` bit to fall
 * out of step with a `schedule:` somebody deleted.
 *
 * **Capability-gated, not type-gated.** The strip renders for any draft that
 * can be on duty — it asks what the record CAN do, never what it is called
 * (AGENTS.md's no-type-special-casing rule).
 *
 * **Absent is never zero, twice.** An agent with no runs says "no runs yet"
 * rather than showing a table of zeros, and a lifetime token total names the
 * unmetered runs it could not include instead of quietly absorbing them.
 */

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; summary: FleetActorSummary; runs: FleetRun[] };

/** How many of this agent's runs the strip lists. The dossier answers "what
 * has it been doing lately"; the fleet section answers "everything", and
 * filtering it by this actor is one click. */
const HISTORY = 10;

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex flex-col" data-testid={testId}>
      <span className="text-2xs uppercase tracking-[0.06em] text-n-500">{label}</span>
      <span className="text-xs text-n-800">{value}</span>
    </div>
  );
}

export function AgentDossier({
  draft,
  actor,
  now = new Date(),
}: {
  draft: AgentDraft;
  /** `process:<slug>` — the same string the run's bearer token stamps. */
  actor: string;
  /** Injected so a test's pinned clock governs the next-fire time, the same
   * `VAULT_TODAY` discipline the e2e specs follow. */
  now?: Date;
}) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const [summary, runs] = await Promise.all([
          ipc.fleetActorSummary(actor),
          ipc.fleetRuns({ actor, limit: HISTORY }),
        ]);
        if (live) setState({ kind: 'ready', summary, runs });
      } catch {
        // Behind a surface, so quiet rather than toasted (the store-layer
        // rule) — and unavailable rather than empty, because "this agent has
        // never run" and "we could not read its runs" are different answers.
        if (live) setState({ kind: 'unavailable' });
      }
    })();
    return () => {
      live = false;
    };
  }, [actor]);

  const onDuty = agentActive(draft);
  const schedule = parseSchedule(draft.schedule);
  const fires = schedule === null ? null : nextFire(schedule, now);

  return (
    <section
      data-testid="agent-dossier"
      data-actor={actor}
      className="flex flex-col gap-2 rounded-lg border border-n-200 p-3"
    >
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-col" data-testid="dossier-duty" data-on-duty={onDuty}>
          <span className="text-2xs uppercase tracking-[0.06em] text-n-500">Status</span>
          <span className="text-xs text-n-800">
            {onDuty ? 'On duty' : 'Off duty — nothing can fire it'}
          </span>
        </div>
        <Stat
          testId="dossier-next-fire"
          label="Next scheduled"
          value={
            fires === null
              ? // A malformed or absent schedule is not a time. Triggers can
                // still fire this agent, which is why the duty pill above is
                // computed from both.
                draft.schedule.trim() === ''
                ? 'no schedule'
                : 'schedule not understood'
              : localStamp(fires)
          }
        />
        {state.kind === 'ready' && (
          <>
            <Stat testId="dossier-runs" label="Runs" value={String(state.summary.run_count)} />
            <Stat
              testId="dossier-tokens"
              label="Lifetime tokens"
              value={
                // The unmetered runs are NAMED, not absorbed. A total that
                // silently swallowed them would read as a smaller bill than
                // the one actually paid.
                `${(state.summary.input_tokens + state.summary.output_tokens).toLocaleString()}${
                  state.summary.unknown_runs > 0
                    ? ` · ${state.summary.unknown_runs} run${
                        state.summary.unknown_runs === 1 ? '' : 's'
                      } unmetered`
                    : ''
                }`
              }
            />
            <Stat
              testId="dossier-last"
              label="Last outcome"
              value={state.summary.last_outcome?.replace(/_/g, ' ') ?? 'never run'}
            />
          </>
        )}
      </div>

      {state.kind === 'loading' && <p className="text-xs text-n-400">Reading…</p>}

      {state.kind === 'unavailable' && (
        <p data-testid="section-unavailable" className="text-xs text-n-500">
          This agent&rsquo;s run history could not be read, so nothing here is a statement about
          what it has done.
        </p>
      )}

      {state.kind === 'ready' && state.runs.length === 0 && (
        <p data-testid="section-empty" className="text-xs text-n-500">
          No runs yet.
        </p>
      )}

      {state.kind === 'ready' &&
        state.runs.map((run) => (
          <div
            key={run.run_id}
            data-testid="fleet-row"
            data-run={run.run_id}
            data-outcome={run.outcome}
            className="flex items-center gap-2 rounded border border-n-200 px-2.5 py-1.5"
          >
            <span className="min-w-0 flex-1 truncate text-2xs text-n-600">{run.started_at}</span>
            <span
              className="rounded px-1.5 py-0.5 text-2xs uppercase tracking-[0.06em]"
              style={{ border: '1px solid var(--n-200)' }}
            >
              {run.outcome.replace(/_/g, ' ')}
            </span>
            <span className="tabular-nums text-2xs text-n-600">
              {run.usage_state === 'exact' ? (
                `${(run.input_tokens + run.output_tokens).toLocaleString()} tokens`
              ) : (
                <span data-testid="usage-unknown">unknown</span>
              )}
            </span>
          </div>
        ))}
    </section>
  );
}
