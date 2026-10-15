import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAgentEvent, runAgent, stopAgent } from './agentIpc';
import { buildSystemPrompt } from './systemPrompt';
import { agentRef, isAgentEntry } from '@/engine/agents';
import { observeScan, type ScanBaseline } from '@/engine/events';
import { causeOfJob, jobQueue, KNOWLEDGE_JOB_KINDS, type AgentJob } from '@/engine/jobs';
import { isRecording, useLedgerStore, useLedgerReview, useQuarantine } from '@/stores/ledgerStore';
import { writtenPath, type RunLogEntry } from '@/engine/runLog';
import { parseTriggers } from '@/engine/triggers';
import {
  triggerWords,
  wakeOffers,
  wakeVerdicts,
  type PendingWake,
  type WakeOffer,
} from '@/engine/wakes';
import { newRunId, shouldYield } from './runs';
import { fireKeyDate, isSkillEntry, parseAllowedTools, parseSchedule } from '@/engine/skills';
import { listConcepts } from '@/engine/okf';
import { grantedTools, holdsShell, holdsWeb, type PromptGrant } from '@/engine/toolGrant';
import {
  admitWakes,
  cancelWakes,
  fleetActorSummary,
  jobLedgerClaim,
  jobLedgerImport,
  jobLedgerRead,
  jobLedgerStamp,
  jobLedgerUnclaim,
  readNote,
  reviewQueue,
  wakesPending,
} from '@/lib/ipc';
import { splitFrontmatter } from '@/engine/frontmatter';
import {
  agentRunPrompt,
  currentStatePrompt,
  distillPrompt,
  refreshSourcePrompt,
  reviewConceptPrompt,
  scheduledSkillPrompt,
  schemaRecheckPrompt,
} from '@/lib/prompts';
import { effectiveCeiling, type ShellCeiling } from '@/lib/policy/toolApproval';
import { todayIso } from '@/lib/templates';
import { useRunLogStore } from '@/stores/runLogStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Drains the background job queue (M8.6 as the learn runner; generalized
 * M13.2) — one derived queue, four job kinds, one agent at a time.
 *
 * Three constraints shaped this, and they are worth stating because each one
 * rules out an easier design:
 *
 * 1. **It must not speak.** A background turn produces no chat message; its
 *    output is notes and concepts, visible where they are relevant. A
 *    scheduled skill that wants to say something writes it into the vault.
 *
 * 2. **It yields.** This was once forced: `AgentState` held a single child, so
 *    a background turn and a typed question could not both be in flight. Since
 *    M17.3 they can, and the runner still holds off while anything else is
 *    running — for a better reason. Someone waiting on a reply should not be
 *    made to wait behind a distill, and the queue itself is unattended work,
 *    so there is nothing to gain by draining more than one job at a time.
 *    `runs.shouldYield` is the whole rule.
 *
 * 3. **It must not spin.** Every job is recorded in its ledger BEFORE the run
 *    — learn jobs by note version, scheduled runs by fire key — so a run that
 *    produces nothing, or dies, is not retried until the note changes or the
 *    schedule fires again. A woken run's record is its durable wake (M63.1),
 *    claimed in Rust with the run's lease. Two refinements leave no record
 *    for a run that never happened. A scheduled run consumes its fire key only once its
 *    record's body has actually been read (PR #5 review): a failed READ is
 *    not a run, and must not eat the whole period. And a run the budget gate
 *    deferred gives its record back, durable and local, so the next launch
 *    asks again (M53.27). Both are held in memory instead (`held`), so
 *    neither can hot-loop within the session.
 */

/** Let a burst of edits settle before reading anything. */
const SETTLE_MS = 4_000;

/** How often the wall clock re-derives the queue. `now` moves on this tick
 * and nowhere else, and three things wait on it: a schedule's fire coming
 * due, an event cooldown running out (TRIGGER_COOLDOWN_MS), and a deferred
 * wake's retry time. The tick also offers again an admission that failed. */
const TICK_MS = 60_000;

/** The most matches one vault holds back for admission (M63.1): a bulk
 * change past it keeps the newest, and the wakes it admits drain twenty to
 * a run. */
const UNADMITTED_CAP = 500;

/** What a job's log says when a hook outside Cerebro held one of its calls
 * (M57.1): nobody watches a job, so nobody answers it. */
export function pausedByHook(tool: string): string {
  return `${tool} was paused by a hook outside Cerebro, and nobody was watching this run to answer it, so it stopped there.`;
}

