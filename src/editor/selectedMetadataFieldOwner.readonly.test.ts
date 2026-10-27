// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  MetadataPatchOperation,
  MetadataPatchRequest,
  MetadataPatchResult,
  SelectedPropertySnapshot,
} from '@/lib/generated/workspace';
import { __resetOpenPages } from './openPages';
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
afterEach(() => __resetOpenPages());
it('Use current readonly observation retires editing eligibility until a fresh admitted presentation', async () => {
  const service = api();
  vi.mocked(service.patch).mockResolvedValueOnce(unknown());
  const current = snapshot();
  current.editable = false;
  current.readOnlyReason = 'This field now belongs to its governed writer.';
  current.version.metadataRevision = '9007199254740994';
  current.version.metadataHash = 'c'.repeat(64);
  vi.mocked(service.read).mockResolvedValue(current);
  const { owner } = attach(service);
  owner.edit('007');
  await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  await owner.compare();
  await owner.choose('current');
  owner.edit('not admitted');
  await owner.flush();
  expect(service.patch).toHaveBeenCalledOnce();
  expect(owner.getSnapshot().generation).toBe(owner.getSnapshot().acknowledgedGeneration);
});
