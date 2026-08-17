import { useEffect, useMemo, useState } from 'react';
import { onAgentEvent } from '@/agent/agentIpc';
import { Button } from '@/components/ui/Button';
import { agentRef, isAgentEntry } from '@/engine/agents';
import { agentActive, agentDraft } from '@/engine/libraryDraft';
import { nextFire, parseSchedule } from '@/engine/skills';
import { localStamp, relativeWhen } from '@/engine/whenText';
import * as ipc from '@/lib/ipc';
import type { FleetActorSummary } from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Who works here (M33b.3, spec D5/D6).
 *
 * The fleet section used to list RUNS — the history, not the team — so the
 * question "what is everyone doing" had no surface at all and the answer to
 * "who works here" was a folder you had to already know about. This lists
 * AGENTS: one row each, what it is on, when it last ran, what it has spent,
 * what it has queued waiting for you. The run history is still here, one
 * level down, and clicking a row narrows it to that agent.
 *
 * **An idle agent still appears (D6).** A fleet that only showed working
 * agents would answer "what is happening" and not "who works here", and the
 * second is the question a person actually has. So does an agent nothing can
 * fire: activation is a human act, an Agent record without a `schedule:` is a
 * description rather than a daemon, and the row SAYS which it is instead of
 * being quietly omitted.
 *
 * **Nothing here is stored.** Identity, brief, schedule and scope come off the
 * record's frontmatter; the run numbers come off `runs` joined by `actor`; the
 * queue comes off the ledger. There is no registry table holding a second copy
 * of any of it — that would be the twin-inventory defect, and it is why an
 * agent renamed on disk is a renamed agent here on the next scan.
 *
 * **The internal constructs get no face.** `agent:m26-ingest` and its two
 * siblings run work and are not standing agents with memory and judgment
 * (M26's name-discipline trap). They are not rows. They are also not hidden:
 * one line under the roster names every actor that has run here without a
 * record behind it, so "who works here" has a complete answer without the
 * surface inventing three colleagues.
 *
 * **A row can be stopped without being deleted (M33b.5).** Each row carries
 * its own pause, which is the cheapest answer to a misbehaving agent that is
 * not deleting its record. It is a button a person presses and nothing else:
 * no badge, no colour, and nowhere on this surface is there a count of how
 * many agents are paused — spec §6 warns this is where the fleet would turn
 * into the nagging screen M8 exists to prevent, and counting up at somebody is
 * how it would start.
 *
 * The button is not the enforcement and must never be mistaken for it. A
 * paused agent is refused in Rust — at the budget gate for every background
 * run and in `run_agent` for every run a surface starts — so a pause holds
 * whether or not this component is on screen.
 *
 * **Four reads, four failures, and none of them becomes a zero.** The run
 * summaries, the proposal queue, the background pause and the paused agents
 * are separate calls. Any one of them failing says so and leaves the others
 * standing — and the state chip refuses to say "idle" when a fact it would
 * need is missing, because "nothing is waiting" and "we could not tell you
 * what is waiting" are opposite sentences. A row whose pause could not be read
 * offers no pause button either: a control whose label would be a guess is
 * worse than none.
 */

/** One read's three states. `loading` is distinct from `unavailable` so a slow
 * read never renders as a refusal. */
type Read<T> = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; data: T };

/**
 * What this agent's rows in `runs` say — and, separately, whether they could
 * be read at all.
 *
 * `never` is measured: the read came back and this actor has no rows, which
 * is exactly what a freshly written Agent record looks like. `unavailable` is
 * the read failing. Mapping one to the other is the mistake this whole
 * milestone is about.
 */
type RunFacts =
  { kind: 'unavailable' } | { kind: 'never' } | { kind: 'some'; summary: FleetActorSummary };

