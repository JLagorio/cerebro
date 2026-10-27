import type { WorkflowContext } from '@/lib/generated/workflows';
import { createWorkflowStartSession, type WorkflowStartApi } from './workflowStartSession';
import { createWorkflowRunSession, type WorkflowRunApi } from './workflowRunSession';
export type WorkflowRuntimeApi = WorkflowStartApi & WorkflowRunApi;
export interface WorkflowRunOwner {
  start: ReturnType<typeof createWorkflowStartSession>;
  run: ReturnType<typeof createWorkflowRunSession>;
  mount: () => () => void;
}
import policy from '../../shared/workflows/editor.v1.json';
const owners = new Map<string, WorkflowRunOwner>();
const sources = new WeakMap<WorkflowRunOwner, WorkflowRuntimeApi>();
/** Bounded original UI request ownership only; never native execution authority. */
export function retainWorkflowRun(
  vault: string,
  context: WorkflowContext,
  workflowId: string,
  api: WorkflowRuntimeApi,
  newKey: () => string,
): WorkflowRunOwner | null {
  const key = JSON.stringify([vault, context.vaultId, context.storeUuid, workflowId]);
  const existing = owners.get(key);
  if (existing !== undefined) return sources.get(existing) === api ? existing : null;
  if (
    policy.formatVersion !== 1 ||
    !Number.isSafeInteger(policy.maxRetainedRunSessions) ||
    policy.maxRetainedRunSessions < 1 ||
    owners.size >= policy.maxRetainedRunSessions
  )
    return null;
  const start = createWorkflowStartSession({ start: api.start }, newKey);
  const run = createWorkflowRunSession(api, context, newKey);
  let mounts = 0;
  let mountedOnce = false;
  let retired = false;
  let sequence = 0;
  const held = () => {
    const starting = start.getSnapshot();
    const running = run.getSnapshot();
    return (
      starting.busy ||
      starting.phase === 'unknown' ||
      running.phase === 'mutating' ||
      running.phase === 'unknown' ||
      running.uncertain ||
      running.waitPending
    );
  };
  const releaseIfSettled = () => {
    const expected = ++sequence;
    if (retired || !mountedOnce || mounts !== 0 || held()) return;
    queueMicrotask(() => {
      if (retired || expected !== sequence || mounts !== 0 || held()) return;
      retired = true;
      unsubscribeStart();
      unsubscribeRun();
      run.clearPayload();
      if (owners.get(key) === owner) owners.delete(key);
    });
  };
  const unsubscribeStart = start.subscribe(releaseIfSettled);
  const unsubscribeRun = run.subscribe(releaseIfSettled);
  const owner: WorkflowRunOwner = {
    start,
    run,
    mount: () => {
      mounts++;
      mountedOnce = true;
      sequence++;
      let mounted = true;
      return () => {
        if (!mounted) return;
        mounted = false;
        mounts--;
        if (mounts === 0) run.clearPayload();
        releaseIfSettled();
      };
    },
  };
  owners.set(key, owner);
  sources.set(owner, api);
  return owner;
}
