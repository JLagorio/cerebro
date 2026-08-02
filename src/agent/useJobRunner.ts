import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAgentEvent, runAgent, startMcp } from './agentIpc';
import { buildSystemPrompt } from './AiPanel';
import type { McpInfo } from './types';
import { agentRef, isAgentEntry } from '@/engine/agents';
import { jobQueue, unlearnableFiled, type AgentJob } from '@/engine/jobs';
import { isSkillEntry, parseSchedule } from '@/engine/skills';
import { listConcepts } from '@/engine/okf';
import { readNote } from '@/lib/ipc';
import { splitFrontmatter } from '@/lib/mockParse';
import {
  agentRunPrompt,
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
 * 2. **There is one agent.** `AgentState` holds a single child process, so a
 *    background turn and a typed question cannot both be in flight. The runner
 *    yields: it starts only when nothing else is running.
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
  const filed = useUiStore((s) => s.filedForLearning);
  const attempts = useUiStore((s) => s.learnAttempts);
  const skillRuns = useUiStore((s) => s.skillRuns);
  const agentBusy = useUiStore((s) => s.agentBusy);
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

  // A filed path that points at a Skill or Agent record can never become a
  // job — their bodies are schema for behavior, excluded from learning — and
  // only a learn attempt consumes a filing, so left alone it sits in the
  // persisted ledger as "filed" forever. Unfiled on sight, which also heals
  // entries persisted before a capture was (re)typed (PR #5 review).
  useEffect(() => {
    const ui = useUiStore.getState();
    for (const path of unlearnableFiled(entries, filed)) ui.unfileForLearning(path);
  }, [entries, filed]);

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

  const today = todayIso();
  const next: AgentJob | null = useMemo(() => {
    if (!autoLearn || vaultPath === null) return null;
    return (
      jobQueue(entries, listConcepts(entries, today), {
        filed,
        attempts,
        // The ledger is vault-scoped (PR #5 review): fire keys are calendar
        // values, so a flat map would let the same relative path in another
        // vault read as already run.
        skillRuns: skillRuns[vaultPath] ?? {},
        now,
        connectors,
      }).find((j) => failedReads[vaultPath]?.[j.path] !== j.runKey) ?? null
    );
  }, [attempts, autoLearn, connectors, entries, failedReads, filed, now, skillRuns, today, vaultPath]);

  // Owns the run: the event stream is shared with the chat, so both sides need
  // to know whose turn the events belong to.
  const running = useRef(false);
  const mcp = useRef<McpInfo | null>(null);

  const finish = useCallback(() => {
    if (!running.current) return;
    running.current = false;
    const ui = useUiStore.getState();
    ui.setLearningPath(null);
    ui.setAgentBusy(false);
    // Whatever it just wrote is on disk and nowhere else until this runs.
    void rescan().catch(() => undefined);
  }, [rescan]);

  // The chat's release wait can take the stream by TIMEOUT: streamReleased
  // clears learningPath itself when the killed child's terminal Done is lost
  // (useAgentChat). That lost Done is the very event finish() rides, so
  // waiting for a terminal event to drop this claim could wedge the runner
  // for the session — `running` stuck true, no job ever scheduled again
  // (PR #5 review). The takeover transition itself is the signal: the path
  // going null while the claim is still held can only be the chat's timeout,
  // because finish() drops the claim BEFORE clearing the path. Drop the
  // claim and rescan; the busy flag is the chat's now — clearing it would
  // let this runner read the agent as idle and start a run that replaces
  // the chat's child mid-answer.
  useEffect(
    () =>
      useUiStore.subscribe((state, prev) => {
        if (prev.learningPath === null || state.learningPath !== null) return;
        if (!running.current) return;
        running.current = false;
        void rescan().catch(() => undefined);
      }),
    [rescan],
  );

  useEffect(
    () =>
      onAgentEvent((event) => {
        if (!running.current) return;
        // `Error` is terminal for the turn but is followed by `Done`; ending on
        // either is harmless because finish() is idempotent.
        if (event.kind === 'Done' || event.kind === 'Error') finish();
      }),
    [finish],
  );

  useEffect(() => {
    if (next === null || vaultPath === null || agentBusy || running.current) return;
    const job = next;
    const timer = setTimeout(() => {
      if (running.current) return;
      running.current = true;
      const ui = useUiStore.getState();
      ui.setAgentBusy(true);
      ui.setLearningPath(job.path);
      // Recorded first, on purpose — see the header. The job SAYS which
      // ledger gates it (jobs.ts decides both sides); re-deriving that here
      // is how agent runs briefly looped forever. Fire-key jobs are the one
      // exception: they must read their record's body before anything else
      // can fail, so their record sits after that read, below.
      if (job.ledger === 'attempts') ui.recordLearnAttempt(job.path, job.runKey);

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
          const message =
            job.kind === 'agent'
              ? agentRunPrompt(
                  job.path,
                  job.title,
                  agent?.actor ?? 'process:agent',
                  agent?.memory ?? '',
                  splitFrontmatter(await readNote(vaultPath, job.path)).body.trim(),
                )
              : job.kind === 'scheduled'
                ? scheduledSkillPrompt(
                    job.path,
                    job.title,
                    splitFrontmatter(await readNote(vaultPath, job.path)).body.trim(),
                  )
                : job.kind === 'refresh'
                  ? refreshSourcePrompt(job.path, job.title)
                  : job.kind === 'schema'
                    ? schemaRecheckPrompt(job.path, job.title)
                    : job.kind === 'stale'
                      ? reviewConceptPrompt(job.path, job.title)
                      : distillPrompt(job.path, job.title);
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
            useUiStore.getState().recordSkillRun(vaultPath, job.path, job.runKey);
            recorded = true;
          }
          await runAgent(vaultPath, {
            message,
            actor: agent?.actor ?? null,
            // The same rules the panel's agent gets — the conventions about
            // sources, anchors and never self-certifying are the contract, not
            // panel decoration. `selection` is 'none': a background reader is
            // not standing anywhere, and telling it otherwise would colour
            // what it takes from a note with wherever you happen to be.
            systemPrompt: buildSystemPrompt({ kind: 'none' }, { connectors, issuePrefixes }),
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
  }, [agentBusy, connectors, finish, issuePrefixes, next, shell, vaultPath]);
}

/** Mounts the runner where its minute tick re-renders nothing but itself. */
export function JobRunnerHost(): null {
  useJobRunner();
  return null;
}
