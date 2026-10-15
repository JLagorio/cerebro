import { onAgentEvent } from './agentIpc';
import { useFollowupStore } from '@/stores/followupStore';
import { waitingFollowup } from '@/engine/followups';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { startAgentJob } from './startAgentJob';
import { assignedWakes, unassignments, type AssignmentRelease } from '@/engine/assignment';
import { buildSchema } from '@/engine/schema';
import { observeScan, type ScanBaseline } from '@/engine/events';
import { jobQueue, KNOWLEDGE_JOB_KINDS, type AgentJob } from '@/engine/jobs';
import { isAgentEntry } from '@/engine/agents';
import { isRecording, useLedgerStore, useLedgerReview, useQuarantine } from '@/stores/ledgerStore';
import { parseTriggers } from '@/engine/triggers';
import { wakeOffers, wakeVerdicts, type PendingWake, type WakeOffer } from '@/engine/wakes';
import { shouldYield } from './runs';
import { isSkillEntry, parseScheduleSet } from '@/engine/skills';
import { listConcepts } from '@/engine/okf';
import {
  admitWakes,
  releaseAssignedWakes,
  cancelWakes,
  jobLedgerImport,
  jobLedgerRead,
  wakesPending,
} from '@/lib/ipc';
import { todayIso } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Drains the background job queue (M8.6 as the learn runner; generalized
 * M13.2) — one derived queue, four job kinds, one agent at a time.
 *
 * Two constraints shaped this, and they are worth stating because each one
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
 * Durable claim ordering, failure cleanup and run-local subscriptions live
 * in startAgentJob, shared with Run now. This hook derives the queue and
 * decides when its next job may try.
 */

/** Let a burst of edits settle before reading anything. */
const SETTLE_MS = 4_000;

/** How often the wall clock re-derives the queue. `now` moves on this tick
 * and nowhere else; it notices a schedule's fire coming
 * due, an event cooldown running out (TRIGGER_COOLDOWN_MS), and a deferred
 * wake's retry time. Follow-up due times, stale claims and local retry holds
 * use the same clock. The tick also offers again an admission that failed. */
const TICK_MS = 60_000;

/** The most matches one vault holds back for admission (M63.1): a bulk
 * change past it keeps the newest, and the wakes it admits drain twenty to
 * a run. */
const UNADMITTED_CAP = 500;

export { pausedByHook } from './startAgentJob';