export function useJobRunner(): void {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  // AUTOMATION-2b: which vault `entries` came from, which during an open can
  // still be the last one (see VaultState.entriesVault).
  const entriesVault = useVaultStore((s) => s.entriesVault);
  const rescan = useVaultStore((s) => s.rescan);
  const autoLearn = useUiStore((s) => s.autoLearn);
  // M49.2: the knowledge lanes wait while the vault is not recording.
  const recording = useLedgerStore((s) => isRecording(vaultPath, s));
  // …and never on a QUARANTINED concept: its writes would refuse just the
  // same, and a claimed attempt would then suppress the recheck after the
  // person keeps or restores it (review fix).
  const quarantine = useQuarantine();
  const ledgerReview = useLedgerReview();
  const attempts = useUiStore((s) => s.learnAttempts);
  const skillRuns = useUiStore((s) => s.skillRuns);
  const triggerRuns = useUiStore((s) => s.triggerRuns);
  // M17.7: read off the run registry rather than off a shared boolean anybody
  // could set. Also the signal that this runner is free again — `agentBusy`
  // flipping back to false was what re-ran the effect below, by accident.
  const yielding = useUiStore((s) => shouldYield(s.runs));
  const shell = useUiStore((s) => s.agentShell);
  const web = useUiStore((s) => s.agentWebAccess);
  const connectors = useUiStore((s) => s.agentConnectors);
  const issuePrefixes = useUiStore((s) => s.issuePrefixes);

  // The tick exists so a due schedule can be NOTICED and an event cooldown
  // can RUN OUT, so a `schedule:` keeps it and so does an Agent's `when:` that
  // parses to a trigger (M53.26). It once took a schedule alone: in a
  // trigger-only vault `now` then stayed at mount time, the agent's first
  // event run stamped its cooldown after it, and the agent was held for the
  // rest of the session. Paused records count, as paused schedules always
  // have. A vault with neither gets no interval and no re-render-per-minute.
  // The hook lives in JobRunnerHost (a null-rendering component) for the same
  // reason: its state churn must not reconcile the whole App tree.
  //
  // M63.1: the open vault's pending wakes, as `wakesPending` last read them,
  // `null` when that read FAILED: gated, not empty, so no woken run is
  // derived and nothing is cancelled. Kept per vault by its tag, so a list
  // read in one vault is never this one's.
  const [wakeRead, setWakeRead] = useState<{
    vault: string;
    wakes: readonly PendingWake[] | null;
  } | null>(null);
  const openWakes = wakeRead !== null && wakeRead.vault === vaultPath ? wakeRead.wakes : null;
  const needsClock = useMemo(
    () =>
      (openWakes?.length ?? 0) > 0 ||
      entries.some(
        (e) =>
          ((isSkillEntry(e) || isAgentEntry(e)) && parseSchedule(e.properties.schedule) !== null) ||
          (isAgentEntry(e) && parseTriggers(e.properties.when).length > 0),
      ),
    [entries, openWakes],
  );
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!needsClock) return;
    const timer = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [needsClock]);

  // Runs this session holds back, vault → ledger slot (`AgentJob.key`) → run
  // key, for one of two reasons: the run died before it recorded anything
  // (most often, its record could not be READ), or the budget gate DEFERRED
  // it (M53.27). Neither run happened, so neither leaves a record, and the
  // next app start asks again. Held here, neither is re-asked at every
  // settle in the meantime — a read→fail→rescan hot loop, or a gate decision
  // and a run-log row every few seconds. A schedule's next fire is a new run
  // key, so it is not held. A woken run is held only when its start failed:
  // a deferred wake waits in Rust with its own time to try again (M63.1).
  // Vault-scoped like skillRuns and for the same reason (PR #5 review): fire
  // keys are calendar values, so a flat map would let one vault's held run
  // suppress the SAME record in a vault opened later this session. Keyed by
  // the slot, never the path: one agent record holds two lanes, its
  // schedule's and its `#wake` one, and keyed by path each lane's failure
  // would overwrite the other's, so the two took turns reading, failing and
  // rescanning every settle (AUTOMATION-2). State rather than a ref so
  // holding a run re-derives `next` and lets the jobs behind it proceed.
  const [held, setHeld] = useState<Record<string, Record<string, string>>>({});

  /**
   * The durable ledgers, hydrated before the queue may fire (M34.2.3).
   *
   * False until the vault's `job_ledger` rows are in the store — an
   * unhydrated map reads as "nothing ever ran", which is the launch storm the
   * ledgers exist to prevent. A read that FAILS leaves the gate closed for
   * the same reason: better a queue that waits than one that re-fires every
   * schedule ever answered. The one-time import feeds the localStorage era
   * into the table; the table has been the arbiter since it existed, so
   * import never overwrites a key the database holds.
   */
  const [ledgersReady, setLedgersReady] = useState(false);
  useEffect(() => {
    if (vaultPath === null) return;
    let cancelled = false;
    setLedgersReady(false);
    void (async () => {
      try {
        let read = await jobLedgerRead(vaultPath);
        const empty =
          Object.keys(read.attempts).length === 0 &&
          Object.keys(read.skillRuns).length === 0 &&
          Object.keys(read.triggerRuns).length === 0;
        if (empty) {
          const ui = useUiStore.getState();
          const entries = [
            // Flat across vaults in its localStorage era: a foreign vault's
            // path lands here too, harmlessly — it suppresses nothing unless
            // this vault holds the same path at the same recorded version.
            ...Object.entries(ui.learnAttempts).map(([key, runKey]) => ({
              ledger: 'attempts',
              key,
              runKey,
            })),
            ...Object.entries(ui.skillRuns[vaultPath] ?? {}).map(([key, runKey]) => ({
              ledger: 'skillRuns',
              key,
              runKey,
            })),
            ...Object.entries(ui.triggerRuns[vaultPath] ?? {}).map(([key, runKey]) => ({
              ledger: 'triggerRuns',
              key,
              runKey,
            })),
          ];
          if (entries.length > 0) {
            await jobLedgerImport(vaultPath, entries);
            read = await jobLedgerRead(vaultPath);
          }
        }
        if (cancelled) return;
        useUiStore.getState().hydrateJobLedgers(vaultPath, read);
        setLedgersReady(true);
      } catch {
        // Gated, not empty. "We could not read the ledgers" and "nothing
        // ever ran" are opposite sentences; acting on the second when the
        // first is true would double-spend every schedule.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

  /**
   * The open vault's pending wakes, read again (M63.1). A read that fails
   * stores `null` for that vault: no woken run is derived from it and no wake
   * is cancelled against it, until a read succeeds. Every read that lands
   * bumps `wakesRevision` (M63.1b), so the lobby's wake list reads again.
   */
  const refreshWakes = useCallback(async (): Promise<void> => {
    const vault = useVaultStore.getState().vaultPath;
    if (vault === null) return;
    let wakes: PendingWake[] | null;
    try {
      wakes = await wakesPending(vault);
    } catch {
      wakes = null;
    }
    if (useVaultStore.getState().vaultPath !== vault) return;
    setWakeRead({ vault, wakes });
    useUiStore.getState().noteWakesChanged();
  }, []);
  useEffect(() => {
    if (vaultPath === null || !ledgersReady) return;
    void refreshWakes();
  }, [ledgersReady, now, refreshWakes, vaultPath]);

  /**
   * What changed since the last scan (M17.12) — the trigger event source.
   *
   * The runner's own memory of what it has already looked at, rather than
   * store state, and kept PER VAULT (AUTOMATION-2b): a first scan must
   * produce NOTHING, or launching the app reads as "every note in the vault
   * was just created" and fires every trigger at once — and the first scan of
   * a vault switched to, or back to, is a first scan too. Diffed against the
   * vault it replaced, every note in the new one read as created. See
   * `observeScan`, which owns that rule. Changes made while the app was
   * closed are therefore never admitted.
   *
   * M63.1: while Learn on its own is on, each scan's matches become wake
   * offers (engine/wakes.ts), held per vault until Rust admits them, at most
   * UNADMITTED_CAP. An admission that fails keeps its batch for the next
   * scan or the minute tick; nothing is dropped. A vault switch drops the
   * other vault's batch: nothing the last vault produced is this one's.
   */
  const seen = useRef<ScanBaseline | null>(null);
  const unadmitted = useRef<{ vault: string; offers: WakeOffer[] } | null>(null);
  const admitting = useRef(false);
  const admit = useCallback(async (): Promise<void> => {
    const held = unadmitted.current;
    if (admitting.current || held === null || held.offers.length === 0) return;
    if (useVaultStore.getState().vaultPath !== held.vault) return;
    const batch = held.offers.slice();
    admitting.current = true;
    try {
      await admitWakes(held.vault, batch);
      // Only what was sent: a scan that landed meanwhile keeps its offers.
      if (unadmitted.current?.vault === held.vault) {
        unadmitted.current.offers = unadmitted.current.offers.slice(batch.length);
      }
      await refreshWakes();
    } catch {
      // Kept for the next scan or the minute tick: a failed admission is
      // offered again, never dropped.
    } finally {
      admitting.current = false;
    }
  }, [refreshWakes]);
  useEffect(() => {
    if (entriesVault === null) return;
    const scan = observeScan(seen.current, entriesVault, entries);
    seen.current = scan.baseline;
    if (unadmitted.current !== null && unadmitted.current.vault !== entriesVault) {
      unadmitted.current = null;
    }
    if (!autoLearn) return;
    const offers = wakeOffers(entries, scan.events);
    if (offers.length > 0) {
      const held = unadmitted.current?.offers ?? [];
      unadmitted.current = {
        vault: entriesVault,
        offers: [...held, ...offers].slice(-UNADMITTED_CAP),
      };
    }
    if (entriesVault === vaultPath) void admit();
    // `autoLearn` and `vaultPath` are read, not listened to: a scan is what
    // offers, and the minute tick below retries.
  }, [entries, entriesVault]); // eslint-disable-line react-hooks/exhaustive-deps -- a scan offers once per new snapshot; re-running on a toggle would diff the same snapshot against itself
  useEffect(() => {
    void admit();
  }, [admit, now]);

  /**
   * Cancel what the vault no longer backs (M63.1): a wake whose agent is gone
   * or paused on its record, whose trigger was edited away, or whose page is
   * gone. Only against the open vault's own entries, never an empty snapshot,
   * only while Learn on its own is on, and only from a read that succeeded.
   * Ids sent are held until their answer, so a re-render sends none twice.
   */
  const cancelling = useRef(new Set<string>());
  useEffect(() => {
    if (!autoLearn || vaultPath === null || entriesVault !== vaultPath || entries.length === 0) {
      return;
    }
    if (openWakes === null) return;
    const verdicts = wakeVerdicts(entries, openWakes).filter(
      (v) => !cancelling.current.has(v.wakeId),
    );
    if (verdicts.length === 0) return;
    for (const v of verdicts) cancelling.current.add(v.wakeId);
    void cancelWakes(vaultPath, verdicts)
      .then(() => refreshWakes())
      .catch(() => undefined)
      .finally(() => {
        for (const v of verdicts) cancelling.current.delete(v.wakeId);
      });
  }, [autoLearn, entries, entriesVault, openWakes, refreshWakes, vaultPath]);

  const today = todayIso();
  const next: AgentJob | null = useMemo(() => {
    // Never from another vault's snapshot (AUTOMATION-2b): between an open
    // moving `vaultPath` and its entries landing — up to a minute (M49) — the
    // last vault's records would be derived against this vault's ledgers,
    // and read, run and claimed under this vault's path.
    if (!autoLearn || vaultPath === null || entriesVault !== vaultPath || !ledgersReady) {
      return null;
    }
    return (
      jobQueue(entries, listConcepts(entries, today, quarantine, ledgerReview), {
        attempts,
        // The ledger is vault-scoped (PR #5 review): fire keys are calendar
        // values, so a flat map would let the same relative path in another
        // vault read as already run.
        skillRuns: skillRuns[vaultPath] ?? {},
        now,
        // Absent when the read failed or has not landed: no woken run.
        ...(openWakes === null ? {} : { wakes: openWakes }),
        triggerRuns: triggerRuns[vaultPath] ?? {},
      }).find(
        (j) =>
          held[vaultPath]?.[j.key] !== j.runKey &&
          (!KNOWLEDGE_JOB_KINDS.has(j.kind) ||
            (recording && quarantine !== 'unknown' && !quarantine.has(j.path))),
      ) ?? null
    );
  }, [
    ledgerReview,
    attempts,
    autoLearn,
    quarantine,
    recording,
    entries,
    entriesVault,
    held,
    openWakes,
    ledgersReady,
    now,
    skillRuns,
    today,
    triggerRuns,
    vaultPath,
  ]);

  // Owns the run. M17.3: "whose events are these" is answered by the run id
  // now, not by two hooks agreeing to take turns — this ref only tracks
  // whether a job is in flight, so a second is not started on top of it.
  const running = useRef(false);
  /** This job's entry in the run registry (M17.7). It carries the note being
   * read, which is what `learningPath` was — now attached to the run doing the
   * reading rather than to a global anybody could set. */
  const task = useRef<string | null>(null);
  /** What this run has written, for the run log (M17.15). Collected from the
   * event stream rather than guessed from the prompt: "wrote nothing" is a
   * real and common outcome and has to be distinguishable from "we did not
   * look". */
  const wrote = useRef<string[]>([]);
  const logged = useRef<Omit<RunLogEntry, 'files' | 'status' | 'at' | 'id'> | null>(null);
  const unsubscribe = useRef<(() => void) | null>(null);

  const failure = useRef<string | null>(null);

  const finish = useCallback(() => {
    if (!running.current) return;
    running.current = false;
    unsubscribe.current?.();
    unsubscribe.current = null;
    if (task.current !== null) {
      useUiStore.getState().endRun(task.current);
      task.current = null;
    }
    // Recorded on the way out, once, whatever ended the run. A log that only
    // captured successes would be a log of the runs that did not need one.
    if (logged.current !== null) {
      useRunLogStore.getState().append({
        ...logged.current,
        id: `rl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        at: new Date().toISOString(),
        files: [...wrote.current],
        status: failure.current === null ? 'ok' : 'failed',
        ...(failure.current === null ? {} : { error: failure.current }),
      });
      logged.current = null;
      wrote.current = [];
      failure.current = null;
    }
    // Whatever it just wrote is on disk and nowhere else until this runs.
    void rescan();
    // And the wakes it finished, coalesced or left waiting (M63.1).
    void refreshWakes();
  }, [refreshWakes, rescan]);

  // M17.3 deleted two whole mechanisms here. The chat used to PREEMPT this
  // runner — kill its child, wait up to 5s for `learningPath` to clear, then
  // take the single shared slot — and this hook needed a store subscriber to
  // notice when that wait timed out and took the stream anyway, or it would
  // wedge `running` true for the session. Both existed because there was one
  // child. A background job and a typed question are now two runs, so neither
  // has anything to hand over.
  //
  // The terminal-event subscription moved into the run itself (see below),
  // scoped to its id: `Error` is terminal but is followed by `Done`, and
  // finishing on either is harmless because finish() is idempotent.

  useEffect(() => {
    if (next === null || vaultPath === null || yielding || running.current) return;
    const job = next;
    const timer = setTimeout(() => {
      if (running.current) return;
      running.current = true;
      const ui = useUiStore.getState();
      const taskId = newRunId();
      task.current = taskId;
      ui.startRun({
        id: taskId,
        owner: 'job',
        label: job.title,
        // A background job is not standing anywhere — see the systemPrompt
        // below, which tells it the same thing. What it IS about is the note.
        place: null,
        path: job.path,
        conversationId: null,
        run: null,
        startedAt: Date.now(),
      });
      // Recorded first, on purpose — see the header, and since M34.2.3 the
      // record is a CLAIM in the durable table: the database arbitrates,
      // so two windows deriving the same due job race for one insert and
      // the loser spawns nothing. The claim moved inside the async block
      // with the rest of the start-up; the ordering it pins is unchanged.
      // Fire-key jobs stay the one exception: they must read their record's
      // body before anything else can fail, so their claim sits after that
      // read, below.

      // An agent job runs AS the agent: its record's identity in the
      // provenance stamps, its memory in the prompt, and shell only when the
      // record asks for it AND the Settings ceiling allows it.
      const entry = useVaultStore.getState().entries.find((e) => e.path === job.path);
      const agent = job.kind === 'agent' && entry !== undefined ? agentRef(entry) : null;
      // The run's own narrowing: an Agent record's `allowed-tools:`, and a
      // scheduled skill's (M54.7). This runner used to drop the skill's, so a
      // skill narrowed to reads ran with every tool on its schedule. Read off
      // the record itself rather than through listSkills, which leaves out a
      // skill with no usable name and would widen exactly that one.
      const narrowing =
        job.kind === 'agent'
          ? (agent?.allowedTools ?? null)
          : job.kind === 'scheduled'
            ? parseAllowedTools(entry?.properties['allowed-tools'])
            : null;
      // M57.2 — the shell ceiling this run may hold. Unattended runs
      // execute vault-authored content, so the one path to the shell on a
      // schedule is an Agent record declaring `tools: shell`, capped by the
      // Settings ceiling; every other job runs at off. Nobody watches, so
      // under Ask the table withholds what it would have asked for, and the
      // run's row says so.
      const ceiling: ShellCeiling =
        job.kind === 'agent' ? effectiveCeiling(shell, agent?.shell ?? false) : 'off';
      // M57.7 — the web the same way: only an Agent record declaring
      // `tools: web`, under Web access in Settings. A skill, a lane job and a
      // record that does not declare it never get it.
      const webCeiling = job.kind === 'agent' && web && (agent?.web ?? false);
      // What this run's prompts may name (M54.7): its narrowed tools, the
      // shell its ceiling plans for an unwatched run, less a read limit
      // (M53.5), and nobody watching.
      const grant: PromptGrant = {
        tools: grantedTools(narrowing),
        shell: holdsShell({
          shell: ceiling,
          attended: false,
          readScoped: agent?.readScope != null,
          narrowing,
        }),
        web: holdsWeb({
          shell: ceiling,
          web: webCeiling ? 'on' : 'off',
          attended: false,
          readScoped: agent?.readScope != null,
          narrowing,
        }),
        attended: false,
      };

      /** Hold this run back for the rest of the session — see `held`. */
      const hold = () =>
        setHeld((m) => ({ ...m, [vaultPath]: { ...m[vaultPath], [job.key]: job.runKey } }));

      /** Has the window moved to another vault since this job was derived
       * (M53.10)? Asked after every await below: a job derived in one vault
       * must not claim, read or spawn in it once the window is showing
       * another. */
      const moved = () => useVaultStore.getState().vaultPath !== vaultPath;

      void (async () => {
        let recorded = false;
        /** Whether this start-up won its durable claim, so an abandoned one
         * knows it has a claim to give back. */
        let claimed = false;
        /** Set once the record is read and the run is being asked for, so a
         * throw after it is the start's refusal (a model or effort Rust would
         * not take, M56.5), not a read that failed. */
        let starting = false;
        /** End a start-up the vault moved out from under: the run never
         * happens, so the claim it won goes back, durable and local alike, as
         * a deferral's does — left in place, the old vault would read the job
         * as answered the next time it is open. Nothing is held: the next
         * time that vault is open, the job is simply due again. */
        const abandon = () => {
          if (claimed && job.ledger !== 'wakes') {
            useUiStore.getState().forgetJobRecord(vaultPath, job.ledger, job.key, job.runKey);
            void jobLedgerUnclaim(vaultPath, job.ledger, job.key, job.runKey).catch(
              () => undefined,
            );
          }
          finish();
        };
        try {
          if (job.ledger === 'attempts') {
            const fresh = await jobLedgerClaim(vaultPath, 'attempts', job.key, job.runKey);
            claimed = fresh;
            if (moved()) {
              abandon();
              return;
            }
            useUiStore.getState().recordLearnAttempt(job.key, job.runKey);
            recorded = true;
            if (!fresh) {
              // Another window or an earlier session already answered this
              // exact version. Nothing to log: the run that DID happen owns
              // the story.
              finish();
              return;
            }
          }
          // What woke a woken run (M63.1): its wake's cause, which Rust
          // stored at admission and quotes into the run's message as data.
          // The trigger's `ask:` and `do:` go to the prompt — layer two,
          // reached only because layer one already passed deterministically,
          // with no model consulted (M17.12).
          const woken = job.wake ?? null;
          // M33.8 — push the state that goes stale, rather than trusting the
          // agent's own notes about it. Both reads degrade to omitting their
          // line: this is a human-action path in every sense that matters, and
          // a run must never fail because a context fetch did.
          const actorForState = agent?.actor ?? null;
          const [lastOutcome, openReviews] = await Promise.all([
            actorForState === null
              ? Promise.resolve(null)
              : fleetActorSummary(actorForState)
                  .then((summary) => summary.last_outcome)
                  .catch(() => null),
            reviewQueue(vaultPath)
              .then((cards) => cards.length)
              // NOT 0. "We could not read the queue" and "the queue is empty"
              // are different, and the block omits the line rather than
              // telling an unattended agent that nothing is waiting.
              .catch(() => null),
          ]);
          if (moved()) {
            abandon();
            return;
          }
          const state = currentStatePrompt({
            vaultName: vaultPath.split('/').filter(Boolean).pop() ?? vaultPath,
            // `todayIso` reads LOCAL date parts, which is the app's one
            // convention for "today" and what the e2e clock is pinned against.
            today: todayIso(),
            lastOutcome,
            openReviews,
          });

          const record =
            job.kind === 'agent' || job.kind === 'scheduled'
              ? splitFrontmatter(await readNote(vaultPath, job.path)).body.trim()
              : '';
          if (moved()) {
            abandon();
            return;
          }
          const body =
            job.kind === 'agent'
              ? agentRunPrompt(
                  grant,
                  job.path,
                  job.title,
                  agent?.actor ?? 'process:agent',
                  agent?.memory ?? { recent: '', preferences: '' },
                  woken === null
                    ? null
                    : {
                        ...(woken.trigger.ask === undefined ? {} : { ask: woken.trigger.ask }),
                        ...(woken.trigger.do === undefined ? {} : { do: woken.trigger.do }),
                      },
                  agent?.scope ?? null,
                  agent?.readScope ?? null,
                )
              : job.kind === 'scheduled'
                ? scheduledSkillPrompt(job.path, job.title, record)
                : job.kind === 'refresh'
                  ? refreshSourcePrompt(job.path, job.title)
                  : job.kind === 'schema'
                    ? schemaRecheckPrompt(job.path, job.title)
                    : job.kind === 'stale'
                      ? reviewConceptPrompt(job.path, job.title)
                      : distillPrompt(job.path, job.title);
          // The block leads. A superseding clause after the instructions
          // would be read as a footnote to them rather than a correction of
          // them.
          const message = `${state}\n\n${body}`;
          // The body is in hand: NOW the fire key is consumed — still before
          // the run itself, so a run that dies waits for the next fire, but
          // after the read, so a read that dies surrenders the key instead
          // of eating the whole period (PR #5 review). Since M34.2.3 the
          // consumption is a durable CLAIM, and the verdict is read: losing
          // it means another window answered this fire, and this one spawns
          // nothing.
          if (job.ledger === 'skillRuns') {
            const fresh = await jobLedgerClaim(vaultPath, 'skillRuns', job.key, job.runKey);
            claimed = fresh;
            if (moved()) {
              abandon();
              return;
            }
            useUiStore.getState().recordSkillRun(vaultPath, job.key, job.runKey);
            recorded = true;
            if (!fresh) {
              finish();
              return;
            }
          }
          starting = true;
          const start = await runAgent(vaultPath, {
            message,
            actor: agent?.actor ?? null,
            // The panel's composer, matched to this run's grant (M54.7): it
            // names only the tools the run holds, and never tells it to call
            // open_note, because nobody is watching a screen it would move.
            // `selection` is 'none': a background reader is not standing
            // anywhere, and telling it otherwise would colour what it takes
            // from a note with wherever you happen to be.
            systemPrompt:
              buildSystemPrompt(
                { kind: 'none' },
                {
                  connectors,
                  issuePrefixes,
                  // M34.1.3: the knowledge lanes ARE the knowledge agent in
                  // all but name until M35 — they keep the fragment. An Agent
                  // record gets it only by declaring the capability.
                  capabilities: job.kind === 'agent' ? (agent?.capabilities ?? []) : ['knowledge'],
                  grant,
                },
              ) +
              (job.kind === 'agent' && record !== ''
                ? // M34.1.4: standing instructions are STANDING — they arrive
                  // with the system prompt, not as something the user just
                  // said. Delivered via --append-system-prompt; no wire
                  // change.
                  `\n\nYour standing instructions, from ${job.path}:\n\n${record}`
                : ''),
            // A fresh session every time: a background turn that accumulated
            // context would carry one note's framing into the next one's.
            sessionId: null,
            // M56.5: the record's own model and effort, or Claude Code's
            // default. Rust refuses a value it would not take, and that
            // refusal is logged like any failed start, every fire until the
            // record is fixed (Q12).
            model: agent?.model ?? null,
            effort: agent?.effort ?? null,
            // The ceilings worked out above, never the Settings ones themselves.
            shell: ceiling,
            web: webCeiling,
            // M17.13/M17.8: the record's own declarations, enforced in Rust.
            // Each is a narrowing — none can widen what Settings granted —
            // and the tools are the narrowing the grant above was read from.
            scope: agent?.scope ?? null,
            readScope: agent?.readScope ?? null,
            allowedTools: narrowing,
            // M54.9: the connector tools an agent's record denies; only an
            // agent job reaches connectors at all.
            disallowedTools: agent?.disallowedTools ?? null,
            connectorNames: agent?.connectors ?? null,
            connectors,
            // Unattended, and it matters beyond bookkeeping: with connectors
            // on but no connectors.json, an attended turn falls back to the
            // user's global MCP config — this run must not, because it
            // executes vault-authored content with nobody watching. The one
            // path to connectors on a schedule is an Agent record that names
            // them, from the vault's own explicit list, each entry approved
            // on this machine (PR #5 security review, M54.9): a job whose
            // record names none reaches none.
            attended: false,
            // M57.4: the record's `ask-first:`. Nobody watches this run, so
            // its page writes are refused at dispatch and recorded; Rust
            // reads the record again, so this can only tighten it.
            askFirst: agent?.askFirst ?? false,
            // M34.2.4: the job's kind IS its budget lane — the run claims a
            // dispatcher lease and faces the ambient gate, so schedules and
            // ingest share one budget and one deferral record.
            lane: job.kind,
            // Why it started (M56.7): admitted by Rust, written with the
            // run's row, and opening its message as quoted data. A woken
            // run names none: its cause is its wake's (M63.1).
            cause: causeOfJob(
              job,
              typeof entry?.properties.schedule === 'string' ? entry.properties.schedule : null,
            ),
            // M63.1: the wake it claims inside the dispatch transaction, and
            // the due wakes of the same trigger it takes with it.
            ...(woken === null ? {} : { wake: { claim: woken.claim, coalesce: woken.coalesce } }),
            approvedStdio: useUiStore.getState().stdioApprovals[vaultPath] ?? [],
          });
          if ('settled' in start) {
            // M63.1: the wake was no longer pending, expired, or its agent's
            // pause cancelled it. Nothing ran and nothing is owed: no row.
            await refreshWakes();
            finish();
            return;
          }
          if ('deferred' in start && woken !== null) {
            // M63.1: the wake stays pending in Rust with its own time to try
            // again, so nothing is held or given back. One row, the first
            // time it is deferred, so a long wait is not a row a minute.
            if (woken.deferredBefore === null) {
              useRunLogStore.getState().append({
                id: `rl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                at: new Date().toISOString(),
                owner: 'job',
                label: job.title,
                source: job.path,
                trigger: 'event',
                scope: agent?.scope ?? null,
                files: [],
                status: 'deferred',
                error: `deferred by the budget gate: ${start.deferred.join(', ')}`,
              });
            }
            await refreshWakes();
            finish();
            return;
          }
          if ('deferred' in start) {
            // The gate said "not now" — over a ceiling, paused, accounting
            // unknown. One honest row, and the claim gives back both records
            // it made, so the deferral never eats the run it refused: the
            // durable row is SURRENDERED, and the local record FORGOTTEN —
            // the next launch starts from its localStorage mirror, and a
            // record left there comes back as answered
            // (uiStore.forgetJobRecord). So the next launch asks again: a
            // schedule's open fire or a concept recheck still due.
            // Within this session the run is `held` instead, and held FIRST,
            // so no render offers it again: re-asking at every settle would
            // be a gate decision and a run-log row every few seconds.
            hold();
            if (job.ledger !== 'wakes') {
              useUiStore.getState().forgetJobRecord(vaultPath, job.ledger, job.key, job.runKey);
              void jobLedgerUnclaim(vaultPath, job.ledger, job.key, job.runKey).catch(
                () => undefined,
              );
            }
            useRunLogStore.getState().append({
              id: `rl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              at: new Date().toISOString(),
              owner: 'job',
              label: job.title,
              source: job.path,
              trigger: 'schedule',
              scope: agent?.scope ?? null,
              files: [],
              status: 'deferred',
              error: `deferred by the budget gate: ${start.deferred.join(', ')}`,
            });
            finish();
            return;
          }
          const { run: runId, durableId } = start;
          // The vault moved while the spawn was in flight. Opening the new
          // vault stops the old one's runs in Rust (`start_watcher`), but a
          // spawn that lands after that sweep is still the old vault's: stop
          // it by id, and give its claim back — it never got to run.
          if (moved()) {
            void stopAgent(runId).catch(() => undefined);
            abandon();
            return;
          }
          // The cooldown clock starts at the RUN, not at its end: an agent
          // that watches a folder it also writes to would otherwise re-fire
          // on its own output the moment it finished (M17.12). After the
          // spawn, so a deferred run starts no cooldown. Fire and forget —
          // a clock is not a claim, and a stamp that failed only costs one
          // extra cooldown check on the next launch. Under `cooldownKey`,
          // the agent's bare identity the check reads, never the job's own
          // `key` (AgentJob.cooldownKey).
          if (job.cooldownKey !== null) {
            const at = new Date().toISOString();
            useUiStore.getState().recordTriggerRun(vaultPath, job.cooldownKey, at);
            void jobLedgerStamp(vaultPath, job.cooldownKey, at).catch(() => undefined);
          }
          // Scoped to THIS job's run (M17.3). The old subscription saw every
          // event in the app and guessed with `running.current`, which is how
          // a chat turn's Done could end a background job — and vice versa.
          useUiStore.getState().attachChild(taskId, runId);
          logged.current = {
            owner: 'job',
            label: job.title,
            source: job.path,
            trigger:
              woken === null
                ? job.kind === 'agent' || job.kind === 'scheduled'
                  ? 'schedule'
                  : job.kind
                : `event: ${triggerWords(woken.trigger)}${
                    woken.coalesce.length > 0 ? ` (+${woken.coalesce.length} more)` : ''
                  }`,
            scope: agent?.scope ?? null,
            // Absent in the browser, where there is no row to point at.
            ...(durableId === null ? {} : { durableId }),
            // M34.2: a schedule-fired job's runKey IS its due stamp, so the
            // log can say when this run was owed — and, on a catch-up after a
            // closed weekend, how late it ran. Late is not failed.
            ...(() => {
              const due = job.ledger === 'skillRuns' ? fireKeyDate(job.runKey) : null;
              return due === null ? {} : { dueAt: due.toISOString() };
            })(),
          };
          unsubscribe.current = onAgentEvent((event) => {
            if (event.kind === 'ToolStart') {
              const path = writtenPath(event.tool_name, event.input ?? null);
              if (path !== null && !wrote.current.includes(path)) wrote.current.push(path);
            }
            if (event.kind === 'Error') failure.current = event.message;
            // M57.1: nobody watches a job, so a call a hook outside Cerebro
            // held is never answered; the run stopped there, and Rust books
            // it failed and requeues its items.
            if (event.kind === 'ToolDeferred') failure.current = pausedByHook(event.tool_name);
            if (event.kind === 'Done' || event.kind === 'Error') finish();
          }, runId);
        } catch (err) {
          // Silent by construction — no toast: a background runner that could
          // raise one would be a notification, which is the one thing this
          // whole surface is not allowed to be. But silent is not INVISIBLE
          // (M34.2): a run that died before it started still gets a log row,
          // because "found nothing to do" and "could not tell" are different
          // sentences and an absent row reads as the first one.
          if (logged.current === null) {
            useRunLogStore.getState().append({
              id: `rl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              at: new Date().toISOString(),
              owner: 'job',
              label: job.title,
              source: job.path,
              trigger: job.wake !== undefined ? 'event' : 'schedule',
              scope: agent?.scope ?? null,
              files: [],
              status: 'failed',
              // A refused start says why in Rust's words, each fire, until
              // the record is fixed (M56.5, Q12).
              error:
                starting && err instanceof Error && err.message !== ''
                  ? `did not start: ${err.message}`
                  : `could not read ${job.path} — this run cannot say what it found`,
            });
          }
          if (!recorded) hold();
          finish();
        }
      })();
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [connectors, finish, issuePrefixes, next, refreshWakes, shell, vaultPath, web, yielding]);
}

/** Mounts the runner where its minute tick re-renders nothing but itself. */
export function JobRunnerHost(): null {
  useJobRunner();
  return null;
}
