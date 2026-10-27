import type { WorkflowContext } from '@/lib/generated/workflows';
import { createWorkflowScheduleSession, type WorkflowScheduleApi } from './workflowScheduleSession';
import policy from '../../shared/workflows/editor.v1.json';
export interface WorkflowScheduleOwner { session: ReturnType<typeof createWorkflowScheduleSession>; mount: () => () => void; }
const owners = new Map<string, WorkflowScheduleOwner>();
const services = new WeakMap<WorkflowScheduleOwner, WorkflowScheduleApi>();
/** Bounded original request retention, without native authority or disk persistence. */
export function retainWorkflowSchedule(vault: string, context: WorkflowContext, workflowId: string, api: WorkflowScheduleApi, newKey: () => string): WorkflowScheduleOwner | null {
 const key = JSON.stringify([vault, context.vaultId, context.storeUuid, workflowId]);
 const existing = owners.get(key); if (existing !== undefined) return services.get(existing) === api ? existing : null;
 if (policy.formatVersion !== 1 || !Number.isSafeInteger(policy.maxRetainedScheduleSessions) || policy.maxRetainedScheduleSessions < 1 || owners.size >= policy.maxRetainedScheduleSessions) return null;
 const session = createWorkflowScheduleSession(api, context, workflowId, newKey);
 let mounts = 0; let retired = false; let generation = 0;
 const held = () => session.getSnapshot().busy || session.getSnapshot().uncertain;
 const release = () => { const current = ++generation; if (retired || mounts !== 0 || held()) return; queueMicrotask(() => { if (retired || current !== generation || mounts !== 0 || held()) return; if (!session.retire()) return; retired = true; unsubscribe(); if (owners.get(key) === owner) owners.delete(key); }); };
 const unsubscribe = session.subscribe(release);
 const owner: WorkflowScheduleOwner = { session, mount: () => { if (retired) return () => {}; mounts++; generation++; let live = true; return () => { if (!live) return; live = false; mounts--; release(); }; } };
 owners.set(key, owner); services.set(owner, api); release(); return owner;
}
