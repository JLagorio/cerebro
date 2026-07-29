import { useCallback, useEffect, useMemo, useRef } from 'react';
import { onAgentEvent, runAgent, startMcp } from './agentIpc';
import { buildSystemPrompt } from './AiPanel';
import type { McpInfo } from './types';
import { learnQueue, type LearnJob } from '@/engine/learn';
import { listConcepts } from '@/engine/okf';
import { distillPrompt } from '@/lib/prompts';
import { todayIso } from '@/lib/templates';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';

/**
 * Drains the learn queue in the background (M8.6) — the thing that makes the
 * base grow instead of waiting to be fed.
 *
 * Three constraints shaped this, and they are worth stating because each one
 * rules out an easier design:
 *
 * 1. **It must not speak.** The rule is that nothing volunteers, and an
 *    assistant that pops a transcript open to tell you it read your note is
 *    volunteering. So a background turn produces no chat message at all. What
 *    it produces is concepts, and those are visible where they are relevant.
 *    This is only legitimate because the distiller writes into `knowledge/`,
 *    which is the agent's own folder — the same autonomy rule as every other
 *    write, not an exception carved for convenience.
 *
 * 2. **There is one agent.** `AgentState` holds a single child process, so a
 *    background turn and a typed question cannot both be in flight. The runner
 *    yields: it starts only when nothing else is running, and a question asked
 *    mid-drain simply waits for the current note to finish.
 *
 * 3. **It must not spin.** Every job is recorded as attempted BEFORE the run,
 *    so a note that yields no concept — or a run that dies — is not picked up
 *    again until the note itself changes.
 */

/** Let a burst of edits settle before reading anything. */
const SETTLE_MS = 4_000;

export function useLearnRunner(): void {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const entries = useVaultStore((s) => s.entries);
  const rescan = useVaultStore((s) => s.rescan);
  const autoLearn = useUiStore((s) => s.autoLearn);
  const filed = useUiStore((s) => s.filedForLearning);
  const attempts = useUiStore((s) => s.learnAttempts);
  const agentBusy = useUiStore((s) => s.agentBusy);
  const shell = useUiStore((s) => s.agentShellAccess);
  const connectors = useUiStore((s) => s.agentConnectors);
  const issuePrefixes = useUiStore((s) => s.issuePrefixes);

  const today = todayIso();
  const next: LearnJob | null = useMemo(() => {
    if (!autoLearn) return null;
    return learnQueue(entries, listConcepts(entries, today), { filed, attempts })[0] ?? null;
  }, [attempts, autoLearn, entries, filed, today]);

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
    // The concepts it just wrote are on disk and nowhere else until this runs.
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
      ui.recordLearnAttempt(job.path, job.modifiedAt);

      void (async () => {
        try {
          mcp.current ??= await startMcp(vaultPath);
          await runAgent(vaultPath, {
            message: distillPrompt(job.path, job.title),
            // The same rules the panel's agent gets — the conventions about
            // sources, anchors and never self-certifying are the contract, not
            // panel decoration. `selection` is 'none': a background reader is
            // not standing anywhere, and telling it otherwise would colour
            // what it takes from a note with wherever you happen to be.
            systemPrompt: buildSystemPrompt({ kind: 'none' }, { connectors, issuePrefixes }),
            // A fresh session every time: a background reader that accumulated
            // context would carry one note's framing into the next one's.
            sessionId: null,
            model: null,
            shell,
            connectors,
            mcp: mcp.current,
          });
        } catch {
          // Silent by construction. A background reader that could raise a
          // toast would be a notification, which is the one thing this whole
          // surface is not allowed to be.
          finish();
        }
      })();
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [agentBusy, connectors, finish, issuePrefixes, next, shell, vaultPath]);
}
