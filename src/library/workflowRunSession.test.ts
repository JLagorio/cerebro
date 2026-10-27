import { expect, it, vi } from 'vitest';
import { createWorkflowRunSession, type WorkflowRunApi } from './workflowRunSession';
import type { ActionEffectDetails } from '@/lib/generated/actions';
import type {
  WorkflowRunView,
  WorkflowStartAck,
  WorkflowWaitAnswer,
} from '@/lib/generated/workflows';
const context = { vaultId: 'a'.repeat(32), storeUuid: 'original' };
const version = { workflowId: 'example', definitionHash: 'b'.repeat(64) };
const id = 'c'.repeat(32);
const invocation = 'd'.repeat(32);
const digest = 'e'.repeat(64);
const run = (extra: Partial<WorkflowRunView> = {}): WorkflowRunView => ({
  context: { ...context },
  version: { ...version },
  runId: id,
  nativeRunId: 'f'.repeat(32),
  admissionEpoch: 3,
  revision: 7,
  state: 'waiting',
  cancelRequested: false,
  configurationDigest: digest,
  inputDigest: digest,
  reason: 'external_input',
  steps: [
    {
      stepId: 'input',
      label: 'Ask',
      kind: 'external_input',
      state: 'waiting',
      ordinal: 1,
      invocationId: null,
      reason: null,
      input: { state: 'not_recorded' },
      output: { state: 'not_recorded' },
      wait: {
        continuationId: '1'.repeat(32),
        kind: 'external_input',
        state: 'pending',
        revision: 2,
        schemaJson: '{}',
        dueAt: null,
        expiresAt: null,
      },
    },
  ],
  ...extra,
});
const ack = (): WorkflowStartAck => ({
  context: { ...context },
  version: { ...version },
  runId: id,
  admissionEpoch: 3,
  revision: 7,
  created: false,
  admission: 'busy',
});
const details = (): ActionEffectDetails => ({
  revision: 4,
  effect: {
    invocationId: invocation,
    state: 'awaiting_approval',
    approvalId: 'approval',
    accountLabel: 'Account',
    canRetry: false,
    canReconcile: false,
  },
  definitionDigest: digest,
  inputDigest: digest,
  preview: {
    summary: 'Create issue',
    fields: [{ label: 'Title', value: 'Draft' }],
    redactedFields: [],
  },
  target: null,
  account: null,
  attempts: [],
  approval: {
    approvalId: 'approval',
    revision: 2,
    expiresAt: '2026-10-27T00:00:00Z',
    askedInputDigest: digest,
    approvedInputDigest: null,
    approvedPreview: null,
  },
});
function api(): WorkflowRunApi {
  return {
    run: vi.fn(async () => run()),
    continue: vi.fn(async () => ack()),
    cancel: vi.fn(async () => run({ state: 'cancelled', revision: 8 })),
    reauthorize: vi.fn(async () => ack()),
    action: vi.fn(async () => details()),
    answerAction: vi.fn(async () => run({ revision: 8 })),
    answerWait: vi.fn(async () => run({ revision: 8, state: 'queued' })),
    value: vi.fn(async () => ({ digest, json: '9007199254740993.0000000000000001' })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
it('reads only the original context and retains finite copied run metadata', async () => {
  const service = api();
  const original = { ...context };
  const response = Object.assign(run(), { unexpectedPayload: 'CANARY' });
  vi.mocked(service.run).mockResolvedValue(response);
  const session = createWorkflowRunSession(service, original, () => '2'.repeat(32));
  original.storeUuid = 'other';
  await session.open(id);
  expect(service.run).toHaveBeenCalledExactlyOnceWith(context, id);
  expect(session.getSnapshot().run).toEqual(run());
  expect(JSON.stringify(session.getSnapshot())).not.toContain('CANARY');
  response.context.storeUuid = 'mutated';
  expect(session.getSnapshot().run?.context).toEqual(context);
});
it('does not let an older run read replace the newly selected run', async () => {
  const service = api();
  const first = deferred<WorkflowRunView>();
  vi.mocked(service.run).mockImplementation(async (_context, selected) =>
    selected === id ? first.promise : run({ runId: selected }),
  );
  const session = createWorkflowRunSession(service, context, () => '2'.repeat(32));
  const old = session.open(id);
  const other = '3'.repeat(32);
  await session.open(other);
  first.resolve(run());
  await old;
  expect(session.getSnapshot().run?.runId).toBe(other);
});
it('continues with the observed original epoch and revision and reads native state after Busy', async () => {
  const service = api();
  const session = createWorkflowRunSession(service, context, () => '2'.repeat(32));
  await session.open(id);
  await session.continueRun();
  expect(service.continue).toHaveBeenCalledExactlyOnceWith({
    context,
    runId: id,
    expectedEpoch: 3,
    expectedRevision: 7,
  });
  expect(service.run).toHaveBeenCalledTimes(2);
  expect(session.getSnapshot().run?.state).toBe('waiting');
});
it('requires an original refresh after ambiguous cancellation before another mutation', async () => {
  const service = api();
  vi.mocked(service.cancel).mockRejectedValueOnce(new Error('PRIVATE-ERROR'));
  const session = createWorkflowRunSession(service, context, () => '2'.repeat(32));
  await session.open(id);
  await session.cancel();
  expect(session.getSnapshot().phase).toBe('unknown');
  expect(session.getSnapshot().run?.state).toBe('waiting');
  await session.cancel();
  expect(service.cancel).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(session.getSnapshot())).not.toContain('PRIVATE');
  await session.refresh();
  await session.cancel();
  expect(service.cancel).toHaveBeenCalledTimes(2);
  expect(session.getSnapshot().run?.state).toBe('cancelled');
});
it('copies explicitly requested reauthorization without synthesizing account grants', async () => {
  const service = api();
  const pending = deferred<WorkflowStartAck>();
  vi.mocked(service.reauthorize).mockReturnValueOnce(pending.promise);
  const session = createWorkflowRunSession(service, context, () => '2'.repeat(32));
  await session.open(id);
  const permissions = { queryRecords: false, readPrefixes: ['Notes'], accounts: [] };
  const work = session.reauthorize(permissions, { runId: id, admissionEpoch: 3 });
  permissions.readPrefixes.push('private');
  expect(service.reauthorize).toHaveBeenCalledExactlyOnceWith({
    context,
    runId: id,
    expectedEpoch: 3,
    permissions: { queryRecords: false, readPrefixes: ['Notes'], accounts: [] },
  });
  pending.resolve(ack());
  await work;
});
it('answers the actual selected approval with both native revisions and exact edited JSON', async () => {
  const service = api();
  const actionRun = run();
  actionRun.steps[0] = {
    ...actionRun.steps[0]!,
    kind: 'action',
    invocationId: invocation,
    wait: null,
  };
  vi.mocked(service.run).mockResolvedValue(actionRun);
  const session = createWorkflowRunSession(service, context, () => '2'.repeat(32));
  await session.open(id);
  await session.inspectAction(invocation);
  const edited = '{"n":9007199254740993.0000000000000001}';
  await session.answerAction(true, edited);
  expect(service.answerAction).toHaveBeenCalledExactlyOnceWith({
    context,
    runId: id,
    invocationId: invocation,
    approvalId: 'approval',
    expectedInvocationRevision: 4,
    expectedApprovalRevision: 2,
    allow: true,
    editedInputJson: edited,
  });
});
it('retains an unknown external signal exactly across refresh and retries one original key', async () => {
  const service = api();
  const requests: WorkflowWaitAnswer[] = [];
  vi.mocked(service.answerWait).mockImplementation(async (request) => {
    requests.push(structuredClone(request));
    if (requests.length === 1) throw new Error('lost');
    return run({ revision: 8, state: 'queued' });
  });
  const key = vi.fn(() => '2'.repeat(32));
  const session = createWorkflowRunSession(service, context, key);
  await session.open(id);
  await session.answerWait('input', ' 9007199254740993.0000000000000001 ');
  expect(session.getSnapshot().waitPending).toBe(true);
  await session.refresh();
  await session.answerWait('input', 'replacement');
  expect(requests).toHaveLength(1);
  await session.retryWait(context);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0]).toEqual({
    context,
    runId: id,
    continuationId: '1'.repeat(32),
    expectedRevision: 2,
    signalKey: '2'.repeat(32),
    inputJson: ' 9007199254740993.0000000000000001 ',
  });
  expect(key).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot().waitPending).toBe(false);
});
it('refuses an external signal retry from a replacement context without dropping the original', async () => {
  const service = api();
  vi.mocked(service.answerWait).mockRejectedValue(new Error('lost'));
  const session = createWorkflowRunSession(service, context, () => '2'.repeat(32));
  await session.open(id);
  await session.answerWait('input', '{}');
  await session.retryWait({ ...context, storeUuid: 'replacement' });
  expect(service.answerWait).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot().waitPending).toBe(true);
  expect(session.getSnapshot().failure).toBe('original_context_required');
});
it('loads values only explicitly from an available matching recorded digest and clears payloads', async () => {
  const service = api();
  const available = run();
  available.steps[0]!.output = { state: 'available', digest, bytes: 33 };
  vi.mocked(service.run).mockResolvedValue(available);
  const session = createWorkflowRunSession(service, context, () => '2'.repeat(32));
  await session.open(id);
  expect(service.value).not.toHaveBeenCalled();
  await session.readValue({ role: 'step_output', stepId: 'input', digest });
  expect(service.value).toHaveBeenCalledExactlyOnceWith({
    context,
    runId: id,
    role: 'step_output',
    stepId: 'input',
    digest,
  });
  expect(session.getSnapshot().value?.json).toBe('9007199254740993.0000000000000001');
  session.clearPayload();
  expect(session.getSnapshot().value).toBeNull();
});
it('rejects foreign run responses and mismatched explicit value payloads without adopting them', async () => {
  const service = api();
  vi.mocked(service.run).mockResolvedValueOnce(
    run({ context: { ...context, storeUuid: 'foreign' } }),
  );
  const session = createWorkflowRunSession(service, context, () => '2'.repeat(32));
  await session.open(id);
  expect(session.getSnapshot().phase).toBe('unavailable');
  expect(session.getSnapshot().run).toBeNull();
  const available = run();
  available.steps[0]!.output = { state: 'available', digest, bytes: 3 };
  vi.mocked(service.run).mockResolvedValue(available);
  await session.refresh();
  vi.mocked(service.value).mockResolvedValue({ digest: 'wrong', json: 'CANARY' });
  await session.readValue({ role: 'step_output', stepId: 'input', digest });
  expect(session.getSnapshot().value).toBeNull();
  expect(JSON.stringify(session.getSnapshot())).not.toContain('CANARY');
});

