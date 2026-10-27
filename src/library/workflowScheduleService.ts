import * as ipc from '@/lib/ipc';
import type { WorkflowScheduleService } from './WorkflowSchedulePanel';
/** Actual native default only; the display-only Library never receives this adapter. */
export const nativeWorkflowScheduleService = Object.freeze({
  read: async (context, workflowId) => ipc.workflowSchedule(context, workflowId),
  enable: async (request) => ipc.workflowScheduleEnable(request),
  pause: async (request) => ipc.workflowSchedulePause(request),
  remove: async (request) => ipc.workflowScheduleRemove(request),
  wake: async (context) => ipc.workflowScheduleWake(context),
  preview: async (context, workflowId) => ipc.workflowSchedulePreview(context, workflowId),
  definition: async (context, version) => ipc.workflowVersion(context, version),
  actions: async (context) => ipc.workflowActions(context),
} satisfies WorkflowScheduleService);
