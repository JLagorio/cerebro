// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import scalarCases from '../../shared/workspace/metadata-scalar-cases.v1.json';
import type { PropertyChange, PropertyValue } from '@/lib/generated/workspace';
import type {
  MetadataPatchOperation,
  MetadataPatchRequest,
  MetadataPatchResult,
  SelectedPropertySnapshot,
} from '@/lib/generated/workspace';
import { __resetOpenPages, flushOpenPages, unresolvedOpenPages } from './openPages';
import {
  attachSelectedMetadataField,
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
  field: 'flag',
});
const snapshot = (): SelectedPropertySnapshot => ({
  path: 'page.md',
  target: { ...target },
  field: 'flag',
  version: {
    kind: 'sqlite_metadata',
    ...target,
    metadataRevision: '9007199254740993',
    metadataHash: 'a'.repeat(64),
    bodyHash: 'b'.repeat(64),
  },
  value: { kind: 'present', value: { kind: 'boolean', value: false } },
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
const toggles = scalarCases.cases.filter(
  (row) =>
    row.fieldKind === 'checkbox' &&
    row.editable &&
    row.change.op === 'set' &&
    'value' in row.change &&
    row.change.value?.kind === 'boolean',
);
it.each(toggles)(
  'shared tagged checkbox $id retains exact Boolean instead of text/number',
  async (row) => {
    const frame = snapshot();
    frame.value =
      row.stored === null
        ? { kind: 'absent' }
        : { kind: 'present', value: row.stored as PropertyValue };
    const service = api();
    const { owner } = attach(service, frame);
    const change = row.change as PropertyChange;
    if (change.op !== 'set' || change.value.kind !== 'boolean')
      throw new Error('bad shared Boolean case');
    owner.editBoolean(change.value.value);
    const outcome = await owner.flush();
    expect(service.patch).toHaveBeenCalledOnce();
    expect(vi.mocked(service.patch).mock.calls[0]![1]).toMatchObject({
      expectedVersion: frame.version,
      changes: [change],
      phase: 'start',
    });
    expect(outcome.kind).toBe('committed');
    expect(owner.getValue()).toEqual({ kind: 'present', value: change.value });
  },
);
it('unknown Boolean outlives detach and barrier resolves the same original typed intent', async () => {
  const service = api();
  vi.mocked(service.patch).mockRejectedValueOnce(new Error('lost Boolean reply'));
  const { owner, release } = attach(service);
  owner.editBoolean(true);
  await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  const first = structuredClone(vi.mocked(service.patch).mock.calls[0]![1]);
  release();
  await flushOpenPages();
  expect(service.patch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(service.patch).mock.calls[1]![1]).toEqual({ ...first, phase: 'resolve' });
  expect(first.changes).toEqual([
    { op: 'set', key: 'flag', value: { kind: 'boolean', value: true } },
  ]);
  expect(owner.getSnapshot().request).toBeNull();
});
it('Keep mine after unknown Boolean keeps the tag across stable explicit new-key choice', async () => {
  const service = api();
  vi.mocked(service.patch).mockResolvedValueOnce(unknown());
  const current = snapshot();
  current.version.metadataHash = 'e'.repeat(64);
  current.version.metadataRevision = '9007199254740994';
  vi.mocked(service.read).mockResolvedValue(current);
  const { owner } = attach(service);
  owner.editBoolean(true);
  await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  await owner.compare();
  await owner.choose('mine');
  expect(service.patch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(service.patch).mock.calls[1]![1]).toMatchObject({
    requestKey: KEY2,
    expectedVersion: current.version,
    changes: [{ op: 'set', key: 'flag', value: { kind: 'boolean', value: true } }],
  });
});
it('Use current Boolean stores its exact tag and cannot replay the old toggle', async () => {
  const service = api();
  vi.mocked(service.patch).mockResolvedValueOnce(unknown());
  const current = snapshot();
  current.value = { kind: 'present', value: { kind: 'boolean', value: true } };
  current.version.metadataHash = 'e'.repeat(64);
  current.version.metadataRevision = '9007199254740994';
  vi.mocked(service.read).mockResolvedValue(current);
  const { owner } = attach(service);
  owner.editBoolean(true);
  await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  await owner.compare();
  await owner.choose('current');
  await flushOpenPages();
  expect(service.patch).toHaveBeenCalledOnce();
  expect(owner.getValue()).toEqual(current.value);
  expect(unresolvedOpenPages()).toEqual([]);
});
it('Boolean removal remains a tagged removal rather than false or null', async () => {
  const { owner, service } = attach();
  owner.remove();
  await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  expect(vi.mocked(service.patch).mock.calls[0]![1].changes).toEqual([
    { op: 'remove', key: 'flag' },
  ]);
  expect(owner.getValue()).toEqual({ kind: 'absent' });
});
it('native readonly Boolean never creates a write owner', () => {
  const current = snapshot();
  current.editable = false;
  const service = api();
  expect(attachSelectedMetadataField(scope(), current, service)).toBeNull();
  expect(service.patch).not.toHaveBeenCalled();
});