it('releases a definitely rejected external signal so corrected input gets a new key', async () => {
  const service = api();
  vi.mocked(service.answerWait).mockRejectedValueOnce({
    code: 'invalid_input',
    diagnostics: [],
    payload: 'CANARY',
  });
  const key = vi.fn().mockReturnValueOnce('4'.repeat(32)).mockReturnValueOnce('5'.repeat(32));
  const session = createWorkflowRunSession(service, context, key);
  await session.open(id);
  await session.answerWait('input', '{invalid');
  expect(session.getSnapshot().phase).toBe('idle');
  expect(session.getSnapshot().waitPending).toBe(false);
  expect(JSON.stringify(session.getSnapshot())).not.toContain('CANARY');
  await session.answerWait('input', '{}');
  expect(service.answerWait).toHaveBeenCalledTimes(2);
  expect(vi.mocked(service.answerWait).mock.calls[0]![0].signalKey).toBe('4'.repeat(32));
  expect(vi.mocked(service.answerWait).mock.calls[1]![0].signalKey).toBe('5'.repeat(32));
  expect(session.getSnapshot().run?.state).toBe('queued');
});

it('cannot switch away from an unknown mutation when its original refresh fails', async () => {
  const service = api();
  vi.mocked(service.cancel).mockRejectedValueOnce(new Error('lost'));
  const session = createWorkflowRunSession(service, context, () => '2'.repeat(32));
  await session.open(id);
  await session.cancel();
  vi.mocked(service.run).mockRejectedValueOnce(new Error('unavailable'));
  await session.refresh();
  await session.open('9'.repeat(32));
  expect(service.run).toHaveBeenCalledTimes(2);
  expect(session.getSnapshot().runId).toBe(id);
  await session.cancel();
  expect(service.cancel).toHaveBeenCalledTimes(1);
  await session.refresh();
  await session.open('9'.repeat(32));
  expect(service.run).toHaveBeenCalledTimes(4);
});

