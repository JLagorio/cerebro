import { expect, it } from 'vitest';
import { DocumentOwner, type DocumentWriter } from './documentOwner';
import type {
  AuthorityError,
  EditorOperation,
  EditorSaveRequest,
  EditorSaveResult,
} from '@/lib/generated/workspace';
import { sha256Hex } from '@/lib/sha256';

const key = { vaultId: '/selected-boundary-toy', path: 'page.md', ownerId: 'owner' };
const target = {
  workspaceId: 'ab933aef-f067-4343-b0ef-1586879c3062',
  recordId: '2453dfd1-caf1-4428-bfe1-feeb4311bd0b',
};
const error: AuthorityError = {
  code: 'capability_unavailable',
  kind: 'recovery_required',
  message: 'Recovery needed.',
  retryable: true,
};
/** Descriptive wire fixture only; no native receipt or authority is minted. */
function operation(request: EditorSaveRequest, body: string): EditorOperation {
  const version = {
    kind: 'sqlite_metadata' as const,
    ...request.target,
    metadataRevision: '2',
    metadataHash: 'a'.repeat(64),
    bodyHash: sha256Hex(body),
  };
  return {
    target: { ...request.target },
    path: key.path,
    requestKey: request.requestKey,
    operationId: 'a33f5b38-275b-456d-9816-37168a3dc695',
    version,
    receipt: {
      workspaceId: request.target.workspaceId,
      recordId: request.target.recordId,
      previousRevision: '1',
      revision: '2',
      epoch: '2',
      metadataBeforeHash: version.metadataHash,
      metadataAfterHash: version.metadataHash,
      bodyBeforeHash: sha256Hex('before'),
      bodyAfterHash: version.bodyHash,
      actor: 'human',
      operation: 'page.body',
      at: '2026-10-24T00:00:00Z',
    },
  };
}
const pending = (request: EditorSaveRequest, body: string): EditorSaveResult => ({
  kind: 'selected_pending',
  operation: operation(request, body),
  error,
});

it('selected_mismatched_pending_reply_cannot_supply_an_original_descriptor', async () => {
  const requests: EditorSaveRequest[] = [];
  const write: DocumentWriter = async (body, _format, _bypass, _hash, _destination, request) => {
    expect(request).toBeDefined();
    if (!request) throw new Error('missing request');
    requests.push(structuredClone(request));
    return pending({ ...request, requestKey: '5f00cf8a-911a-4e9b-8ffa-487e740d16e3' }, body);
  };
  const owner = new DocumentOwner(key, 'before', write, target);
  owner.edit('mine');
  expect(await owner.flush()).toMatchObject({ kind: 'pending', status: 'unknown' });
  expect(await owner.retry()).toMatchObject({ kind: 'pending', status: 'unknown' });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ phase: 'resolve', requestKey: requests[0].requestKey });
  expect(requests[1].original ?? null).toBeNull();
  expect(owner.snapshot()).toMatchObject({ latestDraft: 'mine', acknowledgedGeneration: 0 });
});

it('selected_target_object_mutation_cannot_retarget_the_retained_owner', async () => {
  const supplied = { ...target };
  const requests: EditorSaveRequest[] = [];
  const write: DocumentWriter = async (body, _format, _bypass, _hash, _destination, request) => {
    expect(request).toBeDefined();
    if (!request) throw new Error('missing request');
    requests.push(structuredClone(request));
    return pending(request, body);
  };
  const owner = new DocumentOwner(key, 'before', write, supplied);
  supplied.recordId = 'f52d3b14-b028-4fb4-a9b8-251d57599671';
  owner.edit('mine');
  expect((await owner.flush()).kind).toBe('pending');
  expect(requests[0].target).toEqual(target);
  expect(owner.selectedTarget).toEqual(target);
});

it('selected_preintent_recovery_choice_preserves_attempt_key_and_one_use_bypass', async () => {
  const calls: { request: EditorSaveRequest; bypass: string | undefined }[] = [];
  const write: DocumentWriter = async (body, _format, bypass, _hash, _destination, request) => {
    expect(request).toBeDefined();
    if (!request) throw new Error('missing request');
    calls.push({ request: structuredClone(request), bypass });
    if (calls.length === 1) throw new Error('recovery_required:exact-original-nonce');
    const original = operation(request, body);
    return {
      kind: 'selected_applied',
      operation: original,
      currentVersion: original.version,
      reconcileRequired: false,
      recovery: { kind: 'without_copy' },
    };
  };
  const owner = new DocumentOwner(key, 'before', write, target);
  owner.edit('mine', 'source');
  expect(await owner.flush()).toMatchObject({
    kind: 'failed',
    code: 'recovery_required:exact-original-nonce',
  });
  expect(owner.snapshot().selectedSave).toBeUndefined();
  expect(await owner.saveWithoutRecoveryCopy('exact-original-nonce', 1)).toMatchObject({
    kind: 'acknowledged',
    generation: 1,
  });
  expect(calls).toHaveLength(2);
  expect(calls[0].bypass).toBeUndefined();
  expect(calls[1]).toMatchObject({
    bypass: 'exact-original-nonce',
    request: { phase: 'start', requestKey: calls[0].request.requestKey },
  });
  expect(await owner.saveWithoutRecoveryCopy('exact-original-nonce', 1)).toMatchObject({
    kind: 'blocked',
    reason: 'choice',
  });
  expect(calls).toHaveLength(2);
});

it('selected_resolve_refusal_cannot_reclassify_an_original_lost_reply_as_not_applied', async () => {
  let calls = 0;
  const write: DocumentWriter = async () => {
    if (++calls === 1) throw new Error('transport lost');
    throw { kind: 'selected_refused', error: { ...error, kind: 'source_changed' } };
  };
  const owner = new DocumentOwner(key, 'before', write, target);
  owner.edit('mine');
  expect(await owner.flush()).toMatchObject({ kind: 'pending', status: 'unknown' });
  expect(await owner.retry()).toMatchObject({ kind: 'pending', status: 'unknown' });
  expect(owner.snapshot()).toMatchObject({
    latestDraft: 'mine',
    acknowledgedGeneration: 0,
    failure: null,
  });
  expect(owner.retireRecovery()).toBe(false);
});
