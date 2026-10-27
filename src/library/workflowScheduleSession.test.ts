import { expect, it, vi } from 'vitest';
import {
  createWorkflowScheduleSession,
  type WorkflowScheduleApi,
  type ScheduleEnableInput,
} from './workflowScheduleSession';
import type {
  WorkflowScheduleAck,
  WorkflowScheduleConfiguration,
  WorkflowScheduleView,
} from '@/lib/generated/workflows';
const context = { vaultId: 'a'.repeat(32), storeUuid: 'original' };
const version = { workflowId: 'scheduled', definitionHash: 'b'.repeat(64) };
const digest = 'c'.repeat(64);
const permissions = () => ({
  queryRecords: true,
  readPrefixes: ['Notes'],
  accounts: [
    {
      connection: 'github',
      account: 'account',
      action: 'github.issue.create',
      definition: digest,
      capabilities: ['issues:write'],
      inputScope: 'exact_canonical_input' as const,
      inputDigest: digest,
    },
  ],
});
const input = (): ScheduleEnableInput => ({
  version: { ...version },
  expectedRevision: 0,
  inputJson: '{"n":9007199254740993.0000000000000001}',
  permissions: permissions(),
});
const configuration = (revision = 1): WorkflowScheduleConfiguration => ({
  activationId: 'd'.repeat(32),
  version: { ...version },
  state: 'enabled',
  revision,
  epoch: 'e'.repeat(32),
  configurationDigest: digest,
  inputDigest: digest,
  permissionDigest: digest,
  triggerDigest: digest,
  anchorMs: 1792980000000,
  cursorMs: 1792980000000,
  recoveryHeld: false,
  coverageKnown: false,
  skippedCount: 0,
  coalescedCount: 0,
  observedAtMs: null,
  firstSkippedMs: null,
  lastSkippedMs: null,
  inputJson: '{}',
  permissions: permissions(),
});
const view = (current: WorkflowScheduleConfiguration | null = null): WorkflowScheduleView => ({
  context: { ...context },
  workflowId: version.workflowId,
  configuration: current,
  readiness: current === null ? 'unconfigured' : 'ready',
  monitoring: 'stopped',
});
const ack = (extra: Partial<WorkflowScheduleAck> = {}): WorkflowScheduleAck => ({
  context: { ...context },
  workflowId: version.workflowId,
  current: configuration(),
  receipt: {
    operation: 'enable',
    revision: 1,
    epoch: 'e'.repeat(32),
    state: 'enabled',
    version: { ...version },
  },
  replayed: false,
  monitoring: 'busy',
  ...extra,
});
function api(): WorkflowScheduleApi {
  return {
    read: vi.fn(async () => view()),
    enable: vi.fn(async () => ack()),
    pause: vi.fn(async () => ack()),
    remove: vi.fn(async () => ack()),
    wake: vi.fn(async (): ReturnType<WorkflowScheduleApi['wake']> => ({
      context,
      monitoring: 'queued',
    })),
    preview: vi.fn(async (): ReturnType<WorkflowScheduleApi['preview']> => ({
      context,
      workflowId: version.workflowId,
      revision: 1,
      epoch: 'e'.repeat(32),
      disposition: 'idle',
      coverageKnown: false,
      dueAtMs: null,
      cursorMs: 1792980000000,
      skippedCount: 0,
      coalescedCount: 0,
    })),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it('reads the exact original configuration without enabling or installing monitoring', async () => {
  const service = api();
  const session = createWorkflowScheduleSession(service, context, version.workflowId, () =>
    '1'.repeat(32),
  );
  await session.refresh();
  expect(service.read).toHaveBeenCalledExactlyOnceWith(context, version.workflowId);
  expect(session.getSnapshot().view).toEqual(view());
  expect(service.enable).not.toHaveBeenCalled();
  expect(service.wake).not.toHaveBeenCalled();
});
it('freezes finite Enable selectors and exact input with one key before asynchronous IPC', async () => {
  const service = api();
  const pending = deferred<WorkflowScheduleAck>();
  vi.mocked(service.enable).mockReturnValue(pending.promise);
  const key = vi.fn(() => '2'.repeat(32));
  const session = createWorkflowScheduleSession(service, context, version.workflowId, key);
  await session.refresh();
  const request = Object.assign(input(), { arbitrary: 'CANARY' });
  const expected = input();
  const work = session.enable(request);
  request.version.definitionHash = 'f'.repeat(64);
  request.permissions.accounts[0]!.capabilities.push('extra');
  request.inputJson = 'changed';
  expect(service.enable).toHaveBeenCalledExactlyOnceWith({
    context,
    ...expected,
    requestKey: '2'.repeat(32),
  });
  expect(session.getSnapshot().phase).toBe('mutating');
  await session.enable(input());
  expect(service.enable).toHaveBeenCalledTimes(1);
  pending.resolve(ack());
  await work;
  expect(session.getSnapshot().uncertain).toBe(false);
  expect(session.getSnapshot().ack?.monitoring).toBe('busy');
  expect(JSON.stringify(session.getSnapshot())).not.toContain('CANARY');
  expect(key).toHaveBeenCalledTimes(1);
});
it('retries unknown Enable using the identical original request after failed refresh', async () => {
  const service = api();
  vi.mocked(service.enable)
    .mockRejectedValueOnce(new Error('PRIVATE'))
    .mockResolvedValueOnce(ack({ replayed: true, monitoring: null }));
  const key = vi.fn(() => '3'.repeat(32));
  const session = createWorkflowScheduleSession(service, context, version.workflowId, key);
  await session.refresh();
  await session.enable(input());
  expect(session.getSnapshot().uncertain).toBe(true);
  vi.mocked(service.read).mockRejectedValueOnce(new Error('read failed'));
  await session.refresh();
  expect(session.getSnapshot().uncertain).toBe(true);
  await session.enable(input());
  expect(service.enable).toHaveBeenCalledTimes(1);
  await session.retry(context);
  expect(vi.mocked(service.enable).mock.calls[1]![0]).toEqual(
    vi.mocked(service.enable).mock.calls[0]![0],
  );
  expect(key).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot().uncertain).toBe(false);
  expect(service.wake).not.toHaveBeenCalled();
  expect(JSON.stringify(session.getSnapshot())).not.toContain('PRIVATE');
});
it('refuses foreign retry and keeps unknown even after a successful configuration read', async () => {
  const service = api();
  vi.mocked(service.enable).mockRejectedValue(new Error('lost'));
  const session = createWorkflowScheduleSession(service, context, version.workflowId, () =>
    '4'.repeat(32),
  );
  await session.refresh();
  await session.enable(input());
  await session.refresh();
  await session.retry({ ...context, storeUuid: 'replacement' });
  expect(service.enable).toHaveBeenCalledTimes(1);
  expect(session.getSnapshot().uncertain).toBe(true);
  await session.retry(context);
  expect(service.enable).toHaveBeenCalledTimes(2);
});
it('keeps known configuration when monitoring is Busy and retries only explicit wake', async () => {
  const service = api();
  const session = createWorkflowScheduleSession(service, context, version.workflowId, () =>
    '5'.repeat(32),
  );
  await session.refresh();
  await session.enable(input());
  expect(session.getSnapshot().ack?.current.revision).toBe(1);
  expect(session.getSnapshot().view?.monitoring).toBe('stopped');
  expect(service.wake).not.toHaveBeenCalled();
  await session.wake();
  expect(service.wake).toHaveBeenCalledExactlyOnceWith(context);
  expect(session.getSnapshot().view?.monitoring).toBe('watching');
  expect(service.enable).toHaveBeenCalledTimes(1);
});
it('does not silently rebase a reviewed Pause revision onto a later configuration', async () => {
  const service = api();
  vi.mocked(service.read)
    .mockResolvedValueOnce(view(configuration(3)))
    .mockResolvedValueOnce(view(configuration(4)));
  const session = createWorkflowScheduleSession(service, context, version.workflowId, () =>
    '6'.repeat(32),
  );
  await session.refresh();
  const captured = session.getSnapshot().view!.configuration!.revision;
  await session.refresh();
  await session.change('pause', captured);
  expect(service.pause).not.toHaveBeenCalled();
  expect(session.getSnapshot().failure).not.toBeNull();
});
it('retains the exact original Pause request through acknowledgement loss', async () => {
  const service = api();
  vi.mocked(service.read).mockResolvedValue(view(configuration(3)));
  const result = ack({
    receipt: { operation: 'pause', revision: 4, epoch: 'e'.repeat(32), state: 'paused', version },
    current: { ...configuration(4), state: 'paused' },
    monitoring: null,
  });
  vi.mocked(service.pause).mockRejectedValueOnce(new Error('lost')).mockResolvedValueOnce(result);
  const session = createWorkflowScheduleSession(service, context, version.workflowId, () =>
    '7'.repeat(32),
  );
  await session.refresh();
  await session.change('pause', 3);
  expect(session.getSnapshot().uncertain).toBe(true);
  await session.retry(context);
  expect(service.pause).toHaveBeenCalledTimes(2);
  expect(vi.mocked(service.pause).mock.calls[0]![0]).toEqual({
    context,
    workflowId: version.workflowId,
    expectedRevision: 3,
    requestKey: '7'.repeat(32),
  });
  expect(vi.mocked(service.pause).mock.calls[1]![0]).toEqual(
    vi.mocked(service.pause).mock.calls[0]![0],
  );
  expect(session.getSnapshot().view?.configuration?.state).toBe('paused');
});
it('refuses a foreign acknowledgement and drops arbitrary successful response fields', async () => {
  const service = api();
  vi.mocked(service.enable)
    .mockResolvedValueOnce(ack({ context: { ...context, storeUuid: 'wrong' } }))
    .mockResolvedValueOnce(
      Object.assign(ack({ replayed: true, monitoring: null }), { private: 'CANARY' }),
    );
  const session = createWorkflowScheduleSession(service, context, version.workflowId, () =>
    '8'.repeat(32),
  );
  await session.refresh();
  await session.enable(input());
  expect(session.getSnapshot().uncertain).toBe(true);
  expect(session.getSnapshot().ack).toBeNull();
  await session.retry(context);
  expect(session.getSnapshot().ack).toEqual(ack({ replayed: true, monitoring: null }));
  expect(JSON.stringify(session.getSnapshot())).not.toContain('CANARY');
});
it('allows correction after definite invalid input without retaining an unknown request', async () => {
  const service = api();
  vi.mocked(service.enable).mockRejectedValueOnce({ code: 'invalid_input', diagnostics: [] });
  const key = vi.fn().mockReturnValueOnce('9'.repeat(32)).mockReturnValueOnce('a'.repeat(32));
  const session = createWorkflowScheduleSession(service, context, version.workflowId, key);
  await session.refresh();
  await session.enable({ ...input(), inputJson: '{bad' });
  expect(session.getSnapshot().uncertain).toBe(false);
  expect(session.getSnapshot().failure).toMatch(/input/i);
  await session.enable(input());
  expect(service.enable).toHaveBeenCalledTimes(2);
  expect(key).toHaveBeenCalledTimes(2);
});
it('drops a late preview after the displayed configuration revision changes', async () => {
  const service = api();
  vi.mocked(service.read)
    .mockResolvedValueOnce(view(configuration()))
    .mockResolvedValueOnce(view(configuration(2)));
  const pending = deferred<Awaited<ReturnType<WorkflowScheduleApi['preview']>>>();
  vi.mocked(service.preview).mockReturnValue(pending.promise);
  const session = createWorkflowScheduleSession(service, context, version.workflowId, () =>
    'b'.repeat(32),
  );
  await session.refresh();
  const work = session.preview();
  expect(service.preview).toHaveBeenCalledExactlyOnceWith(context, version.workflowId);
  await session.refresh();
  pending.resolve({
    context,
    workflowId: version.workflowId,
    revision: 1,
    epoch: 'e'.repeat(32),
    disposition: 'due',
    coverageKnown: false,
    dueAtMs: 1792980000000,
    cursorMs: 1792980000000,
    skippedCount: 0,
    coalescedCount: 0,
  });
  await work;
  expect(session.getSnapshot().preview).toBeNull();
  expect(session.getSnapshot().view?.configuration?.revision).toBe(2);
});
it('uses a captured Remove CAS and never turns removal into run cancellation', async () => {
  const service = api();
  vi.mocked(service.read).mockResolvedValue(view(configuration(2)));
  vi.mocked(service.remove).mockResolvedValue(
    ack({
      receipt: {
        operation: 'remove',
        revision: 3,
        epoch: 'e'.repeat(32),
        state: 'removed',
        version,
      },
      current: { ...configuration(3), state: 'removed', inputJson: null, permissions: null },
      monitoring: null,
    }),
  );
  const session = createWorkflowScheduleSession(service, context, version.workflowId, () =>
    'c'.repeat(32),
  );
  await session.refresh();
  await session.change('remove', 2);
  expect(service.remove).toHaveBeenCalledExactlyOnceWith({
    context,
    workflowId: version.workflowId,
    expectedRevision: 2,
    requestKey: 'c'.repeat(32),
  });
  expect(session.getSnapshot().view?.configuration?.state).toBe('removed');
  expect(session.getSnapshot().ack?.monitoring).toBeNull();
});

it('invalidates a pending observation preview when explicit monitoring resumes', async () => {
  const service = api();
  vi.mocked(service.read).mockResolvedValue(view(configuration()));
  const pending = deferred<Awaited<ReturnType<WorkflowScheduleApi['preview']>>>();
  vi.mocked(service.preview).mockReturnValue(pending.promise);
  const session = createWorkflowScheduleSession(service, context, version.workflowId, () =>
    'd'.repeat(32),
  );
  await session.refresh();
  const preview = session.preview();
  await session.wake();
  expect(service.wake).toHaveBeenCalledTimes(1);
  pending.resolve({
    context,
    workflowId: version.workflowId,
    revision: 1,
    epoch: 'e'.repeat(32),
    disposition: 'due',
    coverageKnown: false,
    dueAtMs: 1792980000000,
    cursorMs: 1792980000000,
    skippedCount: 0,
    coalescedCount: 0,
  });
  await preview;
  expect(session.getSnapshot().preview).toBeNull();
});
