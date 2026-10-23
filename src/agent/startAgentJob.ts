import { useFollowupStore } from '@/stores/followupStore';
import { attachRun, checkWake, runAgent, stopAgent } from './agentIpc';
import { buildSystemPrompt } from './systemPrompt';
import { newRunId } from './runs';
import { assignmentPrefix, stillAssigned } from '@/engine/assignment';
import { hostsOf } from '@/engine/filing';
import { scopeAdmits } from '@/engine/agentAccess';
import { agentRef } from '@/engine/agents';
import { causeOfJob, type AgentJob } from '@/engine/jobs';
import { writtenPath, type RunLogEntry } from '@/engine/runLog';
import { triggerWords } from '@/engine/wakes';
import { fireKeyDate, parseAllowedTools } from '@/engine/skills';
import { isKnowledgePath } from '@/engine/okf';
import {
  grantedTools,
  holdsShell,
  holdsWeb,
  editsNotes,
  type PromptGrant,
} from '@/engine/toolGrant';
import {
  claimFollowup,
  releaseAssignedWakes,
  fleetActorSummary,
  jobLedgerClaim,
  jobLedgerStamp,
  jobLedgerUnclaim,
  readNote,
  reviewQueue,
} from '@/lib/ipc';
import { splitFrontmatter } from '@/engine/frontmatter';
import {
  agentRunPrompt,
  type AssignmentBrief,
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
import { getSchema, useVaultStore } from '@/stores/vaultStore';

export type JobStart =
  | { kind: 'started'; run: number }
  | { kind: 'answered' }
  | { kind: 'deferred'; reasons: string[]; words: string[]; gaveBack: boolean }
  | { kind: 'moved' }
  | { kind: 'failed'; error: string; recorded: boolean };
export interface JobContext {
  vaultPath: string;
  /** Runs before registry removal so the queue can derive the next job. */
  onSettled: () => void;
  onHold?: () => void;
  checkedYes?: Set<string>;
  onCheckHold?: (ids: readonly string[], retryAt: string) => void;
  refreshWakes?: () => Promise<unknown>;
  onClaimedWakes?: (ids: readonly string[]) => void;
}

/** Unknown older backends still say why in words without inventing a verdict. */
export function deferralText(reasons: readonly string[], words?: readonly string[]): string {
  return (
    reasons
      .map((reason, index) => words?.[index]?.trim() || `the budget gate said ${reason}`)
      .join('; ') || 'the dispatcher found nothing to start'
  );
}
export function pausedByHook(tool: string): string {
  return `${tool} was paused by a hook outside Cerebro, and nobody was watching this run to answer it, so it stopped there.`;
}
const logId = () => `rl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Queue and Run now share this start and its run-local event ownership.
 * Claims precede spawn but a schedule's body read precedes its claim. A
 * refused start gives back only a claim this call won; a manual call that
 * lost a due fire still runs without consuming somebody else's claim. */
export async function startAgentJob(job: AgentJob, ctx: JobContext): Promise<JobStart> {
  const { vaultPath } = ctx;
  const ui = useUiStore.getState();
  const taskId = newRunId();
  let finished = false;
  let unsubscribe: (() => void) | null = null;
  let logged: Omit<RunLogEntry, 'files' | 'status' | 'at' | 'id'> | null = null;
  const wrote: string[] = [];
  let failure: string | null = null;
  let claimed = false;
  let recorded = false;
  let starting = false;
  const hold = () => {
    if (useVaultStore.getState().vaultPath !== vaultPath) return;
    if (job.followup !== undefined) {
      const followups = useFollowupStore.getState();
      if (followups.vault === vaultPath)
        followups.hold(job.followup.followupId, Date.now() + 15 * 60_000);
    } else ctx.onHold?.();
  };
  const refreshFollowups = () => useFollowupStore.getState().refresh(vaultPath);
  const refreshWakes = async () => {
    await ctx.refreshWakes?.();
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    unsubscribe?.();
    ctx.onSettled();
    useUiStore.getState().endRun(taskId);
    if (logged !== null)
      useRunLogStore.getState().append({
        ...logged,
        id: logId(),
        at: new Date().toISOString(),
        files: [...wrote],
        status: failure === null ? 'ok' : 'failed',
        ...(failure === null ? {} : { error: failure }),
      });
    void useVaultStore.getState().rescan();
    void refreshWakes();
    void refreshFollowups();
  };
  const moved = () => useVaultStore.getState().vaultPath !== vaultPath;
  const giveBack = async (): Promise<boolean> => {
    if (!claimed || job.ledger === null || job.ledger === 'wakes' || job.ledger === 'followup')
      return false;
    claimed = false;
    useUiStore.getState().forgetJobRecord(vaultPath, job.ledger, job.key, job.runKey);
    try {
      const removed = await jobLedgerUnclaim(vaultPath, job.ledger, job.key, job.runKey);
      if (removed) recorded = false;
      return removed;
    } catch {
      return false;
    }
  };
  const abandon = async (): Promise<JobStart> => {
    await giveBack();
    finish();
    return { kind: 'moved' };
  };
  ui.startRun({
    id: taskId,
    owner: 'job',
    label: job.title,
    place: null,
    path: job.path,
    conversationId: null,
    run: null,
    startedAt: Date.now(),
  });
  const entry = useVaultStore.getState().entries.find((entry) => entry.path === job.path);
  const agent = job.kind === 'agent' && entry !== undefined ? agentRef(entry) : null;
  const narrowing =
    job.kind === 'agent'
      ? (agent?.allowedTools ?? null)
      : job.kind === 'scheduled'
        ? parseAllowedTools(entry?.properties['allowed-tools'])
        : null;
  const ceiling: ShellCeiling =
    job.kind === 'agent' ? effectiveCeiling(ui.agentShell, agent?.shell ?? false) : 'off';
  const web = job.kind === 'agent' && ui.agentWebAccess && (agent?.web ?? false);
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
      web: web ? 'on' : 'off',
      attended: false,
      readScoped: agent?.readScope != null,
      narrowing,
    }),
    attended: false,
  };
  const trigger = job.manual
    ? 'manual'
    : job.followup !== undefined
      ? 'followup'
      : job.wake !== undefined
        ? 'event'
        : 'schedule';
  const appendFailure = (status: 'failed' | 'deferred', error: string) =>
    useRunLogStore.getState().append({
      id: logId(),
      at: new Date().toISOString(),
      owner: 'job',
      label: job.title,
      source: job.path,
      trigger,
      scope: agent?.scope ?? null,
      files: [],
      status,
      error,
    });
  try {
    if (moved()) return await abandon();
    let followup = job.followup;
    if (followup !== undefined) {
      starting = true;
      const answer = await claimFollowup(vaultPath, followup.followupId);
      if (moved()) return await abandon();
      starting = false;
      if (answer.state !== 'claimed') {
        finish();
        return { kind: 'answered' };
      }
      followup = answer.row;
    }
    if (job.ledger === 'attempts') {
      claimed = await jobLedgerClaim(vaultPath, 'attempts', job.key, job.runKey);
      if (moved()) return await abandon();
      useUiStore.getState().recordLearnAttempt(job.key, job.runKey);
      recorded = true;
      if (!claimed) {
        finish();
        return { kind: 'answered' };
      }
    }
    let woken = job.wake ?? null;
    const assigned = woken?.assignment;
    const assignmentStillHeld = () => {
      if (assigned === undefined) return true;
      const fresh = useVaultStore.getState();
      return stillAssigned(
        {
          agent: assigned.agent,
          cause: { kind: 'assigned', subject: assigned.subject },
          trigger: assigned.trigger,
        },
        fresh.entries,
        getSchema(fresh.entries),
      );
    };
    const releaseGone = async (): Promise<JobStart> => {
      if (assigned !== undefined)
        await releaseAssignedWakes(
          vaultPath,
          assigned.agent,
          assigned.subject,
          assignmentPrefix(assigned.field),
        );
      await refreshWakes();
      finish();
      return { kind: 'answered' };
    };
    if (!assignmentStillHeld()) return await releaseGone();
    if (woken !== null && woken.trigger.ask !== undefined && agent !== null) {
      const checked = ctx.checkedYes ?? new Set<string>();
      const ids = [woken.claim, ...woken.coalesce];
      const unchecked = ids.filter((id) => !checked.has(id));
      if (unchecked.length > 0) {
        starting = true;
        const result = await checkWake(vaultPath, agent.actor, unchecked, woken.trigger.ask);
        if (moved()) return await abandon();
        starting = false;
        if (result.state === 'deferred') {
          if (woken.deferredBefore === null)
            appendFailure(
              'deferred',
              `deferred by the budget gate: ${deferralText(result.reasons, result.words)}`,
            );
          await refreshWakes();
          finish();
          return {
            kind: 'deferred',
            reasons: result.reasons,
            words: result.words,
            gaveBack: false,
          };
        }
        if (result.state === 'met')
          for (const id of result.wakes) if (unchecked.includes(id)) checked.add(id);
        if (result.state === 'unavailable' && !result.skipped && result.retry_at !== null)
          ctx.onCheckHold?.(result.wakes, result.retry_at);
        await refreshWakes();
        if (moved()) return await abandon();
      }
      const surviving = ids.filter((id) => checked.has(id));
      if (surviving.length === 0) {
        finish();
        return { kind: 'answered' };
      }
      woken = { ...woken, claim: surviving[0], coalesce: surviving.slice(1) };
      if (!assignmentStillHeld()) return await releaseGone();
    }
    let assignment: AssignmentBrief | undefined;
    if (assigned !== undefined) {
      const fresh = useVaultStore.getState();
      const subject = fresh.entries.find((item) => item.path === assigned.subject);
      const host =
        subject === undefined
          ? undefined
          : hostsOf(subject, fresh.entries, getSchema(fresh.entries)).find((item) =>
              scopeAdmits(agent?.readScope ?? null, item.path),
            );
      assignment = {
        field: assigned.field,
        canWrite:
          editsNotes(grant) &&
          scopeAdmits(agent?.scope ?? null, assigned.subject) &&
          !isKnowledgePath(assigned.subject),
        host: host === undefined ? null : { title: host.title, path: host.path },
      };
    }
    // Context may be unavailable without refusing an otherwise valid run.
    // Failed reads omit their line; they never say the queue is empty.
    const [lastOutcome, openReviews] = await Promise.all([
      agent === null
        ? Promise.resolve(null)
        : fleetActorSummary(agent.actor)
            .then((summary) => summary.last_outcome)
            .catch(() => null),
      reviewQueue(vaultPath)
        .then((cards) => cards.length)
        .catch(() => null),
    ]);
    if (moved()) return await abandon();
    const state = currentStatePrompt({
      vaultName: vaultPath.split('/').filter(Boolean).pop() ?? vaultPath,
      today: todayIso(),
      lastOutcome,
      openReviews,
    });
    const record =
      job.kind === 'agent' || job.kind === 'scheduled'
        ? splitFrontmatter(await readNote(vaultPath, job.path)).body.trim()
        : '';
    if (moved()) return await abandon();
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
            assignment,
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
    let actualJob = followup === undefined ? job : { ...job, followup };
    if (job.ledger === 'skillRuns') {
      claimed = await jobLedgerClaim(vaultPath, 'skillRuns', job.key, job.runKey);
      if (moved()) return await abandon();
      useUiStore.getState().recordSkillRun(vaultPath, job.key, job.runKey);
      recorded = true;
      if (!claimed) {
        if (!job.manual) {
          finish();
          return { kind: 'answered' };
        }
        actualJob = { ...job, ledger: null };
      }
    }
    starting = true;
    if (!assignmentStillHeld()) return await releaseGone();
    const start = await runAgent(vaultPath, {
      message: `${state}\n\n${body}`,
      actor: agent?.actor ?? null,
      systemPrompt:
        buildSystemPrompt(
          { kind: 'none' },
          {
            connectors: ui.agentConnectors,
            issuePrefixes: ui.issuePrefixes,
            capabilities: job.kind === 'agent' ? (agent?.capabilities ?? []) : ['knowledge'],
            grant,
          },
        ) +
        (job.kind === 'agent' && record !== ''
          ? `\n\nYour standing instructions, from ${job.path}:\n\n${record}`
          : ''),
      sessionId: null,
      model: agent?.model ?? null,
      effort: agent?.effort ?? null,
      shell: ceiling,
      web,
      scope: agent?.scope ?? null,
      readScope: agent?.readScope ?? null,
      allowedTools: narrowing,
      disallowedTools: agent?.disallowedTools ?? null,
      connectorNames: agent?.connectors ?? null,
      connectors: ui.agentConnectors,
      attended: false,
      askFirst: agent?.askFirst ?? false,
      lane: job.kind,
      cause: causeOfJob(actualJob, entry?.properties.schedule),
      ...(followup === undefined ? {} : { followup: followup.followupId }),
      ...(woken === null ? {} : { wake: { claim: woken.claim, coalesce: woken.coalesce } }),
      approvedStdio: useUiStore.getState().stdioApprovals[vaultPath] ?? [],
    });
    if (moved()) {
      if ('run' in start) void stopAgent(start.run).catch(() => undefined);
      return await abandon();
    }
    if ('settled' in start) {
      await refreshWakes();
      finish();
      return { kind: 'answered' };
    }
    if ('deferred' in start) {
      const words = start.words ?? [];
      if (woken === null) hold();
      const gaveBack = await giveBack();
      if (woken === null || woken.deferredBefore === null)
        appendFailure(
          'deferred',
          `deferred by the budget gate: ${deferralText(start.deferred, words)}`,
        );
      if (woken !== null) await refreshWakes();
      finish();
      return { kind: 'deferred', reasons: start.deferred, words, gaveBack };
    }
    const { run: runId, durableId } = start;
    if (woken !== null) ctx.onClaimedWakes?.([woken.claim, ...woken.coalesce]);
    if (job.cooldownKey !== null && !job.manual) {
      const at = new Date().toISOString();
      useUiStore.getState().recordTriggerRun(vaultPath, job.cooldownKey, at);
      void jobLedgerStamp(vaultPath, job.cooldownKey, at).catch(() => undefined);
    }
    useUiStore.getState().attachChild(taskId, runId);
    const due =
      followup !== undefined
        ? new Date(followup.dueAt)
        : !job.manual && job.ledger === 'skillRuns'
          ? fireKeyDate(job.runKey)
          : null;
    logged = {
      owner: 'job',
      label: job.title,
      source: job.path,
      trigger: job.manual
        ? 'manual'
        : followup !== undefined
          ? 'followup'
          : woken === null
            ? job.kind === 'agent' || job.kind === 'scheduled'
              ? 'schedule'
              : job.kind
            : woken.assignment !== undefined
              ? `assigned via ${woken.assignment.field}`
              : `event: ${triggerWords(woken.trigger)}${woken.coalesce.length > 0 ? ` (+${woken.coalesce.length} more)` : ''}`,
      scope: agent?.scope ?? null,
      ...(durableId === null ? {} : { durableId }),
      ...(due === null ? {} : { dueAt: due.toISOString() }),
    };
    const attached = await attachRun(start, 0, (event) => {
      if (event.kind === 'ToolStart') {
        const path = writtenPath(event.tool_name, event.input ?? null);
        if (path !== null && !wrote.includes(path)) wrote.push(path);
      }
      // A subagent's Error (one with a `parent`, M91.3b) failed only its own
      // Agent call, which the run reads and goes on from: as Rust's reader
      // takes it, it is never the run's failure and never its end.
      const failed = event.kind === 'Error' && event.parent === undefined ? event.message : null;
      if (failed !== null) failure = failed;
      if (event.kind === 'ToolDeferred') failure = pausedByHook(event.tool_name);
      if (event.kind === 'Done' || failed !== null) finish();
    });
    // Replay can finish synchronously before attachRun hands back detach.
    if (attached.state === 'unknown') {
      failure = "Couldn't read this run's events, so its outcome is unknown.";
      finish();
    } else if (finished) attached.detach();
    else {
      unsubscribe = attached.detach;
      if (attached.done) finish();
    }
    if (moved()) {
      void stopAgent(runId).catch(() => undefined);
      return await abandon();
    }
    return { kind: 'started', run: runId };
  } catch (error) {
    if (moved()) return await abandon();
    const message = starting
      ? error instanceof Error
        ? error.message
        : String(error)
      : `could not read ${job.path} — this run cannot say what it found`;
    if (logged === null) appendFailure('failed', starting ? `did not start: ${message}` : message);
    if (starting) {
      hold();
      await giveBack();
    } else if (!recorded) hold();
    finish();
    return { kind: 'failed', error: message, recorded };
  }
}
