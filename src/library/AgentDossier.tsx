import { useWaitingFollowup } from '@/stores/followupStore';
import { stampActivation, RESUME_STAMP_FAILED } from '@/agent/activation';
import { recordIdentity } from '@/engine/identity';
import { scheduleZone } from './ScheduleField';
import { runAgentNow, useRunNowStarting } from '@/agent/runNow';
import { useUiStore } from '@/stores/uiStore';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { agentRef } from '@/engine/agents';
import { agentActive, agentDraft } from '@/engine/libraryDraft';
import { nextSetFire, parseScheduleSet } from '@/engine/skills';
import type { Entry } from '@/engine/types';
// The local-time rationale that used to live beside a private copy of this
// went with it — see `engine/whenText`.
import { localStamp } from '@/engine/whenText';
import * as ipc from '@/lib/ipc';
import type { FleetActorSummary } from '@/lib/ipc';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * The agent page's duty bar (M33.6; a bar on every tab since M55.12).
 *
 * **Nothing about the agent is stored here.** Identity, mission, schedule and
 * tools live in the record's frontmatter; SQLite holds runs and joins them by
 * `actor`. This bar is a READ of that join — a `registry` table holding a
 * second copy of agent config would be the twin-inventory defect.
 *
 * **On duty is DERIVED, never stored.** `agentActive` computes it from the
 * schedule and triggers, alongside any waiting follow-up: an agent is on duty when something can fire
 * it and it is not paused, so there is no `enabled:` bit to fall out of step
 * with a `schedule:` somebody deleted. `paused:` is the one switch, written by
 * the bar's Pause and Resume.
 *
 * **Capability-gated, not type-gated.** It renders for any record that can be
 * on duty — it asks what the record CAN do, never what it is called
 * (AGENTS.md's no-type-special-casing rule).
 *
 * **Absent is never zero.** A lifetime token total names the unmetered runs it
 * could not include instead of quietly absorbing them, and a failed read says
 * so rather than reading as an agent that never ran. The runs themselves are
 * the Runs tab's.
 */

type State =
  { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; summary: FleetActorSummary };

function Stat({
  label,
  value,
  testId,
  title,
}: {
  label: string;
  value: string;
  testId: string;
  title?: string;
}) {
  return (
    <div className="flex flex-col" data-testid={testId} title={title}>
      <span className="text-2xs uppercase tracking-[0.06em] text-n-500">{label}</span>
      <span className="text-xs text-n-800">{value}</span>
    </div>
  );
}

export function AgentDossier({
  entry,
  now: injectedNow,
}: {
  entry: Entry;
  /** Injected so a test's pinned clock governs the next-fire time, the same
   * `VAULT_TODAY` discipline the e2e specs follow. */
  now?: Date;
}) {
  const now = injectedNow ?? new Date();
  const patchFrontmatter = useVaultStore((s) => s.patchFrontmatter);
  const vault = useVaultStore((state) => state.vaultPath);
  const starting = useRunNowStarting(vault, entry.path);
  const live = useUiStore((state) =>
    state.runs.some((run) => run.owner === 'job' && run.path === entry.path),
  );
  const running = starting || live;
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const draft = agentDraft(entry, '');
  // `process:<slug>` — the same string the run's bearer token stamps.
  const actor = agentRef(entry).actor;
  const later = useWaitingFollowup(actor);
  const paused = entry.properties.paused === true;

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    ipc.fleetActorSummary(actor).then(
      (summary) => live && setState({ kind: 'ready', summary }),
      // Behind a surface, so quiet rather than toasted (the store-layer
      // rule) — and unavailable rather than empty, because "this agent has
      // never run" and "we could not read its runs" are different answers.
      () => live && setState({ kind: 'unavailable' }),
    );
    return () => {
      live = false;
    };
  }, [actor]);

  const fireable = agentActive(draft, now);
  const onDuty = (fireable || later) && !paused;
  const schedule = parseScheduleSet(draft.schedule);
  const fires = schedule === null ? null : nextSetFire(schedule, now);

  const toggle = () => {
    if (busy) return;
    setBusy(true);
    void (async () => {
      const stamped =
        !paused ||
        vault === null ||
        (await stampActivation(
          vault,
          recordIdentity(entry),
          draft.schedule,
          injectedNow ?? new Date(),
        ));
      if (useVaultStore.getState().vaultPath !== vault) return;
      const saved = await patchFrontmatter(entry.path, { paused: paused ? null : true });
      if (saved && !stamped) useUiStore.getState().toast(RESUME_STAMP_FAILED);
    })().finally(() => setBusy(false));
  };

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
            {paused
              ? 'Paused'
              : fireable
                ? 'On duty'
                : later
                  ? 'Off duty — only a follow-up it booked will run it, while Learn on its own is on'
                  : 'Off duty — nothing can fire it'}
          </span>
        </div>
        <Stat
          testId="dossier-next-fire"
          title={`This computer's clock (${scheduleZone()})`}
          label="Next scheduled"
          value={
            fires === null
              ? draft.schedule.length === 0
                ? 'no schedule'
                : schedule === null
                  ? 'schedule not understood'
                  : 'its one time has passed'
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
        <span className="flex-1" />
        <span title={running ? `${entry.title} is already running` : undefined}>
          <Button
            variant="secondary"
            size="sm"
            testId="agent-run-now"
            disabled={running}
            onClick={() => void runAgentNow(entry.path)}
          >
            {running ? 'Running…' : 'Run now'}
          </Button>
        </span>
        <Button
          variant="secondary"
          size="sm"
          testId="agent-duty-toggle"
          disabled={busy}
          onClick={toggle}
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
      </div>

      {state.kind === 'loading' && <p className="m-0 text-xs text-n-400">Reading…</p>}

      {state.kind === 'unavailable' && (
        <p data-testid="section-unavailable" className="m-0 text-xs text-n-500">
          This agent&rsquo;s run history could not be read, so nothing here is a statement about
          what it has done.
        </p>
      )}
    </section>
  );
}
