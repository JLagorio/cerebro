import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAgentEvent, runAgent, startMcp } from './agentIpc';
import { buildSystemPrompt } from './AiPanel';
import type { McpInfo } from './types';
import { jobQueue, type AgentJob } from '@/engine/jobs';
import { isSkillEntry, parseSchedule } from '@/engine/skills';
import { listConcepts } from '@/engine/okf';
import { readNote } from '@/lib/ipc';
import { splitFrontmatter } from '@/lib/mockParse';
import { distillPrompt, reviewConceptPrompt, scheduledSkillPrompt } from '@/lib/prompts';
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
 *    schedule fires again.
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
    () => entries.some((e) => isSkillEntry(e) && parseSchedule(e.properties.schedule) !== null),
    [entries],
  );
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!hasSchedules) return;
    const timer = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [hasSchedules]);

  const today = todayIso();
  const next: AgentJob | null = useMemo(() => {
    if (!autoLearn) return null;
    return (
      jobQueue(entries, listConcepts(entries, today), { filed, attempts, skillRuns, now })[0] ??
      null
    );
  }, [attempts, autoLearn, entries, filed, now, skillRuns, today]);

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
      // Recorded first, on purpose — see the header.
      if (job.kind === 'scheduled') ui.recordSkillRun(job.path, job.runKey);
      else ui.recordLearnAttempt(job.path, job.runKey);

      void (async () => {
        try {
          const message =
            job.kind === 'scheduled'
              ? scheduledSkillPrompt(
                  job.path,
                  job.title,
                  splitFrontmatter(await readNote(vaultPath, job.path)).body.trim(),
                )
              : job.kind === 'stale'
                ? reviewConceptPrompt(job.path, job.title)
                : distillPrompt(job.path, job.title);
          mcp.current ??= await startMcp(vaultPath);
          await runAgent(vaultPath, {
            message,
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
            shell,
            connectors,
            mcp: mcp.current,
          });
        } catch {
          // Silent by construction. A background runner that could raise a
          // toast would be a notification, which is the one thing this whole
          // surface is not allowed to be.
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