export function useJobRunner(): void {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  // AUTOMATION-2b: which vault `entries` came from, which during an open can
  // still be the last one (see VaultState.entriesVault).
  const entriesVault = useVaultStore((s) => s.entriesVault);
  const autoLearn = useUiStore((s) => s.autoLearn);
  const followupVault = useFollowupStore((s) => s.vault);
  const followupRead = useFollowupStore((s) => s.read);
  const followupHolds = useFollowupStore((s) => s.held);
  const followups =
    followupVault === vaultPath && followupRead.state === 'ready' ? followupRead.rows : null;
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

  // The tick exists so a due schedule can be NOTICED and an event cooldown
  // can RUN OUT, so a `schedule:` keeps it and so does an Agent's `when:` that
  // parses to a trigger (M53.26). It once took a schedule alone: in a
  // trigger-only vault `now` then stayed at mount time, the agent's first
  // event run stamped its cooldown after it, and the agent was held for the
  // rest of the session. Paused records count, as paused schedules always
  // have. A waiting follow-up or unavailable follow-up read also keeps this clock;
  // a quiet vault without any of these gets no interval.
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
      (followups?.some(waitingFollowup) ?? false) ||
      followupRead.state === 'unavailable' ||
      (openWakes?.length ?? 0) > 0 ||
      entries.some(
        (e) =>
          ((isSkillEntry(e) || isAgentEntry(e)) &&
            parseScheduleSet(e.properties.schedule) !== null) ||
          (isAgentEntry(e) && parseTriggers(e.properties.when).length > 0),
      ),
    [entries, openWakes, followups, followupRead.state],
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
  // Follow-ups use their own per-id fifteen-minute retry holds in followupStore.
  const [held, setHeld] = useState<Record<string, Record<string, string>>>({});
  // A yes lasts only for this open vault session. A failed check has its
  // own retry clock, independent of the full run's cooldown. Rust persists
  // that clock too, so reopening the vault cannot evade the wait.
  const checkedSession = useRef<{ vault: string | null; yes: Set<string> }>({
    vault: null,
    yes: new Set(),
  });
  if (checkedSession.current.vault !== vaultPath)
    checkedSession.current = { vault: vaultPath, yes: new Set() };
  const [checkHeld, setCheckHeld] = useState<Record<string, Record<string, string>>>({});

  // Every agent turn can book a later run, including a panel turn. Reload
  // after Done as well as open, scans and clock ticks; failed reads stay gated.
  useEffect(() => {
    if (vaultPath !== null && entriesVault === vaultPath)
      void useFollowupStore.getState().refresh(vaultPath);
  }, [vaultPath, entriesVault, entries, now]);
  useEffect(
    () =>
      onAgentEvent((event) => {
        if (event.kind !== 'Done') return;
        const vault = useVaultStore.getState().vaultPath;
        if (vault !== null) void useFollowupStore.getState().refresh(vault);
      }),
    [],
  );

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
  const schema = useMemo(() => buildSchema(entries), [entries]);
  type ScanBatch = { seenAt: string; offers: WakeOffer[]; releases: AssignmentRelease[] };
  const unadmitted = useRef<{ vault: string; batches: ScanBatch[] } | null>(null);
  const admitting = useRef(false);
  const admit = useCallback(async (): Promise<void> => {
    if (admitting.current) return;
    admitting.current = true;
    try {
      for (;;) {
        const held = unadmitted.current;
        const batch = held?.batches[0];
        if (held == null || batch === undefined) break;
        if (useVaultStore.getState().vaultPath !== held.vault) break;
        for (const release of batch.releases) {
          if (useVaultStore.getState().vaultPath !== held.vault) return;
          await releaseAssignedWakes(held.vault, release.agent, release.subject, release.keyPrefix);
        }
        if (useVaultStore.getState().vaultPath !== held.vault) return;
        if (batch.offers.length > 0) await admitWakes(held.vault, batch.seenAt, batch.offers);
        // Remove the exact batch: a scan or a cap applied during the await
        // must never discard offers that were not part of this admission.
        if (unadmitted.current?.vault === held.vault) {
          unadmitted.current.batches = unadmitted.current.batches.filter((b) => b !== batch);
        }
      }
      await refreshWakes();
    } catch {
      // The exact scan time stays with the batch when admission is retried.
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
    const offers = [
      ...wakeOffers(entries, scan.events),
      ...assignedWakes(entries, scan.events, schema),
    ];
    const releases = unassignments(entries, scan.events, schema);
    if (offers.length > 0 || releases.length > 0) {
      const batches = [
        ...(unadmitted.current?.batches ?? []),
        { seenAt: new Date().toISOString(), offers, releases },
      ];
      let excess = batches.reduce((n, batch) => n + batch.offers.length, 0) - UNADMITTED_CAP;
      while (excess > 0 && batches.length > 0) {
        const index = batches.findIndex((batch) => batch.offers.length > 0);
        if (index === -1) break;
        const first = batches[index];
        if (first.offers.length <= excess) {
          excess -= first.offers.length;
          // Releases cannot be dropped by the offer cap.
          if (first.releases.length > 0) batches[index] = { ...first, offers: [] };
          else batches.splice(index, 1);
        } else {
          batches[index] = { ...first, offers: first.offers.slice(excess) };
          excess = 0;
        }
      }
      unadmitted.current = { vault: entriesVault, batches };
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
        ...(openWakes === null
          ? {}
          : {
              wakes: openWakes.filter((wake) => {
                const retry = checkHeld[vaultPath]?.[wake.wakeId];
                return retry === undefined || Date.parse(retry) <= now.getTime();
              }),
            }),
        triggerRuns: triggerRuns[vaultPath] ?? {},
        followups: (followups ?? []).filter(
          (row) => (followupHolds[row.followupId] ?? 0) <= now.getTime(),
        ),
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
    checkHeld,
    followups,
    followupHolds,
    openWakes,
    ledgersReady,
    now,
    skillRuns,
    today,
    triggerRuns,
    vaultPath,
  ]);

  // The shared start owns its event subscription; the queue only holds its
  // current slot until onSettled runs, before the registry announces Done.
  const running = useRef(false);
  useEffect(() => {
    if (next === null || vaultPath === null || yielding || running.current) return;
    const job = next;
    const timer = setTimeout(() => {
      if (running.current) return;
      running.current = true;
      void startAgentJob(job, {
        vaultPath,
        checkedYes: checkedSession.current.yes,
        onCheckHold: (ids, retryAt) =>
          setCheckHeld((held) => ({
            ...held,
            [vaultPath]: {
              ...held[vaultPath],
              ...Object.fromEntries(ids.map((id) => [id, retryAt])),
            },
          })),
        onSettled: () => {
          running.current = false;
        },
        onHold: () =>
          setHeld((held) => ({
            ...held,
            [vaultPath]: { ...held[vaultPath], [job.key]: job.runKey },
          })),
        refreshWakes,
        onClaimedWakes: (ids) => {
          const claimed = new Set(ids);
          setWakeRead((read) =>
            read?.vault === vaultPath && read.wakes !== null
              ? { ...read, wakes: read.wakes.filter((wake) => !claimed.has(wake.wakeId)) }
              : read,
          );
        },
      });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [next, refreshWakes, vaultPath, yielding]);
}

/** Mounts the runner where its minute tick re-renders nothing but itself. */
export function JobRunnerHost(): null {
  useJobRunner();
  return null;
}