/**
 * What an agent is doing right now (M33b.4; two pauses since M33b.5).
 *
 * Derived, never stored, from the run table, the proposal queue and the two
 * pauses. The order is the argument:
 *
 * - **working** wins outright. A run the dispatcher opened and has not
 *   finalized is the loudest true thing about an agent.
 * - **waiting on you** outranks both pauses, because pausing does not un-queue
 *   a decision somebody still owes.
 * - **paused** — this ONE agent, by somebody pressing the button on this row —
 *   outranks everything below it, including "not activated". A human act on
 *   this agent is the fact the row exists to report, and a pause the row
 *   declined to mention would be the hidden button spec §6 warns about. It
 *   also outranks the background pause: an agent stopped twice reads as
 *   stopped by the control with a button next to it, and pressing that button
 *   flips the row to `background-paused` — which is exactly the lesson, since
 *   resuming one agent under a global pause starts nothing.
 * - **not activated** outranks the BACKGROUND pause, unchanged from M33b.4:
 *   an agent nothing can fire was never started by anybody, and calling that
 *   "the background is paused" would blame the wrong control.
 * - **background paused** is the global pause, and is a different sentence
 *   from `paused`. "Everything is stopped" and "this colleague is stopped"
 *   want different actions, and one word for both would hide which is true.
 * - **unknown** is what stands where `idle` would go when a fact the idle
 *   claim rests on could not be read. Idle asserts that nothing is running,
 *   nothing is queued and nothing is stopped — four claims now, and a surface
 *   that makes them on a failed read is inventing calm.
 */
export type AgentState =
  'working' | 'waiting' | 'inactive' | 'paused' | 'background-paused' | 'unknown' | 'idle';

export function liveState(facts: {
  /** Rows open right now. `null` = the run summaries could not be read. */
  running: number | null;
  /** Proposals of this actor's awaiting a decision. `null` = queue unread. */
  waiting: number | null;
  /** Whether anything — a schedule or a trigger — can fire it. */
  onDuty: boolean;
  /** This agent's own pause (M33b.5). `null` = it could not be read. */
  agentPaused: boolean | null;
  /** The subscription-wide background pause. `null` = it could not be read. */
  backgroundPaused: boolean | null;
}): AgentState {
  if (facts.running !== null && facts.running > 0) return 'working';
  if (facts.waiting !== null && facts.waiting > 0) return 'waiting';
  if (facts.agentPaused === true) return 'paused';
  if (!facts.onDuty) return 'inactive';
  if (facts.backgroundPaused === true) return 'background-paused';
  if (
    facts.running === null ||
    facts.waiting === null ||
    facts.agentPaused === null ||
    facts.backgroundPaused === null
  ) {
    return 'unknown';
  }
  return 'idle';
}

const STATE_TEXT: Record<AgentState, string> = {
  working: 'working now',
  waiting: 'waiting on you',
  inactive: 'not activated',
  paused: 'paused',
  'background-paused': 'background paused',
  unknown: 'state unknown',
  idle: 'idle',
};

/** When this agent last did anything. Never an epoch and never a dash: an
 * agent that has never run has no last-run time, and that is a sentence. */
function lastRunText(facts: RunFacts, now: Date): string {
  if (facts.kind === 'unavailable') return 'last run not read';
  if (facts.kind === 'never') return 'has never run';
  const started = facts.summary.last_started_at;
  return started === null ? 'has never run' : relativeWhen(started, now);
}

/**
 * What this agent has spent.
 *
 * Three different absences and three different sentences. No runs at all is
 * not zero spend, it is no measurement; runs that all lost their usage is
 * "not recorded" with the count of what was skipped; and a partial total says
 * how many runs it could not include rather than absorbing them into a
 * smaller bill than the one actually paid.
 */
function spendText(facts: RunFacts): string {
  if (facts.kind === 'unavailable') return 'spend not read';
  if (facts.kind === 'never') return 'nothing spent — no runs yet';
  const { input_tokens, output_tokens, run_count, unknown_runs } = facts.summary;
  const runs = (n: number) => `${n} run${n === 1 ? '' : 's'} unmetered`;
  if (run_count - unknown_runs === 0) return `not recorded — ${runs(unknown_runs)}`;
  const total = (input_tokens + output_tokens).toLocaleString();
  return unknown_runs === 0 ? `${total} tokens` : `${total} tokens · ${runs(unknown_runs)}`;
}

/** What is queued against this agent. A measured zero is said out loud, so
 * the absence of a number is never mistaken for an unread queue. */
