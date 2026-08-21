import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAgentEvent, runAgent, startMcp } from './agentIpc';
import { buildSystemPrompt } from './systemPrompt';
import type { McpInfo } from './types';
import { agentRef, isAgentEntry } from '@/engine/agents';
import { diffEntries, type VaultEvent } from '@/engine/events';
import { jobQueue, type AgentJob } from '@/engine/jobs';
import { appendRunLog, writtenPath, type RunLogEntry } from '@/engine/runLog';
import { describeTrigger, firstMatch, parseTriggers } from '@/engine/triggers';
import type { Entry } from '@/engine/types';
import { newRunId, shouldYield } from './runs';
import { isSkillEntry, parseSchedule } from '@/engine/skills';
import { listConcepts } from '@/engine/okf';
import { fleetActorSummary, readNote, reviewQueue } from '@/lib/ipc';
import { splitFrontmatter } from '@/lib/mockParse';
import {
  agentRunPrompt,
  currentStatePrompt,
  distillPrompt,
  refreshSourcePrompt,
  reviewConceptPrompt,
  scheduledSkillPrompt,
  schemaRecheckPrompt,
} from '@/lib/prompts';
import { todayIso } from '@/lib/templates';
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
 *    schedule fires again. One refinement (PR #5 review): a scheduled run
 *    consumes its fire key only once its record's body has actually been
 *    read — a failed READ is not a run, and must not eat the whole period.
 *    The failed read itself is remembered in memory (failedReads) so it
 *    cannot hot-loop within the session either.
 */

/** Let a burst of edits settle before reading anything. */
const SETTLE_MS = 4_000;

/** How often the wall clock re-derives the queue — a due schedule can only
 * be noticed when `now` moves. */
const TICK_MS = 60_000;

export function useJobRunner(): void {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const rescan = useVaultStore((s) => s.rescan);
  const autoLearn = useUiStore((s) => s.autoLearn);
  const attempts = useUiStore((s) => s.learnAttempts);
  const skillRuns = useUiStore((s) => s.skillRuns);
  const triggerRuns = useUiStore((s) => s.triggerRuns);
  // M17.7: read off the run registry rather than off a shared boolean anybody
  // could set. Also the signal that this runner is free again — `agentBusy`
  // flipping back to false was what re-ran the effect below, by accident.
  const yielding = useUiStore((s) => shouldYield(s.runs));
  const shell = useUiStore((s) => s.agentShellAccess);
  const connectors = useUiStore((s) => s.agentConnectors);
  const issuePrefixes = useUiStore((s) => s.issuePrefixes);

  // The tick exists only so a due schedule can be NOTICED — a vault with no
  // scheduled skill gets no interval and no re-render-per-minute. The hook
  // lives in JobRunnerHost (a null-rendering component) for the same reason:
  // its state churn must not reconcile the whole App tree.
  const hasSchedules = useMemo(
    () =>
      entries.some(
        (e) =>
          (isSkillEntry(e) || isAgentEntry(e)) && parseSchedule(e.properties.schedule) !== null,
      ),
    [entries],
  );
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!hasSchedules) return;
    const timer = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [hasSchedules]);

  // Scheduled runs whose record could not be READ this session, vault →
  // path → fire key. Vault-scoped like skillRuns and for the same reason
  // (PR #5 review): fire keys are calendar values, so a flat path map would
  // let one vault's failed read suppress the SAME relative path in a vault
  // opened later this session. A failed read leaves the fire key unconsumed
  // so the run is retried — but retried on the next app start or the next
  // fire, not in a read→fail→rescan hot loop. State rather than a ref so
  // recording a failure re-derives `next` and lets the jobs behind it
  // proceed.
  const [failedReads, setFailedReads] = useState<Record<string, Record<string, string>>>({});

  /**
   * What changed since the last scan (M17.12) — the trigger event source.
   *
   * The runner's own memory of what it has already looked at, rather than
   * store state, and `null` until the first corpus arrives: a first scan must
   * produce NOTHING, or launching the app reads as "every note in the vault
   * was just created" and fires every trigger at once.
   */
  const seen = useRef<Entry[] | null>(null);
  const [events, setEvents] = useState<VaultEvent[]>([]);
  useEffect(() => {
    if (entries.length === 0) return;
    const next = diffEntries(seen.current, entries);
    seen.current = entries;
    // Replaced, never appended. An event the queue has already been offered
    // and declined will not become interesting later, and a growing list would
    // re-offer it on every scan for the rest of the session.
    if (next.length > 0) setEvents(next);
  }, [entries]);

  const today = todayIso();
  const next: AgentJob | null = useMemo(() => {
    if (!autoLearn || vaultPath === null) return null;
    return (
      jobQueue(entries, listConcepts(entries, today), {
        attempts,
        // The ledger is vault-scoped (PR #5 review): fire keys are calendar
        // values, so a flat map would let the same relative path in another
        // vault read as already run.
        skillRuns: skillRuns[vaultPath] ?? {},
        now,
        connectors,
        events,
        triggerRuns: triggerRuns[vaultPath] ?? {},
      }).find((j) => failedReads[vaultPath]?.[j.path] !== j.runKey) ?? null
    );
  }, [
    attempts,
    autoLearn,
    connectors,
    entries,
    failedReads,
    events,
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
  const mcp = useRef<McpInfo | null>(null);

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
      appendRunLog({
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
  }, [rescan]);

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
      // Recorded first, on purpose — see the header. The job SAYS which
      // ledger gates it (jobs.ts decides both sides); re-deriving that here
      // is how agent runs briefly looped forever. Fire-key jobs are the one
      // exception: they must read their record's body before anything else
      // can fail, so their record sits after that read, below.
      if (job.ledger === 'attempts') ui.recordLearnAttempt(job.key, job.runKey);

      // An agent job runs AS the agent: its record's identity in the
      // provenance stamps, its memory in the prompt, and shell only when the
      // record asks for it AND the Settings ceiling allows it.
      const agent =
        job.kind === 'agent'
          ? (() => {
              const entry = useVaultStore.getState().entries.find((e) => e.path === job.path);
              return entry === undefined ? null : agentRef(entry);
            })()
          : null;

      void (async () => {
        let recorded = job.ledger === 'attempts';
        try {
          // M17.12: an event run says what woke it and carries the trigger's
          // `ask:` — layer two, reached only because layer one already passed
          // deterministically, with no model consulted.
          const event = job.runKey.startsWith('event:')
            ? (events.find((e) => job.runKey.endsWith(`:${e.path}@${e.entry.modifiedAt}`)) ?? null)
            : null;
          const trigger =
            event === null
              ? null
              : firstMatch(
                  parseTriggers(
                    useVaultStore.getState().entries.find((e) => e.path === job.path)?.properties
                      .when,
                  ),
                  event,
                );
          const woken =
            event === null || trigger === null
              ? null
              : {
                  subject: event.path,
                  because: describeTrigger(trigger)
                    .replace(/^When /, '')
                    .replace(/\.$/, ''),
                  ...(trigger.ask === undefined ? {} : { ask: trigger.ask }),
                  ...(trigger.do === undefined ? {} : { do: trigger.do }),
                };
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
          const body =
            job.kind === 'agent'
              ? agentRunPrompt(
                  job.path,
                  job.title,
                  agent?.actor ?? 'process:agent',
                  agent?.memory ?? { recent: '', preferences: '' },
                  woken,
                  agent?.scope ?? null,
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
          mcp.current ??= await startMcp(vaultPath);
          // Ownership re-check (PR #5 review): while this start-up was
          // parked on readNote or startMcp, a chat preemption may have taken
          // the stream — the takeover subscriber dropped this claim — and a
          // spawn now would replace the chat's child mid-answer through the
          // single shared AgentState. Checked before the ledger records
          // anything, so a preempted job keeps its fire key and simply runs
          // when the agent is next idle.
          if (!running.current) return;
          // The body is in hand: NOW the fire key is consumed — still before
          // the run itself, so a run that dies waits for the next fire, but
          // after the read, so a read that dies surrenders the key instead
          // of eating the whole period (PR #5 review).
          if (job.ledger === 'skillRuns') {
            useUiStore.getState().recordSkillRun(vaultPath, job.key, job.runKey);
            // The cooldown clock starts at the RUN, not at its end: an agent
            // that watches a folder it also writes to would otherwise re-fire
            // on its own output the moment it finished (M17.12).
            if (job.runKey.startsWith('event:')) {
              useUiStore.getState().recordTriggerRun(vaultPath, job.key, new Date().toISOString());
            }
            recorded = true;
          }
          const { run: runId, durableId } = await runAgent(vaultPath, {
            message,
            actor: agent?.actor ?? null,
            // The same rules the panel's agent gets — the conventions about
            // sources, anchors and never self-certifying are the contract, not
            // panel decoration. `selection` is 'none': a background reader is
            // not standing anywhere, and telling it otherwise would colour
            // what it takes from a note with wherever you happen to be.
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
            model: null,
            // Unattended runs execute vault-authored content, so none of
            // them inherit the Settings toggle — that grant is the
            // assistant's, made for turns a person is watching (PR #5
            // review). Here it is only a CEILING: the one path to shell on
            // a schedule is an Agent record declaring `tools: shell`, and
            // no record can grant itself what Settings denies.
            shell: job.kind === 'agent' && shell && (agent?.shell ?? false),
            // M17.13/M17.8: the record's own declarations, enforced in Rust.
            // Both are narrowings — neither can widen what Settings granted.
            scope: agent?.scope ?? null,
            allowedTools: agent?.allowedTools ?? null,
            connectorNames: agent?.connectors ?? null,
            connectors,
            // Unattended, and it matters beyond bookkeeping: with connectors
            // on but no connectors.json, an attended turn falls back to the
            // user's global MCP config — this run must not, because it
            // executes vault-authored content with nobody watching. The one
            // path to connectors on a schedule is the vault's own explicit
            // list, stdio entries machine-approved (PR #5 security review).
            attended: false,
            approvedStdio: useUiStore.getState().stdioApprovals[vaultPath] ?? [],
            mcp: mcp.current,
          });
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
                : `event: ${woken.because}`,
            scope: agent?.scope ?? null,
            // Absent in the browser, where there is no row to point at.
            ...(durableId === null ? {} : { durableId }),
          };
          unsubscribe.current = onAgentEvent((event) => {
            if (event.kind === 'ToolStart') {
              const path = writtenPath(event.tool_name, event.input ?? null);
              if (path !== null && !wrote.current.includes(path)) wrote.current.push(path);
            }
            if (event.kind === 'Error') failure.current = event.message;
            if (event.kind === 'Done' || event.kind === 'Error') finish();
          }, runId);
        } catch {
          // Silent by construction. A background runner that could raise a
          // toast would be a notification, which is the one thing this whole
          // surface is not allowed to be.
          if (!recorded) {
            setFailedReads((m) => ({
              ...m,
              [vaultPath]: { ...m[vaultPath], [job.path]: job.runKey },
            }));
          }
          finish();
        }
      })();
    }, SETTLE_MS);
    return () => clearTimeout(timer);
    // `events` is read inside the timer to describe what woke a run. Listed
    // because it is genuinely read — and harmless as a dep: it only changes
    // when a scan produced something new, which is also when `next` changes.
  }, [connectors, events, finish, issuePrefixes, next, shell, vaultPath, yielding]);
}

/** Mounts the runner where its minute tick re-renders nothing but itself. */
export function JobRunnerHost(): null {
  useJobRunner();
  return null;
}
