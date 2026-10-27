// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import scalarCases from '../../shared/workspace/metadata-scalar-cases.v1.json';
import type {
  PropertyChange,
  PropertyValue,
  MetadataPatchOperation,
  MetadataPatchRequest,
  MetadataPatchResult,
  SelectedPropertySnapshot,
} from '@/lib/generated/workspace';
import { __resetOpenPages, flushOpenPages, unresolvedOpenPages } from './openPages';
import {
  SelectedMetadataFieldOwner,
  attachSelectedMetadataField,
  type MetadataFieldApi,
  type MetadataFieldScope,
} from './selectedMetadataFieldOwner';
const target = {
  workspaceId: '915781f1-6812-478c-8063-3f41322547f5',
  recordId: '76b64da5-34b6-45f2-8ab2-e2779227ace3',
};
const KEY1 = 'b0ede44d-aee0-4ad9-baf4-c896ba47f300',
  KEY2 = '075a623f-adf5-467f-845f-387dff926af8';
const scope = (): MetadataFieldScope => ({
  vault: '/metadata-number-owner-fixture',
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
  value: { kind: 'present', value: { kind: 'decimal', value: '9007199254740993.125' } },
  editable: true,
  readOnlyReason: null,
  coherence: 'paired',
  observedBodyHash: 'b'.repeat(64),
});
function operation(q: MetadataPatchRequest): MetadataPatchOperation {
  const version = {
    ...q.expectedVersion,
    metadataRevision: (BigInt(q.expectedVersion.metadataRevision) + 1n).toString(),
    metadataHash: 'c'.repeat(64),
  };
  return {
    target: { ...q.target },
    path: 'page.md',
    requestKey: q.requestKey,
    operationId: 'fca816d3-e22f-47a9-8c19-3fa5ef6aa85c',
    version,
    receipt: {
      workspaceId: target.workspaceId,
      recordId: target.recordId,
      epoch: '2',
      previousRevision: q.expectedVersion.metadataRevision,
      revision: version.metadataRevision,
      metadataBeforeHash: q.expectedVersion.metadataHash,
      metadataAfterHash: version.metadataHash,
      bodyBeforeHash: version.bodyHash,
      bodyAfterHash: version.bodyHash,
      actor: 'human:me',
      operation: 'metadata.patch',
      at: '2026-10-26T00:00:00Z',
    },
  };
}
const applied = (q: MetadataPatchRequest): MetadataPatchResult => {
  const op = operation(q);
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
    patch: vi.fn<MetadataFieldApi['patch']>(async (_scope, q) => applied(q)),
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
function owner(service = api(), frame = snapshot()) {
  const owner = new SelectedMetadataFieldOwner(scope(), frame, service);
  return { owner, service, release: owner.attach() };
}
beforeEach(() => __resetOpenPages());
afterEach(() => __resetOpenPages());
const decimalCases = scalarCases.cases.filter(
  (row) =>
    row.fieldKind === 'number' &&
    row.editable &&
    row.change.op === 'set' &&
    'value' in row.change &&
    row.change.value?.kind === 'decimal',
);
it.each(decimalCases)(
  'shared exact Number $id authors the Decimal lexeme without numeric coercion',
  async (row) => {
    const frame = snapshot();
    frame.value =
      row.stored === null
        ? { kind: 'absent' }
        : { kind: 'present', value: row.stored as PropertyValue };
    const h = owner(api(), frame);
    if (row.outcome === 'unchanged')
      vi.mocked(h.service.patch).mockImplementation(async (_scope, q) => ({
        kind: 'unchanged',
        target: { ...q.target },
        path: 'page.md',
        requestKey: q.requestKey,
        version: { ...q.expectedVersion },
        currentVersion: { ...q.expectedVersion },
        reconcileRequired: false,
      }));
    const change = row.change as PropertyChange;
    if (change.op !== 'set' || change.value.kind !== 'decimal')
      throw new Error('bad shared Number case');
    h.owner.editDecimal(change.value.value);
    const outcome = await h.owner.flush();
    expect(h.service.patch).toHaveBeenCalledOnce();
    expect(vi.mocked(h.service.patch).mock.calls[0]![1]).toMatchObject({
      phase: 'start',
      requestKey: KEY1,
      expectedVersion: frame.version,
      changes: [change],
    });
    expect(outcome.kind).toBe('committed');
    expect(h.owner.getValue()).toEqual({ kind: 'present', value: change.value });
  },
);
it('fresh native editable Number frame can attach without projecting its exact original value', () => {
  const frame = snapshot();
  const service = api();
  const handle = attachSelectedMetadataField(scope(), frame, service);
  expect(handle).not.toBeNull();
  expect(handle?.owner.getSnapshot().latestDraft).toBe('9007199254740993.125');
  expect(handle?.owner.getValue()).toEqual(frame.value);
  expect(service.patch).not.toHaveBeenCalled();
});
it('invalid Number lexeme remains owned across detach/barrier with zero patch or request key', async () => {
  const h = owner();
  h.owner.editDecimal('007');
  expect(h.owner.getSnapshot().latestDraft).toBe('007');
  h.release();
  const outcome = await h.owner.flush();
  expect(outcome.kind).toBe('failed');
  await flushOpenPages();
  expect(h.service.patch).not.toHaveBeenCalled();
  expect(h.service.mintKey).not.toHaveBeenCalled();
  expect(unresolvedOpenPages().some((row) => row.key.path === 'page.md')).toBe(true);
  expect(h.owner.getSnapshot().message).toMatch(/number|decimal/i);
});
it('invalid draft corrected explicitly authors only the new exact lexeme', async () => {
  const h = owner();
  h.owner.editDecimal('1e');
  await h.owner.flush();
  expect(h.service.patch).not.toHaveBeenCalled();
  h.owner.editDecimal('1e400');
  await h.owner.flush();
  expect(h.service.patch).toHaveBeenCalledOnce();
  expect(vi.mocked(h.service.patch).mock.calls[0]![1].changes).toEqual([
    { op: 'set', key: 'flag', value: { kind: 'decimal', value: '1e400' } },
  ]);
});
it('unknown Number survives detach and barrier Resolve keeps the exact original tag/key/version', async () => {
  const h = owner();
  vi.mocked(h.service.patch).mockRejectedValueOnce(new Error('lost Number reply'));
  h.owner.editDecimal('-0.00E+03');
  await h.owner.flush();
  expect(h.service.patch).toHaveBeenCalledOnce();
  const first = structuredClone(vi.mocked(h.service.patch).mock.calls[0]![1]);
  h.release();
  await flushOpenPages();
  expect(h.service.patch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(h.service.patch).mock.calls[1]![1]).toEqual({ ...first, phase: 'resolve' });
  expect(first.changes).toEqual([
    { op: 'set', key: 'flag', value: { kind: 'decimal', value: '-0.00E+03' } },
  ]);
});
it('Keep mine after stable comparison preserves authored exponent and freezes a fresh current version', async () => {
  const h = owner();
  vi.mocked(h.service.patch).mockResolvedValueOnce(unknown());
  const current = snapshot();
  current.value = { kind: 'present', value: { kind: 'decimal', value: '2e400' } };
  current.version.metadataRevision = '9007199254740994';
  current.version.metadataHash = 'e'.repeat(64);
  vi.mocked(h.service.read).mockResolvedValue(current);
  h.owner.editDecimal('1e400');
  await h.owner.flush();
  expect(h.service.patch).toHaveBeenCalledOnce();
  await h.owner.compare();
  await h.owner.choose('mine');
  expect(h.service.patch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(h.service.patch).mock.calls[1]![1]).toMatchObject({
    requestKey: KEY2,
    expectedVersion: current.version,
    changes: [{ op: 'set', key: 'flag', value: { kind: 'decimal', value: '1e400' } }],
  });
});
it('Use current exact Number cannot replay the old authored fraction on the next barrier', async () => {
  const h = owner();
  vi.mocked(h.service.patch).mockResolvedValueOnce(unknown());
  const current = snapshot();
  current.value = { kind: 'present', value: { kind: 'decimal', value: '9007199254740993.127' } };
  vi.mocked(h.service.read).mockResolvedValue(current);
  h.owner.editDecimal('9007199254740993.126');
  await h.owner.flush();
  expect(h.service.patch).toHaveBeenCalledOnce();
  await h.owner.compare();
  await h.owner.choose('current');
  await flushOpenPages();
  expect(h.service.patch).toHaveBeenCalledOnce();
  expect(h.owner.getValue()).toEqual(current.value);
  expect(h.owner.getSnapshot().latestDraft).toBe('9007199254740993.127');
});
it('readonly current Number revokes authoring after explicit Use current', async () => {
  const h = owner();
  vi.mocked(h.service.patch).mockResolvedValueOnce(unknown());
  const current = snapshot();
  current.editable = false;
  current.readOnlyReason = 'Canonical Number is now derived.';
  vi.mocked(h.service.read).mockResolvedValue(current);
  h.owner.editDecimal('7');
  await h.owner.flush();
  expect(h.service.patch).toHaveBeenCalledOnce();
  await h.owner.compare();
  await h.owner.choose('current');
  h.owner.editDecimal('8');
  await h.owner.flush();
  expect(h.service.patch).toHaveBeenCalledOnce();
  expect(h.owner.getValue()).toEqual(current.value);
});
it('native readonly Number never creates a write owner', () => {
  const current = snapshot();
  current.editable = false;
  const service = api();
  expect(attachSelectedMetadataField(scope(), current, service)).toBeNull();
  expect(service.patch).not.toHaveBeenCalled();
});

it.each(['1\n', '\n1', ' 1', '1 ', '1' + '0'.repeat(256)])(
  'invalid exact Decimal draft %j remains owned without a request',
  async (text) => {
    const h = owner();
    h.owner.editDecimal(text);
    expect(h.owner.getSnapshot().latestDraft).toBe(text);
    const result = await h.owner.flush();
    expect(result.kind).toBe('failed');
    expect(h.service.patch).not.toHaveBeenCalled();
    expect(h.service.mintKey).not.toHaveBeenCalled();
    expect(h.owner.getSnapshot().generation).toBeGreaterThan(
      h.owner.getSnapshot().acknowledgedGeneration,
    );
  },
);