function waitingText(waiting: number | null): string {
  if (waiting === null) return 'queue not read';
  if (waiting === 0) return 'nothing waiting on you';
  return `${waiting} waiting on you`;
}

/**
 * What an agent is ON.
 *
 * The schedule if one fires it, the next fire time if that schedule parses,
 * and the plain fact otherwise. "Activation is a human act" is a promise the
 * roster keeps by saying, on the row, that this record is a description.
 */
function dutyText(schedule: string, onDuty: boolean, now: Date): string {
  if (!onDuty) return 'A description, not a daemon — nothing can fire it.';
  const parsed = parseSchedule(schedule);
  if (parsed === null) {
    // On duty with no readable schedule means a trigger fires it — or the
    // schedule is malformed, which is a different thing and says so.
    return schedule.trim() === '' ? 'Fired by a trigger.' : 'Schedule not understood.';
  }
  return `${schedule.trim()} · next ${localStamp(nextFire(parsed, now))}`;
}

/**
 * Re-read when a run starts or ends, rather than on a timer (M33b.4).
 *
 * The agent stream already announces exactly the transitions this surface
 * cares about, so there is no interval here — a polling loop beside an event
 * channel is a second, worse copy of the channel, and it would keep the
 * runtime database busy on a tab nobody is looking at.
 *
 * `Result` is deliberately not in the list: it arrives before `Done` on the
 * same run and would double every re-read for no new fact. And the deltas are
 * not either — a token of streamed text is not a change of state.
 *
 * What this does NOT cover is named rather than papered over: a run that
 * another window or a future out-of-process scheduler starts emits nothing
 * here, so the roster learns about it the next time this tab is opened. That
 * is the same freshness every other tab under Knowledge has, by the same
 * deliberate choice — these surfaces speak when they are opened.
 */
function useFleetPulse(): number {
  const [pulse, setPulse] = useState(0);
  useEffect(
    () =>
      onAgentEvent((event) => {
        if (event.kind === 'Init' || event.kind === 'Done' || event.kind === 'Error') {
          setPulse((previous) => previous + 1);
        }
      }),
    [],
  );
  return pulse;
}

function Chip({ state }: { state: AgentState }) {
  // No colour ladder and no badge. Spec §6: this surface can become the
  // nagging screen M8 exists to prevent, and the way it would get there is by
  // learning to shout. A state is a word.
  return (
    <span
      data-testid="agent-state"
      data-state={state}
      className="rounded px-1.5 py-0.5 text-2xs uppercase tracking-[0.06em] text-n-600"
      style={{ border: '1px solid var(--n-200)' }}
    >
      {STATE_TEXT[state]}
    </span>
  );
}