// Proposed reviewed-identity argument; the current one-argument implementation
// accepts extra JS arguments but ignores them, exposing the causal rebase defect.
type ReviewedAccess = { runId: string; admissionEpoch: number };
function reviewedAccessCall(session: ReturnType<typeof createWorkflowRunSession>) {
  return session.reauthorize as (
    permissions: import('@/lib/generated/workflows').WorkflowPermissions,
    reviewed: ReviewedAccess,
  ) => Promise<unknown>;
}
it('does not rebase reviewed access to a newer observed admission epoch', async () => {
  const service = api();
  const session = createWorkflowRunSession(service, context, () => '2'.repeat(32));
  await session.open(id);
  const reviewed = { runId: id, admissionEpoch: session.getSnapshot().run!.admissionEpoch };
  vi.mocked(service.run).mockResolvedValue(run({ admissionEpoch: 4, revision: 8 }));
  await session.refresh();
  await reviewedAccessCall(session)(
    { queryRecords: false, readPrefixes: [], accounts: [] },
    reviewed,
  );
  expect(service.reauthorize).not.toHaveBeenCalled();
  expect(session.getSnapshot().run?.admissionEpoch).toBe(4);
});
it('does not apply an old run access review to a newly selected run', async () => {
  const service = api();
  const session = createWorkflowRunSession(service, context, () => '2'.repeat(32));
  await session.open(id);
  const reviewed = { runId: id, admissionEpoch: 3 };
  const other = '9'.repeat(32);
  vi.mocked(service.run).mockResolvedValue(run({ runId: other }));
  await session.open(other);
  await reviewedAccessCall(session)(
    { queryRecords: false, readPrefixes: [], accounts: [] },
    reviewed,
  );
  expect(service.reauthorize).not.toHaveBeenCalled();
  expect(session.getSnapshot().run?.runId).toBe(other);
});
it('dispatches reviewed access only under its unchanged original run and epoch', async () => {
  const service = api();
  const session = createWorkflowRunSession(service, context, () => '2'.repeat(32));
  await session.open(id);
  const permissions = { queryRecords: false, readPrefixes: ['Notes'], accounts: [] };
  await reviewedAccessCall(session)(permissions, { runId: id, admissionEpoch: 3 });
  expect(service.reauthorize).toHaveBeenCalledExactlyOnceWith({
    context,
    runId: id,
    expectedEpoch: 3,
    permissions,
  });
});
