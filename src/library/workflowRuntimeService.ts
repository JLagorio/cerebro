import * as ipc from '@/lib/ipc';
import type { WorkflowRuntimeService } from './WorkflowRunPanel';
/** Native default only. Preview Library services never receive this execution adapter. */
export const nativeWorkflowRuntimeService = Object.freeze({
  start: async (request) => ipc.workflowStart(request),
  run: async (context, runId) => ipc.workflowRun(context, runId),
  access: async (context, runId) => ipc.workflowAccess(context, runId),
  runs: async (context, after) => ipc.workflowRuns(context, after),
  continue: async (request) => ipc.workflowContinue(request),
  cancel: async (request) => ipc.workflowCancel(request),
  reauthorize: async (request) => ipc.workflowReauthorize(request),
  action: async (context, runId, invocationId) =>
    ipc.workflowActionDetails(context, runId, invocationId),
  answerAction: async (request) => ipc.workflowAnswerAction(request),
  answerWait: async (request) => ipc.workflowAnswerWait(request),
  value: async (request) => ipc.workflowValue(request),
  definition: async (context, version) => ipc.workflowVersion(context, version),
  actions: async (context) => ipc.workflowActions(context),
} satisfies WorkflowRuntimeService);