export function AgentRoster({
  vaultPath,
  focus,
  onFocus,
  now = new Date(),
}: {
  vaultPath: string | null;
  /** The actor whose history the run list below is narrowed to, if any. */
  focus: string | null;
  onFocus: (actor: string | null) => void;
  /** Injected so a pinned clock governs "3 hours ago" and the next fire time
   * — the same `VAULT_TODAY` discipline the e2e specs follow. */
  now?: Date;
}) {
  const entries = useVaultStore((s) => s.entries);
  const pulse = useFleetPulse();

  // The body is the standing instructions and no row renders them, so it is
  // passed empty: `agentDraft` is reused rather than re-parsing `schedule:`
  // and `when:` beside it, which is how two readings of one record start to
  // disagree about whether it is on duty.
  const agents = useMemo(
    () =>
      entries
        .filter(isAgentEntry)
        .map((entry) => ({ ref: agentRef(entry), duty: agentDraft(entry, '') })),
    [entries],
  );

  const [summaries, setSummaries] = useState<Read<FleetActorSummary[]>>({ kind: 'loading' });
  const [queue, setQueue] = useState<Read<Map<string, number>>>({ kind: 'loading' });
  const [background, setBackground] = useState<Read<boolean>>({ kind: 'loading' });
  const [paused, setPaused] = useState<Read<Set<string>>>({ kind: 'loading' });
  /** Bumped by a pause or a resume, so the four reads run again against what
   * was just written rather than against a copy this component is holding. */
  const [written, setWritten] = useState(0);
  const [busy, setBusy] = useState(false);
  const toast = useUiStore((s) => s.toast);

  useEffect(() => {
    let live = true;
    setSummaries({ kind: 'loading' });
    setQueue({ kind: 'loading' });
    setBackground({ kind: 'loading' });
    setPaused({ kind: 'loading' });

    // Four reads, fired together and landing independently. A read behind a
    // surface goes quiet rather than toasting (the store-layer rule) and the
    // row says what it could not find out.
    void ipc.fleetActorSummaries().then(
      (data) => live && setSummaries({ kind: 'ready', data }),
      () => live && setSummaries({ kind: 'unavailable' }),
    );

    if (vaultPath === null) {
      // No vault, no ledger and no pause to read. Unavailable rather than
      // empty: there is no claim to make about a queue nobody can open, and
      // "nobody is paused" would be a claim about a vault that is not open.
      setQueue({ kind: 'unavailable' });
      setBackground({ kind: 'unavailable' });
      setPaused({ kind: 'unavailable' });
    } else {
      void ipc.reviewQueue(vaultPath).then(
        (cards) => {
          if (!live) return;
          const counts = new Map<string, number>();
          for (const card of cards) counts.set(card.actor, (counts.get(card.actor) ?? 0) + 1);
          setQueue({ kind: 'ready', data: counts });
        },
        () => live && setQueue({ kind: 'unavailable' }),
      );
      void ipc.pipelineOverview(vaultPath).then(
        (overview) => live && setBackground({ kind: 'ready', data: overview.global_pause }),
        () => live && setBackground({ kind: 'unavailable' }),
      );
      void ipc.pausedAgents(vaultPath).then(
        // An empty list is measured-at-zero: nobody is paused. It is never
        // conflated with the read having failed.
        (actors) => live && setPaused({ kind: 'ready', data: new Set(actors) }),
        () => live && setPaused({ kind: 'unavailable' }),
      );
    }

    return () => {
      live = false;
    };
    // `pulse` is the deliberate re-read: a run started or ended, so what these
    // four reads would say has changed. `written` is the same thing for a
    // pause somebody just pressed.
  }, [vaultPath, pulse, written]);

  /**
   * Pause or resume one agent. A human UI action, so the store-layer rule
   * applies: it catches, toasts, and re-reads rather than propagating.
   *
   * The toast is deliberately about the ACT and not about the outcome —
   * "paused" is a thing that just happened, and telling somebody who resumed
   * an agent under a global pause that it is now running would be a lie the
   * chip beside it immediately contradicts.
   */
  const setAgentPause = (actor: string, next: boolean) => {
    if (busy || vaultPath === null) return;
    setBusy(true);
    void ipc
      .setAgentPaused(vaultPath, actor, next)
      .then(
        () => toast(next ? `${actor} paused` : `${actor} resumed`),
        (e: unknown) => toast(e instanceof Error ? e.message : 'That did not take'),
      )
      .finally(() => {
        setBusy(false);
        setWritten((previous) => previous + 1);
      });
  };

  const factsFor = (actor: string): RunFacts => {
    if (summaries.kind !== 'ready') return { kind: 'unavailable' };
    const summary = summaries.data.find((s) => s.actor === actor);
    return summary === undefined ? { kind: 'never' } : { kind: 'some', summary };
  };

  const waitingFor = (actor: string): number | null =>
    queue.kind === 'ready' ? (queue.data.get(actor) ?? 0) : null;

  /** Actors the runs know about that no record in this vault claims — the
   * internal constructs, and the old slug of anything renamed. Named, never
   * given a row: a row implies a persona, and these have none. */
  const unowned =
    summaries.kind === 'ready'
      ? summaries.data
          .map((summary) => summary.actor)
          .filter((actor) => !agents.some((agent) => agent.ref.actor === actor))
      : [];

  return (
    <div className="flex flex-col gap-1.5" data-testid="agent-roster">
      {summaries.kind === 'loading' && <p className="text-xs text-n-400">Reading…</p>}

      {/* Named reads, so two failures never read as one. Each is the
          `section-unavailable` the rest of the app uses, and each says which
          claim it is refusing to make. */}
      {summaries.kind === 'unavailable' && (
        <p data-testid="section-unavailable" className="text-xs text-n-500">
          The run history could not be read, so no row here says when an agent last ran or what it
          has spent.
        </p>
      )}
      {queue.kind === 'unavailable' && (
        <p data-testid="section-unavailable" className="text-xs text-n-500">
          The proposal queue could not be read, so no row here says what is waiting on you.
        </p>
      )}
      {background.kind === 'unavailable' && (
        <p data-testid="section-unavailable" className="text-xs text-n-500">
          The background pause could not be read, so no row here says whether work is stopped.
        </p>
      )}
      {paused.kind === 'unavailable' && (
        <p data-testid="section-unavailable" className="text-xs text-n-500">
          Which agents are paused could not be read, so no row here offers to pause or resume one.
        </p>
      )}

      {agents.length === 0 && summaries.kind !== 'loading' && (
        <p data-testid="roster-empty" className="text-xs text-n-500">
          No agent records in this vault. An agent is a record of{' '}
          <code className="text-n-600">type: Agent</code> whose body is its standing instructions.
        </p>
      )}

      {agents.map(({ ref, duty }) => {
        const facts = factsFor(ref.actor);
        const waiting = waitingFor(ref.actor);
        const onDuty = agentActive(duty);
        const agentPaused = paused.kind === 'ready' ? paused.data.has(ref.actor) : null;
        const state = liveState({
          running: facts.kind === 'some' ? facts.summary.running_runs : null,
          waiting,
          onDuty,
          agentPaused,
          backgroundPaused: background.kind === 'ready' ? background.data : null,
        });
        const focused = focus === ref.actor;
        return (
          // The row and its pause are SIBLINGS, not nested: the row is a
          // button (clicking it narrows the history below) and a button inside
          // a button is not a thing a browser will render.
          <div key={ref.path} className="flex items-start gap-1.5">
            <button
              type="button"
              data-testid="agent-row"
              data-actor={ref.actor}
              data-state={state}
              aria-pressed={focused}
              // Clicking narrows the history below to this agent's runs — the
              // "one level down" D5 asks for. Clicking again lets go of it,
              // because a filter you cannot clear is a trap.
              onClick={() => onFocus(focused ? null : ref.actor)}
              className={[
                'flex min-w-0 flex-1 flex-col gap-0.5 rounded border px-2.5 py-2 text-left',
                focused ? 'border-n-400 bg-n-50' : 'border-n-200 hover:bg-n-50',
              ].join(' ')}
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-n-800">
                  {ref.title}
                </span>
                <Chip state={state} />
              </span>
              <span data-testid="agent-duty" className="text-2xs text-n-600">
                {dutyText(duty.schedule, onDuty, now)}
              </span>
              <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-n-500">
                <span
                  data-testid="agent-last-run"
                  // The exact stamp is one hover away, so nothing is rounded
                  // out of reach.
                  title={
                    facts.kind === 'some' ? (facts.summary.last_started_at ?? undefined) : undefined
                  }
                >
                  {lastRunText(facts, now)}
                </span>
                <span data-testid="agent-spend" className="tabular-nums">
                  {spendText(facts)}
                </span>
                <span data-testid="agent-waiting" className="tabular-nums">
                  {waitingText(waiting)}
                </span>
              </span>
            </button>
            {/* Absent when the pause could not be read: a button whose label
                would be a guess is worse than no button, and the note above
                already says why it is missing. */}
            {agentPaused !== null && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                testId="agent-pause"
                onClick={() => setAgentPause(ref.actor, !agentPaused)}
              >
                {agentPaused ? 'Resume' : 'Pause'}
              </Button>
            )}
          </div>
        );
      })}

      {unowned.length > 0 && (
        <p data-testid="roster-unowned" className="text-2xs text-n-500">
          Also ran here, with no record in this vault: {unowned.join(', ')}. Internal work and
          retired names, not standing agents — their runs are in the history below.
        </p>
      )}
    </div>
  );
}
