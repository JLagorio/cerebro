// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  MetadataPatchOperation,
  MetadataPatchRequest,
  MetadataPatchResult,
  SelectedPropertySnapshot,
} from '@/lib/generated/workspace';
import { __resetOpenPages, flushOpenPages, unresolvedOpenPages } from './openPages';
import {
  attachSelectedMetadataField,
  retainedSelectedMetadataField,
  type MetadataFieldApi,
  type MetadataFieldScope,
} from './selectedMetadataFieldOwner';
const target = {
  workspaceId: '915781f1-6812-478c-8063-3f41322547f5',
  recordId: '76b64da5-34b6-45f2-8ab2-e2779227ace3',
};
const KEY1 = 'b0ede44d-aee0-4ad9-baf4-c896ba47f300';
const KEY2 = '075a623f-adf5-467f-845f-387dff926af8';
const scope = (): MetadataFieldScope => ({
  vault: '/metadata-owner-fixture',
  path: 'page.md',
  target: { ...target },
  field: 'code',
});
const snapshot = (): SelectedPropertySnapshot => ({
  path: 'page.md',
  target: { ...target },
  field: 'code',
  version: {
    kind: 'sqlite_metadata',
    ...target,
    metadataRevision: '9007199254740993',
    metadataHash: 'a'.repeat(64),
    bodyHash: 'b'.repeat(64),
  },
  value: { kind: 'present', value: { kind: 'string', value: 'before' } },
  editable: true,
  readOnlyReason: null,
  coherence: 'paired',
  observedBodyHash: 'b'.repeat(64),
});
function operation(request: MetadataPatchRequest): MetadataPatchOperation {
  const version = {
    ...request.expectedVersion,
    metadataRevision: (BigInt(request.expectedVersion.metadataRevision) + 1n).toString(),
    metadataHash:
      request.expectedVersion.metadataHash === 'c'.repeat(64) ? 'd'.repeat(64) : 'c'.repeat(64),
  };
  return {
    target: { ...request.target },
    path: 'page.md',
    requestKey: request.requestKey,
    operationId: 'fca816d3-e22f-47a9-8c19-3fa5ef6aa85c',
    version,
    receipt: {
      workspaceId: target.workspaceId,
      recordId: target.recordId,
      epoch: '2',
      previousRevision: request.expectedVersion.metadataRevision,
      revision: version.metadataRevision,
      metadataBeforeHash: request.expectedVersion.metadataHash,
      metadataAfterHash: version.metadataHash,
      bodyBeforeHash: version.bodyHash,
      bodyAfterHash: version.bodyHash,
      actor: 'human:me',
      operation: 'metadata.patch',
      at: '2026-10-26T00:00:00Z',
    },
  };
}
const applied = (request: MetadataPatchRequest): MetadataPatchResult => {
  const op = operation(request);
  return {
    kind: 'applied',
    operation: op,
    currentVersion: { ...op.version },
    reconcileRequired: false,
  };
};
function api(): MetadataFieldApi {
  return {
    read: vi.fn<MetadataFieldApi['read']>(async () => snapshot()),
    patch: vi.fn<MetadataFieldApi['patch']>(async (_scope, request) => applied(request)),
    mintKey: vi.fn<MetadataFieldApi['mintKey']>().mockReturnValueOnce(KEY1).mockReturnValue(KEY2),
  };
}
const unknown = (): MetadataPatchResult => ({
  kind: 'outcome_unknown',
  requestKey: KEY1,
  error: {
    code: 'capability_unavailable',
    kind: 'metadata_unavailable',
    message: 'Original result cannot be proven.',
    retryable: false,
  },
});
function attach(service = api(), frame = snapshot()) {
  const handle = attachSelectedMetadataField(scope(), frame, service);
  expect(handle).not.toBeNull();
  if (!handle) throw new Error('actual owner interface missing');
  return { ...handle, service };
}
beforeEach(() => __resetOpenPages());
afterEach(() => {
  __resetOpenPages();
  vi.useRealTimers();
});
it('readonly canonical field cannot construct an inline write owner', () => {
  const frame = snapshot();
  frame.editable = false;
  const service = api();
  expect(attachSelectedMetadataField(scope(), frame, service)).toBeNull();
  expect(service.patch).not.toHaveBeenCalled();
});
it('foreign returned requested-field scope cannot construct the wanted owner', () => {
  const frame = snapshot();
  frame.target.recordId = '61a79a0c-5846-4870-9873-b5382c0d66d0';
  const service = api();
  expect(attachSelectedMetadataField(scope(), frame, service)).toBeNull();
  expect(service.patch).not.toHaveBeenCalled();
});
it('literal text saves exactly one typed metadata request with whole original version', async () => {
  const frame = snapshot();
  const before = structuredClone(frame.version);
  const { owner, service } = attach(api(), frame);
  owner.edit('007');
  const outcome = await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  expect(vi.mocked(service.patch).mock.calls[0]).toEqual([
    scope(),
    {
      target,
      requestKey: KEY1,
      expectedVersion: before,
      changes: [{ op: 'set', key: 'code', value: { kind: 'string', value: '007' } }],
      phase: 'start',
      original: null,
    },
  ]);
  expect(outcome.kind).toBe('committed');
  expect(owner.getSnapshot().acknowledgedGeneration).toBe(owner.getSnapshot().generation);
  expect(owner.getSnapshot().request).toBeNull();
});
it('authored empty string is not normalized to null or removal', async () => {
  const { owner, service } = attach();
  owner.edit('');
  await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  expect(vi.mocked(service.patch).mock.calls[0]![1].changes).toEqual([
    { op: 'set', key: 'code', value: { kind: 'string', value: '' } },
  ]);
});
it('explicit removal uses its own tagged operation without empty-string ambiguity', async () => {
  const { owner, service } = attach();
  owner.remove();
  await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  expect(vi.mocked(service.patch).mock.calls[0]![1].changes).toEqual([
    { op: 'remove', key: 'code' },
  ]);
});
it('unknown request outlives detach and reattach and the barrier only resolves its frozen original', async () => {
  const first = api();
  vi.mocked(first.patch).mockRejectedValueOnce(new Error('lost native reply'));
  const frame = snapshot();
  const before = structuredClone(frame.version);
  const handle = attach(first, frame);
  handle.owner.edit('007');
  await handle.owner.flush();
  expect(first.patch).toHaveBeenCalledOnce();
  expect(handle.owner.getSnapshot().phase).toBe('unknown');
  handle.release();
  frame.version.metadataRevision = '9007199254740999';
  frame.version.metadataHash = 'f'.repeat(64);
  const replacement = api();
  const reattached = attachSelectedMetadataField(scope(), frame, replacement);
  expect(reattached?.owner).toBe(handle.owner);
  await flushOpenPages();
  expect(first.patch).toHaveBeenCalledTimes(2);
  expect(replacement.patch).not.toHaveBeenCalled();
  const calls = vi.mocked(first.patch).mock.calls;
  expect(calls[1]![1]).toMatchObject({
    requestKey: KEY1,
    phase: 'resolve',
    expectedVersion: before,
    changes: calls[0]![1].changes,
  });
  expect(handle.owner.getSnapshot().request).toBeNull();
});
it('definite fresh native refusal keeps draft and explicit retry never borrows later expectation', async () => {
  const service = api();
  vi.mocked(service.patch).mockRejectedValue({
    kind: 'metadata_refused',
    error: {
      code: 'capability_unavailable',
      kind: 'stale_metadata',
      message: 'Canonical metadata changed.',
      retryable: false,
    },
  });
  const frame = snapshot();
  const before = structuredClone(frame.version);
  const { owner } = attach(service, frame);
  owner.edit('007');
  await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  expect(owner.getSnapshot().phase).toBe('failed');
  expect(owner.getSnapshot().latestDraft).toBe('007');
  frame.version.metadataHash = 'f'.repeat(64);
  await owner.retry();
  expect(service.patch).toHaveBeenCalledTimes(2);
  expect(
    vi
      .mocked(service.patch)
      .mock.calls.every(
        ([, q]) =>
          q.phase === 'start' &&
          q.requestKey === KEY1 &&
          q.expectedVersion.metadataHash === before.metadataHash,
      ),
  ).toBe(true);
});
it('foreign native acknowledgement cannot clear original request or report clean', async () => {
  const service = api();
  vi.mocked(service.patch).mockImplementation(async (_scope, q) => {
    const value = applied(q);
    if (value.kind !== 'applied') throw new Error('bad fixture');
    value.operation.requestKey = KEY2;
    return value;
  });
  const { owner } = attach(service);
  owner.edit('007');
  const outcome = await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  expect(outcome.kind).not.toBe('committed');
  expect(owner.getSnapshot().phase).toBe('unknown');
  expect(owner.getSnapshot().request?.requestKey).toBe(KEY1);
});
it('barrier timeout and detach keep the actual original invoke owned until completion', async () => {
  vi.useFakeTimers();
  let finish!: (value: MetadataPatchResult) => void;
  const pending = new Promise<MetadataPatchResult>((resolve) => {
    finish = resolve;
  });
  const service = api();
  vi.mocked(service.patch).mockReturnValue(pending);
  const handle = attach(service);
  handle.owner.edit('007');
  const run = handle.owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  handle.release();
  const report = flushOpenPages(1);
  await vi.advanceTimersByTimeAsync(1);
  expect((await report).unresolvedOwnerIds).not.toEqual([]);
  expect(retainedSelectedMetadataField(scope())).toBe(handle.owner);
  expect(handle.owner.getSnapshot().busy).toBe(true);
  expect(service.patch).toHaveBeenCalledOnce();
  finish(applied(vi.mocked(service.patch).mock.calls[0]![1]));
  await run;
  expect(service.patch).toHaveBeenCalledOnce();
});
it('Use current after terminal unknown cannot replay an old property at a later barrier', async () => {
  const service = api();
  vi.mocked(service.patch).mockResolvedValueOnce(unknown());
  const current = snapshot();
  current.version.metadataRevision = '9007199254740994';
  current.version.metadataHash = 'c'.repeat(64);
  current.value = { kind: 'present', value: { kind: 'string', value: 'current' } };
  vi.mocked(service.read).mockResolvedValue(current);
  const { owner } = attach(service);
  owner.edit('007');
  await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  expect(await owner.compare()).toBe(true);
  await owner.choose('current');
  await flushOpenPages();
  expect(service.patch).toHaveBeenCalledOnce();
  expect(owner.getSnapshot().latestDraft).toBe('current');
  expect(owner.getSnapshot().request).toBeNull();
  expect(unresolvedOpenPages()).toEqual([]);
});
it('Keep mine refreshes changed comparison and creates a new key only after another stable explicit choice', async () => {
  const service = api();
  vi.mocked(service.patch).mockResolvedValueOnce(unknown());
  const first = snapshot();
  first.version.metadataHash = 'c'.repeat(64);
  first.version.metadataRevision = '9007199254740994';
  const changed = structuredClone(first);
  changed.version.metadataHash = 'e'.repeat(64);
  changed.version.metadataRevision = '9007199254740995';
  vi.mocked(service.read).mockResolvedValueOnce(first).mockResolvedValue(changed);
  const { owner } = attach(service);
  owner.edit('007');
  await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  expect(await owner.compare()).toBe(true);
  expect((await owner.choose('mine')).kind).toBe('blocked');
  expect(service.patch).toHaveBeenCalledOnce();
  await owner.choose('mine');
  expect(service.patch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(service.patch).mock.calls[1]![1]).toMatchObject({
    requestKey: KEY2,
    phase: 'start',
    expectedVersion: changed.version,
    changes: [{ op: 'set', key: 'code', value: { kind: 'string', value: '007' } }],
  });
});
it('uneditable current observation never admits Keep mine while preserving authored text', async () => {
  const service = api();
  vi.mocked(service.patch).mockResolvedValueOnce(unknown());
  const current = snapshot();
  current.editable = false;
  current.readOnlyReason = 'This field belongs to its governed writer.';
  vi.mocked(service.read).mockResolvedValue(current);
  const { owner } = attach(service);
  owner.edit('007');
  await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  await owner.compare();
  expect((await owner.choose('mine')).kind).toBe('blocked');
  expect(service.patch).toHaveBeenCalledOnce();
  expect(owner.getSnapshot().latestDraft).toBe('007');
  expect(owner.getSnapshot().request?.requestKey).toBe(KEY1);
});
